/**
 * Анимация куска: ключевые кадры (положение X/Y, масштаб, прозрачность) и готовые анимации из effects
 * (появление, исчезновение, зум, выезд, уход, поп). Всё считается ОДНОЙ функцией animAt от времени куска — её же в виде
 * выражений ffmpeg (animExpr) использует экспорт, поэтому превью и результат совпадают по кадрам (как gainAt для звука).
 *
 * Время ключей — секунды ТАЙМЛАЙНА от начала куска, от скорости не зависит. Значение свойства: есть ключи — линия по ним
 * (до первого и после последнего держится крайнее), нет — значение из «Кадра». Готовые анимации накладываются поверх:
 * прозрачность и масштаб умножаются, сдвиг складывается. Итог = база × ключи × анимации.
 * Единицы: x, y — % кадра проекта (от центра), scale — множитель (1 = 100%), opacity — 0..1.
 */
import { EFFECTS, END_ANIMS, sameEffects, type Effect, type EffectType } from './effects.ts'
import type { Frame } from './frame.ts'

export type KeyProp = 'x' | 'y' | 'scale' | 'opacity'
export const KEY_PROPS: KeyProp[] = ['x', 'y', 'scale', 'opacity']

export interface Key {
  /** секунды от начала куска (таймлайн) */
  t: number
  v: number
  /** сегмент от этого ключа до следующего идёт плавно (ease in-out), иначе линейно */
  ease: boolean
}

export type Keys = Record<KeyProp, Key[]>

/** Пределы и значение по умолчанию: совпадают с полями «Кадра». */
export const KEY_INFO: Record<KeyProp, { title: string; min: number; max: number; def: number; unit: string }> = {
  x: { title: 'Положение X', min: -150, max: 150, def: 0, unit: '%' },
  y: { title: 'Положение Y', min: -100, max: 100, def: 0, unit: '%' },
  scale: { title: 'Масштаб', min: 10, max: 400, def: 100, unit: '%' },
  opacity: { title: 'Прозрачность', min: 0, max: 100, def: 100, unit: '%' }
}

export const MAX_KEYS = 100
/** Ключи ближе этого по времени — один и тот же ключ. */
export const KEY_GAP = 0.02
/** Предел итогового масштаба (как у поля «Масштаб»): защита от кадров-гигантов в экспорте. */
export const SCALE_MIN = 0.05
export const SCALE_MAX = 4

const r3 = (x: number): number => Math.round(x * 1000) / 1000
const r2 = (x: number): number => Math.round(x * 100) / 100
const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x))

export const noKeys = (): Keys => ({ x: [], y: [], scale: [], opacity: [] })
export const hasKeys = (k: Keys): boolean => KEY_PROPS.some((p) => k[p].length > 0)

export function sameKeys(a: Keys, b: Keys): boolean {
  return KEY_PROPS.every((p) => a[p].length === b[p].length && a[p].every((k, i) => Math.abs(k.t - b[p][i].t) < 1e-6 && Math.abs(k.v - b[p][i].v) < 1e-6 && k.ease === b[p][i].ease))
}

/** Ключи из файла проекта: мусор выбрасывается, значения зажимаются, время по возрастанию без дублей. */
export function cleanKeys(raw: unknown): Keys {
  const out = noKeys()
  if (!raw || typeof raw !== 'object') return out
  for (const prop of KEY_PROPS) {
    const list = (raw as Record<string, unknown>)[prop]
    if (!Array.isArray(list)) continue
    const info = KEY_INFO[prop]
    const keys: Key[] = []
    for (const k of list) {
      if (!k || typeof k !== 'object') continue
      const t = Number((k as Key).t)
      const v = Number((k as Key).v)
      if (!Number.isFinite(t) || !Number.isFinite(v) || t < 0) continue
      keys.push({ t: r3(t), v: r2(clamp(v, info.min, info.max)), ease: (k as Key).ease === true })
    }
    keys.sort((a, b) => a.t - b.t)
    out[prop] = keys.filter((k, i) => i === 0 || k.t - keys[i - 1].t > 0.001).slice(0, MAX_KEYS)
  }
  return out
}

/**
 * Кривые движения. Плавное движение (ключи «плавно», кадр трекинга) — ease-in-out кубическая: мягкий старт и мягкий финиш.
 * Входы анимаций (появление, зум, выезд) — ease-out: быстро стартуют и мягко садятся; выходы — ease-in: плавно разгоняются.
 */
