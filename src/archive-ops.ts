/**
 * ArchiveOps — the single owner of what "archive" means in this plugin.
 *
 * Contract (docs/adr/0001-host-authoritative-archive.md):
 *  1. VISIBILITY truth lives in the host workspace registry. Its
 *     `archivedSessionIds` set is the only switch the left sidebar filters on
 *     (`sessionVisible()`), so every archive/restore must go through it.
 *  2. DISK truth lives here: a session is physically archived only when its
 *     directory moved from the sessions tree into the archive root.
 *  3. Registry first, then disk. `archiveSession()` refuses sessions that are
 *     neither live nor persisted, so the move must happen *after* the host
 *     call; when the move cannot run yet (the session object is still live,
 *     transient EBUSY/EPERM) the host archive still stands and the record is
 *     marked `pendingMove` — hidden immediately, reclaimed later by `sweep()`.
 *  4. Restore is the mirror image: move the directory back first, then clear
 *     the host mark. Delete clears the host mark too, so no dangling id stays
 *     in `archivedSessionIds`.
 *
 * The class is host-agnostic (pure ports + the filesystem) so every branch is
 * node-testable without booting DSH.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ArchiveStore } from './store.ts'
import { archiveSession, collectSessionTree, deleteArchiveDir, restoreSession } from './fs.ts'
import type { SessionDiscovery } from './fs.ts'
import type { ArchiveRecord, SessionRow } from './types.ts'
import { NO_CWD_DIR, NO_CWD_KEY } from './types.ts'
import { archivedIdSet, type WorkspaceRegistryPort } from './host-registry.ts'

export type ArchiveStatus = 'archived' | 'pending' | 'skipped' | 'already'

export interface ArchiveOutcome {
  sessionId: string
  status: ArchiveStatus
  /** Human-readable cause for `pending` / `skipped`. */
  reason?: string
}

export interface BatchOutcome {
  archived: number
  pending: number
  already: number
  skipped: number
  skippedReasons: string[]
  outcomes: ArchiveOutcome[]
}

export interface RestoreOutcome {
  sessionId: string
  /** `unarchived` = host-only archive (files never left the sessions tree). */
  status: 'restored' | 'unarchived' | 'not-found' | 'failed'
  /** Failure cause, or a non-fatal warning (files restored but the host mark stayed). */
  reason?: string
}

export interface DeleteOutcome {
  sessionId: string
  status: 'deleted' | 'blocked' | 'not-found' | 'failed'
  reason?: string
}

export interface SweepOutcome {
  moved: number
  skipped: number
  failed: number
  reasons: string[]
}

export interface DriftReport {
  /** Archived per the host, but still sitting in the sessions tree. */
  pending: string[]
  /** Pending records that cannot converge without manual help. */
  conflict: string[]
  /** Records whose directory exists in neither tree. */
  missing: string[]
  /** Registry ids this plugin holds no record for (host archived them alone). */
  hostOnly: string[]
  /** Our records the registry no longer considers archived. */
  storeOnly: string[]
}

/** Everything ArchiveOps needs from the host, injected so tests can fake it. */
export interface ArchiveOpsDeps {
  store: ArchiveStore
  disc: SessionDiscovery
  /** Absent on hosts without a workspace registry (degraded file-only mode). */
  registry?: WorkspaceRegistryPort
  /** True while the host still holds a live Session object for this id. */
  isLive(sessionId: string): boolean
  /** Drop the projection-cache row (title/size cache) for a moved session. */
  dropProjcache?(sessionId: string): void
  /** Write a captured title back into the projection cache after a restore. */
  restoreTitle?(sessionId: string, title: string): void
}

export class ArchiveOps {
  private readonly deps: ArchiveOpsDeps

  constructor(deps: ArchiveOpsDeps) {
    this.deps = deps
  }

  /** True when the host cannot track archive visibility (old host). */
  get degraded(): boolean {
    return this.deps.registry === undefined
  }

  /** Snapshot of the host's archive set. */
  hostArchivedIds(): Set<string> {
    return archivedIdSet(this.deps.registry)
  }

  /** Flag rows the host already considers archived but whose files remain. */
  markHostArchived(rows: SessionRow[]): void {
    const hostIds = this.hostArchivedIds()
    if (hostIds.size === 0) return
    for (const row of rows) {
      if (hostIds.has(row.sessionId)) row.hostArchived = true
    }
  }

  /** Archive one root session and every descendant subagent session. */
  async archiveTree(rows: SessionRow[], rootSessionId: string): Promise<BatchOutcome> {
    return await this.archiveRows(collectSessionTree(rows, rootSessionId))
  }

