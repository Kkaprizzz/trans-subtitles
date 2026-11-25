/**
 * Верхнее меню в теме приложения. Щелчок открывает раздел, при открытом меню наведение переключает соседний,
 * Esc и щелчок мимо закрывают. Сами сочетания клавиш обрабатываются там, где живут команды; здесь — только подписи.
 */
import { useEffect, useRef, useState } from 'react'

export type MenuItem = { label: string; shortcut?: string; disabled?: boolean; action: () => void } | 'sep'
export interface Menu {
  label: string
  items: MenuItem[]
}

export default function MenuBar({ menus }: { menus: Menu[] }): React.JSX.Element {
  const [open, setOpen] = useState<number | null>(null)
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    if (open === null) return
    const down = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(null)
      }
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [open])

  return (
    <nav className="menubar" ref={ref} aria-label="Меню">
      {menus.map((m, i) => (
        <div key={m.label} className="mb-root">
          <button
            className={`mb-top${open === i ? ' on' : ''}`}
            aria-haspopup="menu"
            aria-expanded={open === i}
            onClick={() => setOpen(open === i ? null : i)}
            onPointerEnter={() => open !== null && open !== i && setOpen(i)}
          >
            {m.label}
          </button>
          {open === i && (
            <div className="mb-drop" role="menu">
              {m.items.map((it, k) =>
                it === 'sep' ? (
                  <div key={`s${k}`} className="mb-sep" role="separator" />
                ) : (
                  <button
                    key={it.label}
                    role="menuitem"
                    className="mb-item"
                    disabled={it.disabled}
                    onClick={() => {
                      setOpen(null)
                      it.action()
                    }}
                  >
                    <span>{it.label}</span>
                    {it.shortcut && <span className="mb-key mono">{it.shortcut}</span>}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      ))}
    </nav>
  )
}
