/**
 * Sidebar entry: a native-looking "会话管理" row (icon + label) mounted in the
 * left sidebar's footer.action slot. Clicking opens the archive panel.
 */
import { useState } from 'react'
import type { Dict } from './locales.ts'
import type { SessionsService, WorkspacesService } from './index.ts'
import { ArchivePanel } from './ArchivePanel.tsx'
import { IconArchive } from './icons.tsx'

export interface ArchiveEntryProps {
  t: (key: keyof Dict, vars?: Record<string, string | number>) => string
  sessions?: SessionsService
  workspaces?: WorkspacesService
}

export function ArchiveEntry({ t, sessions, workspaces }: ArchiveEntryProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        title={t('entry.label')}
        onClick={() => setOpen(true)}
        style={{
          boxSizing: 'border-box',
          cursor: 'pointer',
          width: 'calc(100% + 4px)',
          height: 42,
          color: 'var(--dsw-alias-label-primary)',
          background: 'transparent',
          border: 'none',
          borderRadius: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          margin: '4px -2px',
          padding: '0 10px 0 8px',
          fontFamily: 'inherit',
          fontSize: 14,
          lineHeight: '22px',
          justifyContent: 'flex-start',
          transition: 'background .15s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
      >
        <span style={{ display: 'inline-flex', color: 'var(--dsw-alias-label-secondary)', flexShrink: 0 }}>
          <IconArchive size={16} />
        </span>
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', flex: 1, textAlign: 'left' }}>{t('entry.label')}</span>
      </button>
      {open && <ArchivePanel onClose={() => setOpen(false)} t={t} sessions={sessions} workspaces={workspaces} />}
    </>
  )
}
