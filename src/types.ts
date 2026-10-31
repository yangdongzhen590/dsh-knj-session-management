/**
 * Shared types for dsh-knj-session-management: session grouping, archive records,
 * and request/response shapes for the plugin routes.
 */

/** Session id / workspace key validation: alphanumerics and dashes only. */
export const SESSION_ID_RE = /^[0-9a-zA-Z-]{1,128}$/

/** Fixed placeholder workspace key for sessions with no cwd (`_no-cwd` source). */
export const NO_CWD_KEY = 'no-cwd'

/** The on-disk directory name DSH uses for sessions without a cwd. */
export const NO_CWD_DIR = '_no-cwd'

export interface SessionMeta {
  sessionId: string
  cwd?: string
  createdAt: number
  updatedAt: number
  /** Directory name under sessions/<workspaceKey>/ (may differ from sessionId for legacy entries). */
  dirName: string
  /** Group label used by the panel. */
  group: 'workspace' | 'dead' | 'no-cwd'
  /** Present when group === 'dead': why the cwd is unusable. */
  deadReason?: string
  sizeBytes?: number
  running: boolean
}

export interface ArchiveRecord {
  sessionId: string
  /** Workspace key used inside archive root (mirrors sessions layout; `no-cwd` for ungrouped). */
  workspaceKey: string
  /** Original directory name under sessions/<workspaceKey>/ (legacy entries may not equal sessionId). */
  dirName: string
  /** Original cwd if the header had one (for restore + display). */
  cwd?: string
  /** Parent session id when this archived member is a subagent (for tree restore/delete). */
  parentSessionId?: string
  /** Display title captured at archive time (may be absent on legacy records). */
  title?: string
  archivedAt: number
  sizeBytes?: number
  /**
   * True when the host already hides this session but its files still sit in
   * the sessions tree: the move is deferred (live session object, transient
   * IO error) and `ArchiveOps.sweep()` reclaims it later.
   */
  pendingMove?: boolean
  /** Why the move was deferred. `conflict` requires a human decision. */
  pendingReason?: 'live' | 'move-failed' | 'conflict'
  /** Underlying error text for `move-failed` / `conflict`. */
  pendingDetail?: string
}

export interface ArchiveStoreFile {
  version: 1
  records: ArchiveRecord[]
}

/** Session row returned by the list endpoint. */
export interface SessionRow {
  sessionId: string
  /** On-disk directory name under sessions/<workspaceKey>/ (legacy dirs may differ from id). */
  dirName: string
  /** Encoded workspace key (host-compatible projectKey; `no-cwd` for ungrouped). */
  workspaceKey: string
  cwd?: string
  title?: string
  createdAt: number
  updatedAt: number
  running: boolean
  group: 'workspace' | 'dead' | 'no-cwd'
  deadReason?: string
  sizeBytes?: number
  /** Parent session id when this is a subagent (delegation) session. */
  parentSessionId?: string
  /** Host header delegation depth (0 = top-level). */
  delegationDepth?: number
  /**
   * True when the host already lists this id as archived but its directory is
   * still in the sessions tree (archived before this plugin knew about the
   * host registry). The panel offers a one-click "finish archiving" action.
   */
  hostArchived?: boolean
}

/** Workspace group summary returned by the list endpoint. */
export interface WorkspaceGroup {
  key: string
  label: string
  path?: string
  dead?: boolean
  sessionCount: number
  totalBytes?: number
}

/** Reconciliation between the host's archive set and our on-disk records. */
export interface ArchiveDrift {
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

export interface SessionListResponse {
  workspaces: WorkspaceGroup[]
  sessions: SessionRow[]
  archived: ArchiveRecord[]
  /** Every session id the host currently hides (source of truth for visibility). */
  hostArchived: string[]
  drift: ArchiveDrift
  stats: {
    projcacheBytes: number
    totalSessions: number
    archivedCount: number
    workspaceCount: number
    /** Archive records whose files are still waiting to move. */
    pendingCount: number
    /** Sessions the host hides but this plugin has not filed yet. */
    hostArchivedCount: number
  }
}

export interface ArchiveResult {
  archived: number
  pending: number
  already: number
  skipped: number
  skippedReasons: string[]
  stats: SessionListResponse['stats']
}

/** Validate a session id / dir name candidate; returns the valid value or throws. */
export function validateSessionId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('sessionId must be a string')
  const trimmed = value.trim()
  if (!SESSION_ID_RE.test(trimmed)) throw new Error(`invalid sessionId '${value}': only [0-9a-zA-Z-], 1..128 chars`)
  return trimmed
}

/** Validate a workspace key candidate (archive-relative dir segment). */
export function validateWorkspaceKey(value: unknown): string {
  if (typeof value !== 'string') throw new Error('workspaceKey must be a string')
  const trimmed = value.trim()
  if (trimmed === '') throw new Error('workspaceKey must not be empty')
  if (!SESSION_ID_RE.test(trimmed) && trimmed !== NO_CWD_KEY) {
    throw new Error(`invalid workspaceKey '${value}': only [0-9a-zA-Z-], 1..128 chars`)
  }
  return trimmed
}

/** Approximate display title from a session row (client side may override). */
export function sessionTitle(row: { title?: string; sessionId: string }): string {
  const t = row.title?.trim()
  if (t !== undefined && t !== '') return t
  return `session ${row.sessionId.slice(0, 8)}`
}