export const ease = (u: number): number => {
  const x = clamp(u, 0, 1)
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}
export const easeOut = (u: number): number => 1 - Math.pow(1 - clamp(u, 0, 1), 3)
export const easeIn = (u: number): number => Math.pow(clamp(u, 0, 1), 3)

/** Значение по ключам в момент t (от начала куска). Без ключей — base. */
export function evalKeys(keys: Key[], base: number, t: number): number {
  const n = keys.length
  if (n === 0) return base
  if (t <= keys[0].t) return keys[0].v
  if (t >= keys[n - 1].t) return keys[n - 1].v
  for (let i = 1; i < n; i++) {
    const a = keys[i - 1]
    const b = keys[i]
    if (t < b.t) {
      const u = (t - a.t) / (b.t - a.t)
      return a.v + (b.v - a.v) * (a.ease ? ease(u) : u)
    }
  }
  return keys[n - 1].v
}

// --- готовые анимации ---

/** d — длительность; sk — сколько уже прошло (анимации начала) или осталось после конца куска (анимации конца), см. Effect.skip. */
export interface AnimSet {
  fadeIn?: { d: number; sk: number }
  fadeOut?: { d: number; sk: number }
  zoom?: { d: number; sk: number; a: number; dir: number }
  slideIn?: { d: number; sk: number; side: number }
  slideOut?: { d: number; sk: number; side: number }
  pop?: { d: number; sk: number; a: number }
}

/** Включённые анимации куска с параметрами (недостающие — по умолчанию из реестра). */
export function animSet(effects: Effect[]): AnimSet {
  const out: AnimSet = {}
  for (const e of effects) {
    if (!e.on || !EFFECTS[e.type]?.anim) continue
    const val = (k: string): number => {
      const v = e.values[k]
      return Number.isFinite(v) ? v : (EFFECTS[e.type].params.find((p) => p.key === k)?.default ?? 0)
    }
    const d = Math.max(0.01, val('dur'))
    const t: EffectType = e.type
    const sk = t === 'fadeOut' || t === 'slideOut' ? (e.skipEnd ?? 0) : (e.skip ?? 0)
    if (t === 'fadeIn') out.fadeIn = { d, sk }
    else if (t === 'fadeOut') out.fadeOut = { d, sk }
    else if (t === 'zoom') out.zoom = { d, sk, a: val('amount') / 100, dir: val('dir') >= 0.5 ? 1 : 0 }
    else if (t === 'slideIn') out.slideIn = { d, sk, side: Math.round(clamp(val('side'), 0, 3)) }
    else if (t === 'slideOut') out.slideOut = { d, sk, side: Math.round(clamp(val('side'), 0, 3)) }
    else if (t === 'pop') out.pop = { d, sk, a: val('amount') / 100 }
  }
  return out
}

export interface AnimSource {
  frame: Frame
  keys: Keys
  effects: Effect[]
}

export interface Anim {
  /** сдвиг от центра, % кадра */
  x: number
  y: number
  /** масштаб: 1 = 100% */
  scale: number
  /** 0..1 */
  opacity: number
}

/** Есть ли у куска что-то, меняющееся по времени (ключи или включённая анимация). */
export function isAnimated(src: Pick<AnimSource, 'keys' | 'effects'>): boolean {
  return hasKeys(src.keys) || Object.keys(animSet(src.effects)).length > 0
}

