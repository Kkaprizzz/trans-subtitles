/**
 * Фигура (прямоугольник, скруглённый, круг, линия, стрелка, рамка-контур): кусок вида 'shape' на видеодорожке, как надпись.
 * Рисуется одним кодом (renderer/shapeDom.ts) и в предпросмотре, и в экспорте. Размеры — доли кадра: ширина и высота
 * блока — % ширины и высоты кадра, центр (x, y) — % кадра, поворот — градусы по часовой, толщины — % высоты кадра.
 * Масштаб, сдвиг, прозрачность, зеркало и анимации берутся у куска («Кадр», ключи, эффекты) — как у надписи.
 */
export type ShapeKind = 'rect' | 'round' | 'circle' | 'line' | 'arrow' | 'frame'

export interface Shape {
  kind: ShapeKind
  /** заливка; у линии и стрелки — их цвет */
  fill: string
  /** обводка закрытой фигуры (у рамки включена всегда) */
  strokeOn: boolean
  strokeColor: string
  /** толщина обводки, % высоты кадра */
  stroke: number
  /** скругление: % половины меньшей стороны (только «скруглённый») */
  radius: number
  /** толщина линии и стрелки, % высоты кадра */
  thick: number
  /** центр блока, % кадра */
  x: number
  y: number
  /** ширина и высота блока, % ширины и высоты кадра */
  w: number
  h: number
  /** поворот, градусы (−180…180) */
  rot: number
}

export const SHAPE_LIMITS = { stroke: [0, 20], radius: [0, 100], thick: [0.2, 12], x: [-50, 150], y: [-50, 150], w: [1, 200], h: [0.5, 200], rot: [-180, 180] } as const
export const DEFAULT_SHAPE_LEN = 3

export const SHAPE_KINDS: Array<{ id: ShapeKind; title: string }> = [
  { id: 'rect', title: 'Прямоугольник' },
  { id: 'round', title: 'Скруглённый' },
  { id: 'circle', title: 'Круг' },
  { id: 'line', title: 'Линия' },
  { id: 'arrow', title: 'Стрелка' },
  { id: 'frame', title: 'Рамка' }
]

const BASE: Shape = { kind: 'rect', fill: '#ffffff', strokeOn: false, strokeColor: '#000000', stroke: 0.6, radius: 30, thick: 1, x: 50, y: 50, w: 40, h: 22, rot: 0 }

/** Новая фигура по умолчанию (aspect — ширина/высота кадра, чтобы круг был круглым): белая, по центру кадра. Рамка — только контур; линия и стрелка — тонкие и длинные. */
export function newShape(kind: ShapeKind, aspect = 16 / 9): Shape {
  const s: Shape = { ...BASE, kind }
  if (kind === 'circle') Object.assign(s, { w: 24, h: round2(24 * aspect) })
  if (kind === 'line' || kind === 'arrow') Object.assign(s, { w: 30, h: 6, thick: kind === 'arrow' ? 1.2 : 0.8 })
  if (kind === 'frame') Object.assign(s, { strokeOn: true, stroke: 0.8, w: 50, h: 40 })
  return s
}

const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x))
const round2 = (x: number): number => Math.round(x * 100) / 100
const color = (x: unknown, d: string): string => (typeof x === 'string' && /^#[0-9a-fA-F]{6}$/.test(x) ? x.toLowerCase() : d)
const KINDS: ShapeKind[] = SHAPE_KINDS.map((k) => k.id)

/** Фигура из файла проекта: мусор — по умолчанию, значения в пределах. */
export function cleanShape(raw: unknown): Shape {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const kind = KINDS.includes(r.kind as ShapeKind) ? (r.kind as ShapeKind) : 'rect'
  const d = newShape(kind)
  const num = (k: keyof typeof SHAPE_LIMITS): number => {
    const v = Number(r[k])
    return round2(clamp(Number.isFinite(v) ? v : (d[k] as number), SHAPE_LIMITS[k][0], SHAPE_LIMITS[k][1]))
  }
  return {
    kind,
    fill: color(r.fill, d.fill),
    strokeOn: kind === 'frame' ? true : r.strokeOn === true,
    strokeColor: color(r.strokeColor, d.strokeColor),
    stroke: num('stroke'),
    radius: num('radius'),
    thick: num('thick'),
    x: num('x'),
    y: num('y'),
    w: num('w'),
    h: num('h'),
    rot: num('rot')
  }
}

/** Правка параметров: числа зажимаются в пределы, вид менять нельзя. */
export function patchShapeValues(s: Shape, patch: Partial<Shape>): Shape {
  const g: Shape = { ...s, ...patch, kind: s.kind }
  for (const k of Object.keys(SHAPE_LIMITS) as Array<keyof typeof SHAPE_LIMITS>) {
    const v = Number(g[k])
    g[k] = round2(clamp(Number.isFinite(v) ? v : (s[k] as number), SHAPE_LIMITS[k][0], SHAPE_LIMITS[k][1]))
  }
  if (g.kind === 'frame') g.strokeOn = true
  return g
}

/** Подпись фигуры на таймлайне. */
export const shapeLabel = (s: Shape): string => SHAPE_KINDS.find((k) => k.id === s.kind)?.title ?? 'Фигура'