  async archiveRows(rows: SessionRow[]): Promise<BatchOutcome> {
    const batch: BatchOutcome = {
      archived: 0,
      pending: 0,
      already: 0,
      skipped: 0,
      skippedReasons: [],
      outcomes: [],
    }
    for (const row of rows) {
      const outcome = await this.archiveRow(row)
      batch.outcomes.push(outcome)
      switch (outcome.status) {
        case 'archived':
          batch.archived += 1
          break
        case 'pending':
          batch.pending += 1
          break
        case 'already':
          batch.already += 1
          break
        default:
          batch.skipped += 1
          batch.skippedReasons.push(`${outcome.sessionId}: ${outcome.reason ?? 'skipped'}`)
          break
      }
    }
    return batch
  }

  /**
   * Archive one session: host mark first (visibility), then the directory move.
   *
   * A session already archived on disk is a no-op. A session the host already
   * archived (host-only archive) skips the host call and only completes the
   * move — that is the "补落盘" path for sessions archived before this fix.
   */
  async archiveRow(row: SessionRow): Promise<ArchiveOutcome> {
    const existing = this.deps.store.get(row.sessionId)
    if (existing !== undefined && existing.pendingMove !== true) {
      return { sessionId: row.sessionId, status: 'already', reason: '已在归档区' }
    }

    const registry = this.deps.registry
    if (registry !== undefined && !archivedIdSet(registry).has(row.sessionId)) {
      try {
        // stopActivity: the caller already refused running sessions; this only
        // makes sure a paused-but-idle turn cannot resume mid-move.
        await registry.archiveSession(row.sessionId, { stopActivity: true })
      } catch (error) {
        return {
          sessionId: row.sessionId,
          status: 'skipped',
          reason: `宿主归档失败: ${cause(error)}`,
        }
      }
    }

    return this.moveIntoArchive(row, existing)
  }

  /** Move one session's directory; downgrade to a pending record when unsafe. */
  private moveIntoArchive(row: SessionRow, existing: ArchiveRecord | undefined): ArchiveOutcome {
    if (this.deps.isLive(row.sessionId)) {
      this.rememberPending(row, existing, 'live')
      return {
        sessionId: row.sessionId,
        status: 'pending',
        reason: '会话仍处于打开状态，已先从列表隐藏，文件待回收',
      }
    }
    try {
      const record = archiveSession(this.deps.disc, row, row.dirName)
      this.deps.store.add(record)
      this.deps.dropProjcache?.(row.sessionId)
      return { sessionId: row.sessionId, status: 'archived' }
    } catch (error) {
      const reason = cause(error)
      // "archive destination already exists" means a duplicate copy — never
      // delete either side; surface it as a conflict for manual review. Every
      // other failure (EBUSY/EPERM/transient IO) is retryable.
      const conflict = /already exists/i.test(reason)
      this.rememberPending(row, existing, conflict ? 'conflict' : 'move-failed', reason)
      return { sessionId: row.sessionId, status: conflict ? 'skipped' : 'pending', reason }
    }
  }

  private rememberPending(
    row: SessionRow,
    existing: ArchiveRecord | undefined,
    pendingReason: NonNullable<ArchiveRecord['pendingReason']>,
    pendingDetail?: string,
  ): void {
    this.deps.store.add(pendingRecord(row, existing, pendingReason, pendingDetail))
  }

  /**
   * Restore one session: move the directory back, then clear the host mark.
   * A record without a move (pending) only needs the host mark cleared.
   * Without a record, a host-only archive is simply unarchived.
   */
  async restore(sessionId: string): Promise<RestoreOutcome> {
    const record = this.deps.store.get(sessionId)
    if (record !== undefined) {
      if (record.pendingMove !== true) {
        try {
          restoreSession(this.deps.disc, record)
        } catch (error) {
          return { sessionId, status: 'failed', reason: cause(error) }
        }
      }
      this.deps.store.remove(sessionId)
      const warning = await this.unarchive(sessionId)
      if (record.title !== undefined && record.title !== '') {
        this.deps.restoreTitle?.(sessionId, record.title)
      }
      return warning === undefined
        ? { sessionId, status: 'restored' }
        : { sessionId, status: 'restored', reason: `文件已恢复，但宿主归档标记未清除: ${warning}` }
    }

    if (this.deps.registry !== undefined && archivedIdSet(this.deps.registry).has(sessionId)) {
      const warning = await this.unarchive(sessionId)
      if (warning !== undefined) return { sessionId, status: 'failed', reason: warning }
      return { sessionId, status: 'unarchived' }
    }
    return { sessionId, status: 'not-found' }
  }

  /** Permanently delete an archived session (files + host mark). */
  async purge(sessionId: string): Promise<DeleteOutcome> {
    const record = this.deps.store.get(sessionId)
    if (record === undefined) return { sessionId, status: 'not-found' }
    if (record.pendingMove === true) {
      return {
        sessionId,
        status: 'blocked',
        reason: '文件仍在会话目录中（待回收）；请先完成回收再删除',
      }
    }
    try {
      deleteArchiveDir(this.deps.disc, record)
    } catch (error) {
      return { sessionId, status: 'failed', reason: cause(error) }
    }
    this.deps.store.remove(sessionId)
    this.deps.dropProjcache?.(sessionId)
    const warning = await this.unarchive(sessionId)
    return warning === undefined
      ? { sessionId, status: 'deleted' }
      : { sessionId, status: 'deleted', reason: `文件已删除，但宿主归档标记未清除: ${warning}` }
  }