/** Значение каждого свойства куска длиной len в момент t (от начала куска). Единственный источник истины для превью и экспорта. */
export function animAt(src: AnimSource, len: number, t: number): Anim {
  const f = src.frame
  let x = evalKeys(src.keys.x, f.x, t)
  let y = evalKeys(src.keys.y, f.y, t)
  let sc = evalKeys(src.keys.scale, f.scale, t) / 100
  let op = evalKeys(src.keys.opacity, f.opacity, t) / 100
  const a = animSet(src.effects)
  if (a.fadeIn) op *= easeOut((t + a.fadeIn.sk) / a.fadeIn.d)
  // исчезновение: прозрачность падает по ease-in от прогресса выхода (1 − оставшаяся доля)
  if (a.fadeOut) op *= 1 - easeIn(1 - clamp((len - t + a.fadeOut.sk) / a.fadeOut.d, 0, 1))
  if (a.zoom) {
    const u = easeOut((t + a.zoom.sk) / a.zoom.d)
    sc *= 1 + a.zoom.a * (a.zoom.dir === 0 ? u : 1 - u)
  }
  if (a.pop) sc *= 1 + a.pop.a * Math.sin(Math.PI * clamp((t + a.pop.sk) / a.pop.d, 0, 1))
  if (a.slideIn) {
    const off = 100 * (1 - easeOut((t + a.slideIn.sk) / a.slideIn.d))
    if (a.slideIn.side === 0) x -= off
    else if (a.slideIn.side === 1) x += off
    else if (a.slideIn.side === 2) y -= off
    else y += off
  }
  if (a.slideOut) {
    const off = 100 * easeIn(1 - (len - t + a.slideOut.sk) / a.slideOut.d)
    if (a.slideOut.side === 0) x -= off
    else if (a.slideOut.side === 1) x += off
    else if (a.slideOut.side === 2) y -= off
    else y += off
  }
  return { x, y, scale: clamp(sc, SCALE_MIN, SCALE_MAX), opacity: clamp(op, 0, 1) }
}

/** Значение одного свойства «Кадра» (в его единицах: %) с учётом только ключей — для полей инспектора. */
export const propAt = (src: Pick<AnimSource, 'frame' | 'keys'>, prop: KeyProp, t: number): number => evalKeys(src.keys[prop], src.frame[prop], t)

// --- резка и склейка анимаций ---

const durOf = (e: Effect): number => Math.max(0.01, e.values.dur ?? EFFECTS[e.type].params.find((x) => x.key === 'dur')?.default ?? 0.5)
const withSkips = (e: Effect, skip: number, skipEnd: number): Effect => {
  const { skip: _a, skipEnd: _b, ...rest } = e
  return { ...rest, ...(skip > 1e-4 ? { skip: r3(skip) } : {}), ...(skipEnd > 1e-4 ? { skipEnd: r3(skipEnd) } : {}) }
}

/**
 * Эффекты куска [from, to] (секунды от начала) исходного куска длиной len. Фильтры остаются, анимации продолжаются без
 * скачка (skip/skipEnd), а те, что в этом куске уже ничего не делают, пропадают. Зум-приближение остаётся всегда:
 * после него картинка так и держится приближенной.
 */
export function sliceEffects(effects: Effect[], len: number, from: number, to: number): Effect[] {
  const out: Effect[] = []
  for (const e of effects) {
    if (!EFFECTS[e.type]?.anim) {
      out.push({ ...e, values: { ...e.values } })
      continue
    }
    const end = END_ANIMS.includes(e.type)
    const skip = (e.skip ?? 0) + (end ? 0 : from)
    const skipEnd = (e.skipEnd ?? 0) + (end ? Math.max(0, len - to) : 0)
    const d = durOf(e)
    const holds = e.type === 'zoom' && (e.values.dir ?? 0) < 0.5
    if (end ? skipEnd >= d - 1e-6 : skip >= d - 1e-6 && !holds) continue
    out.push(withSkips({ ...e, values: { ...e.values } }, end ? 0 : skip, end ? skipEnd : 0))
  }
  return out
}

/**
 * Эффекты склеенного куска из левого (длина aLen) и правого (bLen). null — склеить нельзя: фильтры разные, либо анимации не
 * являются продолжением друг друга (например, на правой половине появилось своё «Появление»).
 */
