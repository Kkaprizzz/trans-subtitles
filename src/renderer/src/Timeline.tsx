/**
 * Таймлайн «Нарезки»: линейка, рамки клипов, слова, волна звука, курсор.
 * Линейку, слова и волну рисует canvas (на 85 минутах это тысячи элементов), рамки — обычные блоки:
 * их удобно таскать и подписывать. Масштаб — Ctrl+колесо вокруг курсора, прокрутка — колесо.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  MIN_CLIP,
  makeClip,
  moveClip,
  resizeClip,
  rulerStep,
  snapToWords,
  timeToX,
  xToTime,
  zoomAt,
  type CutClip,
  type TimelineView
} from '../../shared/cut'
import type { Word } from '../../shared/types'
import { fmtTime } from './format'

export interface Peaks {
  pps: number
  peaks: Uint8Array
}

interface Props {
  duration: number
  time: number
  playing: boolean
  clips: CutClip[]
  selectedId: string | null
  focusId: string | null
  words: Word[]
  peaks: Peaks | null
  onSeek(t: number): void
  onSelect(id: string | null): void
  onOpen(id: string): void
  /** key — для склейки шагов перетаскивания в одну отмену */
  onChange(clip: CutClip, key: string): void
  onCreate(clip: CutClip): void
}

const RULER = 22
const CLIPS = 52
const WORDS = 22
const TOP_CLIPS = RULER
const TOP_WORDS = RULER + CLIPS
const TOP_WAVE = RULER + CLIPS + WORDS
const SNAP_PX = 6
const MAX_PPS = 400

