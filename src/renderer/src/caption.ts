/**
 * Рисование подписи одним и тем же кодом в превью и на странице рендера.
 * Все размеры идут в cqmin (доля меньшей стороны контейнера-сцены), поэтому картинка
 * не зависит от пикселей: окно 400 px и кадр 3840 px выглядят одинаково.
 */
import { displayText, type CaptionState, type Phrase, type SubtitleStyle } from '../../shared/timeline'
import type { Word } from '../../shared/types'

/** Стиль задан в пикселях при высоте кадра 1080. */
const REF = 1080
const u = (px: number): string => `${(px / REF) * 100}cqmin`

function hexA(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/** Делает элемент сценой: контейнер размеров для cqmin. */
export function setupStage(stage: HTMLElement): void {
  stage.style.containerType = 'size'
  if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative'
  stage.style.overflow = 'hidden'
}

export interface CaptionView {
  /** Включает клики по словам (только превью в окне; на странице рендера выключено). */
  onWordClick: ((wordIdx: number) => void) | null
  /** Прямоугольник слова на экране (для окошка правки) или null, если слово сейчас не нарисовано. */
  wordRect(wordIdx: number): DOMRect | null
  /** Сообщает слова, фразы, стиль и итоговое имя шрифта; перерисовывает последнее состояние. */
  configure(words: Word[], phrases: Phrase[], style: SubtitleStyle, fontFamily: string): void
  render(state: CaptionState | null): void
}

export function createCaptionView(host: HTMLElement): CaptionView {
  const block = document.createElement('div')
  const plate = document.createElement('div')
  block.appendChild(plate)
  host.appendChild(block)

  let words: Word[] = []
  let phrases: Phrase[] = []
  let style: SubtitleStyle
  let family = ''
  let built = -1
  let fit = 1
  let last: CaptionState | null = null
  let wordEls: HTMLElement[] = []
  let letterEls: HTMLElement[] = []

  let onWordClick: ((wordIdx: number) => void) | null = null
  block.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-word]')
    if (el && onWordClick) onWordClick(Number(el.dataset.word))
  })

  const setSize = (): void => {
    block.style.fontSize = u(style.size * fit)
  }

  function applyBase(): void {
    const s = block.style
    s.position = 'absolute'
    s.left = '50%'
    s.top = `${style.posY}%`
    s.width = `${style.blockWidth}%`
    s.textAlign = 'center'
    s.pointerEvents = 'none'
    s.visibility = 'hidden'
    s.fontFamily = family
    s.fontWeight = String(style.weight)
    s.lineHeight = '1.12'
    s.textTransform = style.uppercase ? 'uppercase' : 'none'
    s.color = style.color
    s.setProperty('-webkit-text-stroke', style.stroke > 0 ? `${u(style.stroke)} ${style.strokeColor}` : '0')
    s.setProperty('paint-order', 'stroke fill')
    s.textShadow = style.shadowOn
      ? `${u(style.shadowX)} ${u(style.shadowY)} ${u(style.shadowBlur)} ${style.shadowColor}`
      : 'none'
    s.transform = 'translate(-50%, -50%)'

    const p = plate.style
    p.display = 'inline-block'
    p.maxWidth = '100%'
    p.boxSizing = 'border-box'
    p.padding = style.plateOn ? `${u(style.platePad * 0.5)} ${u(style.platePad)}` : '0'
    p.borderRadius = style.plateOn ? u(style.plateRadius) : '0'
    p.background = style.plateOn ? hexA(style.plateColor, style.plateOpacity) : 'transparent'
    setSize()
  }

  /** Если фраза не влезает в заданное число строк или в ширину блока, уменьшаем шрифт. */
  function fitText(): void {
    fit = 1
    setSize()
    const saved = block.style.transform
    block.style.transform = 'translate(-50%, -50%)'
    for (let i = 0; i < 14; i++) {
      const fs = parseFloat(getComputedStyle(block).fontSize)
      const cs = getComputedStyle(plate)
      const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      const rect = plate.getBoundingClientRect()
      const lines = Math.round((rect.height - padV) / (fs * 1.12))
      const tooWide = rect.width > block.clientWidth + 1
      if ((lines <= style.maxLines && !tooWide) || fit <= 0.4) break
      fit -= 0.05
      setSize()
    }
    block.style.transform = saved
  }

  function rebuild(idx: number): void {
    plate.textContent = ''
    wordEls = []
    letterEls = []
    const ph = phrases[idx]
    for (let k = ph.first; k <= ph.last; k++) {
      if (k > ph.first) plate.appendChild(document.createTextNode(' '))
      const el = document.createElement('span')
      el.style.display = 'inline-block'
      el.style.whiteSpace = 'nowrap'
      el.dataset.word = String(k)
      if (onWordClick) {
        el.style.pointerEvents = 'auto'
        el.style.cursor = 'text'
      }
      if (style.mode === 'typewriter') {
        for (const ch of displayText(words[k].text, style)) {
          const l = document.createElement('span')
          l.textContent = ch
          letterEls.push(l)
          el.appendChild(l)
        }
      } else {
        el.textContent = displayText(words[k].text, style)
      }
      plate.appendChild(el)
      wordEls.push(el)
    }
    fitText()
  }

  function render(state: CaptionState | null): void {
    last = state
    if (!state || !phrases[state.phrase]) {
      block.style.visibility = 'hidden'
      return
    }
    if (state.phrase !== built) {
      rebuild(state.phrase)
      built = state.phrase
    }
    const ph = phrases[state.phrase]

    // появление фразы
    const e = state.enter
    let scale = 1
    let rise = 0
    if (style.enter === 'pop' && style.mode !== 'typewriter') {
      scale = style.enterScale + (1 - style.enterScale) * e
      rise = (1 - e) * 0.08
    }
    block.style.opacity = style.enter === 'none' || style.mode === 'typewriter' ? '1' : String(e)
    block.style.transform = `translate(-50%, calc(-50% + ${rise}em)) scale(${scale})`
    block.style.visibility = 'visible'

    // содержимое по режиму
    if (style.mode === 'word') {
      wordEls[0].style.color = style.accent
    } else if (style.mode === 'highlight') {
      wordEls.forEach((el, i) => {
        const on = ph.first + i === state.active
        el.style.color = on ? style.accent : style.color
        el.style.transform = on ? `scale(${1 + (style.pop - 1) * state.pop})` : ''
      })
    } else {
      letterEls.forEach((el, i) => {
        el.style.visibility = i < state.typed ? 'visible' : 'hidden'
      })
    }
  }

  return {
    get onWordClick() {
      return onWordClick
    },
    set onWordClick(fn) {
      onWordClick = fn
      built = -1
      render(last)
    },
    wordRect(wordIdx) {
      const el = wordEls.find((x) => x.dataset.word === String(wordIdx))
      return el && block.style.visibility === 'visible' ? el.getBoundingClientRect() : null
    },
    configure(w, p, s, f) {
      words = w
      phrases = p
      style = s
      family = f
      built = -1
      applyBase()
      render(last)
    },
    render
  }
}
