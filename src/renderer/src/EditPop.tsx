import { useEffect, useRef, useState } from 'react'

interface Props {
  text: string
  /** якорь внутри сцены, px */
  x: number
  y: number
  /** размеры сцены для ограничения положения */
  stageW: number
  onCommit(text: string, move: -1 | 0 | 1): void
  onCancel(): void
}

/** Маленькое поле правки слова поверх сцены. Enter — сохранить, Esc — отмена, Tab / Shift+Tab — соседнее слово. */
export default function EditPop(p: Props): React.JSX.Element {
  const [value, setValue] = useState(p.text)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const finish = (move: -1 | 0 | 1): void => {
    if (done.current) return
    done.current = true
    p.onCommit(value, move)
  }

  const width = 220
  const left = Math.min(Math.max(p.x - width / 2, 8), Math.max(8, p.stageW - width - 8))

  return (
    <div className="edit-pop" style={{ left, top: p.y }} onClick={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => finish(0)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            finish(0)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            done.current = true
            p.onCancel()
          } else if (e.key === 'Tab') {
            e.preventDefault()
            finish(e.shiftKey ? -1 : 1)
          }
        }}
        aria-label="Текст слова"
      />
      <span className="hint tight">Enter — сохранить · Esc — отмена · Tab — следующее · пробел делит слово</span>
    </div>
  )
}
