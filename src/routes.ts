/**
 * HTTP routes bridging the browser archive panel to the host. This layer only
 * parses requests, calls the discovery/archive operations, and serializes
 * responses. Security: every mutating route accepts same-origin POST only,
 * validates the session id against a whitelist, and requires `confirm: true`
 * for permanent deletion.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ArchiveStore } from './store.ts'
import type { SessionDiscovery } from './fs.ts'
import { archiveSession, collectSessionTree, deleteArchiveDir, discoverSessions, restoreSession } from './fs.ts'
import type { PolicyConfig } from './policy.ts'
import { selectForArchive } from './policy.ts'
import type { ArchiveRecord, ArchiveResult, SessionListResponse } from './types.ts'
import { NO_CWD_KEY, validateSessionId } from './types.ts'

export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

export interface ArchiveHost {
  webServer: WebServerService
}

const BASE = '/dsh-knj-session-management'
const MAX_BODY_BYTES = 64 * 1024

/** Minimal projection-cache surface (the host service's public table). */
export interface ProjcacheDeleter {
  table?: {
    delete(id: string): Promise<unknown> | unknown
    get?(key: string): { identity?: { createdAt?: number }; rows?: Record<string, { val?: unknown }> } | undefined
    put?(key: string, value: unknown): Promise<unknown> | unknown
  }
}

export interface RouteDeps {
  store: ArchiveStore
  disc: SessionDiscovery
  sessionsRoot: string
  archiveRoot: string
  projcache: ProjcacheDeleter | undefined
  projcacheBytes(): number
  policy: PolicyConfig
  attachedIds(): Set<string>
}

