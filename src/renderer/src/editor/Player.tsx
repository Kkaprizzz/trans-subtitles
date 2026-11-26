/**
 * Плеер таймлайна. Единые часы таймлайна (time), под ними — пул <video>/<audio> только для кусков,
 * которые играют сейчас или начнутся в ближайшие секунды (следующий подгружается заранее, чтобы
 * стык был почти без запинки). Элементы создаются и двигаются напрямую, мимо React: так дешевле.
 * Картинка вписывается в кадр по центру — так же, как в экспорте (scale decrease + overlay по центру).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fontFamilyOf } from '../../../shared/fonts'
import { CLIP_H, CLIP_W, clipSubtitleStyle } from '../../../shared/cut'
import { animAt, isAnimated, propAt, type Anim } from '../../../shared/anim'
import { gainAt } from '../../../shared/audio'
import { cssFilter } from '../../../shared/effects'
import { fitSize, frameRect, isDefaultFrame, type Frame } from '../../../shared/frame'
import { fillPlate, loadPlateFont } from '../plateDom'
import { fillShape } from '../shapeDom'
import type { Shape } from '../../../shared/shape'
import { activeAt, itemDur, itemEnd, itemTrackKind, mediaOf, sourceTime, type Framing, type Item, type Project, type SubLayer, type TlWord } from '../../../shared/project'
import { buildPhrases, captionAt, DEFAULT_STYLE, normalizeStyle, type SubtitleStyle } from '../../../shared/timeline'
import { createCaptionView, setupStage, type CaptionView } from '../caption'
import EditPop from '../EditPop'

interface Props {
  project: Project
  time: number
  playing: boolean
  /** id файла -> путь копии для предпросмотра (для форматов, которые окно не показывает) */
  previews: Record<string, string>
  fontTick: number
  /** слои субтитров (по дорожкам, сверху вниз) */
  layers: SubLayer[]
  /** общая громкость предпросмотра 0…1 (на экспорт не влияет) */
  masterVolume: number
  /** слово, которое сейчас правят окошком, и обработчики */
  editWord: TlWord | null
  onWordClick(w: TlWord): void
  onEditCommit(text: string, move: -1 | 0 | 1): void
  onEditCancel(): void
  /** режим фокуса на клипе: кадр 9:16 с кропом или видео на размытом фоне; null — обычное превью */
  clipView?: { mediaId: string; mode: Framing; offsetX: number } | null
  /** сдвиг кропа, потянутый мышью в кадре */
  onOffset?(v: number): void
  /** выделенный кусок, у которого можно двигать и масштабировать кадр мышью в превью (null — нет) */
  frameItemId?: string | null
  onFrameDrag?(id: string, patch: Partial<Frame>): void
  /** выделенная надпись: её можно таскать мышью в превью */
  plateItemId?: string | null
  /** надпись потянули мышью: сдвиг в % кадра и значения в начале движения (положение плашки и ключевые значения сдвига) */
  onPlateMove?(id: string, dx: number, dy: number, start: PlateStart): void
  /** выделенная фигура: тащить, тянуть за ручки, поворачивать за углом */
  shapeItemId?: string | null
  onShapeMove?(id: string, dx: number, dy: number, start: PlateStart): void
  onShapeEdit?(id: string, edit: ShapeEdit): void
}

/** Что мышь меняет у фигуры: центр, размер, поворот. */
export type ShapeEdit = Partial<Pick<Shape, 'x' | 'y' | 'w' | 'h' | 'rot'>>

/** Значения в момент, когда надпись схватили: положение плашки (px, py) и сдвиг по ключам/«Кадру» (x, y). */
export interface PlateStart {
  px: number
  py: number
  x: number
  y: number
}

/** z-index слоя по положению дорожки: выше дорожка — выше слой. */
export const layerZ = (trackIdx: number): number => 1000 - trackIdx * 10

interface CaptionLayerProps {
  layer: SubLayer
  style: SubtitleStyle
  time: number
  z: number
  fontTick: number
  frameW: number
  frameH: number
  register(trackId: string, view: CaptionView | null): void
  onClick(w: TlWord): void
}

