/**
 * Distill handoff logic — host-side twin of src/client/distill.ts.
 * Pure, testable parts shared by the node:test suite. The browser bundle
 * carries its own copy (client/distill.ts) since the client cannot import
 * from lib at runtime.
 *
 * ⚠ 两个 twin 必须保持一致（有 sync 测试比对 buildDistillTrigger 的函数体）。
 */

/**
 * 兜底指令：**只在拿不到会话 id 时使用**。
 *
 * 历史教训（本文件的前身只有这一条常量）：面板上的「蒸馏后归档 / 蒸馏后删除」是
 * **删除前的安全闸门**，但它复制的是这条"蒸馏近期会话"的固定文案，而闸门实际保护的是
 * **所选会话**（`doArchive([...selected])`）。归档/删除的对象天然是旧会话，而"近期"根本
 * 覆盖不到它们——于是用户看到"指令已复制"、点「已蒸馏，继续」，真正要删的那批内容
 * 从未被蒸馏。现在调用方一律传 id 走 buildDistillTrigger；这条只作为防御性兜底保留。
 */
export const DISTILL_TRIGGER = '用 wiki-distill 蒸馏近期 DSH 会话进知识库（先向我确认范围）'

/**
 * 按**指定会话 id** 生成蒸馏指令（提取器第 6 参数过滤 + 忽略时间下限）。
 *
 * - 提取器的参数是**位置**参数，第 3 个是项目过滤名，第 6 个是会话 id。项目过滤拿不到时
 *   也要占住该位置（传空串），否则后面的参数会整体前移、被错当成项目名。
 * - 项目过滤只是提速与护栏；**按 id 过滤才是正确性所在**（会话 id 全局唯一），所以即使
 *   跨工作区选择、无法给出项目过滤，指令依然是对的。
 * - 空/非法 id 列表 → 回退到 DISTILL_TRIGGER（绝不生成一条带空 id 列表的指令）。
 */
export function buildDistillTrigger(ids: readonly string[], projectFilter?: string | null): string {
  const list = [...new Set(
    (ids ?? []).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()),
  )]
  if (list.length === 0) return DISTILL_TRIGGER
  const joined = list.join(',')
  const filter = (projectFilter ?? '').trim()
  return [
    `用 wiki-distill 只蒸馏【这些会话】共 ${list.length} 个进知识库（不蒸其它会话）：`,
    list.join('、'),
    '',
    '硬约束（直接使用，不要自行推导）：',
    '1) 调用提取器时加第 6 个参数＝会话 id（逗号分隔），并把时间下限显式设为 1970-01-01T00:00:00Z'
      + '（忽略时间下限，避免老会话被 mtime 过滤掉）：',
    '   node <vault>/_system/tools/extract-dsh-sessions.cjs "%USERPROFILE%\\.dsh\\sessions" <vault>/_system/dsh-sessions'
      + ` "${filter}" 1970-01-01T00:00:00Z "${joined}"`,
    ...(filter === '' ? ['   （第 3 个参数留空＝不按项目过滤；按 id 过滤已足以保证只蒸这些会话，扫描会慢一些。）'] : []),
    '2) 逐会话入库 source=`session:<id>`，contentHash 用【该会话自己的摘要内容哈希】'
      + '（逐会话判重，重复执行自动跳过）。',
    '边界：不读取其它工作区会话；原始归档只落 <vault>/_system/dsh-sessions/，不参与检索；未知内容标注 inferred。',
  ].join('\n')
}

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
