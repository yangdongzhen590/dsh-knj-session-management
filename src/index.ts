/**
 * dsh-knj-session-management host entry: mounts the archive HTTP routes, the
 * archive store, and runs the deferred-move sweep + auto-archive policy once at
 * boot.
 *
 * Archive visibility belongs to the host (`ctx.workspaceRegistry`
 * `archivedSessionIds`); this plugin owns the disk move. See
 * docs/adr/0001-host-authoritative-archive.md.
 */
import { homedir } from 'node:os'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ArchiveStore } from './store.ts'
import { discoverSessions, type SessionDiscovery } from './fs.ts'
import { ArchiveOps } from './archive-ops.ts'
import { resolveWorkspaceRegistry, type ServiceBag } from './host-registry.ts'
import { selectForArchive, type PolicyConfig } from './policy.ts'
import {
  fileOnlyOps,
  mountArchiveRoutes,
  type ArchiveHost,
  type ProjcacheDeleter,
  type RouteDeps,
} from './routes.ts'

export const name = 'dsh-knj-session-management'

export interface Config {
  /** Archive root (default: $DSH_HOME/archive-sessions). */
  archiveRoot?: string
  /** Auto-archive: keep at most N sessions per workspace. 0 disables. */
  maxSessionsPerWorkspace?: number
  /** Master switch for the auto-archive policy (default true). */
  enabled?: boolean
  /** Cap per policy run (default 50) — bounds event-loop blocking. */
  maxPerRun?: number
}

interface HostServices {
  sessions: {
    list(): Array<{ id: string }>
    get(id: string): unknown
  }
  agents?: {
    get(id: string): { status?: string } | undefined
  }
  sessionProjectionCache?: ProjcacheDeleter
}

