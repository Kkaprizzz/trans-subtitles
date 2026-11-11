import { useMemo, useState } from 'react'
import type { SubtitleStyle } from '../../shared/timeline'
import type {
  H264Quality,
  MediaInfo,
  ProgressEvent,
  RenderFormat,
  RenderRequest,
  RenderResult,
  Word
} from '../../shared/types'
import { resolveFps, resolveSize, type Settings } from './renderSettings'

const FORMATS: Array<{ id: RenderFormat; label: string }> = [
  { id: 'animation', label: 'MOV · Animation · альфа' },
  { id: 'prores4444', label: 'MOV · ProRes 4444 · альфа*' },
  { id: 'h264-green', label: 'MP4 · H.264 · зелёный фон' }
]

const SIZES: Array<{ id: string; label: string }> = [
  { id: 'source', label: 'Как у исходника' },
  { id: '1080x1920', label: '1080×1920 · 9:16' },
  { id: '1920x1080', label: '1920×1080 · 16:9' },
  { id: '1080x1080', label: '1080×1080 · 1:1' },
  { id: '1080x1350', label: '1080×1350 · 4:5' },
  { id: '2160x3840', label: '2160×3840 · 4K вертикаль' },
  { id: '3840x2160', label: '3840×2160 · 4K' },
  { id: 'custom', label: 'Свой размер' }
]

const FPS_LIST = ['source', '24', '25', '30', '50', '60']
const QUALITY: Array<{ id: H264Quality; label: string }> = [
  { id: 'high', label: 'Высокое' },
  { id: 'medium', label: 'Среднее' },
  { id: 'small', label: 'Малый размер' }
]

const fmtMB = (b: number): string => `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} МБ`

interface Props {
  media: MediaInfo | null
  settings: Settings
  onSettingsChange(patch: Partial<Settings>): void
  /** слова уже со сдвигом */
  words: Word[]
  style: SubtitleStyle
  shiftMs: number
  onShiftChange(v: number): void
  progress: ProgressEvent | null
  /** занято чем-то другим (распознавание, загрузка модели) */
  otherBusy: boolean
  onBusyChange(v: boolean): void
  onError(msg: string | null): void
}

