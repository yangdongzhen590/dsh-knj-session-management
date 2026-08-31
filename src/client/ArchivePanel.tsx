/**
 * Session archive panel: stats bar, current/archived tabs, workspace-grouped
 * session list, batch archive/restore/delete with confirmations, and the
 * auto-policy runner. Styled with the host's --dsw-alias design tokens.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Dict } from './locales.ts'
import * as api from './api.ts'
import type { ArchiveRecordView, SessionRowView, SessionListResponse, StatsView, WorkspaceGroupView } from './api.ts'
import { DISTILL_TRIGGER } from './distill.ts'
import { IconArchive, IconClose, IconFolder, IconRefresh, IconRestore, IconTrash, IconWand } from './icons.tsx'

type Tab = 'current' | 'archived'
type ToastState = { kind: 'ok' | 'warn' | 'err'; text: string } | null

export interface ArchivePanelProps {
  onClose: () => void
  t: (key: keyof Dict, vars?: Record<string, string | number>) => string
  sessions?: SessionsService
  workspaces?: WorkspacesService
}

/** The subset of the host `sessions` client service this plugin touches. */
export interface SessionsService {
  open(id: string): void
  list?: { getSnapshot(): { byId: Record<string, { cwd?: string }>; current?: string } }
}

/** The subset of the host `workspaces` client service this plugin touches. */
export interface WorkspacesService {
  list?: { getSnapshot(): { items: Array<{ workspaceId: string; path: string; title?: string }> } }
}

const PAGE_SIZE = 50

const T = {
  text: 'var(--dsw-alias-label-primary)',
  text2: 'var(--dsw-alias-label-secondary)',
  text3: 'var(--dsw-alias-label-tertiary)',
  card: 'var(--dsw-alias-bg-layer-1)',
  surface: 'var(--dsw-alias-bg-layer-2)',
  border: 'var(--dsw-alias-border-l2)',
  accent: 'var(--dsw-alias-brand-primary)',
  success: 'var(--dsw-static-green-500)',
  danger: 'var(--dsw-alias-state-error-primary)',
  warn: 'var(--dsw-static-yellow-500)',
  font: 'var(--dsw-font-family)',
}

