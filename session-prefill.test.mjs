// session-prefill.test.mjs
// 「新建会话并预填蒸馏指令」的纯逻辑：必须不抛、必须读回校验、绝不覆盖用户输入、失败要能降级。
// 这些用例用假服务注入，不依赖宿主与 DOM。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'

/**
 * 客户端源码（src/client/**）被 tsconfig.json 排除、且只经 tsdown 打成 client/client.js
 * （window.__ModuleLoader__ 闭包，不可直接 import），所以没有可 import 的构建产物。
 * 这里用 TypeScript 编译器 API 就地转译源码再以 data: URL 导入：测的是
 * src/client/session-prefill.ts 的真实代码，既不需要构建顺序，也不会出现手工副本走偏。
 */
const here = dirname(fileURLToPath(import.meta.url))
async function loadClientModule(rel) {
  const src = readFileSync(join(here, rel), 'utf8')
  const js = ts.transpileModule(src, {
    fileName: rel,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(js)}`)
}

const { prefillNewSession, normalizePath, matchWorkspaceId } = await loadClientModule('src/client/session-prefill.ts')

const NOWAIT = () => Promise.resolve()

/** 假 composer：可控制 scope/composer 在第几轮就绪、setDraft 是否真写进 state。 */
function fakeHost(opts = {}) {
  const calls = { create: 0, open: [], setDraft: [] }
  let draft = ''
  const state = { getSnapshot: () => ({ draft }) }
  const input = {
    setDraft(text) {
      calls.setDraft.push(text)
      if (opts.setDraftIgnored) return // 写了但不进 state：模拟"调用成功但没写进去"
      draft = text
    },
    state,
  }
  const scopeReadyAt = opts.scopeReadyAt ?? 0
  const inputReadyAt = opts.inputReadyAt ?? 0
  let attempt = 0
  const sessions = {
    create: opts.noCreate
      ? undefined
      : opts.createThrows
        ? async () => { calls.create++; throw new Error('创建失败') }
        : async () => { calls.create++; return 'new-session-1' },
    scope: opts.noScope ? undefined : () => {
      const i = attempt++
      return i >= scopeReadyAt ? { sessionId: 'new-session-1' } : undefined
    },
    open: (id) => calls.open.push(id),
    refresh: async () => {},
  }
  const conversation = opts.noConversation ? undefined : {
    input: { for: () => (attemptNow() >= inputReadyAt ? input : undefined) },
  }
  // 用同一个计数器近似"轮次"：scope 与 input 都按轮次放行
  function attemptNow() { return attempt }
  return { calls, sessions, conversation, state, getDraft: () => draft, setDraftExternally: (v) => { draft = v } }
}

test('成功路径：create → open → setDraft → 读回校验通过', async () => {
  const h = fakeHost()
  const res = await prefillNewSession({
    text: '用 wiki-distill 只蒸馏这些会话：session-a', cwd: 'D:/workspace/proj',
    sessions: h.sessions, conversation: h.conversation, wait: NOWAIT,
  })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.sessionId, 'new-session-1')
  assert.equal(h.calls.create, 1, '应新建会话')
  assert.deepEqual(h.calls.open, ['new-session-1'], '应打开新会话')
  assert.ok(h.calls.setDraft.length >= 1, '应写入草稿')
  assert.ok(h.getDraft().includes('wiki-distill'), '草稿应含指令')
})

test('懒挂载：前几轮取不到 scope/输入面，之后拿到 → 仍然成功', async () => {
  const h = fakeHost({ scopeReadyAt: 3, inputReadyAt: 3 })
  const res = await prefillNewSession({
    text: '指令内容够长以便做标记校验', cwd: 'D:/w', sessions: h.sessions, conversation: h.conversation, wait: NOWAIT,
  })
  assert.equal(res.ok, true, `轮询应最终成功：${JSON.stringify(res)}`)
})

test('setDraft 调用成功但没写进 state → 重试到上限后失败（不做假成功）', async () => {
  const h = fakeHost({ setDraftIgnored: true })
  const res = await prefillNewSession({
    text: '指令内容', cwd: 'D:/w', sessions: h.sessions, conversation: h.conversation, wait: NOWAIT, maxAttempts: 3,
  })
  assert.equal(res.ok, false, '读回没看到草稿就不能算成功')
  assert.match(res.reason, /仍未确认预填成功/)
  assert.ok(h.calls.setDraft.length >= 1, '应确实尝试过写入')
})

test('降级路径全部不抛：无 create / 无 scope / 无 conversation / create 抛错', async () => {
  const cases = [
    { name: '无 sessions', opts: { sessions: undefined } },
    { name: '无 create', host: { noCreate: true } },
    { name: '无 scope', host: { noScope: true } },
    { name: '无 conversation', host: { noConversation: true }, expect: /尚未就绪|仍未确认/ },
    { name: 'create 抛错', host: { createThrows: true }, expect: /抛错|仍未确认/ },
  ]
  for (const c of cases) {
    const h = c.host ? fakeHost(c.host) : { calls: {}, sessions: undefined, conversation: undefined }
    const res = await prefillNewSession({
      text: '指令', cwd: 'D:/w', wait: NOWAIT, maxAttempts: 2,
      sessions: c.opts ? c.opts.sessions : h.sessions,
      conversation: h.conversation,
    })
    assert.equal(res.ok, false, `${c.name} 应降级为 ok:false`)
    assert.equal(typeof res.reason, 'string', `${c.name} 应给可读原因`)
    assert.ok(res.reason.length > 0, `${c.name} 原因不能为空`)
  }
})

test('空指令直接失败（不建会话）', async () => {
  const h = fakeHost()
  const res = await prefillNewSession({ text: '', cwd: 'D:/w', sessions: h.sessions, conversation: h.conversation, wait: NOWAIT })
  assert.equal(res.ok, false)
  assert.equal(h.calls.create, 0, '空指令不该建会话')
})

test('绝不覆盖用户输入：新会话里已有非空草稿（不含我们的标记）→ 停手', async () => {
  const h = fakeHost()
  // 第一轮之后用户自己敲了字：让 setDraft 变成 no-op，并在第二轮前塞入用户草稿
  let n = 0
  const input = {
    setDraft: () => { n++; if (n === 1) h.setDraftExternally('用户自己敲的内容') },
    state: { getSnapshot: () => ({ draft: h.getDraft() }) },
  }
  const sessions = { create: async () => 's2', open: () => {}, refresh: async () => {}, scope: () => ({}) }
  const conversation = { input: { for: () => input } }
  const res = await prefillNewSession({ text: '我们的指令标记xyz', cwd: 'D:/w', sessions, conversation, wait: NOWAIT, maxAttempts: 5 })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.match(res.note ?? '', /已有你的输入/, '应如实说明检测到用户输入并停手')
  assert.equal(h.getDraft(), '用户自己敲的内容', '绝不能把用户的字覆盖掉')
})

test('工作区按路径匹配：命中返回 id，未命中/异常返回 undefined（不新建工作区）', () => {
  const workspaces = { list: { getSnapshot: () => ({ items: [{ workspaceId: 'w1', path: 'D:\\Workspace\\Proj\\' }] }) } }
  assert.equal(matchWorkspaceId(workspaces, 'd:/workspace/proj'), 'w1', '应忽略斜杠方向/尾斜杠/大小写')
  assert.equal(matchWorkspaceId(workspaces, 'D:/other'), undefined)
  assert.equal(matchWorkspaceId(workspaces, undefined), undefined)
  assert.equal(matchWorkspaceId({ list: { getSnapshot: () => { throw new Error('x') } } }, 'D:/w'), undefined, '宿主抛错时也要返回 undefined 而非抛出')
  assert.equal(normalizePath(' D:\\a\\b\\ '), 'd:/a/b')
})

test('匹配到工作区时 create 带上 workspaceId；匹配不到则只带 cwd 并如实提示', async () => {
  const seen = []
  const sessions = { create: async (o) => { seen.push(o); return 's3' }, open: () => {}, refresh: async () => {}, scope: () => ({}) }
  let draft = ''
  const conversation = { input: { for: () => ({ setDraft: (t) => { draft = t }, state: { getSnapshot: () => ({ draft }) } }) } }
  const workspaces = { list: { getSnapshot: () => ({ items: [{ workspaceId: 'w9', path: 'D:/w' }] }) } }

  const hit = await prefillNewSession({ text: '指令ABC', cwd: 'D:/w', sessions, conversation, workspaces, wait: NOWAIT })
  assert.equal(hit.ok, true)
  assert.deepEqual(seen[0], { workspaceId: 'w9', cwd: 'D:/w' }, '命中工作区应带上 workspaceId')

  const miss = await prefillNewSession({ text: '指令ABC', cwd: 'D:/elsewhere', sessions, conversation, workspaces, wait: NOWAIT })
  assert.equal(miss.ok, true)
  assert.deepEqual(seen[1], { cwd: 'D:/elsewhere' }, '未命中只带 cwd')
  assert.match(miss.note ?? '', /匹配成工作区/, '未命中要如实提示，不能假装归属正确')
})
