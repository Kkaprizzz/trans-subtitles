/**
 * Эффекты куска: реестр и чистые функции. Эффект хранит набор параметров (values); на звук и субтитры не влияет.
 * Два рода: фильтры (блюр, чёрно-белый, цветокоррекция) действуют на всю картинку и по времени не меняются;
 * анимации (появление, исчезновение, зум, выезд, уход, поп) меняют прозрачность, масштаб и положение куска
 * у его начала или конца — их значения по времени считает anim.ts.
 * Блюр считается в долях высоты кадра, поэтому в предпросмотре и в экспорте выглядит одинаково при любом размере.
 * Порядок эффектов — по списку на куске.
 */
export type EffectType = 'blur' | 'bw' | 'color' | 'fadeIn' | 'fadeOut' | 'zoom' | 'slideIn' | 'slideOut' | 'pop'

export interface EffectParam {
  key: string
  title: string
  min: number
  max: number
  default: number
  /** шаг значения (по умолчанию 1) */
  step?: number
  /** единица в подписи: «с», «%» */
  unit?: string
  /** выбор из вариантов: значение — номер варианта */
  options?: string[]
}

export interface EffectInfo {
  title: string
  description: string
  /** анимация (у начала или конца куска) — действует и на надписи; остальные — фильтры картинки */
  anim?: boolean
  params: EffectParam[]
}

export interface Effect {
  id: string
  type: EffectType
  /** включён ли (глаз в инспекторе) */
  on: boolean
  /** значения параметров по ключам из реестра */
  values: Record<string, number>
  /**
   * Только у анимаций, кусок которых получился резкой: сколько секунд анимации начала уже прошло до начала этого куска
   * (skip) и сколько секунд до конца исходного куска осталось после его конца (skipEnd). Так обе половины продолжают
   * анимацию без скачка. У нетронутого куска не задаются (0).
   */
  skip?: number
  skipEnd?: number
}

export const EFFECTS: Record<EffectType, EffectInfo> = {
  blur: {
    title: 'Блюр',
    description: 'Размывает картинку куска',
    params: [{ key: 'strength', title: 'Сила', min: 0, max: 100, default: 50, unit: '%' }]
  },
  bw: {
    title: 'Чёрно-белый',
    description: 'Убирает цвет: от лёгкого до полного',
    params: [{ key: 'strength', title: 'Сила', min: 0, max: 100, default: 100, unit: '%' }]
  },
  color: {
    title: 'Цветокоррекция',
    description: 'Яркость, контраст, насыщенность',
    params: [
      { key: 'brightness', title: 'Яркость', min: -100, max: 100, default: 0 },
      { key: 'contrast', title: 'Контраст', min: -100, max: 100, default: 0 },
      { key: 'saturation', title: 'Насыщенность', min: -100, max: 100, default: 0 }
    ]
  },
  fadeIn: {
    title: 'Появление',
    description: 'Плавно проявляется в начале куска',
    anim: true,
    params: [{ key: 'dur', title: 'Длительность', min: 0.1, max: 10, default: 0.5, step: 0.1, unit: 'с' }]
  },
  fadeOut: {
    title: 'Исчезновение',
    description: 'Плавно гаснет в конце куска',
    anim: true,
    params: [{ key: 'dur', title: 'Длительность', min: 0.1, max: 10, default: 0.5, step: 0.1, unit: 'с' }]
  },
  zoom: {
    title: 'Зум',
    description: 'Приближение или отдаление в начале куска',
    anim: true,
    params: [
      { key: 'dir', title: 'Тип', min: 0, max: 1, default: 0, options: ['Приближение', 'Отдаление'] },
      { key: 'dur', title: 'Длительность', min: 0.2, max: 60, default: 1.5, step: 0.1, unit: 'с' },
      { key: 'amount', title: 'На сколько', min: 5, max: 100, default: 20, unit: '%' }
    ]
  },
  slideIn: {
    title: 'Выезд',
    description: 'Въезжает в кадр со стороны',
    anim: true,
    params: [
      { key: 'side', title: 'Откуда', min: 0, max: 3, default: 0, options: ['Слева', 'Справа', 'Сверху', 'Снизу'] },
      { key: 'dur', title: 'Длительность', min: 0.1, max: 5, default: 0.5, step: 0.1, unit: 'с' }
    ]
  },
  slideOut: {
    title: 'Уход',
    description: 'Уезжает из кадра в сторону',
    anim: true,
    params: [
      { key: 'side', title: 'Куда', min: 0, max: 3, default: 1, options: ['Влево', 'Вправо', 'Вверх', 'Вниз'] },
      { key: 'dur', title: 'Длительность', min: 0.1, max: 5, default: 0.5, step: 0.1, unit: 'с' }
    ]
  },
  pop: {
    title: 'Поп',
    description: 'Выброс масштаба в начале куска',
    anim: true,
    params: [
      { key: 'dur', title: 'Длительность', min: 0.1, max: 2, default: 0.3, step: 0.05, unit: 'с' },
      { key: 'amount', title: 'Размах', min: 5, max: 100, default: 15, unit: '%' }
    ]
  }
}
export const EFFECT_TYPES = Object.keys(EFFECTS) as EffectType[]
/** Фильтры картинки и анимации — отдельными группами во вкладке «Эффекты». */
export const FILTER_TYPES = EFFECT_TYPES.filter((t) => !EFFECTS[t].anim)
export const ANIM_TYPES = EFFECT_TYPES.filter((t) => EFFECTS[t].anim)
export const isAnimType = (t: EffectType): boolean => !!EFFECTS[t]?.anim
/** Анимации у начала куска (у левой половины при резке) и у конца (у правой). */
export const START_ANIMS: EffectType[] = ['fadeIn', 'zoom', 'slideIn', 'pop']
export const END_ANIMS: EffectType[] = ['fadeOut', 'slideOut']
export const EFFECT_MIME = 'application/x-ts-effect'

