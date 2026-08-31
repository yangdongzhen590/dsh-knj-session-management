/**
 * Auto-archive policy: when a workspace holds more than maxSessionsPerWorkspace
 * persisted sessions, archive the oldest non-running ones until the cap is met.
 * Only archives; never deletes. `_no-cwd` sessions count as their own group.
 */
import type { SessionRow } from './types.ts'

export interface PolicyConfig {
  enabled: boolean
  maxSessionsPerWorkspace: number
  /** Cap on how many sessions one policy run may archive (default 50). */
  maxPerRun?: number
}

/**
 * Select sessions to archive under the policy.
 * @param rows - all discovered session rows (attached ones carry running=true).
 * @param config - policy config.
 * @returns the rows that should be archived (oldest first per group), capped
 *   by maxPerRun so a single run never blocks the event loop for minutes.
 */
export function selectForArchive(rows: SessionRow[], config: PolicyConfig): SessionRow[] {
  if (!config.enabled || config.maxSessionsPerWorkspace <= 0) return []

  const byGroup = new Map<string, SessionRow[]>()
  for (const row of rows) {
    if (row.running) continue
    // Subagent (delegation) sessions belong to their parent and are archived
    // together with it; they must not consume the per-workspace cap alone.
    if (row.parentSessionId !== undefined) continue
    const key = row.workspaceKey
    const list = byGroup.get(key)
    if (list === undefined) byGroup.set(key, [row])
    else list.push(row)
  }

  const selected: SessionRow[] = []
  for (const [key, groupRows] of byGroup) {
    // Oldest first (updatedAt ascending).
    const sorted = [...groupRows].sort((a, b) => a.updatedAt - b.updatedAt)
    const overflow = sorted.length - config.maxSessionsPerWorkspace
    if (overflow > 0) selected.push(...sorted.slice(0, overflow))
  }

  const cap = config.maxPerRun ?? 50
  if (selected.length > cap) return selected.slice(0, cap)
  return selected
}
