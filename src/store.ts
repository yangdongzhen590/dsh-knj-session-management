/**
 * ArchiveStore: durable archive manifest (archive.json, atomic write) tracking
 * which sessions have been moved into the archive root and where they live, so
 * restore can map them back to their original sessions tree location.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { ArchiveRecord, ArchiveStoreFile } from './types.ts'

const ARCHIVE_FILE = 'archive.json'

export class ArchiveStore {
  private records: ArchiveRecord[] = []
  private loaded = false

  constructor(
    private readonly dataDir: string,
    private readonly archiveRoot: string,
  ) {
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(archiveRoot, { recursive: true })
  }

  private file(): string {
    return join(this.dataDir, ARCHIVE_FILE)
  }

  /** Load persisted records (idempotent; a corrupt file keeps an empty manifest). */
  load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!existsSync(this.file())) return
      const parsed = JSON.parse(readFileSync(this.file(), 'utf8')) as Partial<ArchiveStoreFile>
      const raw = Array.isArray(parsed.records) ? parsed.records : []
      this.records = raw.filter((r): r is ArchiveRecord => isArchiveRecord(r))
    } catch (error) {
      console.error('[dsh-knj-session-management] archive.json read failed (keeping in-memory state):', error)
      this.records = this.records ?? []
    }
  }

  list(): ArchiveRecord[] {
    this.load()
    return [...this.records]
  }

  get(sessionId: string): ArchiveRecord | undefined {
    this.load()
    return this.records.find((r) => r.sessionId === sessionId)
  }

  /** Record an archived session (replaces an existing record of the same id). */
  add(record: ArchiveRecord): void {
    this.load()
    this.records = this.records.filter((r) => r.sessionId !== record.sessionId)
    this.records.push(record)
    this.persist()
  }

  /** Remove the manifest record (after a restore or a permanent delete). */
  remove(sessionId: string): boolean {
    this.load()
    const before = this.records.length
    this.records = this.records.filter((r) => r.sessionId !== sessionId)
    if (this.records.length !== before) {
      this.persist()
      return true
    }
    return false
  }

  /** The archive directory for one record: <archiveRoot>/<workspaceKey>/<dirName>. */
  archiveDirOf(record: ArchiveRecord): string {
    return join(this.archiveRoot, record.workspaceKey, record.dirName)
  }

  /**
   * Backfill missing parentSessionId on legacy archive records (archived before
   * the tree-aware version) by reading each archived session's log header.
   * Persists only when something changed. Fail-soft per record.
   */
  backfillParents(): void {
    this.load()
    let changed = false
    for (const record of this.records) {
      if (record.parentSessionId !== undefined) continue
      const dir = this.archiveDirOf(record)
      const logPath = join(dir, 'session.jsonl')
      const zstdPath = join(dir, 'session.jsonl.zstd')
      const header = readArchiveHeader(existsSync(logPath) ? logPath : existsSync(zstdPath) ? zstdPath : undefined)
      const parent = header?.['parentSession']
      if (typeof parent === 'string' && parent !== '') {
        record.parentSessionId = parent
        changed = true
      }
    }
    if (changed) this.persist()
  }

  /** Atomic write: temp file + rename. A failed write keeps the old file. */
  private persist(): void {
    const payload: ArchiveStoreFile = { version: 1, records: this.records }
    const tmp = `${this.file()}.tmp`
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.file())
  }
}

function isArchiveRecord(value: unknown): value is ArchiveRecord {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Partial<ArchiveRecord>
  return (
    typeof r.sessionId === 'string' &&
    r.sessionId !== '' &&
    typeof r.workspaceKey === 'string' &&
    r.workspaceKey !== '' &&
    typeof r.dirName === 'string' &&
    r.dirName !== '' &&
    typeof r.archivedAt === 'number'
  )
}

/** Read the first (header) line of an archived session log, zstd-aware. */
function readArchiveHeader(logPath: string | undefined): Record<string, unknown> | undefined {
  if (logPath === undefined) return undefined
  try {
    const buf = readFileSync(logPath)
    const text = logPath.endsWith('.zstd')
      ? zstdDecompressSync(buf.subarray(0, Math.min(buf.length, 1 << 20))).toString('utf8')
      : buf.toString('utf8')
    const line = text.split('\n').find((l) => l.trim() !== '')
    return line === undefined ? undefined : (JSON.parse(line) as Record<string, unknown>)
  } catch {
    return undefined
  }
}
