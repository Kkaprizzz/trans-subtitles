/**
 * «Кадр» куска: масштаб, положение, кроп и прозрачность картинки в кадре проекта. Не эффект: свои поля в инспекторе и рамка в превью.
 * Кроп режет края картинки (обрезанное место прозрачное, остаток не двигается и не растягивается); масштаб и положение
 * считаются от центра кадра. Порядок в экспорте: вписывание → эффекты → кроп → масштаб и положение.
 */
export interface Frame {
  /** масштаб, % (100 — как вписано) */
  scale: number
  /** сдвиг от центра кадра, % ширины и высоты кадра проекта */
  x: number
  y: number
  /** кроп: доля картинки, срезаемая с каждой стороны, % */
  cl: number
  cr: number
  ct: number
  cb: number
  /** непрозрачность куска, % (100 — как есть) */
  opacity: number
  /** зеркало: 1 — отражено по горизонтали / по вертикали (флаги, не анимируются) */
  flipH: number
  flipV: number
}

export const DEFAULT_FRAME: Frame = { scale: 100, x: 0, y: 0, cl: 0, cr: 0, ct: 0, cb: 0, opacity: 100, flipH: 0, flipV: 0 }
export const FRAME_LIMITS = { scale: [10, 400], x: [-150, 150], y: [-100, 100], cl: [0, 90], cr: [0, 90], ct: [0, 90], cb: [0, 90], opacity: [0, 100], flipH: [0, 1], flipV: [0, 1] } as const
export type FrameKey = keyof Frame

const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x))
const round = (x: number): number => Math.round(x * 100) / 100

/** Кадр без движения: всё по умолчанию, кроме зеркала (оно рисуется в самой картинке слоя). */
export const isStillFrame = (f: Frame): boolean => isDefaultFrame({ ...f, flipH: 0, flipV: 0 })

/** Зеркало куска для ffmpeg: фильтры после вписывания и эффектов, до кропа (кроп считается по экрану). */
export const flipFilters = (f: Frame): string[] => [...(f.flipH ? ['hflip'] : []), ...(f.flipV ? ['vflip'] : [])]

export const isDefaultFrame = (f: Frame): boolean => (Object.keys(DEFAULT_FRAME) as FrameKey[]).every((k) => f[k] === DEFAULT_FRAME[k])
export const sameFrame = (a: Frame, b: Frame): boolean => (Object.keys(DEFAULT_FRAME) as FrameKey[]).every((k) => Math.abs(a[k] - b[k]) < 1e-6)

/** Кадр из файла проекта: мусор — по умолчанию, значения в пределах, кроп не съедает картинку целиком (сумма сторон ≤ 95%). */
export function cleanFrame(raw: unknown): Frame {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const f = { ...DEFAULT_FRAME }
  for (const k of Object.keys(f) as FrameKey[]) {
    const v = Number(r[k])
    if (Number.isFinite(v)) f[k] = round(clamp(v, FRAME_LIMITS[k][0], FRAME_LIMITS[k][1]))
  }
  f.flipH = f.flipH >= 0.5 ? 1 : 0
  f.flipV = f.flipV >= 0.5 ? 1 : 0
  return limitCrop(f)
}

/** Противоположные стороны кропа в сумме не больше 95%: картинка не исчезает совсем. */
export function limitCrop(f: Frame): Frame {
  const g = { ...f }
  if (g.cl + g.cr > 95) g.cr = round(Math.max(0, 95 - g.cl))
  if (g.ct + g.cb > 95) g.cb = round(Math.max(0, 95 - g.ct))
  return g
}

export function patchFrameValues(f: Frame, patch: Partial<Frame>, prefer?: FrameKey): Frame {
  const g = { ...f }
  for (const k of Object.keys(patch) as FrameKey[]) {
    const v = Number(patch[k])
    if (Number.isFinite(v)) g[k] = round(clamp(v, FRAME_LIMITS[k][0], FRAME_LIMITS[k][1]))
  }
  // если сумма противоположных сторон превысила предел, уступает другая сторона, а не та, что двигают
  g.flipH = g.flipH >= 0.5 ? 1 : 0
  g.flipV = g.flipV >= 0.5 ? 1 : 0
  const lim = limitCrop(g)
  if (prefer === 'cr' || prefer === 'cb') {
    if (g.cl + g.cr > 95) lim.cr = round(95 - g.cl)
  } else if (prefer === 'cl') {
    if (g.cl + g.cr > 95) {
      lim.cl = g.cl
      lim.cr = round(Math.max(0, 95 - g.cl))
    }
  }
  return lim
}

