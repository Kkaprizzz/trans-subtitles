/** Диалог экспорта таймлайна одним файлом. */
import { useEffect, useMemo, useState } from 'react'
import { orderedClips } from '../../../shared/cut'
import { projectDuration, timelineWords, type Project } from '../../../shared/project'
import type { ClipsExportResult, ExportRequest, ExportResult, H264Quality, ProgressEvent, RenderFormat } from '../../../shared/types'
import { fmtTime } from '../format'

interface Props {
  project: Project
  progress: ProgressEvent | null
  onClose(): void
  onBusy(v: boolean): void
}

interface Saved {
  format: ExportRequest['format']
  quality: H264Quality
  burn: boolean
  overlayFormat: RenderFormat
  green: string
}

const fmtMB = (b: number): string => `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} МБ`
const clean = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export default function ExportDialog(p: Props): React.JSX.Element {
  const [s, setS] = useState<Saved>({ format: 'h264', quality: 'medium', burn: true, overlayFormat: 'animation', green: '#00FF00' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ExportResult | null>(null)
  const [clipsResult, setClipsResult] = useState<ClipsExportResult | null>(null)
  // режим «Папка клипов»: список рамок с галочками (по умолчанию — включённые и стоящие на таймлайне)
  const list = useMemo(() => orderedClips(p.project), [p.project])
  const [mode, setMode] = useState<'timeline' | 'clips'>('timeline')
  const [picked, setPicked] = useState<Set<string>>(() => new Set(orderedClips(p.project).filter((c) => c.clip.enabled && c.at).map((c) => c.clip.id)))
  const [writeText, setWriteText] = useState(true)
  const cv = p.project.canvas ?? { w: 1920, h: 1080 }
  const hasSubs = timelineWords(p.project).length > 0
  const dur = projectDuration(p.project)

  // значения по умолчанию — из настроек приложения (раздел «Экспорт»)
  useEffect(() => {
    void window.api.getAppSettings().then((st) => setS((x) => ({ ...x, format: st.exportFormat, quality: st.exportQuality })), () => {})
  }, [])

  const runClips = async (): Promise<void> => {
    setError(null)
    setResult(null)
    setClipsResult(null)
    setBusy(true)
    p.onBusy(true)
    try {
      const r = await window.api.exportClips(p.project, {
        clipIds: list.filter((c) => picked.has(c.clip.id) && c.at).map((c) => c.clip.id),
        quality: s.quality,
        burnSubtitles: s.burn && hasSubs,
        writeText
      })
      if (r) setClipsResult(r)
    } catch (e) {
      const msg = clean(e)
      if (msg !== 'Отменено') setError(msg)
    } finally {
      setBusy(false)
      p.onBusy(false)
    }
  }

  const run = async (): Promise<void> => {
    setError(null)
    setResult(null)
    setClipsResult(null)
    setBusy(true)
    p.onBusy(true)
    try {
      const r = await window.api.exportTimeline(p.project, {
        format: s.format,
        quality: s.quality,
        width: cv.w,
        height: cv.h,
        fps: p.project.fps,
        burnSubtitles: s.burn && hasSubs,
        overlayFormat: s.overlayFormat,
        greenColor: s.green
      })
      if (r) setResult(r)
    } catch (e) {
      const msg = clean(e)
      if (msg !== 'Отменено') setError(msg)
    } finally {
      setBusy(false)
      p.onBusy(false)
    }
  }

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && !busy && p.onClose()}>
      <div className="modal" role="dialog" aria-label="Экспорт">
        <div className="pane-head">
          <span>Экспорт</span>
          <button className="btn icon small" onClick={p.onClose} disabled={busy} aria-label="Закрыть">
            ×
          </button>
        </div>
        <div className="modal-body">
          {list.length > 0 && (
            <div className="seg" role="radiogroup" aria-label="Что экспортировать">
              <button role="radio" aria-checked={mode === 'timeline'} className={mode === 'timeline' ? 'on' : ''} onClick={() => setMode('timeline')} disabled={busy}>
                Весь таймлайн
              </button>
              <button role="radio" aria-checked={mode === 'clips'} className={mode === 'clips' ? 'on' : ''} onClick={() => setMode('clips')} disabled={busy}>
                Папка клипов · {list.length}
              </button>
            </div>
          )}
          {mode === 'clips' ? (
            <>
              <p className="dim mono">1080×1920 · {p.project.fps} fps · MP4 · по ролику на клип</p>
              <ul className="exp-clips">
                {list.map(({ clip, at }, i) => (
                  <li key={clip.id}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={picked.has(clip.id) && !!at}
                        disabled={!at || busy}
                        onChange={(e) =>
                          setPicked((x) => {
                            const n = new Set(x)
                            if (e.target.checked) n.add(clip.id)
                            else n.delete(clip.id)
                            return n
                          })
                        }
                      />
                      <span>
                        {String(i + 1).padStart(2, '0')} · {clip.title || 'Без названия'}
                      </span>
                    </label>
                    <span className="mono dim">{at ? `${(at.end - at.start).toFixed(0)} с` : 'видео убрано'}</span>
                  </li>
                ))}
              </ul>
              <label className="insp-row">
                <span>Качество</span>
                <select value={s.quality} onChange={(e) => setS({ ...s, quality: e.target.value as H264Quality })} disabled={busy}>
                  <option value="high">Высокое</option>
                  <option value="medium">Среднее</option>
                  <option value="small">Малый размер</option>
                </select>
              </label>
              <label className="check">
                <input type="checkbox" checked={s.burn && hasSubs} disabled={!hasSubs || busy} onChange={(e) => setS({ ...s, burn: e.target.checked })} />
                <span>{hasSubs ? 'Вшить субтитры' : 'Субтитров на таймлайне нет'}</span>
              </label>
              <label className="check">
                <input type="checkbox" checked={writeText} disabled={busy} onChange={(e) => setWriteText(e.target.checked)} />
                <span>Положить рядом .txt: заголовок, описание, хэштеги</span>
              </label>
              {busy && p.progress?.stage === 'render' && (
                <div className="exp-progress">
                  <span className="note-bar">
                    <span style={{ transform: `scaleX(${p.progress.value})` }} />
                  </span>
                  <span className="mono dim">{p.progress.label}</span>
                </div>
              )}
              {error && <p className="hint warn">{error}</p>}
              {clipsResult && (
                <p className="render-result">
                  <span>
                    Готово: {clipsResult.clips} клипов за {clipsResult.seconds.toFixed(0)} с, {fmtMB(clipsResult.bytes)}
                  </span>
                  <button className="link" onClick={() => void window.api.revealFile(clipsResult.files[0])}>
                    Показать папку
                  </button>
                </p>
              )}
            </>
          ) : (
            <>
          <p className="dim mono">
            {cv.w}×{cv.h} · {p.project.fps} fps · {fmtTime(dur)}
          </p>
          <label className="insp-row">
            <span>Формат</span>
            <select value={s.format} onChange={(e) => setS({ ...s, format: e.target.value as ExportRequest['format'] })} disabled={busy}>
              <option value="h264">MP4 · H.264 — для публикации</option>
              <option value="prores422">MOV · ProRes 422 — мастер-копия</option>
              <option value="overlay">Только субтитры — для наложения в другом редакторе</option>
            </select>
          </label>
          {s.format === 'overlay' && (
            <>
              <label className="insp-row">
                <span>Файл</span>
                <select value={s.overlayFormat} onChange={(e) => setS({ ...s, overlayFormat: e.target.value as RenderFormat })} disabled={busy}>
                  <option value="animation">MOV · Animation · альфа</option>
                  <option value="prores4444">MOV · ProRes 4444 · альфа</option>
                  <option value="h264-green">MP4 · H.264 · зелёный фон</option>
                </select>
              </label>
              {s.overlayFormat === 'h264-green' && (
                <label className="insp-row">
                  <span>Цвет фона</span>
                  <input type="text" className="mono" value={s.green} onChange={(e) => setS({ ...s, green: e.target.value })} disabled={busy} />
                </label>
              )}
            </>
          )}
          <label className="insp-row">
            <span>Качество</span>
            <select value={s.quality} onChange={(e) => setS({ ...s, quality: e.target.value as H264Quality })} disabled={busy}>
              <option value="high">Высокое</option>
              <option value="medium">Среднее</option>
              <option value="small">{s.format === 'prores422' ? 'ProRes 422 (не HQ)' : 'Малый размер'}</option>
            </select>
          </label>
          {s.format !== 'overlay' && (
            <label className="check">
              <input type="checkbox" checked={s.burn && hasSubs} disabled={!hasSubs || busy} onChange={(e) => setS({ ...s, burn: e.target.checked })} />
              <span>{hasSubs ? 'Вшить субтитры' : 'Субтитров на таймлайне нет'}</span>
            </label>
          )}
          {s.format === 'overlay' && !hasSubs && <p className="hint warn">На таймлайне нет субтитров: нажми «Субтитры».</p>}
          {busy && p.progress?.stage === 'render' && (
            <div className="exp-progress">
              <span className="note-bar">
                <span style={{ transform: `scaleX(${p.progress.value})` }} />
              </span>
              <span className="mono dim">{p.progress.label}</span>
            </div>
          )}
          {error && <p className="hint warn">{error}</p>}
          {result && (
            <p className="render-result">
              <span>
                Готово за {result.seconds.toFixed(0)} с, {fmtMB(result.bytes)}
              </span>
              <button className="link" onClick={() => void window.api.revealFile(result.path)}>
                Показать файл
              </button>
            </p>
          )}
            </>
          )}
        </div>
        <div className="modal-actions">
          {busy ? (
            <button className="btn" onClick={() => void window.api.cancelRender()}>
              Отменить
            </button>
          ) : mode === 'clips' ? (
            <button className="btn primary" onClick={() => void runClips()} disabled={!list.some((c) => picked.has(c.clip.id) && c.at)}>
              Экспортировать клипы
            </button>
          ) : (
            <button className="btn primary" onClick={() => void run()} disabled={dur <= 0 || (s.format === 'overlay' && !hasSubs)}>
              Экспортировать
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
