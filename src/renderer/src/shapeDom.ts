/**
 * Рисование фигуры: один код и для предпросмотра, и для экспорта (страница рендера). Блок размером w×h (доли кадра) с центром
 * в (x, y); внутри — SVG. Порядок преобразований: поворот, затем зеркало (зеркало отражает уже повёрнутую фигуру, как на экране).
 */
import type { Shape } from '../../shared/shape'

const NS = 'http://www.w3.org/2000/svg'
const f = (x: number): string => (Math.round(x * 100) / 100).toString()

function node(name: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(NS, name)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el
}

/** Применяет параметры фигуры к элементу внутри контейнера размером W×H (position: relative/absolute). */
export function fillShape(el: HTMLElement, sh: Shape, W: number, H: number, flip?: { h: boolean; v: boolean }): void {
  const bw = Math.max(1, (sh.w / 100) * W)
  const bh = Math.max(1, (sh.h / 100) * H)
  const s = el.style
  s.position = 'absolute'
  s.left = `${sh.x}%`
  s.top = `${sh.y}%`
  s.width = `${f(bw)}px`
  s.height = `${f(bh)}px`
  s.pointerEvents = 'none'
  // transform применяется справа налево: сначала поворот, потом зеркало, потом перенос центра в точку (x, y)
  s.transform = `translate(-50%, -50%) scale(${flip?.h ? -1 : 1}, ${flip?.v ? -1 : 1}) rotate(${sh.rot}deg)`
  el.textContent = ''
  const svg = node('svg', { width: f(bw), height: f(bh), viewBox: `0 0 ${f(bw)} ${f(bh)}` }) as SVGSVGElement
  svg.style.display = 'block'
  svg.style.overflow = 'visible'
  const sw = (sh.stroke / 100) * H
  const th = (sh.thick / 100) * H
  const edge = sh.strokeOn ? sw / 2 : 0
  const stroke: Record<string, string> = sh.strokeOn ? { stroke: sh.strokeColor, 'stroke-width': f(sw) } : {}
  const box = { x: f(edge), y: f(edge), width: f(Math.max(0, bw - 2 * edge)), height: f(Math.max(0, bh - 2 * edge)) }
  switch (sh.kind) {
    case 'rect':
      svg.appendChild(node('rect', { ...box, fill: sh.fill, ...stroke }))
      break
    case 'round': {
      const r = (sh.radius / 100) * (Math.min(bw, bh) / 2)
      svg.appendChild(node('rect', { ...box, rx: f(r), ry: f(r), fill: sh.fill, ...stroke }))
      break
    }
    case 'circle':
      svg.appendChild(node('ellipse', { cx: f(bw / 2), cy: f(bh / 2), rx: f(Math.max(0, bw / 2 - edge)), ry: f(Math.max(0, bh / 2 - edge)), fill: sh.fill, ...stroke }))
      break
    case 'frame': {
      // рамка-контур: цвет — «заливка», толщина — «обводка»
      const e = sw / 2
      svg.appendChild(node('rect', { x: f(e), y: f(e), width: f(Math.max(0, bw - sw)), height: f(Math.max(0, bh - sw)), fill: 'none', stroke: sh.fill, 'stroke-width': f(sw) }))
      break
    }
    case 'line':
      svg.appendChild(node('line', { x1: f(th / 2), y1: f(bh / 2), x2: f(bw - th / 2), y2: f(bh / 2), stroke: sh.fill, 'stroke-width': f(th), 'stroke-linecap': 'round' }))
      break
    case 'arrow': {
      const hl = Math.min(bw * 0.5, th * 4.5)
      const hh = th * 2.2
      svg.appendChild(node('line', { x1: '0', y1: f(bh / 2), x2: f(bw - hl + th * 0.6), y2: f(bh / 2), stroke: sh.fill, 'stroke-width': f(th) }))
      svg.appendChild(node('polygon', { points: `${f(bw - hl)},${f(bh / 2 - hh)} ${f(bw)},${f(bh / 2)} ${f(bw - hl)},${f(bh / 2 + hh)}`, fill: sh.fill }))
      break
    }
  }
  el.appendChild(svg)
}
