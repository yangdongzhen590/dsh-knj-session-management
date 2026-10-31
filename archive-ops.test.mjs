/**
 * Red/green tests for the host-authoritative archive change
 * (docs/adr/0001-host-authoritative-archive.md).
 *
 * Run: node --test archive-ops.test.mjs
 *
 * They import the TypeScript sources directly (Node >= 22.18 strips types), so
 * no build step is needed to see them fail or pass.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { ArchiveStore } from './src/store.ts'
import { discoverSessions, pickLogFile } from './src/fs.ts'
import { ArchiveOps } from './src/archive-ops.ts'
import { mountArchiveRoutes } from './src/routes.ts'
import { archivedIdSet, resolveWorkspaceRegistry } from './src/host-registry.ts'
import { NO_CWD_KEY } from './src/types.ts'

const DAY = 24 * 60 * 60 * 1000

function mkHome() {
  const root = mkdtempSync(join(tmpdir(), 'dshsa-'))
  const sessionsRoot = join(root, 'sessions')
  const archiveRoot = join(root, 'archive-sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  mkdirSync(archiveRoot, { recursive: true })
  return {
    root,
    sessionsRoot,
    archiveRoot,
    discovery: (over = {}) => ({ sessionsRoot, archiveRoot, isAttached: () => false, ...over }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** Write a generation-1 (v0) plain log. */
function writeV0(dir, header) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.jsonl'), JSON.stringify(header) + '\n')
}

/** Write a current-generation (v4) compressed log, like the host does. */
function writeV4(dir, header) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n')))
}

/** Fake host workspace registry recording calls and order. */
function fakeRegistry(initialIds = [], hooks = {}) {
  const ids = new Set(initialIds)
  const calls = []
  return {
    calls,
    get archivedSessionIds() {
      return [...ids]
    },
    async archiveSession(id, options) {
      calls.push(['archive', id, options?.stopActivity === true])
      hooks.onArchive?.(id)
      ids.add(id)
    },
    async unarchiveSession(id) {
      calls.push(['unarchive', id])
      hooks.onUnarchive?.(id)
      ids.delete(id)
    },
  }
}

test('pickLogFile prefers the newest generation, then the compressed form', () => {
  assert.equal(pickLogFile(['session.jsonl', 'session.v4.jsonl.zstd']), 'session.v4.jsonl.zstd')
  assert.equal(pickLogFile(['session.v4.jsonl', 'session.v4.jsonl.zstd']), 'session.v4.jsonl.zstd')
  assert.equal(pickLogFile(['session.jsonl', 'session.jsonl.zstd']), 'session.jsonl.zstd')
  assert.equal(pickLogFile(['session.v12.jsonl', 'session.v9.jsonl.zstd']), 'session.v12.jsonl')
  assert.equal(pickLogFile(['notes.txt', 'events.jsonl']), undefined)
  assert.equal(pickLogFile([]), undefined)
})

test('discoverSessions finds sessions whose log uses the current generation name', () => {
  const home = mkHome()
  try {
    const cwd = 'D:\\workspace\\proj1'
    writeV4(join(home.sessionsRoot, '--D-workspace-proj1--', 'session-v4'), {
      id: 'session-v4',
      cwd,
      createdAt: Date.now() - 5 * DAY,
      title: 'current generation',
    })
    const { rows } = discoverSessions(home.discovery())
    assert.equal(rows.length, 1)
    assert.equal(rows[0].sessionId, 'session-v4')
    assert.equal(rows[0].title, 'current generation')
    assert.ok((rows[0].sizeBytes ?? 0) > 0)
  } finally {
    home.cleanup()
  }
})

test('discoverSessions keeps reading legacy (v0) sessions', () => {
  const home = mkHome()
  try {
    const cwd = 'D:\\workspace\\proj1'
    writeV0(join(home.sessionsRoot, '--D-workspace-proj1--', 'session-v0'), {
      id: 'session-v0',
      cwd,
      createdAt: Date.now() - 5 * DAY,
    })
    const { rows } = discoverSessions(home.discovery())
    assert.equal(rows.length, 1)
    assert.equal(rows[0].sessionId, 'session-v0')
  } finally {
    home.cleanup()
  }
})

