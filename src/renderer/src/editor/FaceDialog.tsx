/**
 * «Следить за лицом»: окно для видеокуска. Шаги: модель поиска лиц (скачать при первом разе) → кадр с найденными лицами →
 * поиск по отрезку куска (с прогрессом и отменой, на процессоре) → трек записывается на кусок. Режимы: «Говорящий» (кадр на том, у кого
 * двигаются губы, пока в звуке есть речь) и «Лицо по щелчку» (следим за выбранным человеком).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { buildTrack, type FaceTrack, type TrackMode } from '../../../shared/face'
import { mediaOf, tlToSrc, itemDur, type Item, type Project } from '../../../shared/project'
import type { FacePreview, ProgressEvent } from '../../../shared/types'

interface Props {
  project: Project
  item: Item
  /** курсор воспроизведения, секунды таймлайна */
  time: number
  onClose(): void
  /** записать трек на кусок; ответ — построены ли ключи X (вертикальный проект) */
  onApply(track: FaceTrack): { keyed: boolean }
}

const clean = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export default function FaceDialog(p: Props): React.JSX.Element {
  const it = p.item
  const media = mediaOf(p.project, it.mediaId)
  const [step, setStep] = useState<'init' | 'model' | 'loading' | 'pick' | 'run' | 'done'>('init')
  const [error, setError] = useState<string | null>(null)
  const [pct, setPct] = useState(0)
  const [prev, setPrev] = useState<FacePreview | null>(null)
  const [sel, setSel] = useState<number | null>(null)
  const [mode, setMode] = useState<TrackMode>('speaker')
  const [result, setResult] = useState<string | null>(null)
  const cancelled = useRef(false)

  // кадр для выбора: под курсором, если он на куске, иначе начало куска
  const startSrc = useMemo(() => {
    const t = p.time >= it.start && p.time < it.start + itemDur(it) ? tlToSrc(it, p.time) : it.in
    return Math.min(Math.max(it.in, t), Math.max(it.in, it.out - 0.3))
  }, [p.time, it])

  useEffect(() => {
    const off = window.api.onProgress((e: ProgressEvent) => {
      if (e.stage === 'face' || e.stage === 'download') setPct(e.value)
    })
    return off
  }, [])

  const load = (t: number): void => {
    if (!media) return
    setError(null)
    setStep('loading')
    setSel(null)
    window.api.facePreview(media.path, t).then(
      (r) => {
        setPrev(r)
        setSel(r.boxes.length === 1 ? 0 : null)
        setStep('pick')
      },
      (e: unknown) => {
        setError(clean(e))
        setStep('pick')
      }
    )
  }

  useEffect(() => {
    window.api.faceStatus().then(
      (s) => (s.installed ? load(startSrc) : setStep('model')),
      (e: unknown) => {
        setError(clean(e))
        setStep('model')
      }
    )
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const download = (): void => {
    setError(null)
    setPct(0)
    window.api.downloadFaceModel().then(
      () => load(startSrc),
      (e: unknown) => setError(clean(e))
    )
  }

  const verticalKeys = !!p.project.canvas && !!media?.width && !!media.height && p.project.canvas.w / p.project.canvas.h < media.width / media.height - 0.02

  const start = (): void => {
    if (!media || !prev || (mode === 'seed' && sel === null)) return
    if (verticalKeys && it.keys.x.length > 0 && !window.confirm('На куске уже есть ключи положения X. Они будут заменены ключами по лицу. Продолжить?')) return
    cancelled.current = false
    setError(null)
    setPct(0)
    setStep('run')
    const seed = sel !== null && prev.boxes[sel] ? { t: prev.t, box: prev.boxes[sel] } : undefined
    window.api.faceTrack(media.path, it.in, it.out, mode === 'speaker').then(
      (scan) => {
        if (cancelled.current) return
        const track = buildTrack(scan, { mode, seed })
        const r = p.onApply(track)
        setResult(
          r.keyed
            ? `Готово: кадр ведёт ${track.length} точек (ключи X на куске, их можно двигать и править). Масштаб поставлен «заполнить кадр».`
            : 'Готово: лицо отслежено. Клипы «Нарезки» из этого куска поедут за лицом; в вертикальном проекте здесь появятся ключи X.'
        )
        setStep('done')
      },
      (e: unknown) => {
        const msg = clean(e)
        if (msg === 'Отменено' || cancelled.current) setStep('pick')
        else {
          setError(msg)
          setStep('pick')
        }
      }
    )
  }

  const stop = (): void => {
    cancelled.current = true
    void window.api.cancelFace()
    setStep('pick')
  }

  const len = it.out - it.in
  const busy = step === 'run' || step === 'loading'
  const nextT = it.in + (((startSrc - it.in + 3) % Math.max(0.5, len - 0.3)) || 0)

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && !busy && p.onClose()}>
      <div className="modal face-modal" role="dialog" aria-label="Следить за лицом">
        <div className="pane-head">
          <span>Следить за лицом</span>
          <button className="btn icon small" onClick={step === 'run' ? stop : p.onClose} aria-label="Закрыть">
            ×
          </button>
        </div>
        <div className="modal-body">
          {step === 'init' && <p className="fd-hint dim">Проверяю модель…</p>}
          {step === 'model' && (
            <>
              <p className="fd-hint">Для поиска лиц нужна небольшая модель (около 0,2 МБ). Она скачивается один раз и работает без интернета на процессоре.</p>
              {pct > 0 && pct < 1 && (
                <span className="note-bar">
                  <span style={{ transform: `scaleX(${pct})` }} />
                </span>
              )}
              <div className="modal-actions">
                <button className="btn primary" onClick={download}>
                  Скачать модель
                </button>
              </div>
            </>
          )}
          {step === 'loading' && <p className="fd-hint dim">Ищу лица на кадре…</p>}
          {step === 'pick' && prev && (
            <>
              <div className="seg" role="radiogroup" aria-label="За кем следить">
                <button role="radio" aria-checked={mode === 'speaker'} className={mode === 'speaker' ? 'on' : ''} onClick={() => setMode('speaker')}>
                  Говорящий
                </button>
                <button role="radio" aria-checked={mode === 'seed'} className={mode === 'seed' ? 'on' : ''} onClick={() => setMode('seed')}>
                  Лицо по щелчку
                </button>
              </div>
              <p className="fd-hint">
                {prev.boxes.length === 0
                  ? 'На этом кадре лиц не нашлось. Попробуй другой кадр.'
                  : mode === 'speaker'
                    ? 'Кадр будет на том, кто говорит (по движению губ и звуку). Лицо можно отметить, чтобы начать с него.'
                    : prev.boxes.length === 1
                      ? 'Нашлось одно лицо. Нажми «Начать».'
                      : 'Щёлкни по лицу, за которым следить.'}
              </p>
              <div className="fd-frame" style={{ aspectRatio: `${prev.width} / ${prev.height}` }}>
                <img src={prev.image} alt="" draggable={false} />
                {prev.boxes.map((b, i) => (
                  <button
                    key={i}
                    className={`fd-box${sel === i ? ' on' : ''}`}
                    style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
                    onClick={() => setSel(i)}
                    aria-label={`Лицо ${i + 1}`}
                    aria-pressed={sel === i}
                  />
                ))}
              </div>
              <p className="fd-meta">Кусок {len.toFixed(1).replace('.', ',')} с · поиск займёт около {Math.max(1, Math.round(len * (mode === 'speaker' ? 0.4 : 0.2)))} с на процессоре</p>
              <div className="modal-actions">
                <button className="btn" onClick={() => load(nextT)}>
                  Другой кадр
                </button>
                <button className="btn primary" onClick={start} disabled={mode === 'seed' && sel === null}>
                  Начать
                </button>
              </div>
            </>
          )}
          {step === 'run' && (
            <>
              <p className="fd-hint">{mode === 'speaker' ? 'Ищу говорящего' : 'Ищу лицо'} по куску… {Math.round(pct * 100)}%</p>
              <span className="note-bar">
                <span style={{ transform: `scaleX(${pct})` }} />
              </span>
              <div className="modal-actions">
                <button className="btn" onClick={stop}>
                  Отменить
                </button>
              </div>
            </>
          )}
          {step === 'done' && (
            <>
              <p className="fd-hint">{result}</p>
              <div className="modal-actions">
                <button className="btn primary" onClick={p.onClose}>
                  Закрыть
                </button>
              </div>
            </>
          )}
          {error && <p className="hint warn">{error}</p>}
        </div>
      </div>
    </div>
  )
}
