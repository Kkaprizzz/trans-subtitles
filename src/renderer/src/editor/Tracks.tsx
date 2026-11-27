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
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { animSet } from '../../../shared/anim'
import { gainAt } from '../../../shared/audio'
import { EFFECT_MIME, EFFECTS, type EffectType } from '../../../shared/effects'
import { plateLabel } from '../../../shared/plate'
import { shapeLabel } from '../../../shared/shape'
import { addGainPoint, addKeysAtTime, attachAudio, canHaveEffects, canJoin, deleteGainPoint, deleteKeysAtTime, detachAudio, hasSound, insertFreeze, joinWithNeighbor, keyTimes, moveGainPoint, moveKeysAtTime, setBaseVolume, setEaseAtTime, setFreezeLength, toggleFlip } from '../../../shared/mix'
import { moveClipBy, rulerStep, setClipEdge, snapToWords, sourceAt, timeToX, xToTime, zoomAt, type Placement, type TimelineView } from '../../../shared/cut'
import {
  MARKER_COLORS,
  NEW_TRACK,
  addMarker,
  deleteItems,
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
  srcToTl,
  tlToSrc,
  snapTo,
  splitItem,
  trackName,
  trimItem,
  type Clip,
  type Item,
  type Marker,
  type Project,
  type TlWord,
  type Track
} from '../../../shared/project'
import { fmtTime } from '../format'
import { currentDrag, endDrag, type DragKind } from './dragState'

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
  /** бросили баннер из библиотеки / фигуру: id и вид из карточки, дорожка (null — как придётся), время */
  onDropBanner(bannerId: string, trackId: string | null, at: number): void
  onDropShape(kind: string, trackId: string | null, at: number): void
  /** что получится, если бросить сюда: тот же расчёт, что у броска; null — класть нечего. Нужен, чтобы показать место заранее */
  previewDrop(kind: DragKind, id: string, trackId: string | null, at: number): { p: Project; id: string } | null
  onWordPick(w: TlWord): void
  /** какое окошко метки открыто */
  markerPopId: string | null
  onMarkerPop(id: string | null): void
  /** рамки клипов с местом на таймлайне (null — видео с этим отрезком нет на таймлайне) */
  clips: Array<{ clip: Clip; at: Placement | null }>
  selectedClip: string | null
  onSelectClip(id: string | null): void
  onClipOpen(id: string): void
  /** сообщение пользователю (почему операция не удалась) */
  onMessage(msg: string): void
  /** карточку эффекта бросили на кусок */
  onDropEffect(itemId: string, type: EffectType): void
  /** буфер копирования не пуст */
  canPaste: boolean
  onCopy(): void
  onCut(): void
  onPaste(): void
  onDuplicate(): void
  /** фокус на рамке: вне неё затемнено, вид приближен */
  focus: { start: number; end: number } | null
  /** внешняя команда «показать всё» — меняется счётчик */
  fitTick: number
  zoomTick: { n: number; factor: number }
}

export const MEDIA_MIME = 'application/x-ts-media'
/** карточка баннера из библиотеки (id) и карточка фигуры (вид) */
export const BANNER_MIME = 'application/x-ts-banner'
export const SHAPE_MIME = 'application/x-ts-shape'
export const MARKER_PALETTE = ['#f0a35a', '#ef6a5e', '#6fcf8e', '#5bb8ec', '#b48aec', '#ecd45b']
const HEAD = 152
const RULER = 24
/** картинка видеокуска, под ней узкая полоса его звука */
const PIC_H = 54
const STRIP_H = 24
const STRIP_GAP = 2
const H_VIDEO = PIC_H + STRIP_GAP + STRIP_H + 2
const GAIN_PAD = 4
const H_AUDIO = 46
const H_CLIPS = 30
const GAP = 4
const SNAP_PX = 8
const MAX_PPS = 300

interface Row {
  track: Track
  top: number
  h: number
}

function layout(tracks: Track[], clipsRow: boolean): { rows: Row[]; bottom: number; clipsTop: number | null } {
  let y = RULER + 8
  const clipsTop = clipsRow ? y : null
  if (clipsRow) y += H_CLIPS + GAP + 2
  const rows: Row[] = []
  for (const t of tracks) {
    const h = t.kind === 'video' ? H_VIDEO : H_AUDIO
    rows.push({ track: t, top: y, h })
    y += h + GAP
  }
  return { rows, bottom: y, clipsTop }
}

/** Куда ляжет то, что тащат из «Медиа»: проект с уже положенным куском (там же новая дорожка, если нужна) и его место. */
interface DropPrev {
  key: string
  pp: Project
  trackId: string
  start: number
  dur: number
  label: string
  /** время, к которому прилипло начало (null — не прилипло) */
  snapT: number | null
}

type Drag =
  | { kind: 'move'; id: string; p0: Project; x0: number; y0: number; moved: boolean; grab: number }
  | { kind: 'trim'; id: string; edge: 'start' | 'end'; p0: Project; moved: boolean }
  | { kind: 'marker'; id: string; x0: number; moved: boolean }
  | { kind: 'gain-base'; id: string; p0: Project; top: number; h: number }
  | { kind: 'gain-pt'; id: string; idx: number; p0: Project; top: number; h: number }
  | { kind: 'key'; id: string; rel: number; p0: Project }
  | { kind: 'clip-move'; id: string; p0: Project; x0: number; moved: boolean }
  | { kind: 'clip-trim'; id: string; edge: 'start' | 'end'; p0: Project; moved: boolean }
  | { kind: 'scrub' }
  /** рамка выделения от пустого места: t0 (время) и y0 (по содержимому) — угол, с которого начали; cx/cy — точка нажатия на экране */
  | { kind: 'marquee'; t0: number; y0: number; cx: number; cy: number; moved: boolean; add: boolean; base: string[]; before: string[] }

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

/**
 * Линия громкости поверх звука куска: без точек — горизонтальная (её тянут целиком), с точками — ломаная.
 * Видна на выделенном куске и при наведении (CSS). Правый щелчок: по линии — добавить точку, по точке — удалить.
 */
