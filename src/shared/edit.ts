/**
 * Правки слов: чистые функции без DOM, возвращают новый массив (или null, если ничего не изменилось).
 * Инварианты: слова упорядочены по началу, не заходят друг на друга, у каждого конец позже начала.
 */
import type { Word } from './types'

/** Минимальная длительность слова, с. */
export const MIN_DUR = 0.04
/** Шаг кнопок ± , с. */
export const NUDGE = 0.02

const round3 = (x: number): number => Math.round(x * 1000) / 1000
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

function newId(words: Word[]): number {
  return words.reduce((m, w) => Math.max(m, w.id), -1) + 1
}

export interface EditResult {
  words: Word[]
  /** индекс слова, которое нужно выделить после правки (-1 — ничего) */
  focus: number
}

export function deleteWord(words: Word[], idx: number): EditResult | null {
  if (!words[idx]) return null
  const next = words.filter((_, i) => i !== idx)
  return { words: next, focus: next.length ? Math.min(idx, next.length - 1) : -1 }
}

/**
 * Меняет текст слова. Пробел внутри текста делит слово на несколько:
 * время делится пропорционально числу букв. Пустой текст удаляет слово.
 */
export function setText(words: Word[], idx: number, raw: string): EditResult | null {
  const w = words[idx]
  if (!w) return null
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return deleteWord(words, idx)
  if (parts.length === 1) {
    if (parts[0] === w.text) return null
    const next = words.slice()
    next[idx] = { ...w, text: parts[0] }
    return { words: next, focus: idx }
  }

  const lens = parts.map((p) => [...p].length)
  const total = lens.reduce((a, b) => a + b, 0)
  const dur = w.end - w.start
  const ids = newId(words)
  let acc = 0
  const pieces: Word[] = parts.map((text, i) => {
    const start = round3(w.start + (dur * acc) / total)
    acc += lens[i]
    const end = round3(i === parts.length - 1 ? w.end : w.start + (dur * acc) / total)
    return { id: i === 0 ? w.id : ids + i - 1, text, start, end }
  })
  return { words: [...words.slice(0, idx), ...pieces, ...words.slice(idx + 1)], focus: idx }
}

/** Склеивает слово со следующим (тексты без пробела — потом можно поправить). */
export function mergeWithNext(words: Word[], idx: number): EditResult | null {
  const a = words[idx]
  const b = words[idx + 1]
  if (!a || !b) return null
  const merged: Word = { id: a.id, text: a.text + b.text, start: a.start, end: b.end }
  return { words: [...words.slice(0, idx), merged, ...words.slice(idx + 2)], focus: idx }
}

/**
 * Двигает начало и/или конец слова, не заходя на соседей и не выходя за [0, duration].
 * Если соседи уже перекрывались до правки, слово остаётся там, где было (в эту сторону не двигаем).
 */
export function setTiming(
  words: Word[],
  idx: number,
  patch: { start?: number; end?: number },
  duration: number
): Word[] | null {
  const w = words[idx]
  if (!w) return null
  const prev = words[idx - 1]
  const next = words[idx + 1]

  const minStart = prev ? Math.min(prev.end, w.start) : 0
  const maxEnd = next ? Math.max(next.start, w.end) : Math.max(duration, w.end)

  let start = w.start
  let end = w.end
  if (patch.start !== undefined) start = clamp(patch.start, minStart, w.end - MIN_DUR)
  if (patch.end !== undefined) end = clamp(patch.end, start + MIN_DUR, maxEnd)

  start = round3(start)
  end = round3(end)
  if (start === w.start && end === w.end) return null
  const out = words.slice()
  out[idx] = { ...w, start, end }
  return out
}