export function joinEffects(a: Effect[], aLen: number, b: Effect[], bLen: number): Effect[] | null {
  const filt = (x: Effect[]): Effect[] => x.filter((e) => !EFFECTS[e.type]?.anim)
  if (!sameEffects(filt(a), filt(b))) return null
  const merged: Effect[] = filt(a)
  const types = [...new Set([...a, ...b].filter((e) => EFFECTS[e.type]?.anim).map((e) => e.type))]
  for (const t of types) {
    const ea = a.find((e) => e.type === t)
    const eb = b.find((e) => e.type === t)
    const end = END_ANIMS.includes(t)
    if (ea && eb) {
      const same = ea.on === eb.on && Object.keys(ea.values).every((k) => ea.values[k] === eb.values[k])
      const chain = end ? Math.abs((ea.skipEnd ?? 0) - ((eb.skipEnd ?? 0) + bLen)) < 0.01 : Math.abs((eb.skip ?? 0) - ((ea.skip ?? 0) + aLen)) < 0.01
      if (!same || !chain) return null
      merged.push(withSkips(ea, end ? 0 : (ea.skip ?? 0), end ? (eb.skipEnd ?? 0) : 0))
    } else if (ea && !end) {
      // у правого куска такая анимация уже ничего не делала (отрезана) — значит, к стыку она закончилась и без остатка
      const holds = t === 'zoom' && (ea.values.dir ?? 0) < 0.5
      if (holds || (ea.skip ?? 0) + aLen < durOf(ea) - 1e-6) return null
      merged.push(withSkips(ea, ea.skip ?? 0, 0))
    } else if (eb && end) {
      if ((eb.skipEnd ?? 0) + bLen < durOf(eb) - 1e-6) return null
      merged.push(withSkips(eb, 0, eb.skipEnd ?? 0))
    } else return null
  }
  return merged
}

// --- операции над списком ключей одного свойства ---

/** Ставит ключ в момент t (в пределах куска): рядом уже есть — обновляет его значение. */
export function setKey(keys: Key[], prop: KeyProp, t: number, v: number, len: number, easeOn?: boolean): { keys: Key[]; index: number } {
  const info = KEY_INFO[prop]
  const tt = r3(clamp(t, 0, Math.max(0, len)))
  const vv = r2(clamp(v, info.min, info.max))
  const near = keys.findIndex((k) => Math.abs(k.t - tt) <= KEY_GAP)
  if (near >= 0) return { keys: keys.map((k, i) => (i === near ? { ...k, v: vv, ease: easeOn ?? k.ease } : k)), index: near }
  if (keys.length >= MAX_KEYS) return { keys, index: -1 }
  // новый ключ по умолчанию «плавно»: линейные отрезки выглядят механически
  const next = [...keys, { t: tt, v: vv, ease: easeOn ?? true }].sort((a, b) => a.t - b.t)
  return { keys: next, index: next.findIndex((k) => k.t === tt) }
}

/** Двигает ключ: время зажато между соседями и краями куска, значение — в пределы свойства. */
export function moveKey(keys: Key[], prop: KeyProp, index: number, t: number, v: number, len: number): Key[] {
  if (index < 0 || index >= keys.length) return keys
  const info = KEY_INFO[prop]
  const min = index > 0 ? keys[index - 1].t + KEY_GAP * 1.5 : 0
  const max = index < keys.length - 1 ? keys[index + 1].t - KEY_GAP * 1.5 : len
  const tt = r3(clamp(t, min, Math.max(min, max)))
  return keys.map((k, i) => (i === index ? { ...k, t: tt, v: r2(clamp(v, info.min, info.max)) } : k))
}

/** Ключи вне куска [0, len] убираются, на краю ставится ключ со значением линии в этой точке (картинка не прыгает). */
export function clampKeys(keys: Key[], len: number): Key[] {
  if (keys.length === 0 || keys[keys.length - 1].t <= len + 1e-3) return keys
  const inside = keys.filter((k) => k.t < len - 1e-3)
  inside.push({ t: r3(len), v: r2(evalKeys(keys, 0, len)), ease: false })
  return inside
}

/**
 * Левый край куска сдвинулся на delta секунд вправо (подрезка; влево — отрицательная): ключи едут в обратную сторону,
 * ушедшие за край заменяются ключом на новом начале со значением линии в этой точке.
 */
export function shiftKeys(keys: Key[], delta: number): Key[] {
  if (keys.length === 0 || Math.abs(delta) < 1e-6) return keys
  if (delta < 0) return keys.map((k) => ({ ...k, t: r3(k.t - delta) }))
  const rest = keys.filter((k) => k.t - delta > 1e-3).map((k) => ({ ...k, t: r3(k.t - delta) }))
  const before = [...keys].reverse().find((k) => k.t <= delta + 1e-3)
  return [{ t: 0, v: r2(evalKeys(keys, 0, delta)), ease: before?.ease ?? false }, ...rest]
}

