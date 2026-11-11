/**
 * Разбор вывода whisper.cpp (`-ml 1 -sow -ojf`): каждая запись JSON — одно слово с временем в мс.
 * Чистые функции, чтобы проверять без запуска модели.
 */
import type { Word } from './types'

export interface WhisperSegment {
  offsets: { from: number; to: number }
  text: string
}

export interface WhisperJson {
  transcription?: WhisperSegment[]
}

const MIN_DUR = 0.04
const round3 = (x: number): number => Math.round(x * 1000) / 1000

/** Только знаки и пробелы (например «?»» или «—»): отдельным словом не считаем. */
const NO_LETTERS = /^[^\p{L}\p{N}]*$/u
/** Служебные пометки вроде [Музыка] или (смех): это не речь. */
const ANNOTATION = /^[\[(].*[\])]$/u

/** Приводит слова к инвариантам: по порядку, конец позже начала, без наложений, id по порядку. */
export function sanitizeWords(input: Word[]): Word[] {
  const sorted = input.slice().sort((a, b) => a.start - b.start)
  const out: Word[] = []
  for (const w of sorted) {
    let start = w.start
    let end = w.end
    const prev = out[out.length - 1]
    if (prev && start < prev.end) {
      if (start >= prev.start + MIN_DUR) prev.end = round3(start)
      else start = prev.end
    }
    if (end < start + MIN_DUR) end = start + MIN_DUR
    out.push({ id: out.length, text: w.text, start: round3(start), end: round3(end) })
  }
  return out
}

export function parseWhisperJson(json: WhisperJson): Word[] {
  const words: Word[] = []
  for (const seg of json.transcription ?? []) {
    const text = seg.text.trim()
    if (!text) continue
    if (NO_LETTERS.test(text)) {
      // хвостовая пунктуация, которую модель вынесла отдельной записью: присоединяем к предыдущему слову
      const prev = words[words.length - 1]
      if (prev) prev.text += text
      continue
    }
    if (ANNOTATION.test(text)) continue
    words.push({ id: words.length, text, start: seg.offsets.from / 1000, end: seg.offsets.to / 1000 })
  }
  return sanitizeWords(words)
}
