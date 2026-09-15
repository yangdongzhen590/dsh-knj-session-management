/**
 * 新建会话并把指令**预填进 composer** —— 与 dsh-knj-obsidian 的 wiki-distill 入口同一条路径。
 *
 * 为什么需要它：面板上的「蒸馏后归档 / 蒸馏后删除」是删除前的安全闸门。只把指令复制到剪贴板
 * 时，用户还得自己找地方粘贴；而闸门的语义是"先蒸再删"，粘贴这一步一旦漏掉，就会出现
 * "以为蒸过了、其实没蒸"的虚假安全感。直接预填到新会话可省掉这一步，且指令不会漏。
 *
 * 三条硬约束（照搬知识库插件已验证的实现，别自行简化）：
 *  1) **不抛**：任何环节失败都返回可读原因，由调用方降级为"仅复制"。
 *  2) **读回校验**：新会话的 composer 是**懒挂载**的，`setDraft` 调用成功 ≠ 草稿真的写进去了。
 *     必须从 `input.state.getSnapshot().draft` 读回、确认包含我们的标记，才算成功。
 *  3) **不覆盖用户输入**：若发现该会话里已有非空草稿且不含我们的标记，立即停手（用户可能
 *     已经在敲字），并如实说明——宁可少填，不可覆盖人已经写的东西。
 *
 * 浏览器不能 import lib，所以本模块是 client-only（不需要像 distill.ts 那样维护双份）。
 */

/** 会话 client 服务里本模块用到的面（全部特性探测，缺失即降级）。 */
export interface PrefillSessionsFace {
  create?(opts: { workspaceId?: string; cwd?: string }): Promise<string> | string
  open?(id: string): void
  refresh?(): Promise<void> | void
  /** 取该会话的作用域 ctx（composer 的输入面挂在它上面）。 */
  scope?(id: string): unknown
}

/** `conversation.input` 的输入面（写草稿 + 读回）。 */
export interface PrefillInputFace {
  setDraft?(text: string): void
  /** 旧版把写通道放在 actions 下。 */
  actions?: { setDraft?(text: string): void }
  state?: { getSnapshot?(): { draft?: string } | undefined }
}

export interface PrefillConversationFace {
  input?: { for?(scope: unknown): PrefillInputFace | undefined }
}

export interface PrefillWorkspacesFace {
  list?: { getSnapshot?(): { items?: ReadonlyArray<Record<string, unknown>> } | undefined }
}

