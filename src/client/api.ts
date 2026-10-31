/**
 * Thin fetch wrapper for the plugin's own routes.
 */

export interface ApiError {
  error?: string
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const body = (await response.json().catch(() => null)) as (T & ApiError) | null
  if (!response.ok) {
    throw new Error(body?.error ?? `HTTP ${response.status}`)
  }
  return body as T
}

export interface WorkspaceGroupView {
  key: string
  label: string
  path?: string
  dead?: boolean
  sessionCount: number
  totalBytes?: number
}

export interface SessionRowView {
  sessionId: string
  dirName: string
  workspaceKey: string
  cwd?: string
  title?: string
  createdAt: number
  updatedAt: number
  running: boolean
  group: 'workspace' | 'dead' | 'no-cwd'
  deadReason?: string
  sizeBytes?: number
  parentSessionId?: string
  delegationDepth?: number
  /** The host already hides this session but its files remain in the tree. */
  hostArchived?: boolean
}

export interface ArchiveRecordView {
  sessionId: string
  workspaceKey: string
  dirName: string
  cwd?: string
  title?: string
  parentSessionId?: string
  archivedAt: number
  sizeBytes?: number
  /** Files are still in the sessions tree; sweep() will finish the move. */
  pendingMove?: boolean
  pendingReason?: 'live' | 'move-failed' | 'conflict'
  pendingDetail?: string
}

export interface DriftView {
  pending: string[]
  conflict: string[]
  missing: string[]
  hostOnly: string[]
  storeOnly: string[]
}

export interface StatsView {
  projcacheBytes: number
  totalSessions: number
  archivedCount: number
  workspaceCount: number
  /** Archive records waiting for their directory move. */
  pendingCount: number
  /** Sessions the host hides that this plugin has not filed yet. */
  hostArchivedCount: number
}

export interface SessionListResponse {
  workspaces: WorkspaceGroupView[]
  sessions: SessionRowView[]
  archived: ArchiveRecordView[]
  hostArchived: string[]
  drift: DriftView
  stats: StatsView
}

export interface ArchiveResult {
  archived: number
  pending: number
  already: number
  skipped: number
  skippedReasons: string[]
  stats: StatsView
}

export interface SweepResult {
  moved: number
  skipped: number
  failed: number
  reasons: string[]
  stats: StatsView
}

export function listSessions(): Promise<SessionListResponse> {
  return api<SessionListResponse>('/dsh-knj-session-management/list')
}

export function archiveSession(sessionId: string): Promise<ArchiveResult> {
  return api<ArchiveResult>('/dsh-knj-session-management/archive', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  })
}

export function restoreSession(
  sessionId: string,
): Promise<{ restored: number; unarchived?: number; skipped?: number; skippedReasons?: string[]; stats: StatsView }> {
  return api('/dsh-knj-session-management/restore', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  })
}

export function deleteSession(
  sessionId: string,
): Promise<{ deleted: number; skipped?: number; skippedReasons?: string[]; stats: StatsView }> {
  return api('/dsh-knj-session-management/delete', {
    method: 'POST',
    body: JSON.stringify({ sessionId, confirm: true }),
  })
}

export function runPolicy(): Promise<ArchiveResult> {
  return api<ArchiveResult>('/dsh-knj-session-management/run-policy', {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export function sweep(): Promise<SweepResult> {
  return api<SweepResult>('/dsh-knj-session-management/sweep', {
    method: 'POST',
    body: JSON.stringify({}),
  })
}