/** Разрез куска в точке cut (секунды от его начала): у обеих половин на стыке ключ со значением линии. */
export function splitKeys(keys: Keys, cut: number): { left: Keys; right: Keys } {
  const left = noKeys()
  const right = noKeys()
  for (const p of KEY_PROPS) {
    const ks = keys[p]
    if (ks.length === 0) continue
    const v = r2(evalKeys(ks, 0, cut))
    const before = [...ks].reverse().find((k) => k.t <= cut + 1e-3)
    left[p] = [...ks.filter((k) => k.t < cut - 1e-3), { t: r3(cut), v, ease: false }]
    right[p] = [{ t: 0, v, ease: before?.ease ?? false }, ...ks.filter((k) => k.t > cut + 1e-3).map((k) => ({ ...k, t: r3(k.t - cut) }))]
  }
  return { left, right }
}

/**
 * Склейка: правая половина встаёт на aLen секунд позже. Свойство без ключей у одной стороны «запекается» в два ключа
 * (значение из «Кадра»), чтобы линия не изменилась. Ключ на стыке, лежащий на прямой между соседями, убирается:
 * после «разрезал и склеил» ключи возвращаются к исходным.
 */
export function mergeKeys(a: KeyedPart, b: KeyedPart): Keys {
  const out = noKeys()
  for (const p of KEY_PROPS) {
    if (a.keys[p].length === 0 && b.keys[p].length === 0) continue
    const bake = (it: KeyedPart): Key[] => (it.keys[p].length ? it.keys[p] : [{ t: 0, v: it.frame[p], ease: false }, { t: it.len, v: it.frame[p], ease: false }])
    const left = bake(a)
    const right = bake(b).map((k) => ({ ...k, t: r3(k.t + a.len) }))
    const list = [...left]
    for (const k of right) {
      const last = list[list.length - 1]
      if (Math.abs(k.t - last.t) <= 0.002) {
        // стык: у склеиваемых значения совпадают (проверка в joinProblem) — берём левый, а плавность — правого
        list[list.length - 1] = { ...last, ease: k.ease }
      } else list.push(k)
    }
    // стыковой ключ, лежащий на прямой между соседями, не нужен
    const j = list.findIndex((k) => Math.abs(k.t - a.len) <= 0.002)
    if (j > 0 && j < list.length - 1) {
      const prev = list[j - 1]
      const next = list[j + 1]
      // ключ лежит на кривой между соседями (с той же плавностью, что у предыдущего отрезка) — он не нужен
      const u = (list[j].t - prev.t) / (next.t - prev.t)
      const onCurve = prev.v + (next.v - prev.v) * (prev.ease ? ease(u) : u)
      if (prev.ease === list[j].ease && Math.abs(onCurve - list[j].v) < 0.02) list.splice(j, 1)
    }
    out[p] = list.slice(0, MAX_KEYS)
  }
  return out
}

/** Что нужно знать о куске для склейки ключей: ключи, «Кадр» и длина на таймлайне. */
export interface KeyedPart {
  keys: Keys
  frame: Frame
  len: number
}

/** Значения на стыке (конец левого и начало правого) различаются — склеивать нельзя. */
export function keysJoinGap(a: KeyedPart, b: KeyedPart): KeyProp | null {
  for (const p of KEY_PROPS) {
    if (a.keys[p].length === 0 && b.keys[p].length === 0) continue
    if (Math.abs(evalKeys(a.keys[p], a.frame[p], a.len) - evalKeys(b.keys[p], b.frame[p], 0)) > 0.02) return p
  }
  return null
}

// --- выражения ffmpeg ---

export type Expr = { c: number; e?: undefined } | { c?: undefined; e: string }

const f6 = (x: number): string => {
  const s = (Math.round(x * 1e6) / 1e6).toString()
  return x < 0 ? `(${s})` : s
}
/** Те же кривые, что ease / easeOut / easeIn, выражениями ffmpeg (u — строка, уже зажатая в 0..1 или внутри отрезка). */
const E = (u: string): string => `(if(lt(${u},0.5),4*(${u})*(${u})*(${u}),1-pow(2-2*(${u}),3)/2))`
const EOUT = (u: string): string => `(1-pow(1-(${u}),3))`
const EIN = (u: string): string => `pow(${u},3)`
const CL01 = (x: string): string => `clip(${x},0,1)`