export function mountArchiveRoutes(host: ArchiveHost, _ctx: Context, deps: RouteDeps): () => void {
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = request.method ?? 'GET'
    try {
      // ---- GET /list ----
      if (path === `${BASE}/list` && method === 'GET') {
        const { groups, rows } = discoverSessions(deps.disc)
        const archived = deps.store.list().map((r) => ({ ...r }))
        const payload: SessionListResponse = {
          workspaces: groups,
          sessions: rows,
          archived,
          stats: {
            projcacheBytes: deps.projcacheBytes(),
            totalSessions: rows.length,
            archivedCount: archived.length,
            workspaceCount: groups.length,
          },
        }
        return sendJson(response, 200, payload)
      }

      // ---- POST /archive {sessionId} ----
      if (path === `${BASE}/archive` && method === 'POST') {
        if (!sameOrigin(request)) return sendJson(response, 403, { error: 'untrusted origin / 非可信来源' })
        const body = await readJsonBody(request)
        const sessionId = validateSessionId((body as { sessionId?: unknown })?.sessionId)
        const { rows } = discoverSessions(deps.disc)
        const row = rows.find((r) => r.sessionId === sessionId)
        if (row === undefined) return sendJson(response, 404, { error: `session not found: ${sessionId}` })
        if (row.running || deps.attachedIds().has(sessionId)) {
          return sendJson(response, 409, { error: 'session is running / 会话正在运行' })
        }
        // Archive the whole tree: root + all descendant subagents.
        const tree = collectSessionTree(rows, sessionId)
        const skippedReasons: string[] = []
        let archived = 0
        for (const member of tree) {
          try {
            const record = archiveSession(deps.disc, member, member.dirName)
            deps.store.add(record)
            deleteProjcacheEntry(deps, member.sessionId)
            archived += 1
          } catch (error) {
            skippedReasons.push(`${member.sessionId}: ${String(error)}`)
          }
        }
        const result: ArchiveResult = {
          archived,
          skipped: tree.length - archived,
          skippedReasons,
          stats: freshStats(deps),
        }
        return sendJson(response, 200, result)
      }

      // ---- POST /restore {sessionId} ----
      if (path === `${BASE}/restore` && method === 'POST') {
        if (!sameOrigin(request)) return sendJson(response, 403, { error: 'untrusted origin / 非可信来源' })
        const body = await readJsonBody(request)
        const sessionId = validateSessionId((body as { sessionId?: unknown })?.sessionId)
        const records = treeRecords(deps, sessionId)
        if (records.length === 0) return sendJson(response, 404, { error: `archived session not found: ${sessionId}` })
        let restored = 0
        for (const record of records) {
          try {
            restoreSession(deps.disc, record)
            deps.store.remove(record.sessionId)
            // Write the captured title back into the projection cache so the
            // restored session shows its title again (archiving deleted the
            // projcache record, which was the title's live source).
            if (record.title !== undefined && record.title !== '') {
              restoreProjcacheTitle(deps, record.sessionId, record.title)
            }
            restored += 1
          } catch {
            /* keep going; a failed member leaves its archive record in place */
          }
        }
        return sendJson(response, 200, { restored, stats: freshStats(deps) })
      }

      // ---- POST /delete {sessionId, confirm: true} ----
      if (path === `${BASE}/delete` && method === 'POST') {
        if (!sameOrigin(request)) return sendJson(response, 403, { error: 'untrusted origin / 非可信来源' })
        const body = await readJsonBody(request)
        const sessionId = validateSessionId((body as { sessionId?: unknown })?.sessionId)
        if ((body as { confirm?: unknown })?.confirm !== true) {
          return sendJson(response, 400, { error: 'deletion requires confirm: true / 删除需二次确认' })
        }
        const records = treeRecords(deps, sessionId)
        if (records.length === 0) return sendJson(response, 404, { error: `archived session not found: ${sessionId}` })
        if (deps.attachedIds().has(sessionId)) {
          return sendJson(response, 409, { error: 'session is running / 会话正在运行' })
        }
        let deleted = 0
        for (const record of records) {
          try {
            deleteArchiveDir(deps.disc, record)
            deps.store.remove(record.sessionId)
            deleteProjcacheEntry(deps, record.sessionId)
            deleted += 1
          } catch {
            /* keep going */
          }
        }
        return sendJson(response, 200, { deleted, stats: freshStats(deps) })
      }

      // ---- POST /run-policy (idempotent) ----
      if (path === `${BASE}/run-policy` && method === 'POST') {
        if (!sameOrigin(request)) return sendJson(response, 403, { error: 'untrusted origin / 非可信来源' })
        const { rows } = discoverSessions(deps.disc)
        const selected = selectForArchive(rows, deps.policy)
        let archived = 0
        const skippedReasons: string[] = []
        for (const row of selected) {
          try {
            const record = archiveSession(deps.disc, row, row.dirName)
            deps.store.add(record)
            deleteProjcacheEntry(deps, row.sessionId)
            archived += 1
          } catch (error) {
            skippedReasons.push(`${row.sessionId}: ${String(error)}`)
          }
        }
        const result: ArchiveResult = {
          archived,
          skipped: selected.length - archived,
          skippedReasons,
          stats: freshStats(deps),
        }
        return sendJson(response, 200, result)
      }

      return sendJson(response, 404, { error: `no such route: ${method} ${path}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return sendJson(response, 400, { error: message })
    }
  }

  const disposer = host.webServer.register({
    kind: 'prefix',
    path: BASE,
    handler,
  })

  return () => {
    disposer()
  }
}

/**
 * Gather the archive records of a full session tree for restore/delete,
 * rebuilt purely from the manifest (each archived record stores its
 * parentSessionId), so it works even after members moved out of the live
 * sessions tree.
 */
function treeRecords(deps: RouteDeps, sessionId: string): ArchiveRecord[] {
  const archived = deps.store.list()
  const rootRecord = archived.find((r) => r.sessionId === sessionId)
  if (rootRecord === undefined) return []
  const children = new Map<string, ArchiveRecord[]>()
  for (const rec of archived) {
    if (rec.parentSessionId === undefined) continue
    const list = children.get(rec.parentSessionId)
    if (list === undefined) children.set(rec.parentSessionId, [rec])
    else list.push(rec)
  }
  const result: ArchiveRecord[] = [rootRecord]
  const visited = new Set([sessionId])
  const queue = [...(children.get(sessionId) ?? [])]
  while (queue.length > 0) {
    const rec = queue.shift()!
    if (visited.has(rec.sessionId)) continue
    visited.add(rec.sessionId)
    result.push(rec)
    for (const child of children.get(rec.sessionId) ?? []) queue.push(child)
  }
  return result
}

function deleteProjcacheEntry(deps: RouteDeps, sessionId: string): void {
  try {
    const table = deps.projcache?.table
    if (table === undefined) return
    const result = table.delete(sessionId)
    if (result !== undefined && typeof (result as Promise<unknown>).catch === 'function') {
      ;(result as Promise<unknown>).catch(() => undefined)
    }
  } catch {
    /* fail-soft: a stale cache row costs volume only, never correctness */
  }
}

/**
 * Write a restored session's captured title back into the projection cache so
 * the host UI and our panel show it again. The row shape mirrors what the
 * session-title projection unit persists ({ver, seq, val: string}).
 */
function restoreProjcacheTitle(deps: RouteDeps, sessionId: string, title: string): void {
  try {
    const table = deps.projcache?.table
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

function freshStats(deps: RouteDeps): SessionListResponse['stats'] {
  const { groups, rows } = discoverSessions(deps.disc)
  return {
    projcacheBytes: deps.projcacheBytes(),
    totalSessions: rows.length,
    archivedCount: deps.store.list().length,
    workspaceCount: groups.length,
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

/** Reject cross-origin writes; a missing Origin (curl, same-origin navigation) passes. */
function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (origin === undefined) return true
  const host = request.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large / 请求体过大')
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('invalid JSON body / JSON 解析失败')
  }
}