/** Один слой субтитров: свой хост с подписью, лежит в стопке слоёв на высоте своей дорожки. */
function CaptionLayer(p: CaptionLayerProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<CaptionView | null>(null)
  const layerRef = useRef(p.layer)
  layerRef.current = p.layer
  const clickRef = useRef(p.onClick)
  clickRef.current = p.onClick
  const words = useMemo(() => p.layer.words.map((w) => ({ id: w.id, text: w.text, start: w.start, end: w.end })), [p.layer])
  const phrases = useMemo(() => buildPhrases(words, p.style), [words, p.style])

  useLayoutEffect(() => {
    if (!hostRef.current) return
    setupStage(hostRef.current)
    const view = createCaptionView(hostRef.current)
    view.onWordClick = (idx) => {
      const w = layerRef.current.words[idx]
      if (w) clickRef.current(w)
    }
    viewRef.current = view
    p.register(p.layer.trackId, view)
    return () => {
      p.register(p.layer.trackId, null)
      viewRef.current = null
    }
  }, [p.layer.trackId]) // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    viewRef.current?.configure(words, phrases, p.style, fontFamilyOf(p.style))
  }, [words, phrases, p.style, p.fontTick, p.frameW, p.frameH])
  const caption = useMemo(() => (words.length ? captionAt(words, phrases, p.style, p.time) : null), [words, phrases, p.style, p.time])
  useLayoutEffect(() => {
    viewRef.current?.render(caption)
  }, [caption])

  return <div className="pl-captions" ref={hostRef} style={{ zIndex: p.z }} />
}

/** Одна надпись в кадре: рисуется тем же кодом, что и в экспорте; выделенную можно таскать. anim — сдвиг, масштаб и прозрачность в этот момент. */
function PlateView(p: { item: Item; z: number; W: number; H: number; selected: boolean; anim: Anim; startAt: PlateStart; onMove?(dx: number, dy: number, start: PlateStart): void }): React.JSX.Element | null {
  const plate = p.item.plate
  const ref = useRef<HTMLDivElement>(null)
  const [tick, setTick] = useState(0)
  const drag = useRef<{ x: number; y: number; start: PlateStart } | null>(null)
  useEffect(() => {
    if (!plate) return
    let alive = true
    void loadPlateFont(plate).then(() => alive && setTick((n) => n + 1))
    return () => {
      alive = false
    }
  }, [plate?.font, plate?.weight, plate?.text]) // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !plate) return
    fillPlate(el, plate, p.W, p.H, { h: p.item.frame.flipH === 1, v: p.item.frame.flipV === 1 })
    if (p.selected && p.onMove) {
      el.style.pointerEvents = 'auto'
      el.style.cursor = 'move'
      el.style.outline = '1.5px solid var(--accent)'
      el.style.touchAction = 'none'
    }
  }, [plate, p.item.frame.flipH, p.item.frame.flipV, p.W, p.H, p.selected, tick]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!plate) return null
  const a = p.anim
  // обёртка во весь кадр: сдвиг в % кадра, масштаб от центра блока, прозрачность — те же значения, что считает экспорт
  const moving = a.x !== 0 || a.y !== 0 || a.scale !== 1
  return (
    <div
      className="pl-anim"
      style={{
        zIndex: p.z,
        transformOrigin: `${plate.x}% ${plate.y}%`,
        transform: moving ? `translate(${a.x}%, ${a.y}%) scale(${a.scale})` : undefined,
        opacity: a.opacity < 1 ? a.opacity : undefined
      }}
    >
      <div
        ref={ref}
        className="pl-plate"
        onPointerDown={(e) => {
          if (!p.selected || !p.onMove || e.button !== 0) return
          e.stopPropagation()
          ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, start: p.startAt }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d || !p.onMove) return
          // курсор движется по экрану, а блок — в его же масштабе: переводим пиксели в % кадра
          p.onMove(((e.clientX - d.x) / p.W) * 100, ((e.clientY - d.y) / p.H) * 100, d.start)
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      />
    </div>
  )
}

