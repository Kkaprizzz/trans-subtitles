/**
 * Таймлайн с дорожками. Слева — шапки дорожек, справа — линейка и куски. Все видеодорожки одинаковые:
 * что выше, то слой выше в кадре. Вид (начало и масштаб) свой: колесо прокручивает, Ctrl+колесо
 * масштабирует вокруг курсора. Куски рисуются только в видимой части, поэтому 3-часовой подкаст при
 * сильном увеличении не создаёт гигантских элементов.
 *
 * Перенос куска показывает «призрак» и применяется по отпусканию; края тянутся сразу — от снимка проекта
 * на момент начала жеста, чтобы правки не накапливались. Метки — флажки на дорожке: тянутся по времени,
 * щелчок открывает окошко (текст, цвет, удалить).
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { rulerStep, timeToX, xToTime, zoomAt, type TimelineView } from '../../../shared/cut'
import {
  MARKER_COLORS,
  NEW_TRACK,
  addMarker,
  deleteMarker,
  itemDur,
  itemEnd,
  itemTrackKind,
  mediaOf,
  moveItem,
  moveMarker,
  patchMarker,
  projectDuration,
  snapPoints,
  snapTo,
  trackName,
  trimItem,
  type Item,
  type Marker,
  type Project,
  type TlWord,
  type Track
} from '../../../shared/project'
import { fmtTime } from '../format'

export interface Peaks {
  pps: number
  peaks: Uint8Array
}

interface Props {
  project: Project
  time: number
  playing: boolean
  selected: string[]
  selectedTrack: string | null
  peaks: Record<string, Peaks>
  /** слова субтитров на таймлайне (для рисования слов внутри кусков) */
  words: TlWord[]
  /** выбранное слово: адрес в словах файла */
  selectedWord: { itemId: string; idx: number } | null
  onSeek(t: number): void
  onSelect(ids: string[]): void
  onSelectTrack(id: string | null): void
  onCommit(next: Project, key?: string): void
  onDropMedia(mediaId: string, trackId: string | null, at: number): void
  onWordPick(w: TlWord): void
  /** какое окошко метки открыто */
  markerPopId: string | null
  onMarkerPop(id: string | null): void
  /** внешняя команда «показать всё» — меняется счётчик */
  fitTick: number
  zoomTick: { n: number; factor: number }
}

export const MEDIA_MIME = 'application/x-ts-media'
export const MARKER_PALETTE = ['#f0a35a', '#ef6a5e', '#6fcf8e', '#5bb8ec', '#b48aec', '#ecd45b']
const HEAD = 152
const RULER = 24
const H_VIDEO = 54
const H_AUDIO = 46
const GAP = 4
const SNAP_PX = 8
const MAX_PPS = 300

interface Row {
  track: Track
  top: number
  h: number
}

function layout(tracks: Track[]): { rows: Row[]; bottom: number } {
  let y = RULER + 8
  const rows: Row[] = []
  for (const t of tracks) {
    const h = t.kind === 'video' ? H_VIDEO : H_AUDIO
    rows.push({ track: t, top: y, h })
    y += h + GAP
  }
  return { rows, bottom: y }
}

type Drag =
  | { kind: 'move'; id: string; p0: Project; x0: number; y0: number; moved: boolean; grab: number }
  | { kind: 'trim'; id: string; edge: 'start' | 'end'; p0: Project; moved: boolean }
  | { kind: 'marker'; id: string; x0: number; moved: boolean }
  | { kind: 'scrub' }

