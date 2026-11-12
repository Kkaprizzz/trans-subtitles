/**
 * Разбор вывода whisper.cpp (`-ml 1 -sow -ojf`): каждая запись JSON — одно слово с временем в мс.
 * Чистые функции, чтобы проверять без запуска модели.
 */
import type { Word } from './types'
import { MIN_DUR, sanitizeWords } from './words.ts'

export interface WhisperToken {
  text: string
  /** время по выравниванию DTW, в сотых секунды; -1, если DTW выключен */
  t_dtw?: number
}

export interface WhisperSegment {
  offsets: { from: number; to: number }
  text: string
  tokens?: WhisperToken[]
}

export interface WhisperJson {
  transcription?: WhisperSegment[]
}

/**
 * Поправки к DTW, подобраны по эталонным границам слов: DTW отмечает середину токена,
 * поэтому начало слова сдвигаем раньше, конец — позже. См. проверку в забеге тестов 2026-11-11.
 */
export const DTW_LEAD = 0.2
export const DTW_TAIL = 0.1

/** Только знаки и пробелы (например «?»» или «—»): отдельным словом не считаем. */
const NO_LETTERS = /^[^\p{L}\p{N}]*$/u
/** Служебные пометки вроде [Музыка] или (смех): это не речь. */
const ANNOTATION = /^[\[(].*[\])]$/u
const SPECIAL = /^\[_/

export { sanitizeWords } from './words.ts'

/**
 * Если в токенах есть DTW-время, берём его (точнее обычных отметок, которые у Whisper
 * «прилипают» к концу предыдущего слова и уезжают в паузы). Иначе — обычные отметки сегмента.
 */
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

    let start = seg.offsets.from / 1000
    let end = seg.offsets.to / 1000
    const timed = (seg.tokens ?? []).filter(
      (t) => !SPECIAL.test(t.text) && /[\p{L}\p{N}]/u.test(t.text) && (t.t_dtw ?? -1) >= 0
    )
    if (timed.length) {
      // DTW не должен уводить слово раньше начала сегмента
      start = Math.max(start, (timed[0].t_dtw as number) / 100 - DTW_LEAD)
      end = Math.max(start + MIN_DUR, (timed[timed.length - 1].t_dtw as number) / 100 + DTW_TAIL)
    }
    words.push({ id: words.length, text, start, end })
  }
  return sanitizeWords(words)
}