const fmtRuler = (t: number, step: number): string => {
  if (step < 1) return `${fmtTime(t).slice(0, -1)}`
  const s = Math.round(t)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

type Drag =
  | { kind: 'move'; id: string; orig: CutClip; x0: number; moved: boolean }
  | { kind: 'start' | 'end'; id: string; orig: CutClip; x0: number; moved: boolean }
  | { kind: 'create'; t0: number; x0: number; moved: boolean }
  | { kind: 'scrub' }

function Timeline(p: Props): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<TimelineView>({ start: 0, pps: 1 })
  const [ghost, setGhost] = useState<{ start: number; end: number } | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const fitted = useRef(false)

  const minPps = size.w > 0 && p.duration > 0 ? size.w / p.duration : 0.01
  const clampView = useCallback(
    (v: TimelineView): TimelineView => {
      const pps = Math.min(MAX_PPS, Math.max(minPps, v.pps))
      const span = size.w / pps
      return { pps, start: Math.max(0, Math.min(v.start, Math.max(0, p.duration - span))) }
    },
    [minPps, size.w, p.duration]
  )

  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // Новый файл — показываем его целиком.
  useEffect(() => {
    fitted.current = false
  }, [p.duration])
  useEffect(() => {
    if (fitted.current || size.w === 0 || p.duration <= 0) return
    fitted.current = true
    setView({ start: 0, pps: size.w / p.duration })
  }, [size.w, p.duration])

  // Открыли клип — приближаем его с полями по краям.
  useEffect(() => {
    const c = p.clips.find((x) => x.id === p.focusId)
    if (!c || size.w === 0) return
    const pad = (c.end - c.start) * 0.08 + 1
    const span = c.end - c.start + 2 * pad
    setView(clampView({ start: c.start - pad, pps: size.w / span }))
  }, [p.focusId, size.w]) // eslint-disable-line react-hooks/exhaustive-deps

  // Во время воспроизведения курсор не уходит за край: страница перелистывается.
  useEffect(() => {
    if (!p.playing || size.w === 0) return
    const x = timeToX(p.time, view)
    if (x > size.w * 0.95 || x < 0) setView((v) => clampView({ ...v, start: p.time - (size.w * 0.1) / v.pps }))
  }, [p.time, p.playing]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- рисование линейки, слов и волны ---
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || size.w === 0) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(size.w * dpr)
    cv.height = Math.round(size.h * dpr)
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const css = getComputedStyle(cv)
    const col = (n: string): string => css.getPropertyValue(n).trim()
    const ink2 = col('--ink-2')
    const ink3 = col('--ink-3')
    const line = col('--line')
    const sunk = col('--panel-sunk')
    ctx.clearRect(0, 0, size.w, size.h)

    // линейка
    const step = rulerStep(view.pps)
    const minor = step / 5
    const t0 = Math.floor(view.start / minor) * minor
    const tEnd = xToTime(size.w, view)
    ctx.font = `11px ${col('--font-mono') || 'monospace'}`
    ctx.textBaseline = 'top'
    for (let t = t0; t <= tEnd; t += minor) {
      const x = Math.round(timeToX(t, view)) + 0.5
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6
      ctx.strokeStyle = major ? ink3 : line
      ctx.beginPath()
      ctx.moveTo(x, major ? 10 : 16)
      ctx.lineTo(x, RULER)
      ctx.stroke()
      if (major && t >= 0) {
        ctx.fillStyle = ink2
        ctx.fillText(fmtRuler(t, step), x + 3, 3)
      }
    }
    ctx.strokeStyle = line
    ctx.beginPath()
    ctx.moveTo(0, RULER + 0.5)
    ctx.lineTo(size.w, RULER + 0.5)
    ctx.moveTo(0, TOP_WORDS + 0.5)
    ctx.lineTo(size.w, TOP_WORDS + 0.5)
    ctx.moveTo(0, TOP_WAVE + 0.5)
    ctx.lineTo(size.w, TOP_WAVE + 0.5)
    ctx.stroke()

    // слова: видны блоками только при достаточном масштабе
    if (view.pps >= 12) {
      ctx.font = `11px ${col('--font-ui') || 'sans-serif'}`
      ctx.textBaseline = 'middle'
      const vis0 = view.start
      for (const w of p.words) {
        if (w.end < vis0) continue
        if (w.start > tEnd) break
        const x = timeToX(w.start, view)
        const wd = Math.max(1, (w.end - w.start) * view.pps - 1)
        ctx.fillStyle = sunk
        ctx.fillRect(x, TOP_WORDS + 3, wd, WORDS - 6)
        if (wd > 18) {
          ctx.save()
          ctx.beginPath()
          ctx.rect(x, TOP_WORDS, wd, WORDS)
          ctx.clip()
          ctx.fillStyle = ink2
          ctx.fillText(w.text, x + 3, TOP_WORDS + WORDS / 2)
          ctx.restore()
        }
      }
    } else if (p.words.length > 0) {
      ctx.fillStyle = ink3
      ctx.font = `11px ${col('--font-ui') || 'sans-serif'}`
      ctx.textBaseline = 'middle'
      ctx.fillText('слова видны при увеличении (Ctrl+колесо)', 6, TOP_WORDS + WORDS / 2)
    }

    // волна
    const waveH = size.h - TOP_WAVE
    const mid = TOP_WAVE + waveH / 2
    if (p.peaks && waveH > 4) {
      const { pps, peaks } = p.peaks
      ctx.fillStyle = ink3
      for (let x = 0; x < size.w; x++) {
        const a = Math.floor(xToTime(x, view) * pps)
        const b = Math.max(a + 1, Math.floor(xToTime(x + 1, view) * pps))
        if (a >= peaks.length) break
        let m = 0
        for (let i = Math.max(0, a); i < Math.min(b, peaks.length); i++) if (peaks[i] > m) m = peaks[i]
        const h = (m / 255) * (waveH - 6)
        if (h > 0.5) ctx.fillRect(x, mid - h / 2, 1, h)
      }
    } else if (waveH > 4) {
      ctx.fillStyle = ink3
      ctx.textBaseline = 'middle'
      ctx.fillText('волна звука считается…', 6, mid)
    }
  }, [size, view, p.words, p.peaks])

  // --- мышь ---
  const localX = (e: { clientX: number }): number => e.clientX - (boxRef.current?.getBoundingClientRect().left ?? 0)
  const tol = SNAP_PX / view.pps

  const onWheel = (e: React.WheelEvent): void => {
    if (e.ctrlKey || e.metaKey) {
      setView((v) => clampView(zoomAt(v, Math.exp(-e.deltaY * 0.0015), localX(e), minPps, MAX_PPS)))
    } else {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      setView((v) => clampView({ ...v, start: v.start + d / v.pps }))
    }
  }

  // колесо внутри таймлайна не должно прокручивать страницу
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const stop = (e: WheelEvent): void => e.preventDefault()
    el.addEventListener('wheel', stop, { passive: false })
    return () => el.removeEventListener('wheel', stop)
  }, [])

  const startDrag = (e: React.PointerEvent, d: Drag): void => {
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = d
  }

  const onPointerDownBg = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const y = e.clientY - (boxRef.current?.getBoundingClientRect().top ?? 0)
    const t = Math.max(0, Math.min(p.duration, xToTime(localX(e), view)))
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    if (y >= TOP_CLIPS && y < TOP_WORDS) {
      // пустое место на дорожке клипов: клик — сброс выбора и курсор, протяжка — новая рамка
      dragRef.current = { kind: 'create', t0: e.altKey ? t : snapToWords(t, p.words, 'start', tol), x0: localX(e), moved: false }
      p.onSelect(null)
      p.onSeek(t)
    } else {
      dragRef.current = { kind: 'scrub' }
      p.onSeek(t)
    }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current
    if (!d) return
    const x = localX(e)
    if (d.kind === 'scrub') {
      p.onSeek(Math.max(0, Math.min(p.duration, xToTime(x, view))))
      return
    }
    if (!d.moved && Math.abs(x - d.x0) < 3) return
    d.moved = true
    const snap = !e.altKey
    if (d.kind === 'create') {
      let t = Math.max(0, Math.min(p.duration, xToTime(x, view)))
      if (snap) t = snapToWords(t, p.words, t > d.t0 ? 'end' : 'start', tol)
      setGhost({ start: Math.min(d.t0, t), end: Math.max(d.t0, t) })
      return
    }
    if (d.kind === 'move') {
      let next = moveClip(d.orig, (x - d.x0) / view.pps, p.duration)
      if (snap) {
        const s = snapToWords(next.start, p.words, 'start', tol)
        if (s !== next.start) next = moveClip(d.orig, s - d.orig.start, p.duration)
      }
      p.onChange(next, `drag-${d.id}`)
      return
    }
    let t = xToTime(x, view)
    if (snap) t = snapToWords(t, p.words, d.kind, tol)
    p.onChange(resizeClip(d.orig, d.kind, t, p.duration), `drag-${d.id}`)
  }

  const onPointerUp = (): void => {
    const d = dragRef.current
    dragRef.current = null
    if (d?.kind === 'create' && ghost) {
      if (ghost.end - ghost.start >= MIN_CLIP) {
        const c = makeClip(ghost.start, ghost.end)
        p.onCreate(c)
        p.onSelect(c.id)
      }
      setGhost(null)
    }
  }

  const span = size.w / view.pps
  const visible = p.clips.filter((c) => c.end >= view.start && c.start <= view.start + span)
  const playX = timeToX(p.time, view)

  return (
    <div
      className="timeline"
      ref={boxRef}
      onWheel={onWheel}
      onPointerDown={onPointerDownBg}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <canvas ref={canvasRef} className="tl-canvas" style={{ width: size.w, height: size.h }} />
      {visible.map((c) => {
        const left = timeToX(c.start, view)
        const width = Math.max(2, (c.end - c.start) * view.pps)
        const sel = c.id === p.selectedId
        const dimmed = p.focusId !== null && c.id !== p.focusId
        return (
          <div
            key={c.id}
            className={`tl-clip${sel ? ' sel' : ''}${dimmed ? ' dim' : ''}${c.enabled ? '' : ' off'}`}
            style={{ left, width, top: TOP_CLIPS + 4, height: CLIPS - 8 }}
            title={`${c.title || 'Без названия'} · ${fmtTime(c.start)}–${fmtTime(c.end)} · ${(c.end - c.start).toFixed(1)} с`}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              p.onSelect(c.id)
              startDrag(e, { kind: 'move', id: c.id, orig: c, x0: localX(e), moved: false })
            }}
            onDoubleClick={() => p.onOpen(c.id)}
          >
            <span
              className="tl-edge l"
              onPointerDown={(e) => {
                if (e.button !== 0) return
                p.onSelect(c.id)
                startDrag(e, { kind: 'start', id: c.id, orig: c, x0: localX(e), moved: false })
              }}
            />
            {width > 40 && (
              <span className="tl-label">
                {c.title || 'Без названия'}
                <span className="mono"> {(c.end - c.start).toFixed(0)} с</span>
              </span>
            )}
            <span
              className="tl-edge r"
              onPointerDown={(e) => {
                if (e.button !== 0) return
                p.onSelect(c.id)
                startDrag(e, { kind: 'end', id: c.id, orig: c, x0: localX(e), moved: false })
              }}
            />
          </div>
        )
      })}
      {ghost && (
        <div
          className="tl-clip ghost"
          style={{ left: timeToX(ghost.start, view), width: Math.max(2, (ghost.end - ghost.start) * view.pps), top: TOP_CLIPS + 4, height: CLIPS - 8 }}
        />
      )}
      {playX >= -1 && playX <= size.w + 1 && <div className="tl-playhead" style={{ left: Math.round(playX) }} />}
    </div>
  )
}

export default memo(Timeline)