const Svg = ({ d, size = 14 }: { d: string; size?: number }): React.JSX.Element => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
    <path d={d} />
  </svg>
)
const I = {
  flag: 'M6 21V4M6 4h11l-2.5 4 2.5 4H6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  eyeOff: 'M3 3l18 18M10.6 6.2A9.8 9.8 0 0112 6c6 0 10 6 10 6a17 17 0 01-3.2 3.7M6.3 7.6C3.8 9.4 2 12 2 12s4 7 10 7c1.5 0 2.9-.4 4.1-1',
  speaker: 'M4 9h4l5-4v14l-5-4H4zM17 9a4 4 0 010 6',
  speakerOff: 'M4 9h4l5-4v14l-5-4H4zM17 9l4 6M21 9l-4 6',
  lock: 'M7 11V8a5 5 0 0110 0v3M5 11h14v9H5z',
  unlock: 'M7 11V8a5 5 0 019.6-1.6M5 11h14v9H5z',
  close: 'M7 7l10 10M17 7L7 17'
}

function Wave({ peaks, from, to, width, height }: { peaks: Peaks; from: number; to: number; width: number; height: number }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv || width < 2) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(width * dpr)
    cv.height = Math.round(height * dpr)
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = 'rgba(232,232,230,0.55)'
    const per = (to - from) / width
    for (let x = 0; x < width; x++) {
      const a = Math.floor((from + x * per) * peaks.pps)
      const b = Math.max(a + 1, Math.floor((from + (x + 1) * per) * peaks.pps))
      let m = 0
      for (let i = Math.max(0, a); i < Math.min(b, peaks.peaks.length); i++) if (peaks.peaks[i] > m) m = peaks.peaks[i]
      const h = (m / 255) * (height - 4)
      if (h > 0.5) ctx.fillRect(x, (height - h) / 2, 1, h)
    }
  }, [peaks, from, to, width, height])
  return <canvas ref={ref} className="tr-wave" style={{ width, height }} />
}

/** Слова куска субтитров блоками (рисуются только те, что попали в видимую часть). */
function SubsWords(p: {
  words: TlWord[]
  view: TimelineView
  from: number
  to: number
  width: number
  height: number
  selected: { itemId: string; idx: number } | null
}): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv || p.width < 2) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(p.width * dpr)
    cv.height = Math.round(p.height * dpr)
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const css = getComputedStyle(cv)
    ctx.clearRect(0, 0, p.width, p.height)
    ctx.font = `11px ${css.getPropertyValue('--font-ui') || 'sans-serif'}`
    ctx.textBaseline = 'middle'
    for (const wd of p.words) {
      if (wd.end < p.from) continue
      if (wd.start > p.to) break
      const x = (wd.start - p.from) * p.view.pps
      const bw = Math.max(1, (wd.end - wd.start) * p.view.pps - 1)
      ctx.fillStyle = 'rgba(0,0,0,0.28)'
      ctx.beginPath()
      ctx.roundRect(x, 3, bw, p.height - 6, 3)
      ctx.fill()
      if (p.selected && p.selected.itemId === wd.itemId && p.selected.idx === wd.idx) {
        ctx.strokeStyle = css.getPropertyValue('--accent')
        ctx.lineWidth = 2
        ctx.stroke()
      }
      if (bw > 20) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(x, 0, bw, p.height)
        ctx.clip()
        ctx.fillStyle = css.getPropertyValue('--ink')
        ctx.fillText(wd.text, x + 5, p.height / 2 + 0.5)
        ctx.restore()
      }
    }
  }, [p.words, p.view.pps, p.from, p.to, p.width, p.height, p.selected])
  return <canvas ref={ref} className="tr-wave" style={{ width: p.width, height: p.height, bottom: 'auto', top: 0 }} />
}

/** Окошко метки: текст, цвет, удалить. */
function MarkerPop(p: { marker: Marker; x: number; y: number; onText(t: string): void; onColor(c: number): void; onDelete(): void; onClose(): void }): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(p.marker.text)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <div className="marker-pop" style={{ left: p.x, top: p.y }} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        type="text"
        value={text}
        maxLength={80}
        placeholder="Текст метки (необязательно)"
        onChange={(e) => {
          setText(e.target.value)
          p.onText(e.target.value)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' || e.key === 'Escape') p.onClose()
        }}
      />
      <div className="marker-colors" role="radiogroup" aria-label="Цвет метки">
        {MARKER_PALETTE.slice(0, MARKER_COLORS).map((c, i) => (
          <button key={c} role="radio" aria-checked={p.marker.color === i} className={p.marker.color === i ? 'on' : ''} style={{ background: c }} onClick={() => p.onColor(i)} aria-label={`Цвет ${i + 1}`} />
        ))}
        <button className="marker-del" onClick={p.onDelete} title="Удалить метку">
          Удалить
        </button>
      </div>
    </div>
  )
}