let seq = 0
const newId = (): string => `fx${Date.now().toString(36)}${(seq++).toString(36)}`
const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x))

export function newEffect(type: EffectType): Effect {
  const values: Record<string, number> = {}
  for (const p of EFFECTS[type].params) values[p.key] = p.default
  return { id: newId(), type, on: true, values }
}

const stepped = (p: EffectParam, v: number): number => {
  const step = p.step ?? 1
  const x = Math.round(clamp(Number.isFinite(v) ? v : p.default, p.min, p.max) / step) * step
  return Math.round(clamp(x, p.min, p.max) * 1000) / 1000
}

/** Новое значение параметра, зажатое в пределы реестра и приведённое к шагу (неизвестный ключ — null). */
export function clampParam(type: EffectType, key: string, v: number): number | null {
  const p = EFFECTS[type]?.params.find((x) => x.key === key)
  return p ? stepped(p, v) : null
}

/** Радиус размытия в пикселях кадра высотой H: сила 100 — 4% высоты. */
export const blurSigma = (strength: number, H: number): number => (clamp(strength, 0, 100) / 100) * 0.04 * H

/** Эффекты из файла проекта: неизвестные типы и мусор выбрасываются, значения зажимаются. Формат v8 (strength) читается. */
export function cleanEffects(raw: unknown): Effect[] {
  if (!Array.isArray(raw)) return []
  const out: Effect[] = []
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const e = x as Record<string, unknown>
    const type = e.type as EffectType
    if (!EFFECTS[type]) continue
    const src = e.values && typeof e.values === 'object' ? (e.values as Record<string, unknown>) : { strength: e.strength }
    const fx = newEffect(type)
    for (const p of EFFECTS[type].params) {
      const v = Number(src[p.key])
      if (Number.isFinite(v)) fx.values[p.key] = stepped(p, v)
    }
    const keep: Pick<Effect, 'skip' | 'skipEnd'> = {}
    if (EFFECTS[type].anim) {
      const sk = Number(e.skip)
      const se = Number(e.skipEnd)
      if (Number.isFinite(sk) && sk > 0) keep.skip = Math.round(clamp(sk, 0, 36000) * 1000) / 1000
      if (Number.isFinite(se) && se > 0) keep.skipEnd = Math.round(clamp(se, 0, 36000) * 1000) / 1000
    }
    out.push({ ...fx, ...keep, id: typeof e.id === 'string' && e.id ? e.id.slice(0, 40) : fx.id, on: e.on !== false })
  }
  return out.slice(0, 12)
}

/** Одинаковый ли набор эффектов (для склейки кусков). */
export function sameEffects(a: Effect[], b: Effect[]): boolean {
  return (
    a.length === b.length &&
    a.every((e, i) => e.type === b[i].type && e.on === b[i].on && Object.keys(e.values).every((k) => e.values[k] === b[i].values[k]))
  )
}

const isNeutral = (e: Effect): boolean => e.type === 'color' && !e.values.brightness && !e.values.contrast && !e.values.saturation

/** Цепочка фильтров ffmpeg для включённых эффектов кадра высотой H (пусто, если делать нечего). */
export function effectFilters(effects: Effect[], H: number): string[] {
  const out: string[] = []
  for (const e of effects) {
    if (!e.on || isNeutral(e)) continue
    if (e.type === 'blur') {
      const s = blurSigma(e.values.strength ?? 0, H)
      if (s >= 0.3) out.push(`gblur=sigma=${s.toFixed(2)}:steps=2`)
    } else if (e.type === 'bw') {
      const k = clamp(e.values.strength ?? 0, 0, 100) / 100
      if (k > 0) out.push(`hue=s=${(1 - k).toFixed(3)}`)
    } else if (e.type === 'color') {
      const b = (e.values.brightness ?? 0) / 200
      const c = 1 + (e.values.contrast ?? 0) / 100
      const s = 1 + (e.values.saturation ?? 0) / 100
      out.push(`eq=brightness=${b.toFixed(3)}:contrast=${c.toFixed(3)}:saturation=${s.toFixed(3)}`)
    }
  }
  return out
}

/** Тот же набор для предпросмотра: CSS-фильтр (блюр точный, яркость и контраст приблизительно). Высота — кадра на экране. */
export function cssFilter(effects: Effect[], H: number): string {
  const parts: string[] = []
  for (const e of effects) {
    if (!e.on || isNeutral(e)) continue
    if (e.type === 'blur') {
      const s = blurSigma(e.values.strength ?? 0, H)
      if (s >= 0.3) parts.push(`blur(${s.toFixed(1)}px)`)
    } else if (e.type === 'bw') {
      const k = clamp(e.values.strength ?? 0, 0, 100) / 100
      if (k > 0) parts.push(`grayscale(${k.toFixed(3)})`)
    } else if (e.type === 'color') {
      parts.push(
        `brightness(${(1 + (e.values.brightness ?? 0) / 200).toFixed(3)}) contrast(${(1 + (e.values.contrast ?? 0) / 100).toFixed(3)}) saturate(${(1 + (e.values.saturation ?? 0) / 100).toFixed(3)})`
      )
    }
  }
  return parts.join(' ')
}