function GainLine(p: {
  item: Item
  view: TimelineView
  /** время таймлайна у левого края отрисованной части куска */
  from: number
  width: number
  height: number
  onBase(e: React.PointerEvent): void
  onPoint(e: React.PointerEvent, idx: number): void
  onLineMenu(e: React.MouseEvent): void
  onPointMenu(e: React.MouseEvent, idx: number): void
}): React.JSX.Element {
  const it = p.item
  const y = (v: number): number => GAIN_PAD + (1 - v) * (p.height - 2 * GAIN_PAD)
  const x = (srcT: number): number => timeToX(srcToTl(it, srcT), p.view) - timeToX(p.from, p.view)
  const srcFrom = tlToSrc(it, p.from)
  const srcTo = tlToSrc(it, p.from + p.width / p.view.pps)
  const inner = it.gain.filter((pt) => pt.t > srcFrom && pt.t < srcTo)
  const verts = [[0, y(gainAt(it.gain, it.volume, srcFrom))], ...inner.map((pt) => [x(pt.t), y(pt.v)]), [p.width, y(gainAt(it.gain, it.volume, srcTo))]]
  const pts = verts.map((v) => `${v[0].toFixed(1)},${v[1].toFixed(1)}`).join(' ')
  const lowered = it.gain.length === 0 && it.volume < 0.999
  return (
    <svg className={`tr-gain${it.gain.length ? ' pts' : ''}${lowered ? ' low' : ''}`} width={p.width} height={p.height}>
      <polyline className="tr-gain-line" points={pts} />
      <polyline className="tr-gain-hit" points={pts} onPointerDown={(e) => it.gain.length === 0 && p.onBase(e)} onContextMenu={p.onLineMenu} />
      {it.gain.map((pt, idx) => {
        if (pt.t < srcFrom - 0.001 || pt.t > srcTo + 0.001) return null
        return <circle key={idx} className="tr-gain-pt" cx={x(pt.t)} cy={y(pt.v)} r={5} onPointerDown={(e) => p.onPoint(e, idx)} onContextMenu={(e) => p.onPointMenu(e, idx)} />
      })}
    </svg>
  )
}

/**
 * Полоса ключевых кадров на куске: ромбик на каждый момент, где у куска есть ключи (все свойства в этой точке — один ромбик).
 * Тянуть — двигать по времени, правый щелчок — меню, двойной щелчок по полосе — добавить ключи в этой точке.
 */