test('updatedAt comes from the log mtime, not the session birth time', () => {
  const home = mkHome()
  try {
    const createdAt = Date.now() - 30 * DAY
    const dir = join(home.sessionsRoot, '--D-workspace-proj1--', 'session-old')
    writeV0(dir, { id: 'session-old', cwd: 'D:\\workspace\\proj1', createdAt })
    const touched = Date.now() - 3 * 60 * 1000
    utimesSync(join(dir, 'session.jsonl'), new Date(touched), new Date(touched))
    const { rows } = discoverSessions(home.discovery())
    assert.equal(rows.length, 1)
    assert.equal(rows[0].createdAt, createdAt)
    assert.ok(rows[0].updatedAt > createdAt, 'updatedAt must follow the log mtime')
    assert.ok(Math.abs(rows[0].updatedAt - touched) < 5000, `updatedAt ~ mtime, got ${rows[0].updatedAt}`)
  } finally {
    home.cleanup()
  }
})

test('archiveRow marks the host first, then moves the directory', async () => {
  const home = mkHome()
  try {
    const dir = join(home.sessionsRoot, '--D-workspace-proj1--', 'session-a')
    writeV0(dir, { id: 'session-a', cwd: 'D:\\workspace\\proj1', createdAt: Date.now() - 10 * DAY })
    let existedDuringHostCall
    const registry = fakeRegistry([], { onArchive: () => { existedDuringHostCall = existsSync(dir) } })
    const store = new ArchiveStore(join(home.root, 'state'), home.archiveRoot)
    store.load()

    const ops = new ArchiveOps({
      store,
      disc: home.discovery(),
      registry,
      isLive: () => false,
    })
    const row = discoverSessions(home.discovery()).rows[0]
    const outcome = await ops.archiveRow(row)

    assert.equal(outcome.status, 'archived')
    assert.equal(existedDuringHostCall, true, 'the host call must happen while the log still exists')
    assert.deepEqual(registry.calls[0], ['archive', 'session-a', true])
    assert.equal(existsSync(dir), false, 'source directory must be gone')
    assert.ok(store.get('session-a') !== undefined)
    assert.ok(existsSync(join(home.archiveRoot, store.get('session-a').workspaceKey, 'session-a')))
  } finally {
    home.cleanup()
  }
})

test('a live session is hidden first and its files are reclaimed by sweep()', async () => {
  const home = mkHome()
  try {
    const dir = join(home.sessionsRoot, '--D-workspace-proj1--', 'session-live')
    writeV0(dir, { id: 'session-live', cwd: 'D:\\workspace\\proj1', createdAt: Date.now() - 10 * DAY })
    const registry = fakeRegistry()
    const store = new ArchiveStore(join(home.root, 'state'), home.archiveRoot)
    store.load()
    const ops = new ArchiveOps({ store, disc: home.discovery(), registry, isLive: () => true })
    const row = discoverSessions(home.discovery()).rows[0]

    const outcome = await ops.archiveRow(row)
    assert.equal(outcome.status, 'pending')
    assert.deepEqual(registry.calls, [['archive', 'session-live', true]], 'visibility still flips at once')
    assert.ok(existsSync(dir), 'files stay put while the session object is live')
    assert.equal(store.get('session-live').pendingMove, true)
    assert.equal(store.get('session-live').pendingReason, 'live')

    // After a restart nothing is live any more: the sweep reclaims the files.
    const afterRestart = new ArchiveOps({ store, disc: home.discovery(), registry, isLive: () => false })
    const swept = await afterRestart.sweep()
    assert.equal(swept.moved, 1)
    assert.equal(existsSync(dir), false)
    const record = new ArchiveStore(join(home.root, 'state'), home.archiveRoot)
    record.load()
    assert.equal(record.get('session-live').pendingMove, undefined)
  } finally {
    home.cleanup()
  }
})

