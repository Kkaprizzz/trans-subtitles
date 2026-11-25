/**
 * Громкость куска: линия из точек (время исходника, уровень 0..1), между точками линейно. Без точек — постоянный
 * уровень base. Чистые функции над массивами: ни проекта, ни дорожек они не знают (операции над проектом — mix.ts).
 *
 * Точки лежат во времени ИСХОДНИКА, поэтому подрезка краёв куска их не сдвигает, а резка делит линию на две
 * с точкой на стыке (звук не прыгает), склейка собирает обратно.
 */

export interface GainPoint {
  /** секунды исходника */
  t: number
  /** уровень 0..1 */
  v: number
}

export const MAX_POINTS = 200
const r3 = (x: number): number => Math.round(x * 1000) / 1000
export const clamp01 = (x: number): number => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0))

/** Точки по возрастанию времени, уровни и время приведены к допустимым, лишние отброшены. */
export function cleanPoints(raw: unknown): GainPoint[] {
  if (!Array.isArray(raw)) return []
  const out: GainPoint[] = []
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue
    const t = Number((p as GainPoint).t)
    const v = Number((p as GainPoint).v)
    if (!Number.isFinite(t) || !Number.isFinite(v) || t < 0) continue
    out.push({ t: r3(t), v: Math.round(clamp01(v) * 1000) / 1000 })
  }
  return out.sort((a, b) => a.t - b.t).slice(0, MAX_POINTS)
}

/** Уровень в момент t: без точек — base; до первой точки и после последней держится её значение. */
export function gainAt(points: GainPoint[], base: number, t: number): number {
  const n = points.length
  if (n === 0) return base
  if (t <= points[0].t) return points[0].v
  if (t >= points[n - 1].t) return points[n - 1].v
  for (let i = 1; i < n; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (t < b.t) {
      const len = b.t - a.t
      return len <= 1e-9 ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / len
    }
  }
  return points[n - 1].v
}

/** Максимум линии на отрезке [from, to] — чтобы не тащить в экспорт совсем немой кусок. */
export function gainPeak(points: GainPoint[], base: number, from: number, to: number): number {
  let m = Math.max(gainAt(points, base, from), gainAt(points, base, to))
  for (const p of points) if (p.t > from && p.t < to) m = Math.max(m, p.v)
  return m
}

/**
 * Разрез в точке cut (время исходника): у обеих половин на стыке стоит точка с уровнем линии в этом месте.
 * Без точек линия остаётся пустой (у половин тот же base).
 */
export function splitGain(points: GainPoint[], base: number, cut: number): { left: GainPoint[]; right: GainPoint[] } {
  if (points.length === 0) return { left: [], right: [] }
  const v = r3(gainAt(points, base, cut))
  return {
    left: [...points.filter((p) => p.t < cut - 1e-6), { t: r3(cut), v }],
    right: [{ t: r3(cut), v }, ...points.filter((p) => p.t > cut + 1e-6)]
  }
}

export interface GainPart {
  points: GainPoint[]
  base: number
  /** границы куска в исходнике */
  in: number
  out: number
}

/**
 * Склейка двух половин (b идёт сразу за a: a.out == b.in). Точки объединяются; если у кого-то точек нет, а
 * уровни разные, постоянный уровень запекается в точки у границ, чтобы звук не изменился.
 */
export function mergeGain(a: GainPart, b: GainPart): { points: GainPoint[]; base: number } {
  if (a.points.length === 0 && b.points.length === 0 && Math.abs(a.base - b.base) < 1e-3) return { points: [], base: a.base }
  const bake = (x: GainPart): GainPoint[] => (x.points.length ? x.points : [{ t: x.in, v: x.base }, { t: x.out, v: x.base }])
  const left = bake(a).filter((p) => p.t <= a.out + 1e-6)
  const right = bake(b).filter((p) => p.t >= b.in - 1e-6)
  const pts = [...left, ...right]
  // два значения в одной точке времени (ступенька): второе сдвигаем на миллисекунду, чтобы время росло строго
  for (let i = 1; i < pts.length; i++) if (pts[i].t <= pts[i - 1].t) pts[i] = { ...pts[i], t: r3(pts[i - 1].t + 0.001) }
  // точки стыка, лежащие на прямой между соседями, не нужны: после резки и склейки линия возвращается к исходной
  let j = left.length - 1
  for (let k = 0; k < 2 && j >= 1 && j < pts.length - 1; k++) {
    const a = pts[j - 1]
    const c = pts[j + 1]
    const on = gainAt([a, c], 0, pts[j].t)
    if (c.t - a.t > 1e-6 && Math.abs(on - pts[j].v) < 0.002) pts.splice(j, 1)
    else j++
  }
  return { points: pts.slice(0, MAX_POINTS), base: 1 }
}

/** Добавляет точку (уровень по умолчанию — текущий на линии). Время не совпадает с соседней точкой. */
export function addPoint(points: GainPoint[], base: number, t: number, v?: number): { points: GainPoint[]; index: number } {
  if (points.length >= MAX_POINTS) return { points, index: -1 }
  const tt = r3(t)
  const val = Math.round(clamp01(v ?? gainAt(points, base, tt)) * 1000) / 1000
  const list = points.filter((p) => Math.abs(p.t - tt) > 0.005)
  const next = [...list, { t: tt, v: val }].sort((a, b) => a.t - b.t)
  return { points: next, index: next.findIndex((p) => p.t === tt) }
}

/** Двигает точку: время зажато между соседями и границами куска, уровень — в 0..1. */
export function movePoint(points: GainPoint[], index: number, t: number, v: number, lo: number, hi: number): GainPoint[] {
  if (index < 0 || index >= points.length) return points
  const gap = 0.01
  const min = Math.max(lo, index > 0 ? points[index - 1].t + gap : lo)
  const max = Math.min(hi, index < points.length - 1 ? points[index + 1].t - gap : hi)
  const tt = r3(Math.min(Math.max(t, min), Math.max(min, max)))
  return points.map((p, i) => (i === index ? { t: tt, v: Math.round(clamp01(v) * 1000) / 1000 } : p))
}

/**
 * Выражение ffmpeg для фильтра volume (eval=frame): уровень по времени куска от его начала.
 * from — начало куска в исходнике. Без точек — просто число.
 */
export function gainExpr(points: GainPoint[], base: number, from: number, dur: number): string {
  if (points.length === 0) return base.toFixed(4)
  // линия в координатах куска: к краям добавляем значения на самих краях, точки вне куска отбрасываем
  const f = (x: number): string => x.toFixed(4)
  const inner = points.filter((p) => p.t - from > 0.0005 && p.t - from < dur - 0.0005)
  const seq: Array<[number, number]> = [[0, gainAt(points, base, from)], ...inner.map((p) => [p.t - from, p.v] as [number, number]), [dur, gainAt(points, base, from + dur)]]
  let expr = f(seq[seq.length - 1][1])
  for (let i = seq.length - 2; i >= 0; i--) {
    const [t0, v0] = seq[i]
    const [t1, v1] = seq[i + 1]
    const len = Math.max(1e-4, t1 - t0)
    expr = `if(lt(t,${f(t1)}),${f(v0)}+(${f(v1 - v0)})*(t-${f(t0)})/${f(len)},${expr})`
  }
  return expr
}