export default function RenderPanel(p: Props): React.JSX.Element {
  const s = p.settings
  const [rendering, setRendering] = useState(false)
  const [result, setResult] = useState<RenderResult | null>(null)

  const set = <K extends keyof Settings>(k: K, v: Settings[K]): void => p.onSettingsChange({ [k]: v } as Partial<Settings>)
  const size = useMemo(() => resolveSize(s, p.media), [s, p.media])
  const fps = resolveFps(s, p.media)
  const canRender = !!p.media && p.words.length > 0 && !p.otherBusy && !rendering

  const start = async (): Promise<void> => {
    if (!p.media) return
    p.onError(null)
    setResult(null)
    setRendering(true)
    p.onBusyChange(true)
    const req: RenderRequest = {
      words: p.words,
      style: p.style,
      duration: p.media.duration,
      width: size.w,
      height: size.h,
      fps,
      format: s.format,
      quality: s.quality,
      greenColor: s.green,
      withAudio: s.withAudio && !!p.media.hasAudio,
      sourcePath: p.media.path,
      suggestedName: p.media.name.replace(/\.[^.]+$/, ''),
      suggestedDir: p.media.path.replace(/[/\\][^/\\]+$/, '')
    }
    try {
      const r = await window.api.render(req)
      if (r) setResult(r)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!/Отменено/.test(msg)) p.onError(msg)
    } finally {
      setRendering(false)
      p.onBusyChange(false)
    }
  }

  const renderProgress = rendering && p.progress?.stage === 'render' ? p.progress : null

  return (
    <section className="render-panel">
      <div className="panel-title">
        <span>Итоговый файл</span>
        <span className="mono dim">
          {size.w}×{size.h} · {Number.isInteger(fps) ? fps : fps.toFixed(2)} fps
        </span>
      </div>

      <div className="form">
        <label className="row">
          <span>Формат</span>
          <select value={s.format} onChange={(e) => set('format', e.target.value as RenderFormat)} disabled={rendering}>
            {FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>

        <label className="row">
          <span>Размер</span>
          <select value={s.size} onChange={(e) => set('size', e.target.value)} disabled={rendering}>
            {SIZES.map((z) => (
              <option key={z.id} value={z.id}>
                {z.label}
              </option>
            ))}
          </select>
        </label>

        {s.size === 'custom' && (
          <div className="row">
            <span />
            <span className="pair">
              <input
                type="number"
                min={16}
                max={7680}
                step={2}
                value={s.customW}
                onChange={(e) => set('customW', Number(e.target.value))}
                disabled={rendering}
                aria-label="Ширина"
              />
              <span className="dim">×</span>
              <input
                type="number"
                min={16}
                max={7680}
                step={2}
                value={s.customH}
                onChange={(e) => set('customH', Number(e.target.value))}
                disabled={rendering}
                aria-label="Высота"
              />
            </span>
          </div>
        )}

        <label className="row">
          <span>FPS</span>
          <select value={s.fps} onChange={(e) => set('fps', e.target.value)} disabled={rendering}>
            {FPS_LIST.map((f) => (
              <option key={f} value={f}>
                {f === 'source' ? 'Как у исходника' : f}
              </option>
            ))}
          </select>
        </label>

        {s.format === 'h264-green' && (
          <>
            <label className="row">
              <span>Качество</span>
              <select value={s.quality} onChange={(e) => set('quality', e.target.value as H264Quality)} disabled={rendering}>
                {QUALITY.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="row">
              <span>Фон</span>
              <span className="pair">
                <input
                  type="color"
                  value={s.green}
                  onChange={(e) => set('green', e.target.value.toUpperCase())}
                  disabled={rendering}
                  aria-label="Цвет фона"
                />
                <span className="mono dim">{s.green}</span>
              </span>
            </label>
          </>
        )}

        <label className="row">
          <span>Звук</span>
          <span className="check">
            <input
              type="checkbox"
              checked={s.withAudio && !!p.media?.hasAudio}
              onChange={(e) => set('withAudio', e.target.checked)}
              disabled={rendering || !p.media?.hasAudio}
            />
            <span>{p.media && !p.media.hasAudio ? 'в исходнике нет звука' : 'добавить из исходника'}</span>
          </span>
        </label>

        <label className="row">
          <span>Сдвиг, мс</span>
          <input
            type="number"
            step={20}
            min={-2000}
            max={2000}
            value={p.shiftMs}
            onChange={(e) => p.onShiftChange(Number(e.target.value))}
            disabled={rendering}
            title="Двигает все слова по времени: минус — раньше, плюс — позже. Действует и на превью."
          />
        </label>
      </div>

      {s.format === 'prores4444' && (
        <p className="hint">* ProRes с альфой в некоторых редакторах (Windows) показывает чёрный фон — проверь в своём.</p>
      )}

      <div className="render-actions">
        {rendering ? (
          <>
            <div className="render-status mono">{renderProgress?.label ?? 'Запускаю…'}</div>
            <button className="btn" onClick={() => void window.api.cancelRender()}>
              Отмена
            </button>
          </>
        ) : (
          <button
            className="btn primary wide"
            onClick={() => void start()}
            disabled={!canRender}
            title={p.words.length === 0 ? 'Сначала распознай речь' : undefined}
          >
            Рендер…
          </button>
        )}
      </div>

      {result && !rendering && (
        <div className="render-result">
          <span>
            Готово · {fmtMB(result.bytes)} · {result.seconds.toFixed(0)} с
          </span>
          <button className="link" onClick={() => void window.api.revealFile(result.path)}>
            Показать в папке
          </button>
        </div>
      )}
    </section>
  )
}