/** Линия по ключам как выражение от rel (время от начала куска, строкой). */
export function keysExpr(keys: Key[], rel: string): string {
  const n = keys.length
  let e = f6(keys[n - 1].v)
  for (let i = n - 2; i >= 0; i--) {
    const a = keys[i]
    const b = keys[i + 1]
    const u = `((${rel}-${f6(a.t)})/${f6(b.t - a.t)})`
    e = `if(lt(${rel},${f6(b.t)}),${f6(a.v)}+${f6(b.v - a.v)}*(${a.ease ? E(u) : u}),${e})`
  }
  return n > 1 ? `if(lt(${rel},${f6(keys[0].t)}),${f6(keys[0].v)},${e})` : e
}

export interface AnimExprs {
  x: Expr
  y: Expr
  scale: Expr
  opacity: Expr
}

/**
 * То же, что animAt, но выражениями ffmpeg. tv — имя переменной времени («t» в overlay/scale, «T» в geq); start — время начала
 * куска на таймлайне, len — длина куска. Свойство без движения — число (с теми же пределами, что у animAt).
 */
export function animExpr(src: AnimSource, len: number, start: number, tv: 't' | 'T'): AnimExprs {
  const f = src.frame
  const rel = `(${tv}-${f6(start)})`
  const L = f6(len)
  const a = animSet(src.effects)
  const keyed = (p: KeyProp): string | null => (src.keys[p].length ? keysExpr(src.keys[p], rel) : null)
  const dirSign = (side: number): { axis: 'x' | 'y'; sign: string } => ({ axis: side < 2 ? 'x' : 'y', sign: side % 2 === 0 ? '-' : '+' })

  // положение: база + сдвиги выезда и ухода
  const shift = { x: [] as string[], y: [] as string[] }
  if (a.slideIn) {
    const { axis, sign } = dirSign(a.slideIn.side)
    shift[axis].push(`${sign}100*(1-${EOUT(CL01(`(${rel}+${f6(a.slideIn.sk)})/${f6(a.slideIn.d)}`))})`)
  }
  if (a.slideOut) {
    const { axis, sign } = dirSign(a.slideOut.side)
    shift[axis].push(`${sign}100*${EIN(CL01(`1-(${L}-${rel}+${f6(a.slideOut.sk)})/${f6(a.slideOut.d)}`))}`)
  }
  const pos = (p: 'x' | 'y'): Expr => {
    const k = keyed(p)
    if (!k && shift[p].length === 0) return { c: f[p] }
    return { e: `(${k ?? f6(f[p])}${shift[p].join('')})` }
  }

  // масштаб: база × зум × поп
  const mul: string[] = []
  if (a.zoom) {
    const u = EOUT(CL01(`(${rel}+${f6(a.zoom.sk)})/${f6(a.zoom.d)}`))
    mul.push(`(1+${f6(a.zoom.a)}*${a.zoom.dir === 0 ? u : `(1-${u})`})`)
  }
  if (a.pop) mul.push(`(1+${f6(a.pop.a)}*sin(PI*${CL01(`(${rel}+${f6(a.pop.sk)})/${f6(a.pop.d)}`)}))`)
  const ks = keyed('scale')
  const scale: Expr = !ks && mul.length === 0 ? { c: clamp(f.scale / 100, SCALE_MIN, SCALE_MAX) } : { e: `clip((${ks ?? f6(f.scale)})/100${mul.map((m) => `*${m}`).join('')},${SCALE_MIN},${SCALE_MAX})` }

  // прозрачность: база × появление × исчезновение
  const om: string[] = []
  if (a.fadeIn) om.push(EOUT(CL01(`(${rel}+${f6(a.fadeIn.sk)})/${f6(a.fadeIn.d)}`)))
  if (a.fadeOut) om.push(`(1-${EIN(`(1-${CL01(`(${L}-${rel}+${f6(a.fadeOut.sk)})/${f6(a.fadeOut.d)}`)})`)})`)
  const ko = keyed('opacity')
  const opacity: Expr = !ko && om.length === 0 ? { c: clamp(f.opacity / 100, 0, 1) } : { e: `clip((${ko ?? f6(f.opacity)})/100${om.map((m) => `*${m}`).join('')},0,1)` }

  return { x: pos('x'), y: pos('y'), scale, opacity }
}