const S: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: T.font, color: T.text, fontSize: 14, lineHeight: 1.5,
  },
  panel: {
    width: 760, maxWidth: '94vw', height: '82vh', display: 'flex', flexDirection: 'column',
    background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14,
    boxShadow: '0 24px 80px rgba(0,0,0,.45)', overflow: 'hidden',
  },
  head: { display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: `1px solid ${T.border}` },
  title: { fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 10 },
  sub: { color: T.text3, fontSize: 12 },
  spacer: { flex: 1 },
  stats: { display: 'flex', gap: 10, padding: '14px 20px', borderBottom: `1px solid ${T.border}` },
  statCard: {
    flex: 1, background: T.card, border: `1px solid ${T.border}`, borderRadius: 10,
    padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0,
  },
  statValue: { fontSize: 18, fontWeight: 600, color: T.text },
  statLabel: { fontSize: 11, color: T.text3 },
  tabBar: { display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0, padding: '0 20px', borderBottom: `1px solid ${T.border}` },
  tab: {
    display: 'inline-flex', alignItems: 'center', gap: 6, height: 38, padding: '0 14px',
    border: 'none', background: 'transparent', color: T.text2, fontSize: 13.5,
    cursor: 'pointer', fontFamily: T.font, marginBottom: -1,
    borderBottom: '2px solid transparent', transition: 'color .15s',
  },
  tabOn: { color: T.accent, borderBottomColor: T.accent, fontWeight: 500 },
  body: { flex: 1, overflow: 'auto', padding: '12px 20px 20px' },
  group: { marginTop: 8, marginBottom: 4 },
  groupHead: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px',
    color: T.text2, fontSize: 12.5, fontWeight: 600,
  },
  groupMeta: { color: T.text3, fontWeight: 400, fontSize: 12 },
  row: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8,
    border: `1px solid ${T.border}`, background: T.card, marginBottom: 6, minWidth: 0,
  },
  rowTitle: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: T.text, fontSize: 13.5 },
  rowMeta: { color: T.text3, fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0 },
  badge: {
    display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 500,
    padding: '1px 8px', borderRadius: 999, flexShrink: 0,
    background: 'color-mix(in srgb, var(--dsw-static-green-500) 12%, transparent)',
    color: 'var(--dsw-static-green-500)',
  },
  iconBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
    height: 28, padding: '0 10px', borderRadius: 7, border: 'none', cursor: 'pointer',
    background: 'transparent', color: T.text2, fontFamily: T.font, fontSize: 12.5, flexShrink: 0,
    transition: 'background .15s',
  },
  primaryBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
    height: 30, padding: '0 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
    background: T.accent, color: '#fff', fontFamily: T.font, fontSize: 13, fontWeight: 500, flexShrink: 0,
  },
  dangerBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
    height: 30, padding: '0 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
    background: T.danger, color: '#fff', fontFamily: T.font, fontSize: 13, fontWeight: 500, flexShrink: 0,
  },
  ghostBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
    height: 30, padding: '0 14px', borderRadius: 8, border: `1px solid ${T.border}`,
    background: 'transparent', color: T.text2, fontFamily: T.font, fontSize: 13, cursor: 'pointer', flexShrink: 0,
  },
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', padding: '0 20px 14px', flexWrap: 'wrap' },
  toast: {
    position: 'absolute', bottom: 18, left: '50%', transform: 'translateX(-50%)',
    padding: '9px 18px', borderRadius: 10, fontSize: 13, maxWidth: '80%',
    background: T.card, border: `1px solid ${T.border}`, boxShadow: '0 8px 30px rgba(0,0,0,.35)', zIndex: 2,
  },
  empty: { textAlign: 'center', color: T.text3, padding: '48px 0', fontSize: 13.5 },
  error: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)',
    border: `1px solid ${T.danger}`, color: T.danger, borderRadius: 10, padding: '10px 14px', marginBottom: 12, fontSize: 13,
  },
  dialogOverlay: { position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  dialog: {
    width: 420, maxWidth: '92vw', background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14,
    padding: '20px 22px', boxShadow: '0 24px 80px rgba(0,0,0,.5)', fontFamily: T.font, color: T.text, fontSize: 14,
  },
  dialogActions: { display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 },
  hint: { color: T.text3, fontSize: 12, marginTop: 6 },
}