const HANDLES: Array<{ id: string; sx: number; sy: number; cursor: string; style: React.CSSProperties }> = [
  { id: 'nw', sx: -1, sy: -1, cursor: 'nwse-resize', style: { left: 0, top: 0 } },
  { id: 'n', sx: 0, sy: -1, cursor: 'ns-resize', style: { left: '50%', top: 0 } },
  { id: 'ne', sx: 1, sy: -1, cursor: 'nesw-resize', style: { left: '100%', top: 0 } },
  { id: 'e', sx: 1, sy: 0, cursor: 'ew-resize', style: { left: '100%', top: '50%' } },
  { id: 'se', sx: 1, sy: 1, cursor: 'nwse-resize', style: { left: '100%', top: '100%' } },
  { id: 's', sx: 0, sy: 1, cursor: 'ns-resize', style: { left: '50%', top: '100%' } },
  { id: 'sw', sx: -1, sy: 1, cursor: 'nesw-resize', style: { left: 0, top: '100%' } },
  { id: 'w', sx: -1, sy: 0, cursor: 'ew-resize', style: { left: 0, top: '50%' } }
]
const ROT_ZONES: Array<{ id: string; style: React.CSSProperties }> = [
  { id: 'r-nw', style: { left: 0, top: 0 } },
  { id: 'r-ne', style: { left: '100%', top: 0 } },
  { id: 'r-se', style: { left: '100%', top: '100%' } },
  { id: 'r-sw', style: { left: 0, top: '100%' } }
]
const MIN_SHAPE_PX = 4

type ShapeDrag =
  | { mode: 'move'; x: number; y: number; start: PlateStart }
  | { mode: 'size'; x: number; y: number; sx: number; sy: number; shape: Shape; theta: number; scale: number }
  | { mode: 'rot'; cx: number; cy: number; a0: number; theta0: number; mirrored: boolean }

/** Одна фигура в кадре: рисуется тем же кодом, что и в экспорте; у выделенной — рамка с ручками размера и зонами поворота у углов. */
function ShapeView(p: {
  item: Item
  z: number
  W: number
  H: number
  selected: boolean
  anim: Anim
  startAt: PlateStart
  onMove?(dx: number, dy: number, start: PlateStart): void
  onEdit?(edit: ShapeEdit): void
}): React.JSX.Element | null {
  const sh = p.item.shape
  const ref = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const drag = useRef<ShapeDrag | null>(null)
  const flipH = p.item.frame.flipH === 1
  const flipV = p.item.frame.flipV === 1
  useLayoutEffect(() => {
    if (ref.current && sh) fillShape(ref.current, sh, p.W, p.H, { h: flipH, v: flipV })
  }, [sh, flipH, flipV, p.W, p.H])
  if (!sh) return null
  const a = p.anim
  const moving = a.x !== 0 || a.y !== 0 || a.scale !== 1
  // зеркало по одной оси переворачивает направление поворота на экране
  const mirrored = flipH !== flipV
  const theta = mirrored ? -sh.rot : sh.rot
  const editable = p.selected && !!p.onEdit

  const down = (e: React.PointerEvent, mode: 'move' | 'size' | 'rot', h?: { sx: number; sy: number }): void => {
    if (!editable || e.button !== 0) return
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    if (mode === 'move') drag.current = { mode, x: e.clientX, y: e.clientY, start: p.startAt }
    else if (mode === 'size' && h) drag.current = { mode, x: e.clientX, y: e.clientY, sx: h.sx, sy: h.sy, shape: sh, theta, scale: a.scale }
    else {
      const r = boxRef.current?.getBoundingClientRect()
      if (!r) return
      const cx = (r.left + r.right) / 2
      const cy = (r.top + r.bottom) / 2
      drag.current = { mode: 'rot', cx, cy, a0: Math.atan2(e.clientY - cy, e.clientX - cx), theta0: theta, mirrored }
    }
  }
  const move = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    if (d.mode === 'move') {
      p.onMove?.(((e.clientX - d.x) / p.W) * 100, ((e.clientY - d.y) / p.H) * 100, d.start)
    } else if (d.mode === 'size') {
      // сдвиг мыши в осях самой фигуры (с учётом поворота и масштаба куска)
      const rad = (d.theta * Math.PI) / 180
      const dx = e.clientX - d.x
      const dy = e.clientY - d.y
      const lx = (dx * Math.cos(rad) + dy * Math.sin(rad)) / d.scale
      const ly = (-dx * Math.sin(rad) + dy * Math.cos(rad)) / d.scale
      const bw0 = (d.shape.w / 100) * p.W
      const bh0 = (d.shape.h / 100) * p.H
      const bw = d.sx === 0 ? bw0 : Math.max(MIN_SHAPE_PX, bw0 + d.sx * lx)
      const bh = d.sy === 0 ? bh0 : Math.max(MIN_SHAPE_PX, bh0 + d.sy * ly)
      // противоположная сторона стоит на месте: центр сдвигается на половину изменения размера
      const cx = (d.sx * (bw - bw0) * d.scale) / 2
      const cy = (d.sy * (bh - bh0) * d.scale) / 2
      const sx = cx * Math.cos(rad) - cy * Math.sin(rad)
      const sy = cx * Math.sin(rad) + cy * Math.cos(rad)
      p.onEdit?.({ w: (bw / p.W) * 100, h: (bh / p.H) * 100, x: d.shape.x + (sx / p.W) * 100, y: d.shape.y + (sy / p.H) * 100 })
    } else {
      let t = d.theta0 + ((Math.atan2(e.clientY - d.cy, e.clientX - d.cx) - d.a0) * 180) / Math.PI
      if (e.shiftKey) t = Math.round(t / 15) * 15
      let rot = d.mirrored ? -t : t
      rot = ((((rot + 180) % 360) + 360) % 360) - 180
      p.onEdit?.({ rot })
    }
  }
  const up = (): void => {
    drag.current = null
  }
  return (
    <div
      className="pl-anim"
      style={{
        zIndex: p.z,
        transformOrigin: `${sh.x}% ${sh.y}%`,
        transform: moving ? `translate(${a.x}%, ${a.y}%) scale(${a.scale})` : undefined,
        opacity: a.opacity < 1 ? a.opacity : undefined
      }}
    >
      <div ref={ref} className="pl-shape" />
      {editable && (
        <div
          ref={boxRef}
          className="pl-shape-box"
          style={{ left: `${sh.x}%`, top: `${sh.y}%`, width: (sh.w / 100) * p.W, height: (sh.h / 100) * p.H, transform: `translate(-50%, -50%) rotate(${theta}deg)` }}
          onPointerDown={(e) => down(e, 'move')}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        >
          {ROT_ZONES.map((z) => (
            <span key={z.id} className="pl-rot" style={z.style} onPointerDown={(e) => down(e, 'rot')} onPointerMove={move} onPointerUp={up} onPointerCancel={up} title="Повернуть (Shift — по 15°)" />
          ))}
          {HANDLES.map((h) => (
            <span key={h.id} className="pl-handle" style={{ ...h.style, cursor: h.cursor }} onPointerDown={(e) => down(e, 'size', h)} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
          ))}
        </div>
      )}
    </div>
  )
}

