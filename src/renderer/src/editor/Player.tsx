/**
 * Плеер таймлайна. Единые часы таймлайна (time), под ними — пул <video>/<audio> только для кусков,
 * которые играют сейчас или начнутся в ближайшие секунды (следующий подгружается заранее, чтобы
 * стык был почти без запинки). Элементы создаются и двигаются напрямую, мимо React: так дешевле.
 * Картинка вписывается в кадр по центру — так же, как в экспорте (scale decrease + overlay по центру).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fontFamilyOf } from '../../../shared/fonts'
import { CLIP_H, CLIP_W, clipSubtitleStyle } from '../../../shared/cut'
import { gainAt } from '../../../shared/audio'
import { blurSigma } from '../../../shared/effects'
import { activeAt, itemEnd, itemTrackKind, mediaOf, sourceTime, type Framing, type Item, type Project, type SubLayer, type TlWord } from '../../../shared/project'
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
        // эффекты куска: блюр в долях высоты кадра — как в экспорте
        const px = it.effects.reduce((n, e) => (e.on && e.type === 'blur' ? n + blurSigma(e.strength, frameH) : n), 0)
        el.style.filter = px >= 0.3 ? `blur(${px.toFixed(1)}px)` : ''
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
          const d = offDrag.current
          if (!d || !p.onOffset) return
          p.onOffset(Math.min(1, Math.max(0, d.start - (e.clientX - d.x) / d.excess)))
        }}
        onPointerUp={() => (offDrag.current = null)}
        onPointerCancel={() => (offDrag.current = null)}
      >
        {cv?.mode === 'fit-blur' && <canvas ref={bgRef} className="pl-bg" width={54} height={96} />}
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