/** 路径归一化（比较用）：统一斜杠、去尾斜杠、忽略大小写。 */
export function normalizePath(p?: string): string {
  return (p ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 按路径把目录匹配到**已有**工作区，返回其 id。
 * 刻意**不**调用 workspaces.create：本插件没有"库根"概念，替用户把一个目录注册成工作区
 * 属于计划外副作用；匹配不到就按 cwd 建会话并如实说明（见 prefillNewSession 的返回值）。
 */
export function matchWorkspaceId(workspaces: PrefillWorkspacesFace | undefined, root?: string): string | undefined {
  if (!root) return undefined
  try {
    const snap = workspaces?.list?.getSnapshot?.()
    const want = normalizePath(root)
    const hit = snap?.items?.find((w) => normalizePath(typeof w.path === 'string' ? w.path : undefined) === want)
    if (!hit) return undefined
    const id = (typeof hit.workspaceId === 'string' && hit.workspaceId) || (typeof hit.id === 'string' && hit.id) || ''
    return id || undefined
  } catch {
    return undefined
  }
}

export type PrefillResult =
  | { ok: true; sessionId: string; note?: string }
  | { ok: false; reason: string }

export interface PrefillOptions {
  text: string
  /** 新会话应落的目录（= 被归档/删除那批会话的公共 cwd）。 */
  cwd?: string
  sessions?: PrefillSessionsFace
  conversation?: PrefillConversationFace
  workspaces?: PrefillWorkspacesFace
  /** 测试注入：等待函数。 */
  wait?: (ms: number) => Promise<void>
  /** 轮询上限（默认 40 次，配合 150ms 约 6s）。 */
  maxAttempts?: number
  onWarn?: (message: string, detail?: Record<string, unknown>) => void
}

const DEFAULT_ATTEMPTS = 40
const POLL_MS = 150

/**
 * 新建会话并预填指令。**绝不抛异常**；失败一律返回 `{ ok:false, reason }` 供调用方降级。
 */
export async function prefillNewSession(opts: PrefillOptions): Promise<PrefillResult> {
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const maxAttempts = opts.maxAttempts ?? DEFAULT_ATTEMPTS
  const fail = (reason: string): PrefillResult => {
    // onWarn 是调用方给的诊断口：它自己抛错不能把本函数带崩（约束 1「绝不抛」）。
    try { opts.onWarn?.('[knj-sm] prefill failed', { reason }) } catch { /* 诊断失败不影响结果 */ }
    return { ok: false, reason }
  }

  try {
    const text = opts.text ?? ''
    if (!text) return fail('指令为空')
    const sessions = opts.sessions
    if (!sessions) return fail('宿主未提供 sessions 服务')
    if (typeof sessions.create !== 'function') return fail('宿主 sessions.create 不可用（版本过旧）')
    if (typeof sessions.scope !== 'function') return fail('宿主 sessions.scope 不可用（版本过旧）')

    const workspaceId = matchWorkspaceId(opts.workspaces, opts.cwd)
    let newId: string
    try {
      newId = await sessions.create(workspaceId ? { workspaceId, ...(opts.cwd ? { cwd: opts.cwd } : {}) } : (opts.cwd ? { cwd: opts.cwd } : {}))
    } catch (e) {
      return fail(`sessions.create 抛错：${String(e)}`)
    }
    if (!newId) return fail('sessions.create 未返回会话 id')
    try { sessions.open?.(newId) } catch (e) { return fail(`sessions.open 抛错：${String(e)}`) }
    try { await sessions.refresh?.() } catch { /* 列表刷新失败不影响预填 */ }

    // 新会话的 composer 懒挂载：轮询 → **写之前先读**（确认没人在打字）→ 写 → 读回校验。
    const marker = text.slice(0, 12)
    /** 读当前草稿；读不到（state 缺失或还没物化）返回 ''。 */
    const readDraft = (input: PrefillInputFace): string => {
      try { return input.state?.getSnapshot?.()?.draft ?? '' } catch { return '' }
    }
    /** 读回命中我们的标记即视为已交付（也涵盖上一轮写入延迟生效的情况）。 */
    const delivered = (): PrefillResult => (workspaceId
      ? { ok: true, sessionId: newId }
      : { ok: true, sessionId: newId, note: `未能把 ${opts.cwd ?? '(未知目录)'} 匹配成工作区，已按 cwd 建会话，请确认左侧工作区` })

    let lastErr = ''
    for (let i = 0; i < maxAttempts; i++) {
      let actx: unknown
      try { actx = sessions.scope(newId) } catch (e) { lastErr = `sessions.scope 抛错：${String(e)}` }
      if (actx === undefined || actx === null) {
        lastErr = `sessions.scope("${newId}") 尚未就绪`
        await wait(POLL_MS)
        continue
      }
      const input = (() => {
        try { return opts.conversation?.input?.for?.(actx) } catch (e) { lastErr = `conversation.input.for 抛错：${String(e)}`; return undefined }
      })()
      if (!input) {
        lastErr = 'conversation.input.for(scope) 尚未就绪'
        await wait(POLL_MS)
        continue
      }
      const setDraft = typeof input.setDraft === 'function' ? input.setDraft : input.actions?.setDraft
      if (typeof setDraft !== 'function') {
        lastErr = '输入面没有 setDraft'
        await wait(POLL_MS)
        continue
      }
      // ① **先读后写**。草稿非空且不含我们的标记 = 有人在打字 → 一次都不写。
      //    顺序不能反：先写再校验的话，覆盖已经发生，读回只能证明"我们写进去了"，用户的字已经丢了。
      try { input.state?.getSnapshot?.() } catch (e) { lastErr = `input.state.getSnapshot 抛错：${String(e)}` }
      const before = readDraft(input)
      if (before.includes(marker)) return delivered()
      if (before.trim() !== '') return fail('新会话的输入框里已有你写的内容，未覆盖')

      // ② 再写，并读回校验（setDraft 调用成功 ≠ 草稿真的写进去了）。
      try { setDraft.call(input, text) } catch (e) { lastErr = `setDraft 抛错：${String(e)}` }
      const after = readDraft(input)
      if (after.includes(marker)) return delivered()
      lastErr = `setDraft 后未读到草稿（draft="${after.slice(0, 40)}"）`
      await wait(POLL_MS)
    }
    return fail(`重试 ${maxAttempts} 次后仍未确认预填成功（新会话 ${newId} 已创建；最后一次错误：${lastErr || '未知'}）`)
  } catch (e) {
    return fail(`意外错误：${String(e)}`)
  }
}