const PRELOAD = 2
const DRIFT = 0.25

type El = HTMLVideoElement | HTMLAudioElement

export default function Player(p: Props): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const views = useRef(new Map<string, CaptionView>())
  const pool = useRef(new Map<string, { el: El; src: string }>())
  const [box, setBox] = useState({ w: 0, h: 0 })

  const cv = p.clipView ?? null
  const canvas = cv ? { w: CLIP_W, h: CLIP_H } : (p.project.canvas ?? { w: 1920, h: 1080 })
  const aspect = canvas.w / canvas.h
  const frameW = Math.max(0, Math.min(box.w - 24, (box.h - 24) * aspect))
  const frameH = frameW / aspect

  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // --- синхронизация элементов с часами ---
  const trackOrder = useMemo(() => new Map(p.project.tracks.map((t, i) => [t.id, i])), [p.project.tracks])
  const muted = useMemo(() => new Set(p.project.tracks.filter((t) => t.muted).map((t) => t.id)), [p.project.tracks])
  const hidden = useMemo(() => new Set(p.project.tracks.filter((t) => t.hidden).map((t) => t.id)), [p.project.tracks])

  // размытый фон для режима «целиком на блюре»: мелкая копия текущего кадра, CSS растягивает и размывает
  const bgRef = useRef<HTMLCanvasElement>(null)
  const latest = useRef({ project: p.project, time: p.time, cv })
  latest.current = { project: p.project, time: p.time, cv }
  const paintBg = useCallback(() => {
    const canvasEl = bgRef.current
    const { project, time, cv: view } = latest.current
    if (!canvasEl || !view || view.mode !== 'fit-blur') return
    const ctx = canvasEl.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, canvasEl.width, canvasEl.height)
    const it = activeAt(project, time).find((i) => i.kind === 'media' && i.mediaId === view.mediaId)
    const el = it ? pool.current.get(it.id)?.el : undefined
    if (!(el instanceof HTMLVideoElement) || el.readyState < 2 || !el.videoWidth) return
    const k = Math.max(canvasEl.width / el.videoWidth, canvasEl.height / el.videoHeight)
    const w = el.videoWidth * k
    const h = el.videoHeight * k
    ctx.drawImage(el, (canvasEl.width - w) / 2, (canvasEl.height - h) / 2, w, h)
  }, [])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const t = p.time
    // куски субтитров — не медиа: для них элементов не заводим
    const isPic = (i: Item): boolean => i.kind === 'media' || i.kind === 'freeze'
    const active = activeAt(p.project, t).filter(isPic)
    const activeIds = new Set(active.map((i) => i.id))
    const upcoming = p.playing ? p.project.items.filter((i) => isPic(i) && !activeIds.has(i.id) && i.start > t && i.start - t < PRELOAD) : []
    const wanted = new Map<string, Item>([...active, ...upcoming].map((i) => [i.id, i]))

    // лишние — убрать
    for (const [id, rec] of pool.current) {
      if (wanted.has(id)) continue
      rec.el.pause()
      rec.el.removeAttribute('src')
      rec.el.load()
      rec.el.remove()
      pool.current.delete(id)
    }

    for (const it of wanted.values()) {
      const m = mediaOf(p.project, it.mediaId)
      if (!m) continue
      const path = p.previews[m.id] ?? (m.needsPreview ? '' : m.path)
      let rec = pool.current.get(it.id)
      const src = path ? window.api.mediaUrl(path) : ''
      if (!rec) {
        // картинка — только у кусков на видеодорожке; звук, отделённый от видео, играет через <audio>
        const asVideo = m.hasVideo && itemTrackKind(p.project, it) === 'video'
        const el: El = asVideo ? document.createElement('video') : document.createElement('audio')
        el.preload = 'auto'
        if (el instanceof HTMLVideoElement) {
          el.playsInline = true
          el.className = 'pl-video'
        }
        frame.appendChild(el)
        rec = { el, src: '' }
        pool.current.set(it.id, rec)
      }
      if (rec.src !== src) {
        rec.src = src
        if (src) rec.el.src = src
        else rec.el.removeAttribute('src')
      }
      const el = rec.el
      if (el instanceof HTMLVideoElement) {
        // кадр клипа: куски его файла заполняют вертикаль (кроп со сдвигом) или лежат целиком поверх размытого фона
        const framed = !!cv && it.mediaId === cv.mediaId
        el.style.objectFit = framed && cv.mode === 'crop' ? 'cover' : 'contain'
        el.style.objectPosition = framed && cv.mode === 'crop' ? `${cv.offsetX * 100}% 50%` : '50% 50%'
        // эффекты куска (блюр — в долях высоты кадра, как в экспорте)
        el.style.filter = cssFilter(it.effects, frameH)
        // кадр куска: кроп режет края вписанной картинки (clip-path в px элемента); положение, масштаб и прозрачность — по времени
        // куска (ключи и анимации, одна функция с экспортом), от центра кадра
        const fr = it.frame
        const a = animAt(it, itemDur(it), Math.min(itemDur(it), Math.max(0, t - it.start)))
        const still = isDefaultFrame(fr) && !isAnimated(it)
        if (still) {
          el.style.transform = ''
          el.style.clipPath = ''
          el.style.opacity = ''
        } else {
          const fit = framed ? { w: frameW, h: frameH } : fitSize(m.width ?? 0, m.height ?? 0, frameW, frameH)
          // кроп считается по экрану: при зеркале его стороны меняются местами (clip-path режет до отражения)
          const l = (frameW - fit.w) / 2 + (fit.w * (fr.flipH ? fr.cr : fr.cl)) / 100
          const r = (frameW - fit.w) / 2 + (fit.w * (fr.flipH ? fr.cl : fr.cr)) / 100
          const tp = (frameH - fit.h) / 2 + (fit.h * (fr.flipV ? fr.cb : fr.ct)) / 100
          const b = (frameH - fit.h) / 2 + (fit.h * (fr.flipV ? fr.ct : fr.cb)) / 100
          el.style.clipPath = fr.cl || fr.cr || fr.ct || fr.cb ? `inset(${tp.toFixed(1)}px ${r.toFixed(1)}px ${b.toFixed(1)}px ${l.toFixed(1)}px)` : ''
          el.style.transform = `translate(${a.x}%, ${a.y}%) scale(${fr.flipH ? -a.scale : a.scale}, ${fr.flipV ? -a.scale : a.scale})`
          el.style.opacity = a.opacity < 1 ? String(a.opacity) : ''
        }
      }
      // скорость куска; тон сохраняется (preservesPitch по умолчанию включён)
      if (el.playbackRate !== it.speed) el.playbackRate = it.speed
      el.muted = muted.has(it.trackId) || !it.audio
      // громкость куска по его линии в этот момент × общая громкость предпросмотра
      const own = gainAt(it.gain, it.volume, activeIds.has(it.id) ? sourceTime(it, t) : it.in)
      el.volume = Math.min(1, Math.max(0, own * p.masterVolume))
      const isActive = activeIds.has(it.id)
      if (el instanceof HTMLVideoElement) {
        // скрытая дорожка картинки не даёт, а звук её куска продолжает играть
        el.style.visibility = isActive && !hidden.has(it.trackId) ? 'visible' : 'hidden'
        // ниже по списку дорожек — ниже по слоям
        el.style.zIndex = String(layerZ(trackOrder.get(it.trackId) ?? 0))
      }
      // стоп-кадр всегда показывает один кадр файла (секунда in) и никогда не играет
      const freeze = it.kind === 'freeze'
      const want = freeze ? it.in : isActive ? sourceTime(it, t) : it.in
      if (freeze) el.muted = true
      if (!src) continue
      if (isActive && p.playing && !freeze) {
        if (Math.abs(el.currentTime - want) > DRIFT * Math.max(1, it.speed)) el.currentTime = want
        if (el.paused) void el.play().catch(() => {})
      } else {
        if (!el.paused) el.pause()
        if (Math.abs(el.currentTime - want) > (isActive && !freeze ? 0.02 : freeze ? 0.01 : 0.2)) el.currentTime = want
      }
    }
    paintBg()
    const h = setTimeout(paintBg, 90)
    return () => clearTimeout(h)
  }, [p.time, p.playing, p.project, p.previews, p.masterVolume, trackOrder, muted, hidden, frameH, cv?.mode, cv?.offsetX, cv?.mediaId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Ушли с проекта — освобождаем все элементы.
  useEffect(() => {
    const map = pool.current
    return () => {
      for (const rec of map.values()) {
        rec.el.pause()
        rec.el.removeAttribute('src')
        rec.el.load()
        rec.el.remove()
      }
      map.clear()
    }
  }, [])

  // --- субтитры поверх кадра (тот же код, что в экспорте), по слою на дорожку ---
  const style = useMemo(() => (cv ? clipSubtitleStyle(normalizeStyle(p.project.style ?? DEFAULT_STYLE)) : normalizeStyle(p.project.style ?? DEFAULT_STYLE)), [p.project.style, !!cv]) // eslint-disable-line react-hooks/exhaustive-deps
  const register = useMemo(
    () => (trackId: string, view: CaptionView | null) => {
      if (view) views.current.set(trackId, view)
      else views.current.delete(trackId)
    },
    []
  )

  // окошко правки встаёт под слово на кадре (или внизу кадра, если слово сейчас не нарисовано)
  const [pop, setPop] = useState<{ x: number; y: number } | null>(null)
  const editLayer = p.editWord ? p.layers.find((l) => l.trackId === p.editWord?.trackId) : undefined
  const editLayerIdx = editLayer && p.editWord ? editLayer.words.findIndex((w) => w.itemId === p.editWord?.itemId && w.idx === p.editWord?.idx) : -1
  useLayoutEffect(() => {
    if (!p.editWord || !stageRef.current) {
      setPop(null)
      return
    }
    const stage = stageRef.current.getBoundingClientRect()
    const r = editLayerIdx >= 0 ? views.current.get(p.editWord.trackId)?.wordRect(editLayerIdx) : null
    const next = r
      ? { x: Math.round(r.left + r.width / 2 - stage.left), y: Math.round(r.bottom - stage.top + 10) }
      : { x: Math.round(stage.width / 2), y: Math.round(stage.height * 0.78) }
    setPop((prev) => (prev && prev.x === next.x && prev.y === next.y ? prev : next))
  }, [p.editWord, editLayerIdx, p.time, frameW, frameH, p.fontTick])

  // сдвиг кропа мышью прямо в кадре: тянем вправо — видна левая часть исходника
  const offDrag = useRef<{ x: number; start: number; excess: number } | null>(null)
  const srcMedia = cv ? mediaOf(p.project, cv.mediaId) : undefined
  const srcAspect = srcMedia?.width && srcMedia.height ? srcMedia.width / srcMedia.height : 16 / 9
  const cropExcess = frameH * srcAspect - frameW
  const canOffset = !!cv && cv.mode === 'crop' && !!p.onOffset && cropExcess > 1

  // рамка выделенного куска в предпросмотре: тянуть внутри — положение, за угол — масштаб (пропорционально)
  const selItem = !cv && p.frameItemId ? p.project.items.find((i) => i.id === p.frameItemId && p.time >= i.start && p.time < itemEnd(i)) : undefined
  const selMedia = selItem ? mediaOf(p.project, selItem.mediaId) : undefined
  // рамка идёт за картинкой: положение и масштаб — с учётом ключей и анимаций в этот момент
  const selAnim = selItem ? animAt(selItem, itemDur(selItem), Math.min(itemDur(selItem), Math.max(0, p.time - selItem.start))) : null
  const selFrame: Frame | null = selItem && selAnim ? { ...selItem.frame, x: selAnim.x, y: selAnim.y, scale: selAnim.scale * 100 } : null
  const selBox = (() => {
    if (!selItem || !selMedia || !selFrame || frameW <= 0) return null
    const r = frameRect(selFrame, selMedia.width ?? 0, selMedia.height ?? 0, frameW, frameH)
    const fr = selItem.frame
    return { x: r.x + (r.w * fr.cl) / 100, y: r.y + (r.h * fr.ct) / 100, w: r.w * (1 - (fr.cl + fr.cr) / 100), h: r.h * (1 - (fr.ct + fr.cb) / 100) }
  })()
  const dragRef = useRef<{ mode: string; x: number; y: number; frame: Frame; cx: number; cy: number; r0: number } | null>(null)
  const startFrameDrag = (e: React.PointerEvent, mode: string): void => {
    if (!selItem || e.button !== 0 || !stageRef.current) return
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const fr0 = frameRef.current?.getBoundingClientRect()
    if (!fr0) return
    const rect = frameRect(selFrame ?? selItem.frame, selMedia?.width ?? 0, selMedia?.height ?? 0, frameW, frameH)
    const cx = fr0.left + rect.x + rect.w / 2
    const cy = fr0.top + rect.y + rect.h / 2
    // правка идёт от значения по ключам (без готовых анимаций): так ключ получает ровно то, что потянули
    const rel = Math.min(itemDur(selItem), Math.max(0, p.time - selItem.start))
    const start: Frame = { ...selItem.frame, x: propAt(selItem, 'x', rel), y: propAt(selItem, 'y', rel), scale: propAt(selItem, 'scale', rel) }
    dragRef.current = { mode, x: e.clientX, y: e.clientY, frame: start, cx, cy, r0: Math.max(8, Math.hypot(e.clientX - cx, e.clientY - cy)) }
  }
  const onFramePointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current
    if (!d || !p.frameItemId || !p.onFrameDrag) return
    if (d.mode === 'move') p.onFrameDrag(p.frameItemId, { x: d.frame.x + ((e.clientX - d.x) / frameW) * 100, y: d.frame.y + ((e.clientY - d.y) / frameH) * 100 })
    else p.onFrameDrag(p.frameItemId, { scale: d.frame.scale * (Math.hypot(e.clientX - d.cx, e.clientY - d.cy) / d.r0) })
  }

  const empty = p.project.items.length === 0
  const nothingNow = !empty && !p.project.items.some((i) => p.time >= i.start && p.time < itemEnd(i))

  return (
    <div className="pl-stage" ref={stageRef}>
      <div
        className={`pl-frame${canOffset ? ' offsettable' : ''}`}
        ref={frameRef}
        style={{ width: frameW, height: frameH }}
        onPointerDown={(e) => {
          if (!canOffset || !cv || e.button !== 0 || (e.target as HTMLElement).closest('[data-word]')) return
          e.currentTarget.setPointerCapture(e.pointerId)
          offDrag.current = { x: e.clientX, start: cv.offsetX, excess: cropExcess }
        }}
        onPointerMove={(e) => {
          onFramePointerMove(e)
          const d = offDrag.current
          if (!d || !p.onOffset) return
          p.onOffset(Math.min(1, Math.max(0, d.start - (e.clientX - d.x) / d.excess)))
        }}
        onPointerUp={() => {
          offDrag.current = null
          dragRef.current = null
        }}
        onPointerCancel={() => {
          offDrag.current = null
          dragRef.current = null
        }}
      >
        {cv?.mode === 'fit-blur' && <canvas ref={bgRef} className="pl-bg" width={54} height={96} />}
        {activeAt(p.project, p.time)
          .filter((i) => i.kind === 'text' && !hidden.has(i.trackId))
          .map((i) => {
            const rel = Math.min(itemDur(i), Math.max(0, p.time - i.start))
            return (
              <PlateView
                key={i.id}
                item={i}
                z={layerZ(trackOrder.get(i.trackId) ?? 0)}
                W={frameW}
                H={frameH}
                selected={p.plateItemId === i.id}
                anim={animAt(i, itemDur(i), rel)}
                startAt={{ px: i.plate?.x ?? 50, py: i.plate?.y ?? 50, x: propAt(i, 'x', rel), y: propAt(i, 'y', rel) }}
                onMove={p.onPlateMove ? (dx, dy, start) => p.onPlateMove?.(i.id, dx, dy, start) : undefined}
              />
            )
          })}
        {activeAt(p.project, p.time)
          .filter((i) => i.kind === 'shape' && !hidden.has(i.trackId))
          .map((i) => {
            const rel = Math.min(itemDur(i), Math.max(0, p.time - i.start))
            return (
              <ShapeView
                key={i.id}
                item={i}
                z={layerZ(trackOrder.get(i.trackId) ?? 0)}
                W={frameW}
                H={frameH}
                selected={p.shapeItemId === i.id}
                anim={animAt(i, itemDur(i), rel)}
                startAt={{ px: i.shape?.x ?? 50, py: i.shape?.y ?? 50, x: propAt(i, 'x', rel), y: propAt(i, 'y', rel) }}
                onMove={p.onShapeMove ? (dx, dy, start) => p.onShapeMove?.(i.id, dx, dy, start) : undefined}
                onEdit={p.onShapeEdit ? (edit) => p.onShapeEdit?.(i.id, edit) : undefined}
              />
            )
          })}
        {selBox && p.onFrameDrag && (
          <div
            className="pl-sel"
            style={{ left: selBox.x, top: selBox.y, width: selBox.w, height: selBox.h }}
            onPointerDown={(e) => startFrameDrag(e, 'move')}
          >
            {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
              <span key={c} className={`pl-handle ${c}`} onPointerDown={(e) => startFrameDrag(e, c)} />
            ))}
          </div>
        )}
        {p.layers.map((l) => (
          <CaptionLayer
            key={l.trackId}
            layer={l}
            style={style}
            time={p.time}
            z={layerZ(trackOrder.get(l.trackId) ?? 0)}
            fontTick={p.fontTick}
            frameW={frameW}
            frameH={frameH}
            register={register}
            onClick={p.onWordClick}
          />
        ))}
      </div>
      {empty && <p className="pl-empty">Перетащи видео из «Медиа» на таймлайн</p>}
      {nothingNow && <p className="pl-empty dim">Здесь на таймлайне пусто</p>}
      {p.editWord && pop && (
        <EditPop key={`${p.editWord.itemId}-${p.editWord.idx}`} text={p.editWord.text} x={pop.x} y={pop.y} stageW={box.w} onCommit={p.onEditCommit} onCancel={p.onEditCancel} />
      )}
    </div>
  )
}
