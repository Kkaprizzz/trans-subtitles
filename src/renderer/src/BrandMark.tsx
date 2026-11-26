import type { CSSProperties, ReactElement } from 'react'

/** Знак Бобины («Лента»): та же геометрия, что в build/logo-mark.svg и на заставке. Цвет — от текста (currentColor). */
export function BrandMark({ size = 16, style }: { size?: number; style?: CSSProperties }): ReactElement {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} fill="none" stroke="currentColor" style={style} aria-hidden="true">
      <circle cx="34" cy="36" r="20" strokeWidth="10" />
      <path d="M34 56V70Q34 80 44 80H94" strokeWidth="8" />
      <path d="M54 92H80" strokeWidth="8" />
      <circle cx="34" cy="36" r="4" fill="currentColor" stroke="none" />
    </svg>
  )
}
