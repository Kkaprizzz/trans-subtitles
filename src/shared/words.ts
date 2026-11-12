/** Общие операции над массивом слов после распознавания. Чистые функции. */
import type { Word } from './types'

export const MIN_DUR = 0.04
const round3 = (x: number): number => Math.round(x * 1000) / 1000

/** Приводит слова к инвариантам: по порядку, конец позже начала, без наложений, id по порядку. */
export function sanitizeWords(input: Word[]): Word[] {
  const sorted = input.slice().sort((a, b) => a.start - b.start)
  const out: Word[] = []
  for (const w of sorted) {
    let start = Math.max(0, w.start)
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

/**
 * Компенсация систематического сдвига модели: начало раньше на lead, конец позже на tail.
 * Наложения, которые при этом появятся, разрешает sanitizeWords (конец предыдущего слова обрезается).
 */
export function correctEdges(words: Word[], lead: number, tail: number): Word[] {
  return sanitizeWords(words.map((w) => ({ ...w, start: w.start - lead, end: w.end + tail })))
}
