/** История правок слов: отмена/повтор, подряд идущие однотипные правки склеиваются в одну. */
import type { Word } from './types'

export interface Hist {
  present: Word[]
  past: Word[][]
  future: Word[][]
  /** ключ последней правки и время (мс) — для склейки */
  key: string | null
  at: number
}

export type HistAction =
  | { type: 'reset'; words: Word[] }
  | { type: 'commit'; words: Word[]; key?: string; now: number }
  | { type: 'undo' }
  | { type: 'redo' }

export const EMPTY_HIST: Hist = { present: [], past: [], future: [], key: null, at: 0 }
export const HIST_LIMIT = 200
export const COALESCE_MS = 800

export function histReducer(h: Hist, a: HistAction): Hist {
  switch (a.type) {
    case 'reset':
      return { ...EMPTY_HIST, present: a.words }
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