/** Размер картинки, вписанной в кадр W×H (как в экспорте: scale decrease). */
export function fitSize(mw: number, mh: number, W: number, H: number): { w: number; h: number } {
  if (!(mw > 0) || !(mh > 0)) return { w: W, h: H }
  const k = Math.min(W / mw, H / mh)
  return { w: mw * k, h: mh * k }
}

const f4 = (x: number): string => (Math.round(x * 10000) / 10000).toString()

/** Свойство кадра для ffmpeg: число или выражение от времени (см. anim.ts, animExpr). */
export type DynValue = { c: number; e?: undefined } | { c?: undefined; e: string }
export interface FrameDyn {
  x: DynValue
  y: DynValue
  scale: DynValue
}

/**
 * Фильтры кадра для ffmpeg. fw, fh — размер вписанной картинки в кадре W×H. Возвращает цепочку фильтров (кроп и масштаб;
 * отдельно crop и scale — между ними встаёт прозрачность) и выражения x/y для overlay (в них доступны W, H и w, h — размер
 * уже обрезанной и промасштабированной картинки). Для кадра по умолчанию — null: граф остаётся прежним.
 * dyn — положение и масштаб меняются по времени (анимация): тогда выражения считаются на каждый кадр (scale eval=frame),
 * а null не возвращается.
 */
export function frameFilters(f: Frame, fw: number, fh: number, dyn?: FrameDyn): { chain: string[]; crop: string[]; scale: string[]; x: string; y: string } | null {
  if (!dyn && isDefaultFrame(f)) return null
  const sv: DynValue = dyn ? dyn.scale : { c: f.scale / 100 }
  const S = sv.e !== undefined ? `(${sv.e})` : f4(sv.c ?? 1)
  // сдвиг как доля кадра
  const share = (v: DynValue | undefined, base: number): string => (v && v.e !== undefined ? `(${v.e})/100` : f4((v ? (v.c ?? 0) : base) / 100))
  const X = share(dyn?.x, f.x)
  const Y = share(dyn?.y, f.y)
  const crop: string[] = []
  const scale: string[] = []
  const cropped = f.cl || f.cr || f.ct || f.cb
  if (cropped) {
    crop.push(`crop=iw*${f4(1 - (f.cl + f.cr) / 100)}:ih*${f4(1 - (f.ct + f.cb) / 100)}:iw*${f4(f.cl / 100)}:ih*${f4(f.ct / 100)}`)
  }
  if (sv.e !== undefined) scale.push(`scale=w='max(2,2*trunc(iw*${S}/2))':h='max(2,2*trunc(ih*${S}/2))':eval=frame`)
  else if (Math.abs((sv.c ?? 1) - 1) > 1e-6) scale.push(`scale=trunc(iw*${S}/2)*2:trunc(ih*${S}/2)*2`)
  // центр вписанной картинки — центр кадра; обрезанная часть смещена от него на половину разницы сторон
  const offX = ((f.cl - f.cr) / 200) * fw
  const offY = ((f.ct - f.cb) / 200) * fh
  const off = (o: number): string => (o === 0 ? '0' : sv.e !== undefined ? `${f4(o)}*${S}` : f4(o * (sv.c ?? 1)))
  return {
    chain: [...crop, ...scale],
    crop,
    scale,
    x: `W/2+W*${X}+${off(offX)}-w/2`,
    y: `H/2+H*${Y}+${off(offY)}-h/2`
  }
}

/**
 * Прямоугольник вписанной картинки на экране кадра размером frameW×frameH с учётом масштаба и положения (без кропа):
 * для рамки выделения в предпросмотре. Координаты — от левого верхнего угла кадра.
 */
export function frameRect(f: Frame, mw: number, mh: number, frameW: number, frameH: number): { x: number; y: number; w: number; h: number } {
  const fit = fitSize(mw, mh, frameW, frameH)
  const s = f.scale / 100
  const w = fit.w * s
  const h = fit.h * s
  return { x: frameW / 2 + (f.x / 100) * frameW - w / 2, y: frameH / 2 + (f.y / 100) * frameH - h / 2, w, h }
}