function Tracks(p: Props): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const rulerRef = useRef<HTMLCanvasElement>(null)
  const [w, setW] = useState(0)
  const [h, setH] = useState(0)
  const [view, setView] = useState<TimelineView>({ start: 0, pps: 20 })
  const [ghost, setGhost] = useState<{ id: string; trackId: string; start: number; top: number; height: number } | null>(null)
  const [dropAt, setDropAt] = useState<{ x: number; top: number; height: number } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; trackId: string; t: number } | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const fitted = useRef(false)

  const duration = projectDuration(p.project)
  const { rows, bottom } = useMemo(() => layout(p.project.tracks), [p.project.tracks])
  const wordsByItem = useMemo(() => {
    const m = new Map<string, TlWord[]>()
    for (const wd of p.words) m.set(wd.itemId, [...(m.get(wd.itemId) ?? []), wd])
    return m
  }, [p.words])
  const span = Math.max(30, duration * 1.15)
  const minPps = w > 0 ? w / Math.max(span, 10) / 4 : 0.01

  const clampView = (v: TimelineView): TimelineView => {
    const pps = Math.min(MAX_PPS, Math.max(minPps, v.pps))
    return { pps, start: Math.max(0, Math.min(v.start, Math.max(0, span - w / pps))) }
  }

  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setW(el.clientWidth)
      setH(el.clientHeight)
    })
    ro.observe(el)
    setW(el.clientWidth)
    setH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const fit = (): void => {
    if (w > 0) setView({ start: 0, pps: Math.min(MAX_PPS, w / Math.max(span, 10)) })
  }
  useEffect(() => {
    if (fitted.current || w === 0 || duration === 0) return
    fitted.current = true
    fit()
  }, [w, duration]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (p.fitTick > 0) fit()
  }, [p.fitTick]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (p.zoomTick.n > 0) setView((v) => clampView(zoomAt(v, p.zoomTick.factor, Math.max(0, timeToX(p.time, v)), minPps, MAX_PPS)))
  }, [p.zoomTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // курсор не уходит за край при воспроизведении
  useEffect(() => {
    if (!p.playing || w === 0) return
    const x = timeToX(p.time, view)
    if (x > w * 0.92 || x < 0) setView((v) => clampView({ ...v, start: p.time - (w * 0.1) / v.pps }))
  }, [p.time, p.playing]) // eslint-disable-line react-hooks/exhaustive-deps

  // линейка
  useEffect(() => {
    const cv = rulerRef.current
    if (!cv || w === 0) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(w * dpr)
    cv.height = Math.round(RULER * dpr)
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const css = getComputedStyle(cv)
    ctx.clearRect(0, 0, w, RULER)
    const step = rulerStep(view.pps, 90)
    const minor = step / 5
    const tEnd = xToTime(w, view)
    ctx.font = `11px ${css.getPropertyValue('--font-mono') || 'monospace'}`
    ctx.textBaseline = 'top'
    for (let t = Math.floor(view.start / minor) * minor; t <= tEnd; t += minor) {
      const x = Math.round(timeToX(t, view)) + 0.5
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6
      ctx.strokeStyle = major ? css.getPropertyValue('--ink-3') : css.getPropertyValue('--line-2')
      ctx.beginPath()
      ctx.moveTo(x, major ? 12 : 18)
      ctx.lineTo(x, RULER)
      ctx.stroke()
      if (major && t >= 0) {
        ctx.fillStyle = css.getPropertyValue('--ink-2')
        const s = Math.round(t)
        const lbl = step < 1 ? fmtTime(t) : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
        ctx.fillText(lbl, x + 3, 2)
      }
    }
  }, [w, view])

  // --- ввод ---
  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = boxRef.current?.getBoundingClientRect()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
  }
  const tol = SNAP_PX / view.pps
  const rowAt = (y: number): Row | 'above' | 'below' | null => {
    if (y < RULER) return null
    if (rows.length && y < rows[0].top - GAP / 2) return 'above'
    for (const r of rows) if (y >= r.top - GAP / 2 && y < r.top + r.h + GAP / 2) return r
    return 'below'
  }

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const stop = (e: WheelEvent): void => e.preventDefault()
    el.addEventListener('wheel', stop, { passive: false })
    return () => el.removeEventListener('wheel', stop)
  }, [])

  // меню закрывается по щелчку мимо
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', close)
    }
  }, [menu])

  const onWheel = (e: React.WheelEvent): void => {
    if (e.ctrlKey || e.metaKey) setView((v) => clampView(zoomAt(v, Math.exp(-e.deltaY * 0.0015), local(e).x, minPps, MAX_PPS)))
    else {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      setView((v) => clampView({ ...v, start: v.start + d / v.pps }))
    }
  }

  const onBgDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const { x, y } = local(e)
    dragRef.current = { kind: 'scrub' }
    if (y >= RULER) {
      p.onSelect([])
      const r = rowAt(y)
      p.onSelectTrack(r && typeof r === 'object' ? r.track.id : null)
    }
    p.onMarkerPop(null)
    p.onSeek(Math.max(0, xToTime(x, view)))
  }

  const onContext = (e: React.MouseEvent): void => {
    e.preventDefault()
    const { x, y } = local(e)
    const r = rowAt(y)
    if (!r || typeof r !== 'object') return
    p.onSelectTrack(r.track.id)
    setMenu({ x, y, trackId: r.track.id, t: Math.max(0, xToTime(x, view)) })
  }

  const startItem = (e: React.PointerEvent, it: Item, mode: 'move' | 'start' | 'end'): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    p.onMarkerPop(null)
    const multi = e.ctrlKey || e.metaKey || e.shiftKey
    if (multi) p.onSelect(p.selected.includes(it.id) ? p.selected.filter((x) => x !== it.id) : [...p.selected, it.id])
    else if (!p.selected.includes(it.id)) p.onSelect([it.id])
    p.onSelectTrack(it.trackId)
    const { x, y } = local(e)
    dragRef.current =
      mode === 'move'
        ? { kind: 'move', id: it.id, p0: p.project, x0: x, y0: y, moved: false, grab: xToTime(x, view) - it.start }
        : { kind: 'trim', id: it.id, edge: mode, p0: p.project, moved: false }
    // щелчок по слову внутри куска субтитров выбирает слово
    if (it.kind === 'subs' && mode === 'move') {
      const t = xToTime(x, view)
      const hit = (wordsByItem.get(it.id) ?? []).find((wd) => t >= wd.start && t < wd.end)
      if (hit) p.onWordPick(hit)
    }
  }

  const startMarker = (e: React.PointerEvent, m: Marker): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { kind: 'marker', id: m.id, x0: local(e).x, moved: false }
  }

  const onMove = (e: React.PointerEvent): void => {
    const d = dragRef.current
    if (!d) return
    const { x, y } = local(e)
    if (d.kind === 'scrub') {
      p.onSeek(Math.max(0, xToTime(x, view)))
      return
    }
    if (d.kind === 'marker') {
      if (!d.moved && Math.abs(x - d.x0) < 3) return
      d.moved = true
      p.onMarkerPop(null)
      p.onCommit(moveMarker(p.project, d.id, Math.max(0, xToTime(x, view))), `marker-${d.id}`)
      return
    }
    const snapOn = !e.altKey
    if (d.kind === 'trim') {
      d.moved = true
      let t = xToTime(x, view)
      if (snapOn) t = snapTo(t, [...snapPoints(d.p0, d.id), p.time], tol)
      p.onCommit(trimItem(d.p0, d.id, d.edge, t), `trim-${d.id}-${d.edge}`)
      return
    }
    if (!d.moved && Math.hypot(x - d.x0, y - d.y0) < 4) return
    d.moved = true
    const it = d.p0.items.find((i) => i.id === d.id)
    if (!it) return
    const kind = itemTrackKind(d.p0, it)
    let start = Math.max(0, xToTime(x, view) - d.grab)
    if (snapOn) {
      const pts = [...snapPoints(d.p0, d.id), p.time]
      const s1 = snapTo(start, pts, tol)
      const s2 = snapTo(start + itemDur(it), pts, tol) - itemDur(it)
      start = Math.abs(s1 - start) <= Math.abs(s2 - start) ? s1 : s2
    }
    const own = rows.find((rr) => rr.track.id === it.trackId)
    const r = rowAt(y)
    let trackId = it.trackId
    let top = own?.top ?? 0
    let height = own?.h ?? H_VIDEO
    if (r === 'above' && kind === 'video') {
      trackId = NEW_TRACK
      top = RULER + 2
      height = 6
    } else if (r === 'below' && kind === 'audio') {
      trackId = NEW_TRACK
      top = bottom - GAP
      height = 6
    } else if (r && typeof r === 'object' && r.track.kind === kind) {
      trackId = r.track.id
      top = r.top
      height = r.h
    }
    setGhost({ id: d.id, trackId, start, top, height })
  }

  const onUp = (): void => {
    const d = dragRef.current
    dragRef.current = null
    if (d?.kind === 'move' && d.moved && ghost) p.onCommit(moveItem(d.p0, d.id, ghost.trackId, ghost.start))
    // щелчок по метке без перетаскивания открывает её окошко
    if (d?.kind === 'marker' && !d.moved) p.onMarkerPop(d.id)
    setGhost(null)
  }

  // --- бросок файла из «Медиа» ---
  const onDragOver = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes(MEDIA_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const { x, y } = local(e)
    const r = rowAt(y)
    const row = r && typeof r === 'object' ? r : null
    setDropAt({ x, top: row ? row.top : r === 'above' ? RULER + 2 : bottom - GAP, height: row ? row.h : 6 })
  }
  const onDrop = (e: React.DragEvent): void => {
    const id = e.dataTransfer.getData(MEDIA_MIME)
    setDropAt(null)
    if (!id) return
    e.preventDefault()
    const { x, y } = local(e)
    const r = rowAt(y)
    const at = Math.max(0, xToTime(x, view))
    p.onDropMedia(id, r === 'above' || r === 'below' ? NEW_TRACK : r ? r.track.id : null, snapTo(at, [...snapPoints(p.project), p.time], tol))
  }

  const setTrack = (t: Track, patch: Partial<Pick<Track, 'muted' | 'hidden' | 'locked'>>): void =>
    p.onCommit({ ...p.project, tracks: p.project.tracks.map((x) => (x.id === t.id ? { ...x, ...patch } : x)) })
  const canRemove = (t: Track): boolean =>
    !p.project.items.some((i) => i.trackId === t.id) && p.project.tracks.filter((x) => x.kind === t.kind).length > 1
  const removeTrack = (t: Track): void =>
    p.onCommit({ ...p.project, tracks: p.project.tracks.filter((x) => x.id !== t.id), markers: p.project.markers.filter((m) => m.trackId !== t.id) })
  const addMarkerAt = (trackId: string, t: number): void => {
    const r = addMarker(p.project, trackId, t, 0, '')
    if (!r.id) return
    p.onCommit(r.p)
    p.onMarkerPop(r.id)
  }

  const tEnd = xToTime(w, view)
  const playX = timeToX(p.time, view)
  const ghostItem = ghost ? p.project.items.find((i) => i.id === ghost.id) : null
  const popMarker = p.markerPopId ? p.project.markers.find((m) => m.id === p.markerPopId) : undefined
  const popRow = popMarker ? rows.find((r) => r.track.id === popMarker.trackId) : undefined

  return (
    <div className="tracks" onDragOver={onDragOver} onDragLeave={() => setDropAt(null)} onDrop={onDrop}>
      <div className="tr-heads" style={{ width: HEAD }}>
        <div className="tr-head-ruler" style={{ height: RULER }} />
        {rows.map((r) => {
          const t = r.track
          const video = t.kind === 'video'
          return (
            <div
              key={t.id}
              className={`tr-head${p.selectedTrack === t.id ? ' sel' : ''}${t.locked ? ' locked' : ''}`}
              style={{ top: r.top, height: r.h }}
              onPointerDown={() => p.onSelectTrack(t.id)}
            >
              <span className="tr-name">{trackName(p.project, t.id)}</span>
              <span className="tr-tools">
                <button onClick={() => addMarkerAt(t.id, p.time)} title="Поставить метку на курсоре (M)" aria-label="Добавить метку">
                  <Svg d={I.flag} />
                </button>
                {video && (
                  <button className={t.hidden ? 'on' : ''} onClick={() => setTrack(t, { hidden: !t.hidden })} title={t.hidden ? 'Показать слой' : 'Скрыть слой'} aria-pressed={t.hidden}>
                    <Svg d={t.hidden ? I.eyeOff : I.eye} />
                  </button>
                )}
                <button className={t.muted ? 'on' : ''} onClick={() => setTrack(t, { muted: !t.muted })} title={t.muted ? 'Включить звук дорожки' : 'Заглушить дорожку'} aria-pressed={t.muted}>
                  <Svg d={t.muted ? I.speakerOff : I.speaker} />
                </button>
                <button className={t.locked ? 'on' : ''} onClick={() => setTrack(t, { locked: !t.locked })} title={t.locked ? 'Открепить дорожку' : 'Закрепить дорожку'} aria-pressed={t.locked}>
                  <Svg d={t.locked ? I.lock : I.unlock} />
                </button>
                {canRemove(t) && (
                  <button onClick={() => removeTrack(t)} title="Удалить пустую дорожку" aria-label="Удалить дорожку">
                    <Svg d={I.close} />
                  </button>
                )}
              </span>
            </div>
          )
        })}
      </div>
      <div
        className="tr-body"
        ref={boxRef}
        onWheel={onWheel}
        onPointerDown={onBgDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onContextMenu={onContext}
      >
        <canvas ref={rulerRef} className="tr-ruler" style={{ width: w, height: RULER }} />
        {rows.map((r) => (
          <div key={r.track.id} className={`tr-lane${r.track.hidden ? ' hidden' : ''}${p.selectedTrack === r.track.id ? ' sel' : ''}`} style={{ top: r.top, height: r.h }} />
        ))}
        {p.project.items.map((it) => {
          const row = rows.find((rr) => rr.track.id === it.trackId)
          if (!row) return null
          const end = itemEnd(it)
          if (end < view.start || it.start > tEnd) return null
          const visFrom = Math.max(it.start, view.start - 1 / view.pps)
          const visTo = Math.min(end, tEnd + 1 / view.pps)
          const left = timeToX(visFrom, view)
          const width = Math.max(2, (visTo - visFrom) * view.pps)
          const m = mediaOf(p.project, it.mediaId)
          const isSubs = it.kind === 'subs'
          const isVideo = !isSubs && !!m?.hasVideo
          const sel = p.selected.includes(it.id)
          const pk = !isSubs && m ? p.peaks[m.id] : undefined
          const dragging = ghost?.id === it.id
          const locked = row.track.locked
          const cls = `tr-item ${isSubs ? 'subs' : isVideo ? 'video' : 'audio'}${sel ? ' sel' : ''}${dragging ? ' lifted' : ''}${row.track.muted ? ' muted' : ''}${row.track.hidden ? ' hid' : ''}${locked ? ' locked' : ''}`
          const label = isSubs ? `Субтитры${it.link ? '' : ' · свои'}` : (m?.name ?? '—')
          return (
            <div
              key={it.id}
              className={cls}
              style={{ left, width, top: row.top, height: row.h }}
              onPointerDown={(e) => startItem(e, it, 'move')}
              title={`${label} · ${fmtTime(it.start)}–${fmtTime(end)} · ${itemDur(it).toFixed(1)} с`}
            >
              {pk && (
                <Wave peaks={pk} from={it.in + (visFrom - it.start)} to={it.in + (visTo - it.start)} width={Math.round(width)} height={isVideo ? Math.round(row.h * 0.45) : row.h - 2} />
              )}
              {isSubs && (
                <SubsWords
                  words={wordsByItem.get(it.id) ?? []}
                  view={view}
                  from={visFrom}
                  to={visTo}
                  width={Math.round(width)}
                  height={row.h - 2}
                  selected={p.selectedWord}
                />
              )}
              {!isSubs && width > 36 && (
                <span className="tr-label">
                  {label} <span className="mono">{itemDur(it).toFixed(1)} с</span>
                </span>
              )}
              {!locked && visFrom === it.start && <span className="tr-edge l" onPointerDown={(e) => startItem(e, it, 'start')} />}
              {!locked && visTo === end && <span className="tr-edge r" onPointerDown={(e) => startItem(e, it, 'end')} />}
            </div>
          )
        })}
        {p.project.markers.map((m) => {
          const row = rows.find((rr) => rr.track.id === m.trackId)
          if (!row) return null
          const x = timeToX(m.t, view)
          if (x < -4 || x > w + 4) return null
          return (
            <div
              key={m.id}
              className={`tr-marker${p.markerPopId === m.id ? ' open' : ''}`}
              style={{ left: x, top: row.top, height: row.h, ['--mc' as string]: MARKER_PALETTE[m.color] ?? MARKER_PALETTE[0] }}
              onPointerDown={(e) => startMarker(e, m)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                p.onMarkerPop(m.id)
              }}
              title={`${m.text || 'Метка'} · ${fmtTime(m.t)}`}
            >
              <svg viewBox="0 0 12 16" width="12" height="16" aria-hidden="true">
                <path d="M1 15V1h10l-3 4 3 4H1" fill="currentColor" stroke="none" />
                <path d="M1 1v14" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
              {m.text && <span className="tr-marker-text">{m.text}</span>}
            </div>
          )
        })}
        {ghost && ghostItem && (
          <div className="tr-ghost" style={{ left: timeToX(ghost.start, view), width: Math.max(2, itemDur(ghostItem) * view.pps), top: ghost.top, height: ghost.height }} />
        )}
        {dropAt && <div className="tr-drop" style={{ left: dropAt.x, top: dropAt.top, height: dropAt.height }} />}
        {playX >= -1 && playX <= w + 1 && (
          <div className="tr-playhead" style={{ left: Math.round(playX), height: Math.max(h, bottom) }}>
            <span />
          </div>
        )}
        {p.project.items.length === 0 && <p className="tr-empty">Перетащи сюда видео или звук из «Медиа»</p>}
        {popMarker && popRow && (
          <MarkerPop
            key={popMarker.id}
            marker={popMarker}
            x={Math.min(Math.max(4, timeToX(popMarker.t, view) + 8), Math.max(4, w - 250))}
            y={popRow.top + popRow.h * 0.5}
            onText={(text) => p.onCommit(patchMarker(p.project, popMarker.id, { text }), `mt-${popMarker.id}`)}
            onColor={(color) => p.onCommit(patchMarker(p.project, popMarker.id, { color }))}
            onDelete={() => {
              p.onCommit(deleteMarker(p.project, popMarker.id))
              p.onMarkerPop(null)
            }}
            onClose={() => p.onMarkerPop(null)}
          />
        )}
        {menu && (
          <div className="ctx" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()} role="menu">
            <button
              role="menuitem"
              onClick={() => {
                addMarkerAt(menu.trackId, menu.t)
                setMenu(null)
              }}
            >
              <Svg d={I.flag} /> Добавить метку
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default memo(Tracks)
