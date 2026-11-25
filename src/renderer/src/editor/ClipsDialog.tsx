/** Окошко «Нарезка»: сколько клипов и какой длины, оценка расхода, ход работы и ошибки. */
import { useEffect, useMemo, useState } from 'react'
import { estimateRun } from '../../../shared/clipsAnalyze'
import { itemDur, mediaOf, neededRanges, type Item, type Project } from '../../../shared/project'
import type { AiSettings, ProgressEvent } from '../../../shared/types'
import { fmtTime } from '../format'

export interface ClipsParams {
  count: number
  minDur: number
  maxDur: number
  /** убрать старые рамки этого файла (иначе новые добавятся к ним) */
  replace: boolean
}

interface Props {
  project: Project
  target: Item
  /** у этого файла уже есть рамки */
  hasClips: boolean
  busy: boolean
  progress: ProgressEvent | null
  error: string | null
  onRun(o: ClipsParams): void
  onCancel(): void
  onClose(): void
  onOpenSettings(): void
  /** поверх открыты настройки: после закрытия перечитываем состояние ключа */
  settingsOpen: boolean
}

const KEY = 'clips-params-v1'
interface Saved {
  count: number
  minDur: number
  maxDur: number
}
const DEFAULT: Saved = { count: 8, minDur: 30, maxDur: 60 }
function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...DEFAULT, ...(JSON.parse(raw) as Partial<Saved>) }
  } catch {
    /* умолчания */
  }
  return DEFAULT
}
const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, Number.isFinite(x) ? x : a))

export default function ClipsDialog(p: Props): React.JSX.Element {
  const [s, setS] = useState<Saved>(load)
  const [replace, setReplace] = useState(false)
  const [ai, setAi] = useState<AiSettings | null>(null)
  useEffect(() => {
    if (!p.settingsOpen) void window.api.getAi().then(setAi, () => {})
  }, [p.settingsOpen])

  const media = mediaOf(p.project, p.target.mediaId)
  const jobs = useMemo(() => neededRanges(p.project, [p.target]), [p.project, p.target])
  const recognized = jobs.length === 0
  const words = useMemo(
    () => (p.project.words[p.target.mediaId] ?? []).filter((w) => w.start >= p.target.in && w.end <= p.target.out),
    [p.project.words, p.target]
  )
  const est = useMemo(() => (recognized && words.length > 0 ? estimateRun(words, { windows: { maxChars: 400_000, overlapChars: 4000 } }) : null), [recognized, words])

  const minDur = clamp(s.minDur, 10, 170)
  const maxDur = clamp(s.maxDur, minDur + 5, 180)
  const count = Math.round(clamp(s.count, 1, 20))
  const noKey = ai !== null && !ai.hasKey
  const stage = p.progress?.stage
  const pct = p.progress ? Math.round(p.progress.value * 100) : 0

  const run = (): void => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ count, minDur, maxDur }))
    } catch {
      /* не критично */
    }
    p.onRun({ count, minDur, maxDur, replace: p.hasClips && replace })
  }

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && !p.busy && p.onClose()}>
      <div className="modal" role="dialog" aria-label="Нарезка">
        <div className="pane-head">
          <span>Нарезка</span>
          <button className="btn icon small" onClick={p.onClose} disabled={p.busy} aria-label="Закрыть">
            ×
          </button>
        </div>
        <div className="modal-body">
          <p>
            ИИ найдёт в видео «{media?.name ?? '—'}» ({fmtTime(itemDur(p.target))}) самые цельные моменты и поставит рамки на строку «Клипы». Границы встанут по словам, края можно поправить.
          </p>
          <label className="insp-row">
            <span>Сколько клипов</span>
            <input type="number" min={1} max={20} value={s.count} onChange={(e) => setS({ ...s, count: Number(e.target.value) })} disabled={p.busy} />
          </label>
          <label className="insp-row">
            <span>Длина от, с</span>
            <input type="number" min={10} max={170} value={s.minDur} onChange={(e) => setS({ ...s, minDur: Number(e.target.value) })} disabled={p.busy} />
          </label>
          <label className="insp-row">
            <span>Длина до, с</span>
            <input type="number" min={15} max={180} value={s.maxDur} onChange={(e) => setS({ ...s, maxDur: Number(e.target.value) })} disabled={p.busy} />
          </label>
          {p.hasClips && (
            <div className="clips-mode" role="radiogroup" aria-label="Что делать со старыми рамками">
              <label className="check">
                <input type="radio" name="cm" checked={!replace} onChange={() => setReplace(false)} disabled={p.busy} />
                <span>Добавить к текущим (пересекающиеся пропущу)</span>
              </label>
              <label className="check">
                <input type="radio" name="cm" checked={replace} onChange={() => setReplace(true)} disabled={p.busy} />
                <span>Заменить: старые рамки этого видео удалятся вместе с правками</span>
              </label>
            </div>
          )}
          <p className="hint">
            {recognized
              ? est
                ? `Речь распознана (${words.length} слов). Запрос к ИИ: примерно ${Math.max(1, Math.round(est.inputTokens / 1000))} тыс. токенов на вход; цена зависит от выбранного ИИ.`
                : 'В этом отрезке нет речи — клипов не найти.'
              : 'Речь ещё не распознана: сначала распознаю её на этом компьютере, потом отправлю текст ИИ. Звук и видео никуда не уходят — только текст.'}
          </p>
          <p className="hint">К видео добавится дорожка субтитров: они нужны, чтобы вшить их в ролики.</p>
          {noKey && (
            <p className="hint warn">
              Не задан ключ ИИ.{' '}
              <button className="link" onClick={p.onOpenSettings}>
                Открыть настройки ИИ
              </button>
            </p>
          )}
          {p.busy && p.progress && (
            <div className="exp-progress">
              <span className="note-bar">
                <span style={{ transform: `scaleX(${p.progress.value})` }} />
              </span>
              <span className="mono dim">
                {p.progress.label}
                {stage === 'asr' ? ` — ${pct}%` : ''}
              </span>
            </div>
          )}
          {p.busy && !p.progress && <p className="hint">Готовлю…</p>}
          {p.error && <p className="hint warn">{p.error}</p>}
        </div>
        <div className="modal-actions">
          {p.busy ? (
            <button className="btn" onClick={p.onCancel} disabled={stage === 'asr' || stage === 'audio'} title={stage === 'asr' || stage === 'audio' ? 'Распознавание речи нельзя прервать — дождись конца, дальше можно отменить поиск' : undefined}>
              Отменить поиск
            </button>
          ) : (
            <button className="btn primary" onClick={run} disabled={noKey || (recognized && words.length === 0)}>
              Найти моменты
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
