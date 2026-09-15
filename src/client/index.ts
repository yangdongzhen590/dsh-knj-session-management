/**
 * dsh-knj-session-management client: registers a "会话管理" entry in the left
 * sidebar's footer.action slot (same pattern as dsh-scheduler / dsh-knj-workflow).
 * Built by tsdown into the __ModuleLoader__ factory bundle at client/client.js.
 */
import { createElement as h } from 'react'
import { en, zh } from './locales.ts'
import { ArchiveEntry } from './ArchiveEntry.tsx'
import { prefillNewSession, type PrefillConversationFace, type PrefillResult } from './session-prefill.ts'

const NS = 'dsh-knj-session-management'

/** The subset of the locale service this plugin touches. */
interface LocaleService {
  register(namespace: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): unknown
  bind(namespace: string): (key: string, vars?: Record<string, string | number>) => string
}

/** The subset of the client slots service this plugin touches. */
interface SlotsService {
  inject(slot: string, register: () => unknown): void
  register(meta: { name: string; id: string; locale: string; order?: number }, render: (props: unknown) => unknown): unknown
}

/** The subset of the host `sessions` client service this plugin touches (see dsh-client-runtime). */
export interface SessionsService {
  open(id: string): void
  list?: { getSnapshot(): { byId: Record<string, { cwd?: string }>; current?: string } }
  /**
   * Concrete-runtime extra (public on SessionRuntime, not on the narrowed
   * ISessions face): re-pull the host session list. The host pushes list
   * frames only for sessions it changed itself, while this plugin moves
   * session files on disk — without a re-pull the left sidebar keeps ghost
   * rows until the next reconnect. Feature-detected at runtime; absent on
   * narrowed test doubles, where sync is a no-op.
   */
  refresh?(): Promise<void> | void
  /**
   * 新建会话与取会话作用域：用于「新建会话并预填蒸馏指令」（与知识库插件同路径）。
   * 同样特性探测——宿主版本旧时不存在，此时面板退回"仅复制指令"。
   */
  create?(opts: { workspaceId?: string; cwd?: string }): Promise<string> | string
  scope?(id: string): unknown
}

/** The subset of the host `workspaces` client service this plugin touches. */
export interface WorkspacesService {
  list?: { getSnapshot(): { items: Array<{ workspaceId: string; path: string; title?: string }> } }
  /** Concrete-runtime extra (same feature-detect rule as sessions.refresh). */
  refresh?(): Promise<void> | void
}

/** 面板拿到的"新建会话并预填"能力（由 index.ts 绑定好宿主服务后传入）。 */
export type PrefillFn = (text: string, cwd?: string) => Promise<PrefillResult>

/** The client cordis context shape this plugin relies on (structural). */
interface ArchiveClientContext {
  effect(callback: () => unknown, label?: string): void
  locale: LocaleService
  slots: SlotsService
  sessions?: SessionsService
  workspaces?: WorkspacesService
  /** 新版宿主：服务经 ctx.get(name) 取；旧版走 ctx[name] 属性（见 hostService）。 */
  get?(name: string): unknown
  conversation?: PrefillConversationFace
}

export const name = 'dsh-knj-session-management'
/**
 * `conversation` 是**真实服务名**（不是包名）——写错会让 fiber 永远 pending、
 * web boot 报 "1 entry did not activate"（knj-prompts 踩过）。知识库插件正是这样注入并用它
 * 把指令预填进 composer 的。
 */
export const inject = ['locale', 'slots', 'sessions', 'workspaces', 'conversation']

/**
 * 双通道取宿主 client 服务：新版 `ctx.get(name)` → 旧版 `ctx[name]` 属性。
 * 两者都没有即视为服务缺失（调用方据此降级），**绝不抛**、不阻塞 boot。
 */
function hostService<T>(ctx: ArchiveClientContext, name: keyof ArchiveClientContext & string): T | undefined {
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (viaGet !== undefined && viaGet !== null) return viaGet as T
  } catch { /* 忽略：退回属性通道 */ }
  const viaProp = (ctx as unknown as Record<string, unknown>)[name]
  return (viaProp ?? undefined) as T | undefined
}

export function apply(ctx: ArchiveClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-knj-session-management: dictionaries')
  const t = ctx.locale.bind(NS) as (key: string, vars?: Record<string, string | number>) => string
  const sessions = hostService<SessionsService>(ctx, 'sessions')
  const workspaces = hostService<WorkspacesService>(ctx, 'workspaces')
  const conversation = hostService<PrefillConversationFace>(ctx, 'conversation')

  /** 新建会话并预填指令；服务缺失或预填失败都返回 ok:false，由面板退回"仅复制"。 */
  const startAgentSession: PrefillFn = (text, cwd) =>
    prefillNewSession({ text, cwd, sessions, conversation, workspaces })

  ctx.effect(() => {
    if (!ctx.slots) return
    ctx.slots.inject('knj.menu.item', () => ctx.slots.register(
      { name: 'knj.menu.item', id: 'dsh-knj-session-management', order: 30, locale: 'zh' },
      () => h(ArchiveEntry, { t, sessions, workspaces, startAgentSession }),
    ))
  }, 'dsh-knj-session-management: sidebar entry')
}