test('restore moves the files back first, then clears the host mark', async () => {
  const home = mkHome()
  try {
    const dir = join(home.sessionsRoot, '--D-workspace-proj1--', 'session-r')
    writeV0(dir, { id: 'session-r', cwd: 'D:\\workspace\\proj1', createdAt: Date.now() - 10 * DAY })
    const registry = fakeRegistry()
    const store = new ArchiveStore(join(home.root, 'state'), home.archiveRoot)
    store.load()
    const ops = new ArchiveOps({ store, disc: home.discovery(), registry, isLive: () => false })
    const row = discoverSessions(home.discovery()).rows[0]
    assert.equal((await ops.archiveRow(row)).status, 'archived')

    let restoredOnDiskDuringUnarchive
    registry.calls.length = 0
    const restoreOps = new ArchiveOps({
      store,
      disc: home.discovery(),
      registry,
      isLive: () => false,
    })
    registry.calls.length = 0
    const originalUnarchive = registry.unarchiveSession
    registry.unarchiveSession = async (id) => {
      restoredOnDiskDuringUnarchive = existsSync(join(home.sessionsRoot, '--D-workspace-proj1--', id))
      return await originalUnarchive(id)
    }
    const outcome = await restoreOps.restore('session-r')
    assert.equal(outcome.status, 'restored')
    assert.equal(restoredOnDiskDuringUnarchive, true, 'files must be back before the host mark is cleared')
    assert.deepEqual(registry.calls, [['unarchive', 'session-r']])
    assert.equal(existsSync(join(home.sessionsRoot, '--D-workspace-proj1--', 'session-r')), true)
    assert.equal(store.get('session-r'), undefined)
    assert.deepEqual([...archivedIdSet(registry)], [])
  } finally {
    home.cleanup()
  }
})

test('restore of a host-only archive just clears the mark', async () => {
  const home = mkHome()
  try {
    const registry = fakeRegistry(['session-legacy'])
    const store = new ArchiveStore(join(home.root, 'state'), home.archiveRoot)
    store.load()
    const ops = new ArchiveOps({ store, disc: home.discovery(), registry, isLive: () => false })
    const outcome = await ops.restore('session-legacy')
    assert.equal(outcome.status, 'unarchived')
    assert.deepEqual(registry.calls, [['unarchive', 'session-legacy']])
  } finally {
    home.cleanup()
  }
})

test('archiveRow completes the move for a session the host already archived', async () => {
  const home = mkHome()
  try {
    const dir = join(home.sessionsRoot, '--D-workspace-proj1--', 'session-h')
    writeV0(dir, { id: 'session-h', cwd: 'D:\\workspace\\proj1', createdAt: Date.now() - 10 * DAY })
    const registry = fakeRegistry(['session-h'])
    const store = new ArchiveStore(join(home.root, 'state'), home.archiveRoot)
    store.load()
    const ops = new ArchiveOps({ store, disc: home.discovery(), registry, isLive: () => false })
    const row = discoverSessions(home.discovery()).rows[0]
    const outcome = await ops.archiveRow(row)
    assert.equal(outcome.status, 'archived')
    assert.deepEqual(registry.calls, [], 'no redundant host call')
    assert.equal(existsSync(dir), false)
    assert.equal(store.get('session-h').pendingMove, undefined)
  } finally {
    home.cleanup()
  }
})

test('a destination conflict never deletes either copy', async () => {
  const home = mkHome()
  try {
    const dir = join(home.sessionsRoot, '--D-workspace-proj1--', 'session-c')
    writeV0(dir, { id: 'session-c', cwd: 'D:\\workspace\\proj1', createdAt: Date.now() - 10 * DAY })
    const registry = fakeRegistry()
    const store = new ArchiveStore(join(home.root, 'state'), home.archiveRoot)
    store.load()
    const ops = new ArchiveOps({ store, disc: home.discovery(), registry, isLive: () => false })
    const row = discoverSessions(home.discovery()).rows[0]
    // Someone else already put a copy at the destination.
    mkdirSync(join(home.archiveRoot, row.workspaceKey, row.dirName), { recursive: true })

    const outcome = await ops.archiveRow(row)
    assert.equal(outcome.status, 'skipped')
    assert.match(outcome.reason ?? '', /already exists/)
    assert.ok(existsSync(dir), 'the source must survive a conflict')
    assert.equal(store.get('session-c').pendingReason, 'conflict')
  } finally {
    home.cleanup()
  }
})

test('without a registry the plugin still archives files (degraded mode)', async () => {
  const home = mkHome()
  try {
    const dir = join(home.sessionsRoot, '_no-cwd', 'session-d')
    writeV0(dir, { id: 'session-d' })
    const store = new ArchiveStore(join(home.root, 'state'), home.archiveRoot)
    store.load()
    const ops = new ArchiveOps({ store, disc: home.discovery(), isLive: () => false })
    assert.equal(ops.degraded, true)
    const row = discoverSessions(home.discovery()).rows[0]
    const outcome = await ops.archiveRow(row)
    assert.equal(outcome.status, 'archived')
    assert.equal(store.get('session-d').workspaceKey, NO_CWD_KEY)
    assert.equal(existsSync(dir), false)
  } finally {
    home.cleanup()
  }
})