export function apply(ctx: Context, config?: Config): void {
  // workspaceRegistry is deliberately NOT in the inject list: the plugin must
  // also load on hosts (and in tests) that have no registry. It is resolved
  // lazily on every use instead, so a late-created service is still found.
  ctx.inject(['webServer', 'loader', 'sessions', 'agents', 'sessionProjectionCache'], (hostCtx: Context) => {
    const host = hostCtx as unknown as ArchiveHost & { get<T>(key: string): T | undefined }
    const bag = hostCtx as unknown as ServiceBag
    const sessions = host.get<HostServices['sessions']>('sessions')
    const agents = host.get<HostServices['agents']>('agents')
    const projcache = host.get<ProjcacheDeleter>('sessionProjectionCache')

    const archiveRoot = config?.archiveRoot ?? defaultArchiveRoot()
    const policy: PolicyConfig = {
      enabled: config?.enabled ?? true,
      maxSessionsPerWorkspace: config?.maxSessionsPerWorkspace ?? 60,
      maxPerRun: config?.maxPerRun ?? 50,
    }

    const store = new ArchiveStore(defaultDataDir(), archiveRoot)
    store.load()
    // Backfill parent links on legacy archive records so tree restore/delete
    // works for sessions archived before the tree-aware version.
    store.backfillParents()

    const disc: SessionDiscovery = {
      sessionsRoot: defaultSessionsRoot(),
      archiveRoot,
      // A session is "running" when its agent is actually running (matches the
      // host's own truth in apiproxy). Using sessions.get(id) would mark every
      // opened-but-idle session as running. Falls back to sessions.get when the
      // agents service is absent (conservative: treat as running).
      isAttached: (id) => {
        if (agents !== undefined) return agents.get(id)?.status === 'running'
        return sessions?.get(id) !== undefined
      },
      titleOf: (id) => {
        try {
          const table = projcache?.table
          if (table === undefined) return undefined
          const row = (table as unknown as { get?(k: string): { rows?: Record<string, { val?: unknown }> } }).get?.(id)
          const val = row?.rows?.['title']?.val
          return typeof val === 'string' && val !== '' ? val : undefined
        } catch {
          return undefined
        }
      },
    }

    /**
     * Live = the host still holds the session in memory (or its agent runs).
     * Moving the directory under a resident writer would corrupt it, so those
     * archives are hidden first and their files reclaimed by sweep() later.
     */
    const isLive = (id: string): boolean => {
      if (agents !== undefined && agents.get(id)?.status === 'running') return true
      try {
        return sessions?.get(id) !== undefined
      } catch {
        return true
      }
    }

    const ops = new ArchiveOps({
      store,
      disc,
      isLive,
      // Lazy: re-resolved per operation, so a registry created after us works.
      get registry() {
        return resolveWorkspaceRegistry(bag)
      },
      dropProjcache: (id) => deleteProjcacheEntry(projcache, id),
      restoreTitle: (id, title) => restoreProjcacheTitle(projcache, id, title),
    })

    const deps: RouteDeps = {
      store,
      disc,
      sessionsRoot: disc.sessionsRoot,
      archiveRoot,
      projcache,
      projcacheBytes: () => projcacheFileSize(),
      policy,
      ops,
      attachedIds: () => {
        // Only truly-running agents are protected from archive; idle sessions
        // that merely exist in the sessions store are archivable.
        const ids = new Set<string>()
        if (agents !== undefined) {
          for (const s of sessions?.list() ?? []) {
            if (agents.get(s.id)?.status === 'running') ids.add(s.id)
          }
        } else {
          for (const s of sessions?.list() ?? []) ids.add(s.id)
        }
        return ids
      },
    }

    const disposeRoutes = mountArchiveRoutes(host, ctx, deps)

    if (ops.degraded) {
      ctx.logger?.warn?.(
        '[dsh-knj-session-management] host workspace registry unavailable: archives move files only and the sidebar may keep showing them',
      )
    }

    // Boot work, in order: reclaim deferred moves from a previous run, then run
    // the auto-archive policy (idempotent, fail-soft).
    void (async () => {
      try {
        const swept = await ops.sweep()
        if (swept.moved > 0) {
          ctx.logger?.info?.(`[dsh-knj-session-management] reclaimed ${swept.moved} deferred archive move(s)`)
        }
        if (policy.enabled && policy.maxSessionsPerWorkspace > 0) {
          await runPolicy(deps)
        }
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-knj-session-management] boot maintenance failed: ${String(error)}`)
      }
    })()

    return () => {
      disposeRoutes()
    }
  })
}

/** Execute the policy: archive oldest over-cap sessions per workspace. */
export async function runPolicy(deps: RouteDeps): Promise<{ archived: number; pending: number; skipped: number }> {
  const ops = deps.ops ?? fileOnlyOps(deps)
  const { rows } = discoverSessions(deps.disc)
  ops.markHostArchived(rows)
  const selected = selectForArchive(rows, deps.policy)
  const batch = await ops.archiveRows(selected)
  return { archived: batch.archived, pending: batch.pending, skipped: batch.skipped }
}

function deleteProjcacheEntry(projcache: ProjcacheDeleter | undefined, sessionId: string): void {
  try {
    const table = projcache?.table
    if (table === undefined) return
    const result = table.delete(sessionId)
    if (result !== undefined && typeof (result as Promise<unknown>).catch === 'function') {
      ;(result as Promise<unknown>).catch(() => undefined)
    }
  } catch {
    /* fail-soft: a stale cache row costs volume only, never correctness */
  }
}

function restoreProjcacheTitle(projcache: ProjcacheDeleter | undefined, sessionId: string, title: string): void {
  try {
    const table = projcache?.table
    const put = table?.put
    if (table === undefined || put === undefined) return
    const existing = typeof table.get === 'function' ? table.get(sessionId) : undefined
    const identity = existing?.identity ?? { createdAt: Date.now() }
    const rows = {
      ...(existing?.rows ?? {}),
      title: { ver: 1, seq: Date.now(), val: title },
    }
    const result = put(sessionId, { identity, rows })
    if (result !== undefined && typeof (result as Promise<unknown>).catch === 'function') {
      ;(result as Promise<unknown>).catch(() => undefined)
    }
  } catch {
    /* fail-soft: title missing from cache only degrades display */
  }
}

function projcacheFileSize(): number {
  try {
    const p = join(defaultStoragesRoot(), 'session_projcache.json')
    return existsSync(p) ? statSync(p).size : 0
  } catch {
    return 0
  }
}

function argvProfile(): string | undefined {
  const argv = process.argv
  const flag = argv.indexOf('--profile')
  if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith('-')) return argv[flag + 1]
  return undefined
}

function defaultDshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function defaultDataDir(): string {
  const profile = argvProfile() ?? 'web'
  return join(defaultDshHome(), 'profiles', profile, 'dsh-session-archive' /* data-compat: 历史归档目录保持不变 */)
}

function defaultArchiveRoot(): string {
  return join(defaultDshHome(), 'archive-sessions')
}

function defaultSessionsRoot(): string {
  return join(defaultDshHome(), 'sessions')
}

function defaultStoragesRoot(): string {
  return join(defaultDshHome(), 'storages')
}
