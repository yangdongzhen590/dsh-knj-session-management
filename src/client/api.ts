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
}

export interface StatsView {
  projcacheBytes: number
  totalSessions: number
  archivedCount: number
  workspaceCount: number
}

export interface SessionListResponse {
  workspaces: WorkspaceGroupView[]
  sessions: SessionRowView[]
  archived: ArchiveRecordView[]
  stats: StatsView
}

export interface ArchiveResult {
  archived: number
  skipped: number
  skippedReasons: string[]
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

export function restoreSession(sessionId: string): Promise<{ restored: number; stats: StatsView }> {
  return api<{ restored: number; stats: StatsView }>('/dsh-knj-session-management/restore', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  })
}

export function deleteSession(sessionId: string): Promise<{ deleted: number; stats: StatsView }> {
  return api<{ deleted: number; stats: StatsView }>('/dsh-knj-session-management/delete', {
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
