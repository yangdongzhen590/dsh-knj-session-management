/**
 * Sidebar-sync seam: after this plugin archives/restores/deletes sessions by
 * moving files on disk, the host client runtime's session-list snapshot is
 * stale — the host pushes list frames only for sessions it changed itself,
 * so the left sidebar keeps ghost rows until the next reconnect. The concrete
 * client runtimes expose a public `refresh()` that re-pulls their baselines
 * (the host re-scans persistence on every `sessions.list` RPC, so re-pulled
 * rows reflect the moved files immediately).
 *
 * Kept pure and host-agnostic so the contract is node-testable: feature-detect
 * `refresh`, call it as a method, and never let a sync failure (missing
 * method, sync throw, rejected promise, non-promise return) break the panel.
 */

/** Anything that may expose the concrete runtime's baseline re-pull. */
export interface RefreshableService {
  /** Public on the concrete SessionRuntime/WorkspaceRuntime; absent on the narrowed faces and test doubles. */
  refresh?(): Promise<void> | void
}

/**
 * Ask every provided host client service to re-pull its baseline. Best-effort
 * by contract: each service is refreshed independently and every failure mode
 * is swallowed — sidebar sync must never surface in the panel's own flows.
 *
 * @param services - host client services (sessions, workspaces); absent
 *   entries are skipped.
 */
export function syncHostLists(services: ReadonlyArray<RefreshableService | undefined | null>): void {
  for (const service of services) {
    const refresh = service?.refresh
    if (typeof refresh !== 'function') continue
    try {
      const result = refresh.call(service) as Promise<void> | void
      if (result !== undefined && typeof (result as Promise<void>).catch === 'function') {
        ;(result as Promise<void>).catch(() => undefined)
      }
    } catch {
      /* best-effort: a failed refresh only delays sidebar convergence */
    }
  }
}
