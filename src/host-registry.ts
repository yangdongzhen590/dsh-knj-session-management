/**
 * Host workspace-registry port: the *visibility* authority for archived
 * sessions.
 *
 * The left sidebar's only archive switch is `archivedSessionIds` on the host's
 * `workspaceRegistry` service (dsh-workspace): the client's `sessionVisible()`
 * returns `!archived.has(session.id)`. Moving directories on disk is invisible
 * to that switch, which is why the old plugin left ghost rows behind.
 *
 * The port is deliberately structural (no dependency on the host package):
 * every member is feature-detected, so a host without the service degrades to
 * file-only archiving instead of failing to mount.
 */

/** The subset of `ctx.workspaceRegistry` this plugin depends on. */
export interface WorkspaceRegistryPort {
  /** Registry-global archive set; the client filters the sidebar on it. */
  readonly archivedSessionIds: readonly string[]
  /** Durably mark one session archived; resolves after durability. */
  archiveSession(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
  /** Durably clear the archived mark; resolves after durability. */
  unarchiveSession(sessionId: string): Promise<void>
}

/** Anything that can resolve a host service by name (`ctx` / a forked ctx). */
export interface ServiceBag {
  get?<T>(name: string): T | undefined
}

/** Structural check: both mutators exist and are callable. */
export function isWorkspaceRegistry(value: unknown): value is WorkspaceRegistryPort {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['archiveSession'] === 'function'
    && typeof candidate['unarchiveSession'] === 'function'
}

/**
 * Resolve the workspace registry from a host service bag.
 *
 * Two channels, newest first: `ctx.get(name)` (service registry) and the
 * `ctx[name]` property (older hosts without a service map). Never throws —
 * callers treat `undefined` as "this host has no archive authority" and fall
 * back to file-only archiving.
 */
export function resolveWorkspaceRegistry(bag: ServiceBag | undefined): WorkspaceRegistryPort | undefined {
  if (bag === undefined) return undefined
  try {
    if (typeof bag.get === 'function') {
      const viaGet = bag.get<unknown>('workspaceRegistry')
      if (isWorkspaceRegistry(viaGet)) return viaGet
    }
  } catch {
    /* fall through to the property channel */
  }
  const viaProp = (bag as unknown as Record<string, unknown>)['workspaceRegistry']
  return isWorkspaceRegistry(viaProp) ? viaProp : undefined
}

/**
 * Snapshot the registry's archived set.
 *
 * The host getter throws while the domain state is not initialized yet (boot
 * race), so a failure reads as "nothing archived" — never as "everything is".
 * Consumers only use this to decide whether a mutation is a no-op, so a stale
 * empty set costs one extra idempotent host call, never data.
 */
export function archivedIdSet(registry: WorkspaceRegistryPort | undefined): Set<string> {
  if (registry === undefined) return new Set()
  try {
    return new Set(registry.archivedSessionIds)
  } catch {
    return new Set()
  }
}
