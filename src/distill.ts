/**
 * Distill handoff logic — host-side twin of src/client/distill.ts.
 * Pure, testable parts shared by the node:test suite. The browser bundle
 * carries its own copy (client/distill.ts) since the client cannot import
 * from lib at runtime.
 */

/** Trigger copied to the clipboard, matching the obsidian plugin's wiki-distill entry. */
export const DISTILL_TRIGGER = '用 wiki-distill 蒸馏近期 DSH 会话进知识库（先向我确认范围）'

/** Build the confirm dialog body given the action label. */
export function buildDistillConfirm(actionLabel: string): string {
  return `蒸馏指令已复制。蒸馏完成后点「已蒸馏，继续」再${actionLabel}；或「取消」。`
}

/** Whether the given error indicates the clipboard is unavailable (fail-soft hint). */
export function isClipboardError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'NotAllowedError' || error.name === 'NotFoundError'
  }
  return false
}
