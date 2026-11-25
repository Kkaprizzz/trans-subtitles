/**
 * Строка управления под превью: ▶ время · полоса перемотки на весь проект · громкость предпросмотра.
 * Громкость — только для прослушивания в окне: в проект и в экспорт не попадает, помнится между запусками.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { fmtTime } from '../format'

const clamp = (x: number, a = 0, b = 1): number => Math.min(b, Math.max(a, x))
const LS_VOL = 'ts.previewVolume'
const LS_MUTE = 'ts.previewMuted'

function readLS(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeLS(key: string, v: string): void {
  try {
    localStorage.setItem(key, v)
  } catch {
    /* хранилище недоступно — громкость просто не запомнится */
  }
}

/** Громкость предпросмотра: уровень 0…1 и признак «заглушено». Звук = muted ? 0 : volume. */
export function useMasterVolume(): { volume: number; muted: boolean; level: number; setVolume(v: number): void; toggleMute(): void } {
  const [volume, setVol] = useState(() => {
    const n = Number(readLS(LS_VOL))
    return readLS(LS_VOL) !== null && Number.isFinite(n) ? clamp(n) : 1
  })
  const [muted, setMuted] = useState(() => readLS(LS_MUTE) === '1')
  const setVolume = useCallback((v: number) => {
    const c = Math.round(clamp(v) * 100) / 100
    setVol(c)
    writeLS(LS_VOL, String(c))
    // двигаешь ползунок — значит, хочешь слышать; на нуле глушить незачем
    setMuted(false)
    writeLS(LS_MUTE, '0')
  }, [])
  const toggleMute = useCallback(() => {
    if (volume === 0) {
      setVolume(0.5)
      return
    }
    setMuted((m) => {
      writeLS(LS_MUTE, m ? '0' : '1')
      return !m
    })
  }, [volume, setVolume])
  return { volume, muted, level: muted ? 0 : volume, setVolume, toggleMute }
}

