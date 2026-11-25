/** История правок (слов, рамок клипов…): отмена/повтор, подряд идущие однотипные правки склеиваются в одну. */
import type { Word } from './types'

export interface Hist<T = Word[]> {
  present: T
  past: T[]
  future: T[]
  /** ключ последней правки и время (мс) — для склейки */
  key: string | null
  at: number
}

/** Поле words — исторически для слов; для других данных в нём лежит любое состояние T. */
export type HistAction<T = Word[]> =
  | { type: 'reset'; words: T }
  | { type: 'commit'; words: T; key?: string; now: number }
  | { type: 'undo' }
  | { type: 'redo' }

export const EMPTY_HIST: Hist = { present: [], past: [], future: [], key: null, at: 0 }
export const emptyHist = <T>(present: T): Hist<T> => ({ present, past: [], future: [], key: null, at: 0 })
export const HIST_LIMIT = 200
export const COALESCE_MS = 800

export function histReducer<T = Word[]>(h: Hist<T>, a: HistAction<T>): Hist<T> {
  switch (a.type) {
    case 'reset':
      return emptyHist(a.words)
    case 'commit': {
      if (a.words === h.present) return h
      if (a.key && a.key === h.key && a.now - h.at < COALESCE_MS) {
        return { ...h, present: a.words, future: [], at: a.now }
      }
      const past = [...h.past, h.present]
      if (past.length > HIST_LIMIT) past.shift()
      return { present: a.words, past, future: [], key: a.key ?? null, at: a.now }
    }
    case 'undo': {
      if (h.past.length === 0) return h
      return {
        present: h.past[h.past.length - 1],
        past: h.past.slice(0, -1),
        future: [h.present, ...h.future],
        key: null,
        at: 0
      }
    }
    case 'redo': {
      if (h.future.length === 0) return h
      return {
        present: h.future[0],
        past: [...h.past, h.present],
        future: h.future.slice(1),
        key: null,
        at: 0
      }
    }
  }
}
