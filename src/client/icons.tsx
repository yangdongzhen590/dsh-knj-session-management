/**
 * One consistent 16px line-icon set (stroke = currentColor, weight 1.5).
 * Minimal set for the session-archive panel.
 */
import type { ReactNode } from 'react'

interface IconProps {
  size?: number
}

function Svg({ size = 16, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flexShrink: 0, display: 'block' }}
    >
      {children}
    </svg>
  )
}

export function IconArchive({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M2.5 5.5h11M2.5 5.5l.8 7.2c.1.5.5.8 1 .8h7.4c.5 0 .9-.3 1-.8l.8-7.2" />
      <path d="M2.5 5.5V3.8c0-.4.3-.8.8-.8h9.4c.5 0 .8.4.8.8v1.7" />
    </Svg>
  )
}

export function IconRestore({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M2.5 6.5c1.6-2 3.4-3 5.5-3 3 0 5.5 2 6.5 5M13.5 9.5c-1.6 2-3.4 3-5.5 3-3 0-5.5-2-6.5-5" />
      <path d="M2 3v3.5h3.5M14 13V9.5h-3.5" />
    </Svg>
  )
}

export function IconTrash({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M3 4.5h10M6 4.5V3.2c0-.4.3-.7.7-.7h2.6c.4 0 .7.3.7.7v1.3" />
      <path d="M4.5 4.5l.6 8.2c0 .4.4.8.8.8h4.2c.4 0 .8-.4.8-.8l.6-8.2" />
    </Svg>
  )
}

export function IconRefresh({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" />
    </Svg>
  )
}

export function IconClose({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  )
}

export function IconWand({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M3 13L10.5 5.5M10.5 5.5l-1.5-1.5M10.5 5.5l1 1M4 5.5c.5-1.2 1.6-1.6 2.5-2.5M10.5 10.5c1.2.5 1.6 1.6 2.5 2.5" />
    </Svg>
  )
}

export function IconFolder({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M2.5 4.5c0-.6.4-1 1-1h3l1.2 1.5h5.8c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1h-10c-.6 0-1-.4-1-1v-7.5z" />
    </Svg>
  )
}
