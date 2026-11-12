import { memo, useEffect, useRef } from 'react'
import type { Word } from '../../shared/types'
import { fmtTime } from './format'

interface RowProps {
  w: Word
  i: number
  active: boolean
  selected: boolean
  onPick(i: number): void
}

/** Строка перерисовывается только когда меняется её слово или подсветка. */
const Row = memo(function Row({ w, i, active, selected, onPick }: RowProps): React.JSX.Element {
  return (
    <button
      data-i={i}
      role="listitem"
      className={`word-row${active ? ' active' : ''}${selected ? ' selected' : ''}`}
      onClick={() => onPick(i)}
    >
      <span className="mono dim">{fmtTime(w.start)}</span>
      <span>{w.text}</span>
    </button>
  )
})

interface Props {
  words: Word[]
  /** слово, подсвеченное в подписи */
  shownIdx: number
  selected: number
  /** к какой строке прокручивать (последнее начавшееся слово) */
  scrollIdx: number
  emptyText: string
  /** стабильная ссылка: иначе memo бесполезен */
  onPick(i: number): void
}

/**
 * Список слов отдельно от App: App перерисовывается на каждом кадре проигрывания, а список —
 * только при смене слова. На 30-минутной записи (4000+ слов) это убирает подвисания по 100 мс.
 */
export default memo(function WordList(p: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (p.scrollIdx < 0) return
    ref.current?.querySelector<HTMLElement>(`[data-i="${p.scrollIdx}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [p.scrollIdx])

  return (
    <div className="word-list" role="list" ref={ref}>
      {p.words.length === 0 && <p className="empty">{p.emptyText}</p>}
      {p.words.map((w, i) => (
        <Row key={w.id} w={w} i={i} active={i === p.shownIdx} selected={i === p.selected} onPick={p.onPick} />
      ))}
    </div>
  )
})
