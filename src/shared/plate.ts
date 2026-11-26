/**
 * Текстовая плашка (надпись поверх видео): параметры и готовые стили. Рисуется одним и тем же кодом в предпросмотре и в
 * экспорте (renderer/plateDom.ts), поэтому выглядит одинаково. Размеры — доли высоты кадра, положение и ширина — доли кадра.
 */
export type PlateAlign = 'left' | 'center' | 'right'

export interface Plate {
  text: string
  /** id встроенного шрифта (shared/fonts.ts) */
  font: string
  weight: number
  /** размер шрифта, % высоты кадра */
  size: number
  color: string
  align: PlateAlign
  strokeOn: boolean
  strokeColor: string
  /** толщина обводки, % размера шрифта */
  stroke: number
  shadowOn: boolean
  shadowColor: string
  /** центр блока, % ширины и высоты кадра */
  x: number
  y: number
  /** ширина блока, % ширины кадра */
  width: number
}

export const PLATE_LIMITS = { size: [1, 40], stroke: [0, 30], x: [0, 100], y: [0, 100], width: [10, 100] } as const
export const MAX_PLATE_TEXT = 600
export const DEFAULT_PLATE_LEN = 3

export interface PlateStyle {
  id: string
  title: string
  description: string
  plate: Omit<Plate, 'text'>
}

export const PLATE_STYLES: PlateStyle[] = [
  {
    id: 'title',
    title: 'Заголовок',
    description: 'Крупный жирный, вверху, с обводкой',
    plate: { font: 'montserrat', weight: 800, size: 8, color: '#ffffff', align: 'center', strokeOn: true, strokeColor: '#000000', stroke: 12, shadowOn: false, shadowColor: '#000000', x: 50, y: 18, width: 84 }
  },
  {
    id: 'caption',
    title: 'Подпись',
    description: 'Мелкий, внизу, с тенью',
    plate: { font: 'commissioner', weight: 600, size: 4.5, color: '#ffffff', align: 'left', strokeOn: false, strokeColor: '#000000', stroke: 10, shadowOn: true, shadowColor: '#000000', x: 50, y: 88, width: 84 }
  },
  {
    id: 'text',
    title: 'Текст',
    description: 'Обычный, в центре',
    plate: { font: 'commissioner', weight: 700, size: 6, color: '#ffffff', align: 'center', strokeOn: false, strokeColor: '#000000', stroke: 10, shadowOn: true, shadowColor: '#000000', x: 50, y: 50, width: 80 }
  }
]

export function newPlate(styleId = 'text', text = 'Текст'): Plate {
  const st = PLATE_STYLES.find((s) => s.id === styleId) ?? PLATE_STYLES[2]
  return { ...st.plate, text }
}

const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x))
const round1 = (x: number): number => Math.round(x * 10) / 10
const color = (x: unknown, d: string): string => (typeof x === 'string' && /^#[0-9a-fA-F]{6}$/.test(x) ? x.toLowerCase() : d)

/** Надпись из файла проекта: мусор — по стилю «Текст», значения в пределах. */
export function cleanPlate(raw: unknown, knownFonts: string[]): Plate {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const d = newPlate('text')
  const num = (k: keyof typeof PLATE_LIMITS, dv: number): number => {
    const v = Number(r[k])
    return round1(clamp(Number.isFinite(v) ? v : dv, PLATE_LIMITS[k][0], PLATE_LIMITS[k][1]))
  }
  const w = Number(r.weight)
  return {
    text: typeof r.text === 'string' ? r.text.slice(0, MAX_PLATE_TEXT) : d.text,
    font: typeof r.font === 'string' && knownFonts.includes(r.font) ? r.font : d.font,
    weight: Number.isFinite(w) ? clamp(Math.round(w / 100) * 100, 100, 900) : d.weight,
    size: num('size', d.size),
    color: color(r.color, d.color),
    align: r.align === 'left' || r.align === 'right' ? r.align : 'center',
    strokeOn: r.strokeOn === true,
    strokeColor: color(r.strokeColor, d.strokeColor),
    stroke: num('stroke', d.stroke),
    shadowOn: r.shadowOn === true,
    shadowColor: color(r.shadowColor, d.shadowColor),
    x: num('x', d.x),
    y: num('y', d.y),
    width: num('width', d.width)
  }
}

export function patchPlateValues(p: Plate, patch: Partial<Plate>): Plate {
  const g = { ...p, ...patch }
  for (const k of Object.keys(PLATE_LIMITS) as Array<keyof typeof PLATE_LIMITS>) {
    const v = Number(g[k])
    g[k] = round1(clamp(Number.isFinite(v) ? v : p[k], PLATE_LIMITS[k][0], PLATE_LIMITS[k][1]))
  }
  g.text = g.text.slice(0, MAX_PLATE_TEXT)
  return g
}

/** Подпись куска на таймлайне: первая непустая строка. */
export const plateLabel = (p: Plate): string => p.text.split('\n').map((s) => s.trim()).find(Boolean) ?? 'Текст'
