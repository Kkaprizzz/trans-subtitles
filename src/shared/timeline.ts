/**
 * Время -> что показывать. Чистые функции без DOM: ими пользуются и превью в окне,
 * и страница рендера, и главный процесс (для пропуска одинаковых кадров).
 */
import type { Word } from './types'

export type CaptionMode = 'word' | 'highlight' | 'typewriter'
export type EnterType = 'pop' | 'fade' | 'none'

/** Все размеры в пикселях при высоте кадра 1080 — на другие размеры масштабируются сами. */
export interface SubtitleStyle {
  mode: CaptionMode

  /** фразы: максимум слов и пауза (с), после которой фраза обрывается */
  maxWords: number
  pauseBreak: number
  /** сколько фраза остаётся на экране после конца последнего слова, с */
  hold: number

  /** id встроенного шрифта или 'custom' (тогда берётся customFontPath) */
  font: string
  customFontPath: string
  customFontName: string
  weight: number
  size: number
  uppercase: boolean
  /** не показывать знаки препинания по краям слов (в словах они сохраняются) */
  stripPunct: boolean

  /** обычный цвет текста / цвет активного слова (в «слово за словом» — самого слова) */
  color: string
  accent: string
  strokeColor: string
  stroke: number

  shadowOn: boolean
  shadowColor: string
  shadowX: number
  shadowY: number
  shadowBlur: number

  plateOn: boolean
  plateColor: string
  plateOpacity: number
  platePad: number
  plateRadius: number

  /** центр блока по вертикали, % высоты */
  posY: number
  /** ширина блока, % ширины */
  blockWidth: number
  /** если фраза не влезает в столько строк, шрифт уменьшается */
  maxLines: number

  enter: EnterType
  /** длительность появления / подскока, с */
  enterDur: number
  /** начальный масштаб при появлении «подскоком» */
  enterScale: number
  /** во сколько раз увеличивается активное слово в подсветке */
  pop: number
}

/** Стартовый стиль: жёлтое слово с толстой чёрной обводкой, как во вшитых субтитрах ролика пользователя. */
export const DEFAULT_STYLE: SubtitleStyle = {
  mode: 'word',
  maxWords: 3,
  pauseBreak: 0.5,
  hold: 0.35,

  font: 'montserrat',
  customFontPath: '',
  customFontName: '',
  weight: 800,
  size: 96,
  uppercase: false,
  stripPunct: true,

  color: '#FFFFFF',
  accent: '#FFE500',
  strokeColor: '#000000',
  stroke: 19,

  shadowOn: false,
  shadowColor: '#000000',
  shadowX: 0,
  shadowY: 6,
  shadowBlur: 12,

  plateOn: false,
  plateColor: '#000000',
  plateOpacity: 0.55,
  platePad: 20,
  plateRadius: 12,

  posY: 63.5,
  blockWidth: 84,
  maxLines: 2,

  enter: 'pop',
  enterDur: 0.14,
  enterScale: 0.8,
  pop: 1.12
}

/** Подмешивает умолчания в сохранённый стиль (старые версии могли не знать новых полей). */
export function normalizeStyle(raw: Partial<SubtitleStyle> | null | undefined): SubtitleStyle {
  return { ...DEFAULT_STYLE, ...(raw ?? {}) }
}

export interface Phrase {
  /** индексы первого и последнего слова во всём массиве слов */
  first: number
  last: number
  start: number
  end: number
}

export interface CaptionState {
  phrase: number
  /** слово, которое звучит сейчас (-1, если оно уже закончилось) */
  active: number
  /** прогресс появления фразы после кривой, 0..1 */
  enter: number
  /** прогресс подскока активного слова, 0..1 */
  pop: number
  /** режим «машинка»: сколько букв (без пробелов) уже напечатано во фразе; иначе -1 */
  typed: number
}

