/**
 * «Скачать по ссылке»: ссылка → «Найти» → название, превью и список качеств → «Скачать». Окно закрывается сразу:
 * загрузка идёт в фоне, строка с процентами появляется в «Медиа», а готовый файл попадает в библиотеку проекта.
 * При первом разе сам скачивается загрузчик видео (yt-dlp) — прогресс виден здесь же.
 */
import { useEffect, useRef, useState } from 'react'
import type { DlInfo } from '../../../shared/download'
import type { ProgressEvent } from '../../../shared/types'
import { fmtBytes, fmtTime } from '../format'

interface Props {
  /** проект, в библиотеку которого попадёт файл */
  projectKey: string
  onClose(): void
  /** загрузка поставлена: id задачи и картинка превью для строки в «Медиа» */
  onStarted(id: string, thumb: string | null): void
}

const clean = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Что выбрать сразу: самое большое видео до 1080p, иначе первое в списке. */
const defaultFormat = (i: DlInfo): number => {
  const k = i.formats.findIndex((f) => f.kind === 'video' && (f.height ?? 0) <= 1080)
  return k >= 0 ? k : 0
}

export default function DownloadDialog(p: Props): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [step, setStep] = useState<'input' | 'search' | 'pick'>('input')
  const [info, setInfo] = useState<DlInfo | null>(null)
  const [sel, setSel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [pct, setPct] = useState<number | null>(null)
  const alive = useRef(true)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    alive.current = true
    // заодно главный процесс проверяет, не вышел ли свежий загрузчик (не чаще раза в 12 часов)
    void window.api.dlStatus().catch(() => {})
    const off = window.api.onProgress((e: ProgressEvent) => {
      if (e.stage === 'download' && e.label.includes('загрузчик')) setPct(e.value >= 1 ? null : e.value)
    })
    return () => {
      alive.current = false
      off()
    }
  }, [])
  useEffect(() => {
    if (step === 'input') inputRef.current?.focus()
  }, [step])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && step !== 'search') p.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, p])

  const search = async (): Promise<void> => {
    const u = url.trim()
    if (!u || step === 'search') return
    setError(null)
    setPct(null)
    setStep('search')
    try {
      const i = await window.api.dlInfo(u)
      if (!alive.current) return
      setInfo(i)
      setSel(defaultFormat(i))
      setStep('pick')
    } catch (e) {
      if (!alive.current) return
      setError(clean(e))
      setStep('input')
    }
  }

  const start = async (): Promise<void> => {
    const f = info?.formats[sel]
    if (!info || !f) return
    try {
      const id = await window.api.dlStart({ projectKey: p.projectKey, url: info.url, title: info.title, duration: info.duration, kind: f.kind, label: f.label, formatId: f.formatId, filesize: f.filesize })
      p.onStarted(id, info.thumbnail)
      p.onClose()
    } catch (e) {
      setError(clean(e))
    }
  }

  const installing = step === 'search' && pct !== null
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && step !== 'search' && p.onClose()}>
      <div className="modal dl-modal" role="dialog" aria-label="Скачать по ссылке">
        <div className="pane-head">
          <span>Скачать по ссылке</span>
          <button className="btn icon small" onClick={p.onClose} aria-label="Закрыть">
            ×
          </button>
        </div>
        <div className="modal-body">
          {step !== 'pick' && (
            <>
              <form
                className="dl-url"
                onSubmit={(e) => {
                  e.preventDefault()
                  void search()
                }}
              >
                <input ref={inputRef} type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Ссылка на видео" spellCheck={false} disabled={step === 'search'} aria-label="Ссылка на видео" />
                <button className="btn primary" type="submit" disabled={step === 'search' || !url.trim()}>
                  Найти
                </button>
              </form>
              {error && <p className="fd-hint warn">{error}</p>}
              {step === 'search' && (
                <>
                  <p className="fd-hint dim">{installing ? `Скачиваю загрузчик видео · ${Math.round((pct ?? 0) * 100)}%` : 'Ищу ролик…'}</p>
                  {installing && (
                    <span className="note-bar">
                      <span style={{ transform: `scaleX(${pct})` }} />
                    </span>
                  )}
                </>
              )}
            </>
          )}
          {step === 'pick' && info && (
            <>
              <div className="dl-head">
                <div className="dl-thumb">{info.thumbnail ? <img src={info.thumbnail} alt="" draggable={false} /> : <span className="dim">нет картинки</span>}</div>
                <div className="dl-meta">
                  <span className="dl-title" title={info.title}>
                    {info.title}
                  </span>
                  <span className="dim mono">
                    {info.source}
                    {info.duration ? ` · ${fmtTime(info.duration).replace(/\.\d+$/, '')}` : ''}
                  </span>
                </div>
              </div>
              <div className="dl-formats" role="radiogroup" aria-label="Качество">
                {info.formats.map((f, i) => (
                  <button key={f.formatId} role="radio" aria-checked={sel === i} className={`dl-fmt${sel === i ? ' on' : ''}`} onClick={() => setSel(i)}>
                    <span className="dl-fmt-label mono">{f.label}</span>
                    <span className="dim">{f.kind === 'audio' ? 'Только звук' : 'Видео со звуком'}</span>
                    <span className="dim mono dl-fmt-size">{f.filesize ? `≈ ${fmtBytes(f.filesize)}` : ''}</span>
                  </button>
                ))}
              </div>
              {error && <p className="fd-hint warn">{error}</p>}
              <div className="modal-actions">
                <button
                  className="btn"
                  onClick={() => {
                    setStep('input')
                    setInfo(null)
                    setError(null)
                  }}
                >
                  Другая ссылка
                </button>
                <button className="btn primary" onClick={() => void start()}>
                  Скачать
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
