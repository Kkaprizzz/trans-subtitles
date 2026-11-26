/**
 * Эффекты куска: реестр (блюр, чёрно-белый, цветокоррекция) и чистые функции. Эффект хранит набор параметров
 * (values), действует на всю картинку куска и не меняется по времени внутри него; на звук и субтитры не влияет.
 * Блюр считается в долях высоты кадра, поэтому в предпросмотре и в экспорте выглядит одинаково при любом размере.
 * Порядок эффектов — по списку на куске.
 */
export type EffectType = 'blur' | 'bw' | 'color'

export interface EffectParam {
  key: string
  title: string
  min: number
  max: number
  default: number
}

export interface EffectInfo {
  title: string
  description: string
  params: EffectParam[]
}

export interface Effect {
  id: string
  type: EffectType
  /** включён ли (глаз в инспекторе) */
  on: boolean
  /** значения параметров по ключам из реестра */
  values: Record<string, number>
}

export const EFFECTS: Record<EffectType, EffectInfo> = {
  blur: {
    title: 'Блюр',
    description: 'Размывает картинку куска',
    params: [{ key: 'strength', title: 'Сила', min: 0, max: 100, default: 50 }]
  },
  bw: {
    title: 'Чёрно-белый',
    description: 'Убирает цвет: от лёгкого до полного',
    params: [{ key: 'strength', title: 'Сила', min: 0, max: 100, default: 100 }]
  },
  color: {
    title: 'Цветокоррекция',
    description: 'Яркость, контраст, насыщенность',
    params: [
      { key: 'brightness', title: 'Яркость', min: -100, max: 100, default: 0 },
      { key: 'contrast', title: 'Контраст', min: -100, max: 100, default: 0 },
      { key: 'saturation', title: 'Насыщенность', min: -100, max: 100, default: 0 }
    ]
  }
}
export const EFFECT_TYPES = Object.keys(EFFECTS) as EffectType[]
export const EFFECT_MIME = 'application/x-ts-effect'

let seq = 0
const newId = (): string => `fx${Date.now().toString(36)}${(seq++).toString(36)}`
const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x))

export function newEffect(type: EffectType): Effect {
  const values: Record<string, number> = {}
  for (const p of EFFECTS[type].params) values[p.key] = p.default
  return { id: newId(), type, on: true, values }
}

/** Новое значение параметра, зажатое в пределы реестра (неизвестный ключ — без изменений). */
export function clampParam(type: EffectType, key: string, v: number): number | null {
  const p = EFFECTS[type]?.params.find((x) => x.key === key)
  return p ? Math.round(clamp(Number.isFinite(v) ? v : p.default, p.min, p.max)) : null
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
      if (Number.isFinite(v)) fx.values[p.key] = Math.round(clamp(v, p.min, p.max))
    }
    out.push({ ...fx, id: typeof e.id === 'string' && e.id ? e.id.slice(0, 40) : fx.id, on: e.on !== false })
  }
  return out.slice(0, 8)
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
