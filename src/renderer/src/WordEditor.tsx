import { useState } from 'react'
import type { Word } from '../../shared/types'

interface Props {
  /** выделенное слово (время уже со сдвигом, как на экране) */
  word: Word | null
  canMerge: boolean
  onText(text: string): void
  onTime(patch: { start?: number; end?: number }, key: string): void
  onNudge(which: 'start' | 'end', dir: 1 | -1): void
  onMerge(): void
  onDelete(): void
  onPlay(): void
}

function TimeField(p: {
  label: string
  value: number
  onCommit(v: number): void
  onNudge(dir: 1 | -1): void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? p.value.toFixed(2)
  const commit = (): void => {
    if (draft === null) return
    const v = Number(draft.replace(',', '.'))
    setDraft(null)
    if (Number.isFinite(v)) p.onCommit(v)
  }
  return (
    <div className="time-field">
      <span>{p.label}</span>
      <button className="btn step" onClick={() => p.onNudge(-1)} aria-label={`${p.label}: на 20 мс раньше`} title="−20 мс">
        −
      </button>
      <input
        className="mono"
        inputMode="decimal"
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setDraft(null)
        }}
        aria-label={`${p.label}, секунды`}
      />
      <button className="btn step" onClick={() => p.onNudge(1)} aria-label={`${p.label}: на 20 мс позже`} title="+20 мс">
        +
      </button>
    </div>
  )
}

export default function WordEditor(p: Props): React.JSX.Element {
  const w = p.word
  const [draft, setDraft] = useState<{ id: number; text: string } | null>(null)

  if (!w) {
    return (
      <div className="word-editor empty">
        <p className="hint tight">Выбери слово в списке или кликни по подписи на видео, чтобы поправить текст и время.</p>
      </div>
    )
  }

  const text = draft && draft.id === w.id ? draft.text : w.text
  const commitText = (): void => {
    if (draft && draft.id === w.id && draft.text !== w.text) p.onText(draft.text)
    setDraft(null)
  }

  return (
    <div className="word-editor">
      <label className="we-row">
        <span>Текст</span>
        <input
          value={text}
          onChange={(e) => setDraft({ id: w.id, text: e.target.value })}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') setDraft(null)
          }}
          title="Пробел внутри делит слово на два"
        />
      </label>
      <TimeField label="Начало" value={w.start} onCommit={(v) => p.onTime({ start: v }, `t-${w.id}-s`)} onNudge={(d) => p.onNudge('start', d)} />
      <TimeField label="Конец" value={w.end} onCommit={(v) => p.onTime({ end: v }, `t-${w.id}-e`)} onNudge={(d) => p.onNudge('end', d)} />
      <div className="we-actions">
        <button className="btn" onClick={p.onPlay} title="Проиграть только это слово">
          Слово ▸
        </button>
        <button className="btn" onClick={p.onMerge} disabled={!p.canMerge} title="Склеить со следующим словом">
          Объединить
        </button>
        <button className="btn" onClick={p.onDelete} title="Убрать слово">
          Удалить
        </button>
      </div>
    </div>
  )
}