export function ArchivePanel({ onClose, t, sessions, workspaces }: ArchivePanelProps) {
  const [tab, setTab] = useState<Tab>('current')
  const [data, setData] = useState<SessionListResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [archivedSelected, setArchivedSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null)
  const [policyPreview, setPolicyPreview] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const d = await api.listSessions()
      setData(d)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const showToast = useCallback((kind: 'ok' | 'warn' | 'err', text: string) => {
    setToast({ kind, text })
    window.setTimeout(() => setToast(null), 4000)
  }, [])

  /** Open a session in the host UI (navigates the main view to it). */
  const openSession = useCallback((id: string) => {
    try {
      sessions?.open(id)
      onClose()
    } catch {
      showToast('err', '会话不存在或已清理 / session not found')
    }
  }, [onClose, sessions, showToast])

  /** Copy the wiki-distill trigger to the clipboard (fail-soft to a hint). */
  const copyDistill = useCallback(async (): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(DISTILL_TRIGGER)
      showToast('ok', t('distill.copied'))
      return true
    } catch {
      showToast('err', DISTILL_TRIGGER)
      return false
    }
  }, [showToast, t])

  const [distillGate, setDistillGate] = useState<'archive' | 'delete' | null>(null)

  const updateStats = useCallback((stats: StatsView) => {
    setData((prev) => (prev === null ? prev : { ...prev, stats }))
  }, [])

  const doArchive = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return
      setBusy('archive')
      const skipped: string[] = []
      let done = 0
      try {
        for (const id of ids) {
          try {
            const r = await api.archiveSession(id)
            done += r.archived
            updateStats(r.stats)
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            if (msg.includes('running')) skipped.push(id)
            else throw error
          }
        }
        if (skipped.length === 0) showToast('ok', t('archive.done', { count: done }))
        else showToast('warn', t('archive.partial', { count: done, skipped: skipped.length }))
        setSelected(new Set())
        await load()
      } catch (error) {
        showToast('err', t('archive.failed', { reason: error instanceof Error ? error.message : String(error) }))
      } finally {
        setBusy(null)
      }
    },
    [load, showToast, t, updateStats],
  )

  const doRestore = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return
      setBusy('restore')
      try {
        let done = 0
        for (const id of ids) {
          const r = await api.restoreSession(id)
          done += r.restored
          updateStats(r.stats)
        }
        showToast('ok', t('restore.done', { count: done }))
        setArchivedSelected(new Set())
        await load()
      } catch (error) {
        showToast('err', error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(null)
      }
    },
    [load, showToast, t, updateStats],
  )

  const doDelete = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return
      setBusy('delete')
      try {
        for (const id of ids) {
          const r = await api.deleteSession(id)
          updateStats(r.stats)
        }
        showToast('ok', t('delete.done', { count: ids.length }))
        setArchivedSelected(new Set())
        setConfirmDelete(null)
        await load()
      } catch (error) {
        showToast('err', error instanceof Error ? error.message : String(error))
        setConfirmDelete(null)
      } finally {
        setBusy(null)
      }
    },
    [load, showToast, t, updateStats],
  )

  const doRunPolicy = useCallback(async () => {
    if (policyPreview === null) return
    setBusy('policy')
    try {
      const r = await api.runPolicy()
      showToast('ok', t('policy.done', { count: r.archived }))
      setPolicyPreview(null)
      await load()
    } catch (error) {
      showToast('err', error instanceof Error ? error.message : String(error))
      setPolicyPreview(null)
    } finally {
      setBusy(null)
    }
  }, [load, policyPreview, showToast, t])

  const stats = data?.stats

  const grouped = useMemo(() => {
    if (data === null) return []
    return data.workspaces.map((g) => ({
      group: g,
      rows: data.sessions.filter((r) => r.workspaceKey === g.key),
    }))
  }, [data])

  const fmtSize = useCallback((bytes?: number): string => {
    if (bytes === undefined || bytes <= 0) return ''
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  }, [])

  const fmtTime = useCallback((ts: number): string => {
    if (!ts) return ''
    const diff = Date.now() - ts
    const min = 60_000
    const hour = 60 * min
    const day = 24 * hour
    if (diff < min) return t('time.justNow')
    if (diff < hour) return t('time.minutesAgo', { n: Math.floor(diff / min) })
    if (diff < day) return t('time.hoursAgo', { n: Math.floor(diff / hour) })
    if (diff < 7 * day) return t('time.daysAgo', { n: Math.floor(diff / day) })
    const d = new Date(ts)
    return t('time.date', { m: d.getMonth() + 1, d: d.getDate() })
  }, [t])

  const toggleIn = useCallback((set: Set<string>, id: string): Set<string> => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }, [])

  if (loading && data === null) {
    return (
      <ModalShell onClose={onClose} t={t}>
        <div style={{ textAlign: 'center', padding: 48, color: T.text3 }}>…</div>
      </ModalShell>
    )
  }

  if (loadError !== null && data === null) {
    return (
      <ModalShell onClose={onClose} t={t}>
        <div style={S.error}>{t('error.load')}：{loadError}</div>
        <div style={{ textAlign: 'center', padding: 16 }}>
          <button type="button" style={S.primaryBtn} onClick={() => void load()}>{t('btn.retry')}</button>
        </div>
      </ModalShell>
    )
  }

  return (
    <ModalShell onClose={onClose} t={t}>
      {stats !== undefined && (
        <div style={S.stats}>
          <StatCard label={t('stat.cache')} value={stats.projcacheBytes > 0 ? `${(stats.projcacheBytes / (1024 * 1024)).toFixed(1)} ${t('stat.mb')}` : '0'} />
          <StatCard label={t('stat.sessions')} value={String(stats.totalSessions)} />
          <StatCard label={t('stat.archived')} value={String(stats.archivedCount)} />
          <StatCard label={t('stat.workspaces')} value={String(stats.workspaceCount)} />
        </div>
      )}

      <div style={{ padding: '6px 20px 0', color: T.text3, fontSize: 12 }}>
        {t('hint.fts')} · {t('hint.policy', { max: 50 })}
      </div>

      <div style={S.tabBar}>
        <button type="button" style={{ ...S.tab, ...(tab === 'current' ? S.tabOn : {}) }} onClick={() => setTab('current')}>
          {t('tab.current')} {data ? `(${data.sessions.length})` : ''}
        </button>
        <button type="button" style={{ ...S.tab, ...(tab === 'archived' ? S.tabOn : {}) }} onClick={() => setTab('archived')}>
          {t('tab.archived')} {data ? `(${data.archived.length})` : ''}
        </button>
        <div style={S.spacer} />
        <button type="button" style={S.iconBtn} title={t('btn.runPolicy')} disabled={busy !== null} onClick={() => {
          const over = data ? policyOverflow(data) : 0
          setPolicyPreview(over)
        }}>
          <IconWand size={15} /> {t('btn.runPolicy')}
        </button>
        <button type="button" style={S.iconBtn} title={t('btn.refresh')} disabled={busy !== null} onClick={() => void load()}>
          <IconRefresh size={15} />
        </button>
      </div>

      {busy !== null && (
        <div style={{ ...S.hint, padding: '8px 20px 0', color: T.text2 }}>
          {busy === 'archive' && t('archive.progress', { done: 0, total: 0 })}
          {busy === 'restore' && t('restore.done', { count: 0 })}
          {busy === 'policy' && t('policy.progress', { done: 0, total: 0 })}
        </div>
      )}

      <div style={S.body}>
        {tab === 'current' && (
          <CurrentList
            grouped={grouped}
            selected={selected}
            toggle={(id) => setSelected((s) => toggleIn(s, id))}
            setGroupSelected={(ids) => setSelected(new Set(ids))}
            t={t}
            fmtSize={fmtSize}
            fmtTime={fmtTime}
            busy={busy}
            onArchive={(id) => void doArchive([id])}
            onDistill={() => void copyDistill()}
            onOpen={(id) => openSession(id)}
          />
        )}
        {tab === 'archived' && (
          <ArchivedList
            records={data?.archived ?? []}
            selected={archivedSelected}
            toggle={(id) => setArchivedSelected((s) => toggleIn(s, id))}
            t={t}
            fmtSize={fmtSize}
            fmtTime={fmtTime}
            busy={busy}
            onRestore={(id) => void doRestore([id])}
            onDelete={(id) => setConfirmDelete([id])}
            onDistill={() => void copyDistill()}
            onOpenRestore={(id) => void doRestore([id]).then(() => openSession(id))}
          />
        )}
      </div>

      {(tab === 'current' ? selected.size > 0 : archivedSelected.size > 0) && (
        <div style={S.toolbar}>
          <span style={{ color: T.text3, fontSize: 13 }}>
            {tab === 'current' ? selected.size : archivedSelected.size} selected
          </span>
          <div style={S.spacer} />
          {tab === 'current' ? (
            <>
              <button
                type="button"
                style={S.ghostBtn}
                disabled={busy !== null}
                onClick={() => void copyDistill().then((ok) => { if (ok) setDistillGate('archive') })}
              >
                <IconWand size={15} /> {t('btn.distillThenArchive')}
              </button>
              <button type="button" style={S.primaryBtn} disabled={busy !== null} onClick={() => void doArchive([...selected])}>
                <IconArchive size={15} /> {t('btn.archiveSelected')}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                style={S.ghostBtn}
                disabled={busy !== null}
                onClick={() => void copyDistill().then((ok) => { if (ok) setDistillGate('delete') })}
              >
                <IconWand size={15} /> {t('btn.distillThenDelete')}
              </button>
              <button type="button" style={S.primaryBtn} disabled={busy !== null} onClick={() => void doRestore([...archivedSelected])}>
                <IconRestore size={15} /> {t('btn.restoreSelected')}
              </button>
              <button type="button" style={S.dangerBtn} disabled={busy !== null} onClick={() => setConfirmDelete([...archivedSelected])}>
                <IconTrash size={15} /> {t('btn.deleteSelected')}
              </button>
            </>
          )}
        </div>
      )}

      {distillGate !== null && (
        <ConfirmDialog
          title={t('btn.distill')}
          body={t('distill.confirmBody', { action: distillGate === 'archive' ? t('distill.action.archive') : t('distill.action.delete') })}
          cancelText={t('btn.cancel')}
          confirmText={t('btn.distilledContinue')}
          onCancel={() => setDistillGate(null)}
          onConfirm={() => {
            const gate = distillGate
            setDistillGate(null)
            if (gate === 'archive') void doArchive([...(tab === 'current' ? selected : [])])
            else setConfirmDelete([...(tab === 'archived' ? archivedSelected : [])])
          }}
        />
      )}

      {toast !== null && (
        <div style={{ ...S.toast, color: toast.kind === 'err' ? T.danger : toast.kind === 'warn' ? T.warn : T.success }}>
          {toast.text}
        </div>
      )}

      {confirmDelete !== null && (
        <ConfirmDialog
          title={t('delete.title', { count: confirmDelete.length })}
          body={t('delete.body')}
          cancelText={t('btn.cancel')}
          confirmText={t('btn.confirmDelete')}
          danger
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void doDelete(confirmDelete)}
        />
      )}

      {policyPreview !== null && (
        <ConfirmDialog
          title={t('policy.title')}
          body={policyPreview > 0 ? t('policy.preview', { count: policyPreview, max: 60 }) : t('policy.none')}
          cancelText={t('btn.cancel')}
          confirmText={t('btn.runPolicy')}
          onCancel={() => setPolicyPreview(null)}
          onConfirm={() => void doRunPolicy()}
          hideConfirm={policyPreview === 0}
        />
      )}
    </ModalShell>
  )
}

