/**
 * dsh-knj-session-management client: registers a "会话管理" entry in the left
 * sidebar's footer.action slot (same pattern as dsh-scheduler / dsh-knj-workflow).
 * Built by tsdown into the __ModuleLoader__ factory bundle at client/client.js.
 */
import { createElement as h } from 'react'
import { en, zh } from './locales.ts'
import { ArchiveEntry } from './ArchiveEntry.tsx'

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
}

/** The subset of the host `workspaces` client service this plugin touches. */
export interface WorkspacesService {
  list?: { getSnapshot(): { items: Array<{ workspaceId: string; path: string; title?: string }> } }
  /** Concrete-runtime extra (same feature-detect rule as sessions.refresh). */
  refresh?(): Promise<void> | void
}

/** The client cordis context shape this plugin relies on (structural). */
interface ArchiveClientContext {
  effect(callback: () => unknown, label?: string): void
  locale: LocaleService
  slots: SlotsService
  sessions?: SessionsService
  workspaces?: WorkspacesService
}

export const name = 'dsh-knj-session-management'
export const inject = ['locale', 'slots', 'sessions', 'workspaces']

export function apply(ctx: ArchiveClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-knj-session-management: dictionaries')
  const t = ctx.locale.bind(NS) as (key: string, vars?: Record<string, string | number>) => string
  const sessions = ctx.sessions
  const workspaces = ctx.workspaces

  ctx.effect(() => {
    if (!ctx.slots) return
    ctx.slots.inject('knj.menu.item', () => ctx.slots.register(
      { name: 'knj.menu.item', id: 'dsh-knj-session-management', order: 30, locale: 'zh' },
      () => h(ArchiveEntry, { t, sessions, workspaces }),
    ))
  }, 'dsh-knj-session-management: sidebar entry')
}
