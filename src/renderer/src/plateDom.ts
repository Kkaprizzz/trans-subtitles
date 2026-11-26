/**
 * Рисование текстовой плашки: один код и для предпросмотра, и для экспорта (страница рендера), поэтому надпись выглядит
 * одинаково. Размер шрифта — доля высоты кадра H, положение и ширина — доли кадра; сам блок центрируется на (x, y).
 */
import { fontById } from '../../shared/fonts'
import type { Plate } from '../../shared/plate'

/** Применяет параметры надписи к элементу, лежащему внутри контейнера размером W×H (position: relative/absolute). */
export function fillPlate(el: HTMLElement, plate: Plate, W: number, H: number): void {
  void W
  const fs = (plate.size / 100) * H
  const s = el.style
  s.position = 'absolute'
  s.left = `${plate.x}%`
  s.top = `${plate.y}%`
  s.width = `${plate.width}%`
  s.transform = 'translate(-50%, -50%)'
  s.fontFamily = fontById(plate.font).family
  s.fontWeight = String(plate.weight)
  s.fontSize = `${fs.toFixed(2)}px`
  s.lineHeight = '1.15'
  s.color = plate.color
  s.textAlign = plate.align
  s.whiteSpace = 'pre-wrap'
  s.overflowWrap = 'anywhere'
  s.pointerEvents = 'none'
  s.setProperty('paint-order', 'stroke fill')
  s.setProperty('-webkit-text-stroke', plate.strokeOn ? `${((plate.stroke / 100) * fs).toFixed(2)}px ${plate.strokeColor}` : '0')
  s.textShadow = plate.shadowOn ? `0 0.05em 0.16em ${plate.shadowColor}d9` : 'none'
  el.textContent = plate.text
}

/** Дожидается шрифта надписи, чтобы первый кадр не вышел запасным шрифтом. */
export async function loadPlateFont(plate: Plate): Promise<void> {
  const family = fontById(plate.font).family
  await document.fonts.load(`${plate.weight} 40px ${family}`, plate.text + 'АаЯя')
}
