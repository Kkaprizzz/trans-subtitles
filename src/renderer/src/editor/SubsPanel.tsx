/** Инспектор дорожки субтитров: вкладки «Слова» (список + правка слова) и «Стиль». */
import { memo, useCallback, useMemo } from 'react'
import { findActive, type SubtitleStyle } from '../../../shared/timeline'
import type { TlWord } from '../../../shared/project'
import { NUDGE } from '../../../shared/edit'
import { plural } from '../format'
import StylePanel from '../StylePanel'
import WordEditor from '../WordEditor'
import WordList from '../WordList'

export type SubsTab = 'words' | 'style'

interface Props {
  words: TlWord[]
  time: number
  style: SubtitleStyle
  selected: number
  tab: SubsTab
  onTab(t: SubsTab): void
  onPick(i: number): void
  onText(i: number, text: string): void
  onTime(i: number, patch: { start?: number; end?: number }, key: string): void
  onMerge(i: number): void
  onDelete(i: number): void
  onPlay(i: number): void
  onStyle(patch: Partial<SubtitleStyle>): void
  onStyleReset(): void
}

function SubsPanel(p: Props): React.JSX.Element {
  const active = useMemo(() => findActive(p.words, p.time), [p.words, p.time])
  const sel = p.selected >= 0 && p.selected < p.words.length ? p.selected : -1
  const pick = useCallback((i: number) => p.onPick(i), [p.onPick]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside className="inspector">
      <div className="tabs" role="tablist">
        {(
          [
            ['words', 'Слова'],
            ['style', 'Стиль']
          ] as Array<[SubsTab, string]>
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={p.tab === id} className={p.tab === id ? 'on' : ''} onClick={() => p.onTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {p.tab === 'words' ? (
        <div className="transcript">
          <div className="panel-title">
            <span>Субтитры</span>
            <span className="mono dim">
              {p.words.length} {plural(p.words.length, 'слово', 'слова', 'слов')}
            </span>
          </div>
          <WordList words={p.words} shownIdx={active} selected={sel} scrollIdx={active} emptyText="Слов нет: нажми «Субтитры» на выделенном видео" onPick={pick} />
          <WordEditor
            word={sel >= 0 ? p.words[sel] : null}
            canMerge={sel >= 0 && sel < p.words.length - 1}
            onText={(text) => p.onText(sel, text)}
            onTime={(patch, key) => p.onTime(sel, patch, key)}
            onNudge={(which, dir) => {
              const w = p.words[sel]
              if (w) p.onTime(sel, { [which]: w[which] + dir * NUDGE }, `n-${w.itemId}-${w.idx}-${which}`)
            }}
            onMerge={() => p.onMerge(sel)}
            onDelete={() => p.onDelete(sel)}
            onPlay={() => p.onPlay(sel)}
          />
        </div>
      ) : (
        <div className="tab-body">
          <StylePanel style={p.style} onChange={p.onStyle} onReset={p.onStyleReset} />
        </div>
      )}
    </aside>
  )
}

export default memo(SubsPanel)

