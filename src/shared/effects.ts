/**
 * Эффекты куска: реестр (сейчас один — блюр) и чистые функции. Эффект действует на всю картинку куска и не меняется
 * по времени внутри него; на звук и субтитры не влияет. Сила блюра — в долях высоты кадра, поэтому в предпросмотре и
 * в экспорте выглядит одинаково при любом размере.
 */
export type EffectType = 'blur'

export interface Effect {
  id: string
  type: EffectType
  /** включён ли (глаз в инспекторе) */
  on: boolean
  /** сила 0..100 */
  strength: number
}

export interface EffectInfo {
  title: string
  description: string
  defaults: { strength: number }
}

export const EFFECTS: Record<EffectType, EffectInfo> = {
  blur: { title: 'Блюр', description: 'Размывает картинку куска', defaults: { strength: 50 } }
}
export const EFFECT_TYPES = Object.keys(EFFECTS) as EffectType[]
export const EFFECT_MIME = 'application/x-ts-effect'

let seq = 0
export const newEffect = (type: EffectType): Effect => ({
  id: `fx${Date.now().toString(36)}${(seq++).toString(36)}`,
  type,
  on: true,
  strength: EFFECTS[type].defaults.strength
})

/** Радиус размытия в пикселях кадра высотой H: сила 100 — 4% высоты. */
export const blurSigma = (strength: number, H: number): number => (Math.min(100, Math.max(0, strength)) / 100) * 0.04 * H

export function cleanEffects(raw: unknown): Effect[] {
  if (!Array.isArray(raw)) return []
  const out: Effect[] = []
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const e = x as Record<string, unknown>
    if (e.type !== 'blur') continue
    const strength = Number(e.strength)
    out.push({
      id: typeof e.id === 'string' && e.id ? e.id.slice(0, 40) : newEffect('blur').id,
      type: 'blur',
      on: e.on !== false,
      strength: Math.round(Math.min(100, Math.max(0, Number.isFinite(strength) ? strength : EFFECTS.blur.defaults.strength)))
    })
  }
  return out.slice(0, 8)
}

/** Одинаковый ли набор эффектов (для склейки кусков). */
export function sameEffects(a: Effect[], b: Effect[]): boolean {
  return a.length === b.length && a.every((e, i) => e.type === b[i].type && e.on === b[i].on && e.strength === b[i].strength)
}

/** Цепочка фильтров ffmpeg для включённых эффектов кадра высотой H (пусто, если делать нечего). */
export function effectFilters(effects: Effect[], H: number): string[] {
  const out: string[] = []
  for (const e of effects) {
    if (!e.on) continue
    if (e.type === 'blur') {
      const s = blurSigma(e.strength, H)
      if (s >= 0.3) out.push(`gblur=sigma=${s.toFixed(2)}:steps=2`)
    }
  }
  return out
}