  /**
   * Retry every retryable pending record: a session that stopped being live
   * (typically after a restart) now moves into the archive root. Conflicts are
   * left alone — they need a human decision.
   */
  async sweep(): Promise<SweepOutcome> {
    const report: SweepOutcome = { moved: 0, skipped: 0, failed: 0, reasons: [] }
    for (const record of this.deps.store.list()) {
      if (record.pendingMove !== true) continue
      if (record.pendingReason === 'conflict') {
        report.skipped += 1
        report.reasons.push(`${record.sessionId}: 归档目标已存在，需人工处理`)
        continue
      }
      if (this.deps.isLive(record.sessionId)) {
        report.skipped += 1
        continue
      }
      try {
        archiveSession(this.deps.disc, rowFromRecord(record), record.dirName)
        this.deps.store.add(settledRecord(record))
        this.deps.dropProjcache?.(record.sessionId)
        report.moved += 1
      } catch (error) {
        const reason = cause(error)
        report.failed += 1
        report.reasons.push(`${record.sessionId}: ${reason}`)
        if (/already exists/i.test(reason)) {
          this.deps.store.add({ ...record, pendingReason: 'conflict', pendingDetail: reason })
        }
      }
    }
    return report
  }

  /** Reconciliation snapshot for /list (never mutates anything). */
  drift(): DriftReport {
    const hostIds = this.hostArchivedIds()
    const report: DriftReport = { pending: [], conflict: [], missing: [], hostOnly: [], storeOnly: [] }
    const known = new Set<string>()
    for (const record of this.deps.store.list()) {
      known.add(record.sessionId)
      if (record.pendingMove === true) {
        report.pending.push(record.sessionId)
        if (record.pendingReason === 'conflict') report.conflict.push(record.sessionId)
        continue
      }
      const dir = join(this.deps.disc.archiveRoot, record.workspaceKey, record.dirName)
      if (!existsSync(dir)) report.missing.push(record.sessionId)
      if (this.deps.registry !== undefined && !hostIds.has(record.sessionId)) {
        report.storeOnly.push(record.sessionId)
      }
    }
    if (this.deps.registry !== undefined) {
      for (const id of hostIds) {
        if (!known.has(id)) report.hostOnly.push(id)
      }
    }
    return report
  }

  private async unarchive(sessionId: string): Promise<string | undefined> {
    const registry = this.deps.registry
    if (registry === undefined) return undefined
    try {
      await registry.unarchiveSession(sessionId)
      return undefined
    } catch (error) {
      return cause(error)
    }
  }
}

/** Build a pending record from a live discovery row (no directory moved). */
function pendingRecord(
  row: SessionRow,
  existing: ArchiveRecord | undefined,
  pendingReason: NonNullable<ArchiveRecord['pendingReason']>,
  pendingDetail: string | undefined,
): ArchiveRecord {
  const record: ArchiveRecord = {
    sessionId: row.sessionId,
    workspaceKey: row.group === 'no-cwd' ? NO_CWD_KEY : row.workspaceKey,
    dirName: row.dirName,
    archivedAt: existing?.archivedAt ?? Date.now(),
    pendingMove: true,
    pendingReason,
  }
  if (row.cwd !== undefined) record.cwd = row.cwd
  if (row.parentSessionId !== undefined) record.parentSessionId = row.parentSessionId
  if (row.title !== undefined) record.title = row.title
  if (row.sizeBytes !== undefined) record.sizeBytes = row.sizeBytes
  if (pendingDetail !== undefined) record.pendingDetail = pendingDetail
  return record
}

/** Rebuild the discovery row a pending record refers to, for the retry move. */
function rowFromRecord(record: ArchiveRecord): SessionRow {
  const noCwd = record.workspaceKey === NO_CWD_KEY
  const row: SessionRow = {
    sessionId: record.sessionId,
    dirName: record.dirName,
    workspaceKey: noCwd ? NO_CWD_DIR : record.workspaceKey,
    createdAt: record.archivedAt,
    updatedAt: record.archivedAt,
    running: false,
    group: noCwd ? 'no-cwd' : 'workspace',
  }
  if (record.cwd !== undefined) row.cwd = record.cwd
  if (record.title !== undefined) row.title = record.title
  if (record.parentSessionId !== undefined) row.parentSessionId = record.parentSessionId
  if (record.sizeBytes !== undefined) row.sizeBytes = record.sizeBytes
  return row
}

/** Drop the pending markers once the directory really moved. */
function settledRecord(record: ArchiveRecord): ArchiveRecord {
  const settled: ArchiveRecord = { ...record }
  delete settled.pendingMove
  delete settled.pendingReason
  delete settled.pendingDetail
  return settled
}

function cause(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