const ICON = {
  play: 'M8 5l11 7-11 7z',
  pause: 'M8 5v14M16 5v14',
  off: 'M4 9h4l5-4v14l-5-4H4zM17 9l4 6M21 9l-4 6',
  low: 'M4 9h4l5-4v14l-5-4H4zM16.5 10.5a2.5 2.5 0 010 3',
  mid: 'M4 9h4l5-4v14l-5-4H4zM17 9a4 4 0 010 6',
  high: 'M4 9h4l5-4v14l-5-4H4zM17 9a4 4 0 010 6M19.8 6.2a8 8 0 010 11.6'
}
function Svg({ d }: { d: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

interface Props {
  time: number
  duration: number
  playing: boolean
  onTogglePlay(): void
  onSeek(t: number): void
  /** начало и конец перетаскивания по полосе: на время перетаскивания воспроизведение ставится на паузу */
  onScrubStart(): void
  onScrubEnd(): void
  level: number
  volume: number
  muted: boolean
  onVolume(v: number): void
  onToggleMute(): void
  /** подпись справа (разрешение и fps) */
  info: string
}

export default function Transport(p: Props): React.JSX.Element {
  const barRef = useRef<HTMLDivElement>(null)
  const [scrub, setScrub] = useState(false)
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null)
  const ready = p.duration > 0
  const frac = ready ? clamp(p.time / p.duration) : 0

  const at = (clientX: number): { x: number; t: number } => {
    const r = barRef.current?.getBoundingClientRect()
    if (!r || r.width <= 0) return { x: 0, t: 0 }
    const x = clamp((clientX - r.left) / r.width)
    return { x: x * r.width, t: x * p.duration }
  }

  return (
    <div className="ed-transport">
      <button className="btn icon" onClick={p.onTogglePlay} disabled={!ready} aria-label={p.playing ? 'Пауза' : 'Играть'} title="Пробел">
        <Svg d={p.playing ? ICON.pause : ICON.play} />
      </button>
      <span className="mono tp-time">
        {fmtTime(p.time)} <span className="dim">/ {fmtTime(p.duration)}</span>
      </span>

      <div
        ref={barRef}
        className={`tp-seek${scrub ? ' scrubbing' : ''}${ready ? '' : ' off'}`}
        role="slider"
        tabIndex={ready ? 0 : -1}
        aria-label="Позиция"
        aria-valuemin={0}
        aria-valuemax={Math.round(p.duration * 100) / 100}
        aria-valuenow={Math.round(p.time * 100) / 100}
        aria-valuetext={fmtTime(p.time)}
        onPointerDown={(e) => {
          if (!ready || e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          setScrub(true)
          p.onScrubStart()
          p.onSeek(at(e.clientX).t)
        }}
        onPointerMove={(e) => {
          if (!ready) return
          const a = at(e.clientX)
          setHover(a)
          if (scrub) p.onSeek(a.t)
        }}
        onPointerUp={() => {
          if (!scrub) return
          setScrub(false)
          p.onScrubEnd()
        }}
        onPointerCancel={() => {
          if (!scrub) return
          setScrub(false)
          p.onScrubEnd()
        }}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(e) => {
          if (!ready) return
          const step = e.shiftKey ? 5 : 1
          if (e.key === 'ArrowLeft') p.onSeek(p.time - step)
          else if (e.key === 'ArrowRight') p.onSeek(p.time + step)
          else return
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        <div className="tp-rail">
          <div className="tp-fill" style={{ width: `${frac * 100}%` }} />
        </div>
        <div className="tp-thumb" style={{ left: `${frac * 100}%` }} />
        {hover && ready && (
          <div className="tp-tip mono" style={{ left: hover.x }}>
            {fmtTime(hover.t)}
          </div>
        )}
      </div>

      <Volume level={p.level} volume={p.volume} muted={p.muted} onVolume={p.onVolume} onToggleMute={p.onToggleMute} />
      <span className="dim mono tp-info">{p.info}</span>
    </div>
  )
}

function Volume({ level, volume, muted, onVolume, onToggleMute }: Pick<Props, 'level' | 'volume' | 'muted' | 'onVolume' | 'onToggleMute'>): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState(false)
  const icon = level === 0 ? ICON.off : level < 0.34 ? ICON.low : level < 0.67 ? ICON.mid : ICON.high

  const setFrom = (clientY: number): void => {
    const r = trackRef.current?.getBoundingClientRect()
    if (!r || r.height <= 0) return
    onVolume(1 - (clientY - r.top) / r.height)
  }
  // Колесо над значком и полосой — ±5%
  const wrapRef = useRef<HTMLDivElement>(null)
  const volRef = useRef(volume)
  volRef.current = volume
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const h = (e: WheelEvent): void => {
      e.preventDefault()
      onVolume(volRef.current + (e.deltaY < 0 ? 0.05 : -0.05))
    }
    el.addEventListener('wheel', h, { passive: false })
    return () => el.removeEventListener('wheel', h)
  }, [onVolume])

  return (
    <div ref={wrapRef} className={`tp-vol${drag ? ' dragging' : ''}`}>
      <div className="tp-vol-pop">
        <span className="mono tp-vol-n">{Math.round(level * 100)}</span>
        <div
          ref={trackRef}
          className="tp-vol-track"
          role="slider"
          tabIndex={0}
          aria-label="Громкость предпросмотра"
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.currentTarget.setPointerCapture(e.pointerId)
            setDrag(true)
            setFrom(e.clientY)
          }}
          onPointerMove={(e) => drag && setFrom(e.clientY)}
          onPointerUp={() => setDrag(false)}
          onPointerCancel={() => setDrag(false)}
          onKeyDown={(e) => {
            const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 0.05 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -0.05 : 0
            if (!d) return
            e.preventDefault()
            e.stopPropagation()
            onVolume(volume + d)
          }}
        >
          <div className="tp-vol-rail">
            <div className="tp-vol-fill" style={{ height: `${level * 100}%` }} />
          </div>
          <div className="tp-vol-thumb" style={{ bottom: `${level * 100}%` }} />
        </div>
      </div>
      <button className="btn icon" onClick={onToggleMute} aria-label={muted || level === 0 ? 'Включить звук' : 'Выключить звук'} aria-pressed={muted}>
        <Svg d={icon} />
      </button>
    </div>
  )
}