test('purge deletes files and the host mark, but refuses a pending record', async () => {
  const home = mkHome()
  try {
    const dir = join(home.sessionsRoot, '--D-workspace-proj1--', 'session-p')
    writeV0(dir, { id: 'session-p', cwd: 'D:\\workspace\\proj1', createdAt: Date.now() - 10 * DAY })
    const registry = fakeRegistry()
    const store = new ArchiveStore(join(home.root, 'state'), home.archiveRoot)
    store.load()
    const ops = new ArchiveOps({ store, disc: home.discovery(), registry, isLive: () => false })
    const row = discoverSessions(home.discovery()).rows[0]
    await ops.archiveRow(row)
    const record = store.get('session-p')
    registry.calls.length = 0

    const deleted = await ops.purge('session-p')
    assert.equal(deleted.status, 'deleted')
    assert.deepEqual(registry.calls, [['unarchive', 'session-p']])
    assert.equal(existsSync(join(home.archiveRoot, record.workspaceKey, record.dirName)), false)
    assert.equal(store.get('session-p'), undefined)

    store.add({ sessionId: 'session-p', workspaceKey: record.workspaceKey, dirName: record.dirName, archivedAt: Date.now(), pendingMove: true, pendingReason: 'live' })
    assert.equal((await ops.purge('session-p')).status, 'blocked')
  } finally {
    home.cleanup()
  }
})

test('drift reports host-only and store-only archives', async () => {
  const home = mkHome()
  try {
    const dir = join(home.sessionsRoot, '--D-workspace-proj1--', 'session-a')
    writeV0(dir, { id: 'session-a', cwd: 'D:\\workspace\\proj1', createdAt: Date.now() - 10 * DAY })
    const registry = fakeRegistry(['session-host-only'])
    const store = new ArchiveStore(join(home.root, 'state'), home.archiveRoot)
    store.load()
    const ops = new ArchiveOps({ store, disc: home.discovery(), registry, isLive: () => false })
    const row0 = discoverSessions(home.discovery()).rows[0]
    await ops.archiveRow(row0)
    store.remove('session-a') // pretend the host lost our record

    const drift = ops.drift()
    assert.deepEqual([...drift.hostOnly].sort(), ['session-a', 'session-host-only'])
    assert.deepEqual(drift.storeOnly, [])
    assert.deepEqual(drift.pending, [])

    // A record the host no longer hides is store-only drift.
    store.add({ sessionId: 'session-orphan', workspaceKey: row0.workspaceKey, dirName: 'session-orphan', archivedAt: Date.now() })
    assert.deepEqual(ops.drift().storeOnly, ['session-orphan'])
  } finally {
    home.cleanup()
  }
})

test('backfillParents reads current-generation log names', async () => {
  const home = mkHome()
  try {
    const store = new ArchiveStore(join(home.root, 'state'), home.archiveRoot)
    store.load()
    const dir = join(home.archiveRoot, '--D-workspace-proj1--', 'session-child')
    writeV4(dir, { id: 'session-child', parentSessionId: 'session-parent' })
    store.add({ sessionId: 'session-child', workspaceKey: '--D-workspace-proj1--', dirName: 'session-child', archivedAt: Date.now() })
    store.backfillParents()
    assert.equal(store.get('session-child').parentSessionId, 'session-parent')
  } finally {
    home.cleanup()
  }
})

test('resolveWorkspaceRegistry finds the service through ctx.get', () => {
  const registry = fakeRegistry(['x'])
  assert.equal(resolveWorkspaceRegistry({ get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }), registry)
  assert.equal(resolveWorkspaceRegistry({}), undefined)
  assert.deepEqual([...archivedIdSet(registry)], ['x'])
  assert.deepEqual([...archivedIdSet(undefined)], [])
})

// ---------------------------------------------------------------------------
// Route-level contract: this is the exact path the panel calls, and the bug
// being fixed lived here (archive of a live session used to 404/409 and the
// client never reloaded). It must answer 200 and hide the session either way.
// ---------------------------------------------------------------------------

