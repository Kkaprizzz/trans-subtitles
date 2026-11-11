/** Встроенные шрифты субтитров (все с кириллицей). CSS подключается в renderer/src/fonts.ts. */
export interface FontDef {
  id: string
  label: string
  /** значение CSS font-family */
  family: string
  /** доступные начертания */
  weights: number[]
}

export const FONTS: FontDef[] = [
  { id: 'montserrat', label: 'Montserrat', family: "'Montserrat Variable'", weights: [400, 500, 600, 700, 800, 900] },
  { id: 'commissioner', label: 'Commissioner', family: "'Commissioner Variable'", weights: [400, 500, 600, 700, 800, 900] },
  { id: 'plex', label: 'IBM Plex Sans', family: "'IBM Plex Sans Variable'", weights: [400, 500, 600, 700] },
  { id: 'arsenal', label: 'Arsenal', family: "'Arsenal'", weights: [400, 700] },
  { id: 'spectral', label: 'Spectral', family: "'Spectral'", weights: [400, 600, 700, 800] },
  { id: 'prata', label: 'Prata', family: "'Prata'", weights: [400] }
]

import type { SubtitleStyle } from './timeline'

/** Имя, под которым регистрируется шрифт из файла пользователя. */
export const CUSTOM_FAMILY = 'TS Custom Font'
export const CUSTOM_EXT = ['.ttf', '.otf', '.woff', '.woff2']

/** Итоговое значение font-family: свой шрифт, а если он не загрузится, то Montserrat. */
export function fontFamilyOf(style: Pick<SubtitleStyle, 'font' | 'customFontPath'>): string {
  if (style.font === 'custom' && style.customFontPath) {
    return `'${CUSTOM_FAMILY}', ${FONTS[0].family}, sans-serif`
  }
  return fontById(style.font).family
}

export const WEIGHT_LABELS: Record<number, string> = {
  400: 'Обычный',
  500: 'Средний',
  600: 'Полужирный',
  700: 'Жирный',
  800: 'Сверхжирный',
  900: 'Чёрный'
}

export function fontById(id: string): FontDef {
  return FONTS.find((f) => f.id === id) ?? FONTS[0]
}

/** Ближайшее доступное начертание (если выбранного у шрифта нет). */
export function nearestWeight(font: FontDef, weight: number): number {
  return font.weights.reduce((best, w) => (Math.abs(w - weight) < Math.abs(best - weight) ? w : best), font.weights[0])
}
