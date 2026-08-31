/**
 * Filesystem operations for session archiving: discover persisted sessions
 * (mirroring the host's listArtifacts scan), move them between the sessions
 * tree and the archive root, restore, and permanently delete.
 *
 * The host's `sessionPersistence.list()` / `listSnapshots()` are preferred for
 * discovery when available (they read the header line of each log). We fall
 * back to our own directory scan so the plugin also sees `_no-cwd` sessions
 * that the host's cold-session list filters out.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, copyFileSync } from 'node:fs'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { ArchiveRecord, SessionRow, WorkspaceGroup } from './types.ts'
import { NO_CWD_DIR, NO_CWD_KEY } from './types.ts'

export interface SessionDiscovery {
  sessionsRoot: string
  archiveRoot: string
  /** True when a session id is currently attached (running) in the host. */
  isAttached(id: string): boolean
  /** Best-effort display title lookup (e.g. from the host's projection cache). */
  titleOf?(id: string): string | undefined
}

/**
 * Encode a cwd into the sessions-tree directory name — EXACT copy of the
 * host's projectKey (dsh-session-persistence-jsonl), so archive/restore map
 * to the same directories the host scans.
 */
export function projectKey(cwd: string | undefined): string {
  if (cwd === undefined) return NO_CWD_DIR
  if (cwd.length === 0) return NO_CWD_DIR
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** Display label for a workspace group: prefer the raw cwd path when available. */
export function projectLabel(key: string): string {
  if (key === NO_CWD_DIR || key === NO_CWD_KEY) return '未分组'
  return key.replace(/^--/, '').replace(/--$/, '')
}

export interface DiscoveredSession {
  sessionId: string
  dirName: string
  workspaceKey: string
  cwd?: string
  createdAt: number
  updatedAt: number
  sizeBytes: number
  title?: string
  /** Parent session id when this is a subagent (delegation) session. */
  parentSessionId?: string
  /** Host header delegation depth (0 = top-level). */
  delegationDepth?: number
}

/** Read the first (header) line of a session log, zstd-aware. */
export function readHeaderLine(logPath: string): Record<string, unknown> | undefined {
  try {
    const buf = readFileSync(logPath)
    let text: string
    if (logPath.endsWith('.zstd')) {
      // Read the first frame; the header line always fits in the first frame.
      const first = zstdDecompressSync(buf.subarray(0, Math.min(buf.length, 1 << 20)))
      text = first.toString('utf8')
    } else {
      text = buf.toString('utf8')
    }
    const line = text.split('\n').find((l) => l.trim() !== '')
    if (line === undefined) return undefined
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Parse the header into the fields we need. */
export function parseHeader(header: Record<string, unknown> | undefined, fallbackId: string): {
  id: string
  cwd?: string
  createdAt: number
  parentSessionId?: string
  delegationDepth?: number
} {
  if (header === undefined) return { id: fallbackId, createdAt: 0 }
  const id = typeof header['id'] === 'string' ? header['id'] : fallbackId
  const cwd = typeof header['cwd'] === 'string' ? header['cwd'] : undefined
  const createdAt = typeof header['createdAt'] === 'number' ? header['createdAt'] : 0
  const parentSessionId = typeof header['parentSession'] === 'string'
    ? header['parentSession']
    : typeof header['parentSessionId'] === 'string'
      ? header['parentSessionId']
      : undefined
  const delegationDepth = typeof header['delegationDepth'] === 'number' ? header['delegationDepth'] : undefined
  return { id, cwd, createdAt, parentSessionId, delegationDepth }
}

/**
 * Discover all persisted sessions by scanning the sessions tree. Returns both
 * the workspace groups and the per-session rows, newest-first within group.
 */
export function discoverSessions(disc: SessionDiscovery): { groups: WorkspaceGroup[]; rows: SessionRow[] } {
  const { sessionsRoot } = disc
  const groups = new Map<string, WorkspaceGroup>()
  const rows: SessionRow[] = []
  const attached = new Set<string>()

  let projectDirs: string[]
  try {
    projectDirs = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return { groups: [], rows: [] }
  }

  for (const projectName of projectDirs) {
    const projectPath = join(sessionsRoot, projectName)
    let sessionDirs: string[]
    try {
      sessionDirs = readdirSync(projectPath, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      continue
    }
    if (sessionDirs.length === 0) continue

    const isNoCwd = projectName === NO_CWD_DIR
    const groupKey = isNoCwd ? NO_CWD_KEY : projectName
    let group = groups.get(groupKey)
    if (group === undefined) {
      group = {
        key: groupKey,
        label: isNoCwd ? '未分组' : projectLabel(projectName),
        path: isNoCwd ? undefined : undefined, // filled from first row's cwd below
        sessionCount: 0,
        totalBytes: 0,
      }
      groups.set(groupKey, group)
    }

    for (const dirName of sessionDirs) {
      const sessionDir = join(projectPath, dirName)
      let sizeBytes = 0
      let logPath: string | undefined
      try {
        for (const f of readdirSync(sessionDir)) {
          if (f === 'session.jsonl' || f === 'session.jsonl.zstd') logPath = join(sessionDir, f)
          try {
            sizeBytes += statSync(join(sessionDir, f)).size
          } catch {
            /* ignore */
          }
        }
      } catch {
        continue
      }
      if (logPath === undefined) continue

      const header = readHeaderLine(logPath)
      const { id, cwd, createdAt, parentSessionId, delegationDepth } = parseHeader(header, dirName)
      const attachedFlag = disc.isAttached(id)
      if (attachedFlag) attached.add(id)

      // Title comes from the host's projection cache when available (header
      // has no title field); fall back to the header's own title if present.
      const headerTitle = typeof header?.['title'] === 'string' ? (header['title'] as string) : undefined
      const title = headerTitle ?? disc.titleOf?.(id)
      const updatedAt = createdAt // header carries createdAt; updatedAt approximated (see D6)
      const row: SessionRow = {
        sessionId: id,
        dirName,
        workspaceKey: groupKey,
        cwd,
        title,
        createdAt,
        updatedAt,
        running: attachedFlag,
        group: isNoCwd ? 'no-cwd' : groupDead(group, cwd),
        sizeBytes,
        ...parentSessionId === undefined ? {} : { parentSessionId },
        ...delegationDepth === undefined ? {} : { delegationDepth },
      }
      if (row.group === 'dead') row.deadReason = '工作区路径不存在'
      rows.push(row)
      group.sessionCount += 1
      group.totalBytes = (group.totalBytes ?? 0) + sizeBytes
      if (group.path === undefined && cwd !== undefined) group.path = cwd
    }
  }

  // Sort rows newest-first, then sort groups by total size descending.
  rows.sort((a, b) => b.updatedAt - a.updatedAt)
  const ordered = [...groups.values()].sort((a, b) => (b.totalBytes ?? 0) - (a.totalBytes ?? 0))
  return { groups: ordered, rows }
}

/** Classify a workspace group: dead when the cwd directory no longer exists. */
function groupDead(group: WorkspaceGroup, cwd: string | undefined): SessionRow['group'] {
  if (cwd === undefined) return 'no-cwd'
  try {
    return statSync(cwd).isDirectory() ? 'workspace' : 'dead'
  } catch {
    return 'dead'
  }
}

/**
 * Archive one session: move its directory from the sessions tree into the
 * archive root, and record the mapping. Returns the archive record.
 */
export function archiveSession(
  disc: SessionDiscovery,
  row: SessionRow,
  dirName: string,
): ArchiveRecord {
  const workspaceKey = row.group === 'no-cwd' ? NO_CWD_KEY : row.workspaceKey
  const srcDir = row.group === 'no-cwd'
    ? join(disc.sessionsRoot, NO_CWD_DIR, dirName)
    : join(disc.sessionsRoot, row.workspaceKey, dirName)
  const destDir = join(disc.archiveRoot, workspaceKey, dirName)

  if (!safeInside(disc.sessionsRoot, srcDir)) throw new Error('source session path escapes sessions root')
  if (!safeInside(disc.archiveRoot, destDir)) throw new Error('archive path escapes archive root')
  if (!existsSync(srcDir)) throw new Error(`session directory not found: ${srcDir}`)
  if (existsSync(destDir)) throw new Error(`archive destination already exists: ${destDir}`)

  mkdirSync(dirname(destDir), { recursive: true })
  moveDir(srcDir, destDir)

  return {
    sessionId: row.sessionId,
    workspaceKey,
    dirName,
    cwd: row.cwd,
    ...row.parentSessionId === undefined ? {} : { parentSessionId: row.parentSessionId },
    ...row.title === undefined ? {} : { title: row.title },
    archivedAt: Date.now(),
    sizeBytes: row.sizeBytes,
  }
}

/** Restore one archived session back into the sessions tree. */
export function restoreSession(disc: SessionDiscovery, record: ArchiveRecord): void {
  const archiveDir = join(disc.archiveRoot, record.workspaceKey, record.dirName)
  if (!safeInside(disc.archiveRoot, archiveDir)) throw new Error('archive path escapes archive root')
  if (!existsSync(archiveDir)) throw new Error(`archived session not found: ${archiveDir}`)

  const workspaceKey = record.workspaceKey === NO_CWD_KEY ? NO_CWD_DIR : record.workspaceKey
  const destDir = join(disc.sessionsRoot, workspaceKey, record.dirName)
  if (!safeInside(disc.sessionsRoot, destDir)) throw new Error('restore path escapes sessions root')
  if (existsSync(destDir)) throw new Error(`restore destination already exists: ${destDir}`)

  mkdirSync(dirname(destDir), { recursive: true })
  moveDir(archiveDir, destDir)
}

/** Permanently delete an archived session's directory. */
export function deleteArchiveDir(disc: SessionDiscovery, record: ArchiveRecord): void {
  const archiveDir = join(disc.archiveRoot, record.workspaceKey, record.dirName)
  if (!safeInside(disc.archiveRoot, archiveDir)) throw new Error('archive path escapes archive root')
  if (!existsSync(archiveDir)) return
  rmSync(archiveDir, { recursive: true, force: true })
}

/**
 * Collect the full session tree under a root session: the root itself plus
 * every descendant subagent (by parentSession), scanning the discovery rows.
 * @param rows - discovery rows (must include parentSessionId + dirName).
 * @param rootSessionId - the top-level session id.
 * @returns rows to archive/restore/delete together (root first, then descendants).
 */
export function collectSessionTree(rows: SessionRow[], rootSessionId: string): SessionRow[] {
  const byParent = new Map<string, SessionRow[]>()
  for (const row of rows) {
    if (row.parentSessionId === undefined) continue
    const list = byParent.get(row.parentSessionId)
    if (list === undefined) byParent.set(row.parentSessionId, [row])
    else list.push(row)
  }
  const result: SessionRow[] = []
  const visited = new Set<string>()
  const walk = (id: string): void => {
    if (visited.has(id)) return
    visited.add(id)
    const row = rows.find((r) => r.sessionId === id)
    if (row !== undefined) result.push(row)
    for (const child of byParent.get(id) ?? []) walk(child.sessionId)
  }
  walk(rootSessionId)
  return result
}

/**
 * Move a directory, falling back to copy+rm when src and dest are on
 * different volumes (Windows: rename across drives throws EXDEV). The design
 * contract (design.md D1/D3) requires this fallback so a user-configured
 * archiveRoot on another drive still works.
 */
function moveDir(src: string, dest: string): void {
  if (sameVolume(src, dest)) {
    renameSync(src, dest)
    return
  }
  copyDirRecursive(src, dest)
  rmSync(src, { recursive: true, force: true })
}

/** Whether two paths live on the same volume (drive/UNC root). Exported for tests. */
export function sameVolume(a: string, b: string): boolean {
  return parse(a).root === parse(b).root
}

function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dest, entry.name)
    if (entry.isDirectory()) copyDirRecursive(s, d)
    else copyFileSync(s, d)
  }
}

/** Guard: `child` must be strictly inside `root` (resolved, no traversal). */
export function safeInside(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child))
  return rel !== '' && !rel.startsWith('..' + sep) && rel !== '..' && !parse(rel).root
}