/** Estimated overflow count for the policy preview (keep 60 per workspace). */
function policyOverflow(data: SessionListResponse): number {
  const perWorkspace = new Map<string, number>()
  for (const row of data.sessions) {
    if (row.running) continue
    perWorkspace.set(row.workspaceKey, (perWorkspace.get(row.workspaceKey) ?? 0) + 1)
  }
  let over = 0
  for (const count of perWorkspace.values()) over += Math.max(0, count - 60)
  return over
}

function ModalShell({ children, onClose, t }: { children: React.ReactNode; onClose: () => void; t: (key: keyof Dict) => string }) {
  return (
    <div style={S.overlay} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <div style={S.panel}>
        <div style={S.head}>
          <div style={S.title}>
            <IconArchive size={17} />
            <span>{t('panel.title')}</span>
          </div>
          <div style={S.sub}>{t('panel.subtitle')}</div>
          <div style={S.spacer} />
          <button type="button" style={S.iconBtn} title={t('btn.close')} onClick={onClose}>
            <IconClose size={15} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={S.statCard}>
      <div style={S.statValue}>{value}</div>
      <div style={S.statLabel}>{label}</div>
    </div>
  )
}

function CurrentList(props: {
  grouped: Array<{ group: WorkspaceGroupView; rows: SessionRowView[] }>
  selected: Set<string>
  toggle: (id: string) => void
  setGroupSelected: (ids: string[]) => void
  t: (key: keyof Dict, vars?: Record<string, string | number>) => string
  fmtSize: (bytes?: number) => string
  fmtTime: (ts: number) => string
  busy: string | null
  onArchive: (id: string) => void
  onDistill: () => void
  onOpen: (id: string) => void
}) {
  const { grouped, selected, toggle, setGroupSelected, t, fmtSize, fmtTime, busy, onArchive, onDistill, onOpen } = props
  const [visible, setVisible] = useState<Record<string, number>>({})
  const [expandedParents, setExpandedParents] = useState<Record<string, boolean>>({})

  if (grouped.length === 0) {
    return (
      <div style={S.empty}>
        <div>{t('empty.sessions')}</div>
      </div>
    )
  }

  return (
    <div>
      {grouped.map(({ group, rows }) => {
        const count = visible[group.key] ?? PAGE_SIZE
        const shown = rows.slice(0, count)
        const noCwd = group.key === 'no-cwd'
        const dead = group.dead === true
        const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.sessionId))
        return (
          <div key={group.key} style={S.group}>
            <div style={S.groupHead}>
              <IconFolder size={14} />
              <span>
                {noCwd ? t('group.ungrouped') : dead ? t('group.dead') : (group.path ?? group.label)}
                {noCwd && <span style={S.groupMeta}> · {t('group.ungroupedHint')}</span>}
                {dead && <span style={S.groupMeta}> · {t('group.deadReason')}</span>}
              </span>
              <span style={S.groupMeta}>（{rows.length} · {fmtSize(group.totalBytes)}）</span>
              <div style={S.spacer} />
              <button
                type="button"
                style={S.iconBtn}
                onClick={() => setGroupSelected(allSelected ? [] : rows.map((r) => r.sessionId))}
              >
                {t('btn.selectGroup')}
              </button>
            </div>
            {shown.map((row) => {
              // Top-level rows: no parent, or parent not present in this list
              // (orphan whose parent was archived/deleted — treated as top-level
              // so it never shows as an unrooted sub row).
              const parentPresent = row.parentSessionId !== undefined && rows.some((r) => r.sessionId === row.parentSessionId)
              const isSub = row.parentSessionId !== undefined && parentPresent
              // Subagent rows render inside their parent's collapsible block;
              // skip them here to avoid duplication.
              if (isSub) return null
              const children = rows.filter((r) => r.parentSessionId === row.sessionId)
              const expanded = expandedParents[row.sessionId] ?? false
              return (
                <div key={row.sessionId}>
                  <div style={S.row}>
                    {children.length > 0 && (
                      <button
                        type="button"
                        style={S.iconBtn}
                        title={expanded ? t('sub.collapse') : t('sub.expand', { count: children.length })}
                        onClick={() => setExpandedParents((prev) => ({ ...prev, [row.sessionId]: !expanded }))}
                      >
                        <span style={{ display: 'inline-block', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
                      </button>
                    )}
                    <input
                      type="checkbox"
                      checked={selected.has(row.sessionId)}
                      onChange={() => toggle(row.sessionId)}
                      style={{ flexShrink: 0, width: 15, height: 15, accentColor: T.accent }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={S.rowTitle}>
                        {row.title ?? row.sessionId.slice(0, 8)}
                        {children.length > 0 && (
                          <span style={S.groupMeta}>（{children.length} 个子会话）</span>
                        )}
                      </div>
                      <div style={S.rowMeta}>
                        {fmtTime(row.updatedAt)}
                        {fmtSize(row.sizeBytes) !== '' ? ` · ${fmtSize(row.sizeBytes)}` : ''}
                      </div>
                    </div>
                    {row.running && <span style={S.badge}>{t('status.running')}</span>}
                    <button
                      type="button"
                      style={S.iconBtn}
                      disabled={busy !== null}
                      title={t('btn.open')}
                      onClick={() => onOpen(row.sessionId)}
                    >
                      {t('btn.open')}
                    </button>
                    {!row.running && (
                      <button
                        type="button"
                        style={S.iconBtn}
                        disabled={busy !== null}
                        title={t('btn.archive')}
                        onClick={() => onArchive(row.sessionId)}
                      >
                        <IconArchive size={14} /> {t('btn.archive')}
                      </button>
                    )}
                    <button type="button" style={S.iconBtn} disabled={busy !== null} title={t('btn.distill')} onClick={onDistill}>
                      <IconWand size={14} /> {t('btn.distill')}
                    </button>
                  </div>
                  {children.length > 0 && expanded && (
                    <div>
                      {children.map((child) => {
                        const childIsSub = child.parentSessionId !== undefined
                        return (
                          <div key={child.sessionId} style={{ ...S.row, marginLeft: 28, borderLeft: `2px solid ${T.border}`, background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-2) 40%, var(--dsw-alias-bg-layer-1))' }}>
                            <input
                              type="checkbox"
                              checked={selected.has(child.sessionId)}
                              onChange={() => toggle(child.sessionId)}
                              style={{ flexShrink: 0, width: 15, height: 15, accentColor: T.accent }}
                            />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={S.rowTitle}>
                                {childIsSub && <span style={{ ...S.badge, marginRight: 6, background: 'transparent', border: `1px solid ${T.border}`, color: T.text3 }}>sub</span>}
                                {child.title ?? child.sessionId.slice(0, 8)}
                              </div>
                              <div style={S.rowMeta}>
                                {fmtTime(child.updatedAt)}
                                {fmtSize(child.sizeBytes) !== '' ? ` · ${fmtSize(child.sizeBytes)}` : ''}
                                {childIsSub && child.parentSessionId !== undefined ? ` · → ${child.parentSessionId.slice(0, 8)}` : ''}
                              </div>
                            </div>
                            {child.running && <span style={S.badge}>{t('status.running')}</span>}
                            <button
                              type="button"
                              style={S.iconBtn}
                              disabled={busy !== null}
                              title={t('btn.open')}
                              onClick={() => onOpen(child.sessionId)}
                            >
                              {t('btn.open')}
                            </button>
                            {!child.running && (
                              <button
                                type="button"
                                style={S.iconBtn}
                                disabled={busy !== null}
                                title={t('btn.archive')}
                                onClick={() => onArchive(child.sessionId)}
                              >
                                <IconArchive size={14} /> {t('btn.archive')}
                              </button>
                            )}
                            <button type="button" style={S.iconBtn} disabled={busy !== null} title={t('btn.distill')} onClick={onDistill}>
                              <IconWand size={14} /> {t('btn.distill')}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
            {rows.length > shown.length && (
              <button
                type="button"
                style={{ ...S.iconBtn, margin: '4px auto', display: 'block' }}
                onClick={() => setVisible({ ...visible, [group.key]: count + PAGE_SIZE })}
              >
                {t('btn.refresh')} ({rows.length - shown.length} more)
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ArchivedList(props: {
  records: ArchiveRecordView[]
  selected: Set<string>
  toggle: (id: string) => void
  t: (key: keyof Dict, vars?: Record<string, string | number>) => string
  fmtSize: (bytes?: number) => string
  fmtTime: (ts: number) => string
  busy: string | null
  onRestore: (id: string) => void
  onDelete: (id: string) => void
  onDistill: () => void
  onOpenRestore: (id: string) => void
}) {
  const { records, selected, toggle, t, fmtSize, fmtTime, busy, onRestore, onDelete, onDistill, onOpenRestore } = props
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  if (records.length === 0) {
    return (
      <div style={S.empty}>
        <div>{t('empty.archived')}</div>
        <div style={{ marginTop: 6, fontSize: 12 }}>{t('empty.hint')}</div>
      </div>
    )
  }
  const byParent = new Map<string, ArchiveRecordView[]>()
  for (const r of records) {
    if (r.parentSessionId === undefined) continue
    const list = byParent.get(r.parentSessionId)
    if (list === undefined) byParent.set(r.parentSessionId, [r])
    else list.push(r)
  }
  const presentIds = new Set(records.map((r) => r.sessionId))
  // Top-level: no parent, or parent not in this archive list (orphan).
  const topLevel = records.filter((r) => r.parentSessionId === undefined || !presentIds.has(r.parentSessionId))

  const renderRow = (r: ArchiveRecordView, isSub: boolean, depth: number) => {
    const children = isSub ? [] : (byParent.get(r.sessionId) ?? [])
    const isOpen = expanded[r.sessionId] ?? false
    return (
      <div key={r.sessionId}>
        <div style={{ ...S.row, marginLeft: isSub ? 14 * depth : 0, ...(isSub ? { borderLeft: `2px solid ${T.border}`, background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-2) 40%, var(--dsw-alias-bg-layer-1))' } : {}) }}>
          {children.length > 0 && (
            <button
              type="button"
              style={S.iconBtn}
              title={isOpen ? t('sub.collapse') : t('sub.expand', { count: children.length })}
              onClick={() => setExpanded((prev) => ({ ...prev, [r.sessionId]: !isOpen }))}
            >
              <span style={{ display: 'inline-block', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
            </button>
          )}
          <input
            type="checkbox"
            checked={selected.has(r.sessionId)}
            onChange={() => toggle(r.sessionId)}
            style={{ flexShrink: 0, width: 15, height: 15, accentColor: T.accent }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={S.rowTitle}>
              {isSub && <span style={{ ...S.badge, marginRight: 6, background: 'transparent', border: `1px solid ${T.border}`, color: T.text3 }}>sub</span>}
              {r.title ?? r.sessionId.slice(0, 8)}
              {children.length > 0 && <span style={S.groupMeta}>（{children.length} 个子会话）</span>}
            </div>
            <div style={S.rowMeta}>
              {r.cwd ?? t('group.ungrouped')} · {fmtTime(r.archivedAt)}
              {fmtSize(r.sizeBytes) !== '' ? ` · ${fmtSize(r.sizeBytes)}` : ''}
            </div>
          </div>
          <button type="button" style={S.iconBtn} disabled={busy !== null} onClick={() => onOpenRestore(r.sessionId)}>
            {t('btn.openRestore')}
          </button>
          <button type="button" style={S.iconBtn} disabled={busy !== null} onClick={() => onRestore(r.sessionId)}>
            <IconRestore size={14} /> {t('btn.restore')}
          </button>
          <button type="button" style={S.iconBtn} disabled={busy !== null} onClick={() => onDelete(r.sessionId)}>
            <IconTrash size={14} /> {t('btn.delete')}
          </button>
          <button type="button" style={S.iconBtn} disabled={busy !== null} title={t('btn.distill')} onClick={onDistill}>
            <IconWand size={14} /> {t('btn.distill')}
          </button>
        </div>
        {children.length > 0 && isOpen && (
          <div>
            {children.map((child) => renderRow(child, true, 1))}
          </div>
        )}
      </div>
    )
  }

  return <div>{topLevel.map((r) => renderRow(r, false, 0))}</div>
}

function ConfirmDialog(props: {
  title: string
  body: string
  cancelText: string
  confirmText: string
  danger?: boolean
  hideConfirm?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const { title, body, cancelText, confirmText, danger, hideConfirm, onCancel, onConfirm } = props
  return (
    <div style={S.dialogOverlay} onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}>
      <div style={S.dialog} role="dialog" aria-modal="true">
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>{title}</div>
        <div style={{ color: T.text2, fontSize: 13.5 }}>{body}</div>
        <div style={S.dialogActions}>
          <button type="button" style={S.ghostBtn} onClick={onCancel} autoFocus>{cancelText}</button>
          {!hideConfirm && (
            <button type="button" style={danger ? S.dangerBtn : S.primaryBtn} onClick={onConfirm}>
              {confirmText}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