/** Minimal http handler harness: mount the routes, then POST like the panel. */
function mountForTest(deps) {
  const routes = new Map()
  const host = {
    webServer: {
      register(route) {
        routes.set(`${route.kind}:${route.path}`, route.handler)
        return () => routes.delete(`${route.kind}:${route.path}`)
      },
    },
  }
  mountArchiveRoutes(host, {}, deps)
  const handler = [...routes.values()][0]
  assert.ok(handler !== undefined, 'route registered under the plugin base path')

  const call = async (h, method, path, body) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const request = {
      method,
      url: path,
      headers: { host: '127.0.0.1:3080', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      async *[Symbol.asyncIterator]() {
        if (payload !== '') yield Buffer.from(payload)
      },
    }
    const captured = { status: 0, body: '' }
    const response = {
      writeHead(status) {
        captured.status = status
      },
      end(chunk) {
        captured.body = chunk === undefined ? '' : String(chunk)
      },
    }
    await h(request, response)
    return { status: captured.status, json: JSON.parse(captured.body) }
  }
  return { call, archive: (id) => call(handler, 'POST', '/dsh-knj-session-management/archive', { sessionId: id }), list: () => call(handler, 'GET', '/dsh-knj-session-management/list') }
}

test('route: POST /archive on a live session answers 200 + pending, and hides it', async () => {
  const home = mkHome()
  try {
    const cwd = 'D:\\workspace\\proj1'
    const dir = join(home.sessionsRoot, '--D-workspace-proj1--', 'session-live')
    writeV4(dir, { id: 'session-live', cwd, createdAt: Date.now() - 3 * DAY, title: 'live one' })

    const registry = fakeRegistry()
    const store = new ArchiveStore(join(home.root, 'data'), home.archiveRoot)
    const disc = home.discovery()
    const deps = {
      store,
      disc,
      sessionsRoot: home.sessionsRoot,
      archiveRoot: home.archiveRoot,
      projcache: undefined,
      projcacheBytes: () => 0,
      policy: { enabled: false, maxSessionsPerWorkspace: 60 },
      attachedIds: () => new Set(),
      ops: new ArchiveOps({ store, disc, registry, isLive: () => true }),
    }
    const api = mountForTest(deps)

    const res = await api.archive('session-live')
    assert.equal(res.status, 200)
    assert.equal(res.json.archived, 0)
    assert.equal(res.json.pending, 1)
    assert.deepEqual(registry.archivedSessionIds, ['session-live'], 'host must hide it immediately')
    assert.equal(existsSync(dir), true, 'files stay until sweep')
    assert.equal(store.list().length, 1)
    assert.equal(store.list()[0].pendingMove, true)

    const list = await api.list()
    assert.equal(list.status, 200)
    assert.deepEqual(list.json.hostArchived, ['session-live'])
    assert.equal(list.json.stats.pendingCount, 1)
    assert.equal(list.json.sessions[0].hostArchived, true)
  } finally {
    home.cleanup()
  }
})

test('route: POST /archive on a cold session answers 200 and moves the files', async () => {
  const home = mkHome()
  try {
    const cwd = 'D:\\workspace\\proj1'
    const dir = join(home.sessionsRoot, '--D-workspace-proj1--', 'session-cold')
    writeV4(dir, { id: 'session-cold', cwd, createdAt: Date.now() - 3 * DAY, title: 'cold one' })

    const registry = fakeRegistry()
    const store = new ArchiveStore(join(home.root, 'data'), home.archiveRoot)
    const disc = home.discovery()
    const api = mountForTest({
      store,
      disc,
      sessionsRoot: home.sessionsRoot,
      archiveRoot: home.archiveRoot,
      projcache: undefined,
      projcacheBytes: () => 0,
      policy: { enabled: false, maxSessionsPerWorkspace: 60 },
      attachedIds: () => new Set(),
      ops: new ArchiveOps({ store, disc, registry, isLive: () => false }),
    })

    const res = await api.archive('session-cold')
    assert.equal(res.status, 200)
    assert.equal(res.json.archived, 1)
    assert.equal(res.json.pending, 0)
    assert.equal(existsSync(dir), false)
    assert.equal(existsSync(join(home.archiveRoot, '--D-workspace-proj1--', 'session-cold')), true)
    assert.deepEqual(registry.archivedSessionIds, ['session-cold'])
  } finally {
    home.cleanup()
  }
})
