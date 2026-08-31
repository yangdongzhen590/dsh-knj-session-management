/**
 * Distill handoff logic — browser-side twin of src/distill.ts (host copy is
 * tested by node:test). The values must stay in sync with the host twin.
 */

/** Trigger copied to the clipboard, matching the obsidian plugin's wiki-distill entry. */
export const DISTILL_TRIGGER = '用 wiki-distill 蒸馏近期 DSH 会话进知识库（先向我确认范围）'

export type DistillAction = 'archive' | 'delete'

/** Build the confirm dialog body given the action label. */
export function buildDistillConfirm(actionLabel: string): string {
  return `蒸馏指令已复制。蒸馏完成后点「已蒸馏，继续」再${actionLabel}；或「取消」。`
}

/** Whether the given error indicates the clipboard is unavailable (fail-soft hint). */
export function isClipboardError(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === 'NotAllowedError' || error.name === 'NotFoundError'
  return false
}