/** Индекс последнего слова, начавшегося не позже t (или -1). */
export function findActive(words: Word[], t: number): number {
  let lo = 0
  let hi = words.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (words[mid].start <= t) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

/** Группировка слов во фразы: до maxWords слов, разрыв на паузе. В «слово за словом» фраза = слово. */
export function buildPhrases(
  words: Word[],
  style: Pick<SubtitleStyle, 'mode' | 'maxWords' | 'pauseBreak'>
): Phrase[] {
  const limit = style.mode === 'word' ? 1 : Math.max(1, Math.floor(style.maxWords))
  const out: Phrase[] = []
  let cur: Phrase | null = null
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const gap = i > 0 ? w.start - words[i - 1].end : 0
    if (cur && (cur.last - cur.first + 1 >= limit || gap > style.pauseBreak)) {
      out.push(cur)
      cur = null
    }
    if (!cur) cur = { first: i, last: i, start: w.start, end: w.end }
    else {
      cur.last = i
      cur.end = w.end
    }
  }
  if (cur) out.push(cur)
  return out
}

function findPhrase(phrases: Phrase[], t: number): number {
  let lo = 0
  let hi = phrases.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (phrases[mid].start <= t) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

/** Единственная кривая проекта: cubic-bezier(0.22, 0.8, 0.2, 1) (см. DESIGN.md). */
function makeBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sx = (t: number): number => ((ax * t + bx) * t + cx) * t
  const sy = (t: number): number => ((ay * t + by) * t + cy) * t
  const dx = (t: number): number => (3 * ax * t + 2 * bx) * t + cx
  return (x) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i++) {
      const err = sx(t) - x
      if (Math.abs(err) < 1e-6) return sy(t)
      const d = dx(t)
      if (Math.abs(d) < 1e-6) break
      t -= err / d
    }
    let lo = 0
    let hi = 1
    t = x
    while (lo < hi && hi - lo > 1e-6) {
      const v = sx(t)
      if (Math.abs(v - x) < 1e-6) break
      if (x > v) lo = t
      else hi = t
      t = (lo + hi) / 2
    }
    return sy(t)
  }
}

export const ease = makeBezier(0.22, 0.8, 0.2, 1)

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
/** Текст слова так, как он показывается на экране. Внутренние дефисы остаются («кока-кола»). */
export function displayText(text: string, style: Pick<SubtitleStyle, 'stripPunct'>): string {
  return style.stripPunct ? text.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '') : text
}

/** Что показывать в момент t (или null, если на экране пусто). */
export function captionAt(
  words: Word[],
  phrases: Phrase[],
  style: SubtitleStyle,
  t: number
): CaptionState | null {
  const pi = findPhrase(phrases, t)
  if (pi < 0) return null
  const ph = phrases[pi]
  if (t > ph.end + style.hold) return null

  // последнее слово фразы, начавшееся не позже t
  let k = ph.first
  while (k < ph.last && words[k + 1].start <= t) k++
  const w = words[k]

  const animated = style.enter !== 'none' && style.enterDur > 0
  const enter = style.mode === 'typewriter' || !animated ? 1 : ease(clamp01((t - ph.start) / style.enterDur))

  let active = k
  let pop = 1
  let typed = -1

  if (style.mode === 'highlight') {
    active = k < ph.last || t <= w.end ? k : -1
    pop = animated ? ease(clamp01((t - w.start) / style.enterDur)) : 1
  } else if (style.mode === 'typewriter') {
    let before = 0
    for (let j = ph.first; j < k; j++) before += [...displayText(words[j].text, style)].length
    const len = [...displayText(w.text, style)].length
    const p = clamp01((t - w.start) / Math.max(0.12, w.end - w.start))
    typed = before + Math.min(len, Math.floor(p * len) + 1)
  }

  return { phrase: pi, active, enter, pop, typed }
}

/** Одинаковый ключ = пиксели кадра совпадают, повторно рисовать не нужно. */
export function frameKey(s: CaptionState | null): string {
  return s ? `${s.phrase}|${s.active}|${s.enter.toFixed(4)}|${s.pop.toFixed(4)}|${s.typed}` : '-'
}