function KeyStrip(p: {
  item: Item
  view: TimelineView
  /** время таймлайна у левого края отрисованной части куска */
  from: number
  width: number
  selRel: number | null
  onDown(e: React.PointerEvent, rel: number): void
  onMenu(e: React.MouseEvent, rel: number): void
}): React.JSX.Element | null {
  const times = keyTimes(p.item)
  if (times.length === 0) return null
  return (
    <div className="tr-kf">
      {times.map((rel) => {
        const x = timeToX(p.item.start + rel, p.view) - timeToX(p.from, p.view)
        if (x < -5 || x > p.width + 5) return null
        const sel = p.selRel !== null && Math.abs(p.selRel - rel) < 0.011
        return (
          <button key={rel} className={`tr-kf-dot${sel ? ' sel' : ''}`} style={{ left: x }} onPointerDown={(e) => p.onDown(e, rel)} onContextMenu={(e) => p.onMenu(e, rel)} title="Ключевой кадр: тяни по времени, правый щелчок — меню" aria-label="Ключевой кадр">
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <path d="M5 0.6 9.4 5 5 9.4 0.6 5Z" fill="currentColor" stroke="rgba(0,0,0,.55)" strokeWidth="0.8" strokeLinejoin="round" />
            </svg>
          </button>
        )
      })}
    </div>
  )
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
  const [fxOver, setFxOver] = useState<string | null>(null)
  const [dropPrev, setDropPrev] = useState<DropPrev | null>(null)
  // вертикальная прокрутка дорожек (пикселей) и рамка выделения (углы: время и y по содержимому)
  const [scrollY, setScrollY] = useState(0)
  const [marquee, setMarquee] = useState<{ t0: number; y0: number; t1: number; y1: number } | null>(null)
  const ptrRef = useRef<{ x: number; by: number } | null>(null)
  type Menu =
    | { kind: 'lane'; x: number; y: number; trackId: string; t: number }
    | { kind: 'item'; x: number; y: number; itemId: string; t: number }
    | { kind: 'line'; x: number; y: number; itemId: string; t: number }
    | { kind: 'point'; x: number; y: number; itemId: string; idx: number }
    | { kind: 'key'; x: number; y: number; itemId: string; rel: number }
  const [menu, setMenu] = useState<Menu | null>(null)
  // выбранный ромбик ключей: Delete удаляет его, пока ничего другого не выбрали
  const [selKey, setSelKey] = useState<{ id: string; rel: number } | null>(null)
  const projectRef = useRef(p.project)
  projectRef.current = p.project
  const commitRef = useRef(p.onCommit)
  commitRef.current = p.onCommit
  useEffect(() => {
    if (!selKey) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Delete' && e.code !== 'Backspace') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.stopImmediatePropagation()
      e.preventDefault()
      commitRef.current(deleteKeysAtTime(projectRef.current, selKey.id, selKey.rel))
      setSelKey(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selKey])
  useEffect(() => {
    if (selKey && !p.selected.includes(selKey.id)) setSelKey(null)
  }, [p.selected, selKey])
  // та же плавающая менюшка, но по границам окна: если не влезает — поднимается/сдвигается, чтобы не обрезаться
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState({ left: 0, top: 0, ready: false })
  useLayoutEffect(() => {
    const el = menuRef.current
    const box = boxRef.current
    if (!menu || !el || !box) {
      setMenuPos((m) => (m.ready ? { left: 0, top: 0, ready: false } : m))
      return
    }
    const r = box.getBoundingClientRect()
    const mw = el.offsetWidth
    const mh = el.offsetHeight
    const M = 8
    // точка щелчка в координатах окна; меню у позиционирования fixed
    const cx = r.left + menu.x
    const cy = r.top + menu.y - (menu.y >= RULER ? sy : 0)
    const left = Math.max(M, Math.min(cx, window.innerWidth - mw - M))
    const top = Math.max(M, Math.min(cy, window.innerHeight - mh - M))
    setMenuPos({ left, top, ready: true })
  }, [menu]) // eslint-disable-line react-hooks/exhaustive-deps
  const dragRef = useRef<Drag | null>(null)
  const fitted = useRef(false)

  const duration = projectDuration(p.project)
  const hasClips = p.project.clips.length > 0
  // раскладка без превью нужна курсору (куда он целится); рисуем раскладку с превью: новая дорожка появляется настоящей строкой
  const baseLayout = useMemo(() => layout(p.project.tracks, hasClips), [p.project.tracks, hasClips])
  const { rows, bottom, clipsTop } = useMemo(
    () => (dropPrev ? layout(dropPrev.pp.tracks, hasClips) : baseLayout),
    [dropPrev?.key, baseLayout, hasClips] // eslint-disable-line react-hooks/exhaustive-deps
  )
  // дорожки прокручиваются по вертикали: линейка стоит на месте, всё остальное сдвигается на sy
  const maxY = Math.max(0, bottom + 8 - h)
  const sy = Math.min(scrollY, maxY)
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
  // фокус на рамке: приближаем так, чтобы рамка заняла почти всю ширину
  const focusStart = p.focus?.start
  const focusEnd = p.focus?.end
  useEffect(() => {
    if (focusStart === undefined || focusEnd === undefined || w === 0) return
    const len = Math.max(1, focusEnd - focusStart)
    const pps = Math.min(MAX_PPS, (w * 0.92) / len)
    setView(clampView({ pps, start: focusStart - (w * 0.04) / pps }))
  }, [focusStart, focusEnd, w]) // eslint-disable-line react-hooks/exhaustive-deps
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
    const y = e.clientY - (r?.top ?? 0)
    // ниже линейки возвращаем y по содержимому: с учётом вертикальной прокрутки
    return { x: e.clientX - (r?.left ?? 0), y: y < RULER ? y : y + sy }
  }
  const tol = SNAP_PX / view.pps
  const rowAt = (y: number): Row | 'above' | 'below' | 'clips' | null => {
    if (y < RULER) return null
    const { rows: bRows, clipsTop: bClips } = baseLayout
    if (bClips !== null && y >= bClips - GAP / 2 && y < bClips + H_CLIPS + GAP / 2) return 'clips'
    if (bRows.length && y < bRows[0].top - GAP / 2) return 'above'
    for (const r of bRows) if (y >= r.top - GAP / 2 && y < r.top + r.h + GAP / 2) return r
    return 'below'
  }

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const stop = (e: WheelEvent): void => e.preventDefault()
    el.addEventListener('wheel', stop, { passive: false })
    return () => el.removeEventListener('wheel', stop)
  }, [])

  // бросок мимо таймлайна и отмена по Esc: превью убираем, описание перетаскиваемого забываем
  useEffect(() => {
    const clear = (): void => {
      setDropPrev(null)
      endDrag()
    }
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
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
    else if (e.shiftKey) {
      // Shift+колесо — по вертикали (Chromium при Shift присылает прокрутку в deltaX)
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      setScrollY((v) => Math.max(0, Math.min(maxY, Math.min(v, maxY) + d)))
    } else {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      setView((v) => clampView({ ...v, start: v.start + d / v.pps }))
    }
  }

  const onBgDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const { x, y } = local(e)
    p.onMarkerPop(null)
    if (y < RULER) {
      // линейка: курсор встаёт в точку и едет за мышью
      dragRef.current = { kind: 'scrub' }
      p.onSeek(Math.max(0, xToTime(x, view)))
      return
    }
    // пустое место дорожек: щелчок снимает выделение и ставит курсор (как раньше), протяжка рисует рамку выделения
    const add = e.ctrlKey || e.metaKey || e.shiftKey
    dragRef.current = { kind: 'marquee', t0: xToTime(x, view), y0: y, cx: e.clientX, cy: e.clientY, moved: false, add, base: add ? p.selected : [], before: p.selected }
    const r = rowAt(y)
    p.onSelectTrack(r && typeof r === 'object' ? r.track.id : null)
  }

  /** Куски, которых касается рамка (закреплённые дорожки пропускаем). */
  const marqueeHits = (m: { t0: number; y0: number; t1: number; y1: number }): string[] => {
    const ta = Math.min(m.t0, m.t1)
    const tb = Math.max(m.t0, m.t1)
    const ya = Math.min(m.y0, m.y1)
    const yb = Math.max(m.y0, m.y1)
    const ids: string[] = []
    for (const it of p.project.items) {
      const row = baseLayout.rows.find((r) => r.track.id === it.trackId)
      if (!row || row.track.locked) continue
      if (it.start <= tb && itemEnd(it) >= ta && row.top <= yb && row.top + row.h >= ya) ids.push(it.id)
    }
    return ids
  }
  /** Рамка тянется до точки указателя (она хранится как x и y окна): выделение обновляется на ходу. */
  const dragMarquee = (): void => {
    const d = dragRef.current
    const pt = ptrRef.current
    if (!d || d.kind !== 'marquee' || !d.moved || !pt) return
    const m = { t0: d.t0, y0: d.y0, t1: Math.max(0, xToTime(pt.x, view)), y1: pt.by < RULER ? RULER : pt.by + sy }
    setMarquee(m)
    const hit = marqueeHits(m)
    const next = d.add ? [...new Set([...d.base, ...hit])] : hit
    if (next.length !== p.selected.length || next.some((id, i) => id !== p.selected[i])) p.onSelect(next)
  }
  const endMarquee = (restore: boolean): void => {
    const d = dragRef.current
    if (d?.kind === 'marquee' && restore) p.onSelect(d.before)
    dragRef.current = null
    ptrRef.current = null
    setMarquee(null)
  }
  // Esc отменяет рамку: выделение возвращается к тому, что было
  useEffect(() => {
    if (!marquee) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'Escape') endMarquee(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [marquee !== null]) // eslint-disable-line react-hooks/exhaustive-deps
  // у края таймлайна рамка сама прокручивает его (по горизонтали и по вертикали)
  useEffect(() => {
    if (!marquee) return
    const EDGE = 28
    const id = setInterval(() => {
      const d = dragRef.current
      const pt = ptrRef.current
      if (!d || d.kind !== 'marquee' || !pt) return
      const dx = pt.x < EDGE ? pt.x - EDGE : pt.x > w - EDGE ? pt.x - (w - EDGE) : 0
      const dy = pt.by < RULER + EDGE ? pt.by - (RULER + EDGE) : pt.by > h - EDGE ? pt.by - (h - EDGE) : 0
      if (dx) setView((v) => clampView({ ...v, start: v.start + (dx * 0.6) / v.pps }))
      if (dy) setScrollY((v) => Math.max(0, Math.min(maxY, Math.min(v, maxY) + dy * 0.6)))
    }, 16)
    return () => clearInterval(id)
  }, [marquee !== null, w, h, maxY]) // eslint-disable-line react-hooks/exhaustive-deps
  // после прокрутки под неподвижным указателем другое время и другая строка: пересчитываем рамку
  useEffect(() => {
    dragMarquee()
  }, [view.start, view.pps, sy]) // eslint-disable-line react-hooks/exhaustive-deps

  const onContext = (e: React.MouseEvent): void => {
    e.preventDefault()
    const { x, y } = local(e)
    const r = rowAt(y)
    if (!r || typeof r !== 'object') return
    p.onSelectTrack(r.track.id)
    setMenu({ kind: 'lane', x, y, trackId: r.track.id, t: Math.max(0, xToTime(x, view)) })
  }

  const startItem = (e: React.PointerEvent, it: Item, mode: 'move' | 'start' | 'end'): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    p.onMarkerPop(null)
    setSelKey(null)
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

  const startKey = (e: React.PointerEvent, it: Item, rel: number): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    ;(e.currentTarget as unknown as Element).setPointerCapture(e.pointerId)
    p.onMarkerPop(null)
    p.onSelect([it.id])
    p.onSelectClip(null)
    p.onSelectTrack(it.trackId)
    setSelKey({ id: it.id, rel })
    dragRef.current = { kind: 'key', id: it.id, rel, p0: p.project }
  }
  const startGain = (e: React.PointerEvent, it: Item, top: number, h: number, idx: number | null): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    ;(e.currentTarget as unknown as Element).setPointerCapture(e.pointerId)
    p.onMarkerPop(null)
    p.onSelect([it.id])
    p.onSelectClip(null)
    p.onSelectTrack(it.trackId)
    dragRef.current = idx === null ? { kind: 'gain-base', id: it.id, p0: p.project, top, h } : { kind: 'gain-pt', id: it.id, idx, p0: p.project, top, h }
  }
  const openMenu = (e: React.MouseEvent, make: (x: number, t: number, y: number) => Menu, it: Item): void => {
    e.preventDefault()
    e.stopPropagation()
    const { x, y } = local(e)
    if (!p.selected.includes(it.id)) p.onSelect([it.id])
    p.onSelectTrack(it.trackId)
    setMenu(make(x, Math.max(0, xToTime(x, view)), y))
  }
  /** Пункты меню правой кнопки; run вызывается по щелчку, окно закрывается само. */
  const menuEntries = (m: Menu): Array<{ label: string; key?: string; run(): void }> => {
    const pr = p.project
    const say = (error?: string): void => {
      if (error) p.onMessage(error)
    }
    if (m.kind === 'lane') {
      const lane: Array<{ label: string; key?: string; run(): void }> = []
      if (p.canPaste) lane.push({ label: 'Вставить', key: 'Ctrl+V', run: p.onPaste })
      lane.push({ label: 'Добавить метку', key: 'M', run: () => addMarkerAt(m.trackId, m.t) })
      return lane
    }
    const it = pr.items.find((i) => i.id === m.itemId)
    if (!it) return []
    if (m.kind === 'line') return [{ label: 'Добавить точку', run: () => p.onCommit(addGainPoint(pr, it.id, m.t).p) }]
    if (m.kind === 'point') return [{ label: 'Удалить точку', run: () => p.onCommit(deleteGainPoint(pr, it.id, m.idx)) }]
    if (m.kind === 'key') {
      const smooth = [...it.keys.x, ...it.keys.y, ...it.keys.scale, ...it.keys.opacity].some((k) => Math.abs(k.t - m.rel) < 0.011 && k.ease)
      return [
        { label: smooth ? 'Линейно' : 'Плавно', run: () => p.onCommit(setEaseAtTime(pr, it.id, m.rel, !smooth)) },
        { label: 'Удалить ключ', key: 'Delete', run: () => { setSelKey(null); p.onCommit(deleteKeysAtTime(pr, it.id, m.rel)) } }
      ]
    }
    const out: Array<{ label: string; key?: string; run(): void }> = []
    out.push({ label: 'Копировать', key: 'Ctrl+C', run: p.onCopy }, { label: 'Вырезать', key: 'Ctrl+X', run: p.onCut })
    if (p.canPaste) out.push({ label: 'Вставить', key: 'Ctrl+V', run: p.onPaste })
    out.push({ label: 'Дублировать', key: 'Ctrl+D', run: p.onDuplicate })
    const media = mediaOf(pr, it.mediaId)
    const own = pr.tracks.find((t) => t.id === it.trackId)
    if (it.kind === 'media' && own?.kind === 'video' && media?.hasVideo && hasSound(pr, it)) {
      out.push({
        label: 'Отделить звук',
        run: () => {
          const r = detachAudio(pr, it.id)
          if (r.error) say(r.error)
          else p.onCommit(r.p)
        }
      })
    }
    if (it.kind === 'media' && own?.kind === 'audio' && media?.hasVideo) {
      out.push({
        label: 'Вернуть звук к видео',
        run: () => {
          const r = attachAudio(pr, it.id)
          if (r.error) say(r.error)
          else p.onCommit(r.p)
        }
      })
    }
    // стоп-кадр в точке курсора воспроизведения: видео и звук режутся, между половинами встаёт кадр на 3 с
    if (it.kind === 'media' && own?.kind === 'video' && media?.hasVideo && p.time >= it.start && p.time <= itemEnd(it)) {
      out.push({
        label: 'Стоп-кадр',
        key: 'Shift+S',
        run: () => {
          const r = insertFreeze(pr, it.id, p.time)
          if (r.error) say(r.error)
          else p.onCommit(r.p)
        }
      })
    }
    // режет всегда по курсору воспроизведения (как клавиша S), поэтому пункт есть, только когда курсор внутри куска
    if (p.time > it.start + 0.1 && p.time < itemEnd(it) - 0.1) {
      out.push({
        label: 'Разрезать',
        key: 'S',
        run: () => {
          const r = splitItem(pr, it.id, p.time)
          if (!r.id) say('Не разрезать: дорожка закреплена')
          else p.onCommit(r.p)
        }
      })
    }
    for (const side of ['left', 'right'] as const) {
      if (!canJoin(pr, it.id, side)) continue
      out.push({
        label: side === 'left' ? 'Соединить с левым' : 'Соединить с правым',
        key: 'Ctrl+J',
        run: () => {
          const r = joinWithNeighbor(pr, it.id, side)
          if (r.error) say(r.error)
          else p.onCommit(r.p)
        }
      })
    }
    const ids = p.selected.includes(it.id) ? p.selected : [it.id]
    if (canHaveEffects(pr, it)) {
      out.push(
        { label: 'Отзеркалить по горизонтали', run: () => p.onCommit(toggleFlip(pr, ids, 'h').p) },
        { label: 'Отзеркалить по вертикали', run: () => p.onCommit(toggleFlip(pr, ids, 'v').p) }
      )
    }
    out.push({ label: 'Удалить', key: 'Delete', run: () => p.onCommit(deleteItems(pr, ids, false)) })
    out.push({ label: 'Удалить и закрыть дыру', key: 'Shift+Delete', run: () => p.onCommit(deleteItems(pr, ids, true)) })
    out.push({ label: 'Добавить метку', key: 'M', run: () => addMarkerAt(it.trackId, m.t) })
    return out
  }

  const startClip = (e: React.PointerEvent, c: Clip, mode: 'move' | 'start' | 'end'): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    p.onMarkerPop(null)
    p.onSelectClip(c.id)
    dragRef.current = mode === 'move' ? { kind: 'clip-move', id: c.id, p0: p.project, x0: local(e).x, moved: false } : { kind: 'clip-trim', id: c.id, edge: mode, p0: p.project, moved: false }
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
    if (d.kind === 'marquee') {
      if (!d.moved && Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < 4) return
      if (!d.moved) {
        d.moved = true
        p.onSelectClip(null)
      }
      const r = boxRef.current?.getBoundingClientRect()
      ptrRef.current = { x, by: e.clientY - (r?.top ?? 0) }
      dragMarquee()
      return
    }
    if (d.kind === 'marker') {
      if (!d.moved && Math.abs(x - d.x0) < 3) return
      d.moved = true
      p.onMarkerPop(null)
      p.onCommit(moveMarker(p.project, d.id, Math.max(0, xToTime(x, view))), `marker-${d.id}`)
      return
    }
    if (d.kind === 'gain-base') {
      p.onCommit(setBaseVolume(d.p0, d.id, 1 - (y - d.top - GAIN_PAD) / (d.h - 2 * GAIN_PAD)), `gb-${d.id}`)
      return
    }
    if (d.kind === 'key') {
      const tl = xToTime(x, view)
      const next = moveKeysAtTime(d.p0, d.id, d.rel, tl)
      p.onCommit(next, `kf-${d.id}-${d.rel}`)
      // выбранным остаётся тот же ромбик, уже на новом месте (Delete удалит его)
      const moved = next.items.find((i) => i.id === d.id)
      if (moved) {
        const near = keyTimes(moved).sort((a, b) => Math.abs(a - (tl - moved.start)) - Math.abs(b - (tl - moved.start)))[0]
        if (near !== undefined) setSelKey({ id: d.id, rel: near })
      }
      return
    }
    if (d.kind === 'gain-pt') {
      const it = d.p0.items.find((i) => i.id === d.id)
      if (!it) return
      let t = xToTime(x, view)
      // точки липнут к краям куска и курсору (Alt — свободно)
      if (!e.altKey) t = snapTo(t, [it.start, itemEnd(it), p.time], tol)
      p.onCommit(moveGainPoint(d.p0, d.id, d.idx, t, 1 - (y - d.top - GAIN_PAD) / (d.h - 2 * GAIN_PAD)), `gp-${d.id}-${d.idx}`)
      return
    }
    if (d.kind === 'clip-move') {
      if (!d.moved && Math.abs(x - d.x0) < 3) return
      d.moved = true
      p.onCommit(moveClipBy(d.p0, d.id, (x - d.x0) / view.pps), `clip-${d.id}`)
      return
    }
    if (d.kind === 'clip-trim') {
      d.moved = true
      const c = d.p0.clips.find((k) => k.id === d.id)
      if (!c) return
      let src = sourceAt(d.p0, c.mediaId, xToTime(x, view))
      if (src === null) return
      // края встают на границы слов (Alt — свободно)
      if (!e.altKey) src = snapToWords(src, d.p0.words[c.mediaId] ?? [], d.edge, 14 / view.pps)
      p.onCommit(setClipEdge(d.p0, d.id, d.edge, src), `clip-${d.id}-${d.edge}`)
      return
    }
    const snapOn = !e.altKey
    if (d.kind === 'trim') {
      d.moved = true
      let t = xToTime(x, view)
      if (snapOn) t = snapTo(t, [...snapPoints(d.p0, d.id), p.time], tol)
      // у стоп-кадра правый край меняет длину, и правая часть дорожки едет вместе с ним
      const fz = d.p0.items.find((i) => i.id === d.id)
      if (fz?.kind === 'freeze') {
        if (d.edge === 'end') p.onCommit(setFreezeLength(d.p0, d.id, t - fz.start).p, `trim-${d.id}-end`)
        return
      }
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
      top = (rows[0]?.top ?? RULER + 8) - 6
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
    if (d?.kind === 'marquee') {
      // без протяжки это щелчок по пустому месту: снимает выделение (Ctrl/Shift — нет) и ставит курсор
      if (!d.moved) {
        if (!d.add) {
          p.onSelect([])
          p.onSelectClip(null)
        }
        p.onSeek(Math.max(0, d.t0))
      }
      endMarquee(false)
      return
    }
    dragRef.current = null
    if (d?.kind === 'move' && d.moved && ghost) p.onCommit(moveItem(d.p0, d.id, ghost.trackId, ghost.start))
    // щелчок по метке без перетаскивания открывает её окошко
    if (d?.kind === 'marker' && !d.moved) p.onMarkerPop(d.id)
    // щелчок по рамке без перетаскивания ставит курсор на её начало
    if (d?.kind === 'clip-move' && !d.moved) {
      const at = p.clips.find((k) => k.clip.id === d.id)?.at
      if (at) p.onSeek(at.start)
    }
    setGhost(null)
  }

  // --- бросок файла из «Медиа» ---
  /** Кусок под точкой (для броска эффекта): строка по y, затем кусок по времени; субтитры и звук не берём. */
  const itemAtPoint = (x: number, y: number): Item | null => {
    const r = rowAt(y)
    if (!r || typeof r !== 'object') return null
    const t = xToTime(x, view)
    return p.project.items.find((i) => i.trackId === r.track.id && i.kind !== 'subs' && t >= i.start && t <= itemEnd(i)) ?? null
  }
  const onDragOver = (e: React.DragEvent): void => {
    if (e.dataTransfer.types.includes(EFFECT_MIME)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      const { x, y } = local(e)
      setFxOver(itemAtPoint(x, y)?.id ?? null)
      return
    }
    const types = e.dataTransfer.types
    const kind: DragKind | null = types.includes(MEDIA_MIME) ? 'media' : types.includes(BANNER_MIME) ? 'banner' : types.includes(SHAPE_MIME) ? 'shape' : null
    if (!kind) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const d = currentDrag(kind)
    if (!d) return
    // то же, что делает бросок: дорожка под курсором, начало прилипает к краям кусков, меткам и курсору
    const { x, y } = local(e)
    const r = rowAt(y)
    const raw = Math.max(0, xToTime(x, view))
    const at = snapTo(raw, [...snapPoints(p.project), p.time], tol)
    const track = r === 'above' || r === 'below' ? NEW_TRACK : r && typeof r === 'object' ? r.track.id : null
    const res = p.previewDrop(kind, d.id, track, at)
    const it = res?.p.items.find((i) => i.id === res.id)
    if (!res || !it) {
      setDropPrev(null)
      return
    }
    const snapT = Math.abs(at - raw) > 1e-9 ? at : null
    const dur = itemDur(it)
    const key = `${it.trackId}|${it.start}|${dur}|${res.p.tracks.length}|${snapT}`
    setDropPrev((prev) => (prev && prev.key === key ? prev : { key, pp: res.p, trackId: it.trackId, start: it.start, dur, label: d.label, snapT }))
  }
  const onDrop = (e: React.DragEvent): void => {
    const fx = e.dataTransfer.getData(EFFECT_MIME)
    if (fx) {
      e.preventDefault()
      const { x, y } = local(e)
      setFxOver(null)
      const hit = itemAtPoint(x, y)
      if (hit) p.onDropEffect(hit.id, fx as EffectType)
      else p.onMessage('Брось карточку на кусок видео')
      return
    }
    const id = e.dataTransfer.getData(MEDIA_MIME)
    const bannerId = e.dataTransfer.getData(BANNER_MIME)
    const shapeKind = e.dataTransfer.getData(SHAPE_MIME)
    setDropPrev(null)
    endDrag()
    if (!id && !bannerId && !shapeKind) return
    e.preventDefault()
    const { x, y } = local(e)
    const r = rowAt(y)
    const at = snapTo(Math.max(0, xToTime(x, view)), [...snapPoints(p.project), p.time], tol)
    const track = r === 'above' || r === 'below' ? NEW_TRACK : r && typeof r === 'object' ? r.track.id : null
    if (id) p.onDropMedia(id, track, at)
    else if (bannerId) p.onDropBanner(bannerId, track, at)
    else p.onDropShape(shapeKind, track, at)
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
    <div className="tracks" onDragOver={onDragOver} onDragLeave={(e) => {
        // переход между дочерними элементами тоже даёт dragleave: убираем превью, только когда курсор ушёл с таймлайна
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
        setDropPrev(null)
        setFxOver(null)
      }} onDrop={onDrop}>
      <div className="tr-heads" style={{ width: HEAD }}>
        <div className="tr-head-ruler" style={{ height: RULER }} />
        <div className="tr-heads-view" style={{ top: RULER }}>
        <div className="tr-heads-content" style={{ top: -RULER, height: bottom, transform: `translateY(${-sy}px)` }}>
        {clipsTop !== null && (
          <div className="tr-head clips" style={{ top: clipsTop, height: H_CLIPS }}>
            <span className="tr-name">Клипы</span>
            <span className="tr-count mono">{p.project.clips.length}</span>
          </div>
        )}
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
              <span className="tr-name">{trackName(dropPrev ? dropPrev.pp : p.project, t.id)}</span>
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
        </div>
      </div>
      <div className="tr-wrap">
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
        <div className="tr-viewport" style={{ top: RULER }}>
        <div className="tr-content" style={{ top: -RULER, height: bottom, transform: `translateY(${-sy}px)` }}>
        {rows.map((r) => (
          <div key={r.track.id} className={`tr-lane${r.track.hidden ? ' hidden' : ''}${p.selectedTrack === r.track.id ? ' sel' : ''}`} style={{ top: r.top, height: r.h }} />
        ))}
        {clipsTop !== null && <div className="tr-lane clips" style={{ top: clipsTop, height: H_CLIPS }} />}
        {clipsTop !== null &&
          p.clips.map(({ clip, at }) => {
            if (!at || at.end < view.start || at.start > tEnd) return null
            const visFrom = Math.max(at.start, view.start - 1 / view.pps)
            const visTo = Math.min(at.end, tEnd + 1 / view.pps)
            const left = timeToX(visFrom, view)
            const width = Math.max(4, (visTo - visFrom) * view.pps)
            const sel = p.selectedClip === clip.id
            const cls = `tr-clip${sel ? ' sel' : ''}${clip.enabled ? '' : ' off'}${clip.note ? ' note' : ''}${clip.approx ? ' approx' : ''}`
            return (
              <div
                key={clip.id}
                className={cls}
                style={{ left, width, top: clipsTop, height: H_CLIPS }}
                onPointerDown={(e) => startClip(e, clip, 'move')}
                onDoubleClick={() => p.onClipOpen(clip.id)}
                title={`${clip.title || 'Клип'} · ${(clip.end - clip.start).toFixed(1)} с${clip.note ? `\nПодсказка ИИ: ${clip.note}` : ''}\nДвойной щелчок — фокус на клипе`}
              >
                {visFrom === at.start && <span className="tr-edge l" onPointerDown={(e) => startClip(e, clip, 'start')} />}
                {width > 40 && (
                  <span className="tr-clip-label">
                    {clip.title || 'Клип'} <span className="mono">{(clip.end - clip.start).toFixed(0)} с</span>
                  </span>
                )}
                {visTo === at.end && <span className="tr-edge r" onPointerDown={(e) => startClip(e, clip, 'end')} />}
              </div>
            )
          })}
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
          const isFreeze = it.kind === 'freeze'
          const isText = it.kind === 'text'
          const isShape = it.kind === 'shape'
          const onVideoTrack = row.track.kind === 'video'
          const isVideo = !isSubs && onVideoTrack && !!m?.hasVideo
          const sel = p.selected.includes(it.id)
          const pk = !isSubs && m ? p.peaks[m.id] : undefined
          const dragging = ghost?.id === it.id
          const locked = row.track.locked
          const sound = hasSound(p.project, it)
          // у видеокуска картинка сверху, звук — узкой полосой под ней; у звукового куска всё в одном
          const picH = onVideoTrack ? PIC_H : row.h
          const cls = `tr-item ${isSubs ? 'subs' : isVideo || isText || isShape ? 'video' : 'audio'}${isFreeze ? ' freeze' : ''}${isText ? ' text' : ''}${isShape ? ' shape' : ''}${fxOver === it.id ? ' fx-over' : ''}${sel ? ' sel' : ''}${dragging ? ' lifted' : ''}${row.track.muted ? ' muted' : ''}${row.track.hidden ? ' hid' : ''}${locked ? ' locked' : ''}`
          // скосы «появление» и «исчезновение»: шириной в оставшуюся длительность (после резки она может быть короче)
          const anim = animSet(it.effects)
          const fadeIn = anim.fadeIn ? Math.max(0, anim.fadeIn.d - anim.fadeIn.sk) : 0
          const fadeOut = anim.fadeOut ? Math.max(0, anim.fadeOut.d - anim.fadeOut.sk) : 0
          const fxNames = it.effects.filter((e) => e.on).map((e) => EFFECTS[e.type].title.toLowerCase())
          const label = isSubs ? `Субтитры${it.link ? '' : ' · свои'}` : isFreeze ? 'Стоп-кадр' : isText && it.plate ? plateLabel(it.plate) : isShape && it.shape ? shapeLabel(it.shape) : (m?.name ?? '—')
          const srcFrom = tlToSrc(it, visFrom)
          const srcTo = tlToSrc(it, visTo)
          const itemMenu = (e: React.MouseEvent): void => openMenu(e, (x, t, y) => ({ kind: 'item', x, y, itemId: it.id, t }), it)
          const gainHandlers = (top: number, h: number): React.ComponentProps<typeof GainLine> => ({
            item: it,
            view,
            from: visFrom,
            width: Math.round(width),
            height: h,
            onBase: (e) => startGain(e, it, top, h, null),
            onPoint: (e, idx) => startGain(e, it, top, h, idx),
            onLineMenu: (e) => openMenu(e, (x, t, y) => ({ kind: 'line', x, y, itemId: it.id, t }), it),
            onPointMenu: (e, idx) => openMenu(e, (x, _t, y) => ({ kind: 'point', x, y, itemId: it.id, idx }), it)
          })
          return (
            <Fragment key={it.id}>
              <div
                className={cls}
                style={{ left, width, top: row.top, height: picH }}
                onPointerDown={(e) => startItem(e, it, 'move')}
                onContextMenu={itemMenu}
                onDoubleClick={(e) => {
                  // двойной щелчок по полосе ключей внизу куска: ключи в этой точке (событие приходит на кусок: он держит захват указателя)
                  const r = e.currentTarget.getBoundingClientRect()
                  if (onVideoTrack && !isSubs && keyTimes(it).length > 0 && e.clientY > r.bottom - 14) p.onCommit(addKeysAtTime(p.project, it.id, xToTime(local(e).x, view)))
                }}
                title={`${label} · ${fmtTime(it.start)}–${fmtTime(end)} · ${itemDur(it).toFixed(1)} с`}
              >
                {pk && !onVideoTrack && <Wave peaks={pk} from={srcFrom} to={srcTo} width={Math.round(width)} height={row.h - 2} />}
                {isSubs && (
                  <SubsWords words={wordsByItem.get(it.id) ?? []} view={view} from={visFrom} to={visTo} width={Math.round(width)} height={picH - 2} selected={p.selectedWord} />
                )}
                {!isSubs && width > 36 && (
                  <span className="tr-label">
                    {label} <span className="mono">{itemDur(it).toFixed(1)} с</span>
                    {it.speed !== 1 && <span className="mono tr-speed"> ×{it.speed}</span>}
                    {fxNames.length > 0 && <span className="mono tr-fx"> · {fxNames.join(', ')}</span>}
                  </span>
                )}
                {fadeIn > 0 && visFrom === it.start && <span className="tr-bevel in" style={{ width: Math.min(width, fadeIn * view.pps) }} />}
                {fadeOut > 0 && visTo === end && <span className="tr-bevel out" style={{ width: Math.min(width, fadeOut * view.pps) }} />}
                {onVideoTrack && !isSubs && (
                  <KeyStrip
                    item={it}
                    view={view}
                    from={visFrom}
                    width={Math.round(width)}
                    selRel={selKey && selKey.id === it.id ? selKey.rel : null}
                    onDown={(e, rel) => startKey(e, it, rel)}
                    onMenu={(e, rel) => openMenu(e, (x, _t, y) => ({ kind: 'key', x, y, itemId: it.id, rel }), it)}
                  />
                )}
                {!locked && !isFreeze && visFrom === it.start && <span className="tr-edge l" onPointerDown={(e) => startItem(e, it, 'start')} />}
                {!locked && visTo === end && <span className="tr-edge r" onPointerDown={(e) => startItem(e, it, 'end')} />}
                {!onVideoTrack && sound && <GainLine {...gainHandlers(row.top, row.h)} />}
              </div>
              {isVideo && sound && (
                <div
                  className={`tr-astrip${sel ? ' sel' : ''}${dragging ? ' lifted' : ''}${row.track.muted ? ' muted' : ''}${locked ? ' locked' : ''}`}
                  style={{ left, width, top: row.top + PIC_H + STRIP_GAP, height: STRIP_H }}
                  onPointerDown={(e) => startItem(e, it, 'move')}
                  onContextMenu={itemMenu}
                  title={`Звук: ${label} · правый щелчок по линии — точки громкости`}
                >
                  {pk && <Wave peaks={pk} from={srcFrom} to={srcTo} width={Math.round(width)} height={STRIP_H - 2} />}
                  {!locked && visFrom === it.start && <span className="tr-edge l" onPointerDown={(e) => startItem(e, it, 'start')} />}
                  {!locked && visTo === end && <span className="tr-edge r" onPointerDown={(e) => startItem(e, it, 'end')} />}
                  <GainLine {...gainHandlers(row.top + PIC_H + STRIP_GAP, STRIP_H)} />
                </div>
              )}
            </Fragment>
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
        {p.focus && (
          <>
            <div className="tr-dim" style={{ left: 0, width: Math.max(0, timeToX(p.focus.start, view)), top: RULER, height: Math.max(h, bottom) }} />
            <div className="tr-dim" style={{ left: Math.max(0, timeToX(p.focus.end, view)), right: 0, top: RULER, height: Math.max(h, bottom) }} />
          </>
        )}
        {ghost && ghostItem && (
          <div className="tr-ghost" style={{ left: timeToX(ghost.start, view), width: Math.max(2, itemDur(ghostItem) * view.pps), top: ghost.top, height: ghost.height }} />
        )}
        {dropPrev &&
          (() => {
            const row = rows.find((rr) => rr.track.id === dropPrev.trackId)
            if (!row) return null
            const width = Math.max(2, dropPrev.dur * view.pps)
            return (
              <>
                {dropPrev.snapT !== null && <div className="tr-snap" style={{ left: Math.round(timeToX(dropPrev.snapT, view)), top: RULER, height: Math.max(h, bottom) - RULER }} />}
                <div className={`tr-drop-prev${width < 64 ? ' narrow' : ''}`} style={{ left: timeToX(dropPrev.start, view), width, top: row.top, height: row.h }}>
                  <span className="tr-dp-text">
                    <span className="tr-dp-name">{dropPrev.label}</span>
                    <span className="tr-dp-time mono">
                      {fmtTime(dropPrev.start)} · {dropPrev.dur.toFixed(1)} с
                    </span>
                  </span>
                </div>
              </>
            )
          })()}
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
        {marquee && (
          <div
            className="tr-marquee"
            style={{ left: timeToX(Math.min(marquee.t0, marquee.t1), view), width: Math.abs(marquee.t1 - marquee.t0) * view.pps, top: Math.min(marquee.y0, marquee.y1), height: Math.abs(marquee.y1 - marquee.y0) }}
          />
        )}
        </div>
        </div>
        {playX >= -1 && playX <= w + 1 && (
          <div className="tr-playhead" style={{ left: Math.round(playX), height: h }}>
            <span />
          </div>
        )}
        {p.project.items.length === 0 && <p className="tr-empty">Перетащи сюда видео или звук из «Медиа»</p>}
        {menu && (
          <div ref={menuRef} className="ctx" style={{ left: menuPos.left, top: menuPos.top, visibility: menuPos.ready ? 'visible' : 'hidden' }} onPointerDown={(e) => e.stopPropagation()} role="menu">
            {menuEntries(menu).map((en) => (
              <button
                key={en.label}
                role="menuitem"
                onClick={() => {
                  en.run()
                  setMenu(null)
                }}
              >
                {en.label === 'Добавить метку' && <Svg d={I.flag} />}
                <span className="ctx-label">{en.label}</span>
                {en.key && <span className="ctx-key mono">{en.key}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <Scrollbar
        dir="v"
        total={Math.max(1, bottom + 8 - RULER)}
        size={Math.max(1, h - RULER)}
        pos={sy}
        onPos={(v) => setScrollY(Math.max(0, Math.min(maxY, v)))}
        style={{ marginTop: RULER }}
        label="Прокрутка дорожек по вертикали"
      />
      <Scrollbar dir="h" total={span} size={w / view.pps} pos={view.start} onPos={(v) => setView((vw) => clampView({ ...vw, start: v }))} label="Прокрутка таймлайна по горизонтали" />
      </div>
    </div>
  )
}

/** Полоса прокрутки: ползунок тянется мышью, щелчок по полосе ставит ползунок в это место. total — вся длина, size — видимая часть, pos — смещение. */
function Scrollbar(p: { dir: 'h' | 'v'; total: number; size: number; pos: number; onPos(v: number): void; style?: React.CSSProperties; label: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ from: number; pos: number } | null>(null)
  const vertical = p.dir === 'v'
  const max = Math.max(0, p.total - p.size)
  const trackLen = (): number => (vertical ? ref.current?.clientHeight : ref.current?.clientWidth) ?? 1
  const thumb = vertical ? { top: `${(Math.min(p.pos, max) / p.total) * 100}%`, height: `${Math.min(1, p.size / p.total) * 100}%` } : { left: `${(Math.min(p.pos, max) / p.total) * 100}%`, width: `${Math.min(1, p.size / p.total) * 100}%` }
  return (
    <div
      ref={ref}
      className={`tr-sb ${p.dir}${max <= 0 ? ' idle' : ''}`}
      style={p.style}
      role="scrollbar"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={p.label}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(Math.min(p.pos, max))}
      onPointerDown={(e) => {
        if (e.target !== e.currentTarget || max <= 0) return
        const r = e.currentTarget.getBoundingClientRect()
        const f = vertical ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width
        p.onPos(Math.max(0, Math.min(max, f * p.total - p.size / 2)))
      }}
    >
      <div
        className="tr-sb-thumb"
        style={thumb}
        onPointerDown={(e) => {
          e.stopPropagation()
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { from: vertical ? e.clientY : e.clientX, pos: Math.min(p.pos, max) }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          p.onPos(Math.max(0, Math.min(max, d.pos + (((vertical ? e.clientY : e.clientX) - d.from) / trackLen()) * p.total)))
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      />
    </div>
  )
}

export default memo(Tracks)
