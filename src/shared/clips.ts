/**
 * Режим «Нарезка», этап 1: из слов подкаста — реплики, окна для ИИ, разбор ответа и точные границы клипов.
 * Всё чистые функции без сети и файлов. ИИ выбирает клип номерами реплик, а не секундами:
 * тогда границы всегда попадают на паузу или конец фразы, а точное время считаем сами по словам.
 */
import type { Word } from './types.ts'

export interface Segment {
  id: number
  /** индексы первого и последнего слова (включительно) в массиве слов */
  first: number
  last: number
  start: number
  end: number
  text: string
}

export interface SegmentOpts {
  /** пауза между словами, на которой реплика рвётся всегда, с */
  gap: number
  /** пауза после слова с точкой/?/!, на которой реплика рвётся, с */
  sentenceGap: number
  /** реплика не длиннее стольких слов (рвём по самой длинной паузе во второй половине) */
  maxWords: number
}

export const SEG_DEFAULTS: SegmentOpts = { gap: 0.9, sentenceGap: 0.1, maxWords: 45 }

const SENT_END = /[.!?…]["»”)\]]*$/
const round3 = (x: number): number => Math.round(x * 1000) / 1000

export function buildSegments(words: Word[], o: SegmentOpts = SEG_DEFAULTS): Segment[] {
  const segs: Segment[] = []
  const push = (first: number, last: number): void => {
    segs.push({
      id: segs.length,
      first,
      last,
      start: words[first].start,
      end: words[last].end,
      text: words
        .slice(first, last + 1)
        .map((w) => w.text)
        .join(' ')
    })
  }
  const gapAfter = (i: number): number => (words[i + 1] ? words[i + 1].start - words[i].end : Infinity)

  let first = 0
  for (let i = 0; i < words.length; i++) {
    const gap = gapAfter(i)
    let cut = gap >= o.gap || (SENT_END.test(words[i].text) && gap >= o.sentenceGap)
    if (!cut && i - first + 1 >= o.maxWords) {
      // принудительный разрез по самой длинной паузе во второй половине набранного
      let best = i
      for (let k = first + Math.floor(o.maxWords / 2); k <= i; k++) if (gapAfter(k) > gapAfter(best)) best = k
      push(first, best)
      first = best + 1
      i = best
      continue
    }
    if (cut) {
      push(first, i)
      first = i + 1
    }
  }
  return segs
}

export const mmss = (t: number): string => {
  const s = Math.max(0, Math.round(t))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const mm = String(m).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export const segmentLine = (s: Segment): string => `[S${s.id} ${mmss(s.start)}-${mmss(s.end)}] ${s.text}`

export interface TextWindow {
  index: number
  firstSeg: number
  lastSeg: number
  text: string
  chars: number
}

export interface WindowOpts {
  /** размер окна в символах транскрипта */
  maxChars: number
  /** на сколько символов соседние окна перекрываются */
  overlapChars: number
}

export const WINDOW_DEFAULTS: WindowOpts = { maxChars: 60_000, overlapChars: 4_000 }

/** Режет реплики на окна, чтобы длинный подкаст влезал в один запрос. Соседние окна перекрываются. */
export function buildWindows(segs: Segment[], o: WindowOpts = WINDOW_DEFAULTS): TextWindow[] {
  if (segs.length === 0) return []
  const lines = segs.map(segmentLine)
  const out: TextWindow[] = []
  let from = 0
  while (from < segs.length) {
    let to = from
    let chars = lines[from].length
    while (to + 1 < segs.length && chars + 1 + lines[to + 1].length <= o.maxChars) {
      to++
      chars += 1 + lines[to].length
    }
    out.push({ index: out.length, firstSeg: from, lastSeg: to, text: lines.slice(from, to + 1).join('\n'), chars })
    if (to >= segs.length - 1) break
    // следующее окно начинается так, чтобы перекрытие не превышало overlapChars; строго правее начала текущего
    let next = to + 1
    let acc = 0
    for (let k = to; k > from; k--) {
      acc += lines[k].length + 1
      if (acc > o.overlapChars) break
      next = k
    }
    from = next
  }
  return out
}

/** Грубая оценка токенов русского текста: ~2.6 символа на токен. Это оценка, не точный подсчёт. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 2.6)

export interface RawClip {
  startSeg: number
  endSeg: number
  /** первые слова клипа дословно из текста (ИИ цитирует их, а мы ищем точное место) */
  startWords: string
  /** последние слова клипа */
  endWords: string
  score: number
  title: string
  reason: string
  description: string
  hashtags: string[]
  /** реплика, в которой уместна рекламная вставка, и слова, после которых её ставить */
  overlaySeg: number | null
  overlayWords: string
}

const clip = (s: unknown, max: number): string => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').slice(0, max) : '')
const quote = (s: unknown): string => clip(Array.isArray(s) ? s.filter((x) => typeof x === 'string').join(' ') : s, 200)
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x)
const asInt = (x: unknown): number | null => {
  if (isInt(x)) return x
  if (typeof x === 'string' && /^\s*\d+\s*$/.test(x)) return Number(x)
  return null
}

function extractJson(text: string): unknown {
  const t = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)
  const body = fenced ? fenced[1] : t
  const a = body.indexOf('{')
  const b = body.lastIndexOf('}')
  const arr0 = body.indexOf('[')
  const arr1 = body.lastIndexOf(']')
  const useArray = arr0 !== -1 && (a === -1 || arr0 < a)
  const slice = useArray ? body.slice(arr0, arr1 + 1) : a !== -1 ? body.slice(a, b + 1) : ''
  if (!slice) throw new Error('В ответе ИИ нет JSON')
  return JSON.parse(slice)
}

/** Разбор ответа ИИ. Бросает, если JSON не разобрался (вызывающий повторит запрос); битые клипы молча отбрасывает. */
export function parseClips(text: string, lo: number, hi: number): RawClip[] {
  const root = extractJson(text)
  const list = Array.isArray(root) ? root : (root as { clips?: unknown }).clips
  if (!Array.isArray(list)) throw new Error('В JSON нет списка clips')
  const out: RawClip[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const a = asInt(r.start_segment)
    const b = asInt(r.end_segment)
    if (a === null || b === null || a < lo || b > hi || a > b) continue
    const score = typeof r.score === 'number' && Number.isFinite(r.score) ? Math.min(10, Math.max(0, r.score)) : 5
    const tags = Array.isArray(r.hashtags) ? r.hashtags : []
    const hashtags = [
      ...new Set(
        tags
          .filter((x): x is string => typeof x === 'string')
          .map((x) => x.replace(/[#\s]+/g, '').slice(0, 30))
          .filter(Boolean)
          .map((x) => `#${x}`)
      )
    ].slice(0, 8)
    let overlaySeg = asInt(r.overlay_after_segment)
    if (overlaySeg !== null && (overlaySeg < a || overlaySeg > b)) overlaySeg = null
    out.push({
      startSeg: a,
      endSeg: b,
      startWords: quote(r.start_words),
      endWords: quote(r.end_words),
      score,
      title: clip(r.title, 80),
      reason: clip(r.reason, 300),
      description: clip(r.description, 400),
      hashtags,
      overlaySeg,
      overlayWords: overlaySeg === null ? '' : quote(r.overlay_after_words)
    })
  }
  return out
}

/** Слово для сравнения: без регистра, ё=е, только буквы и цифры. */
export const normWord = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '')

function lev1(a: string, b: string): boolean {
  // расстояние Левенштейна не больше 1
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i)
}

/**
 * Похожесть слова цитаты на слово расшифровки (0 — разные): точное 1, общий корень 0.8, опечатка 0.6.
 * Поправка на ошибки распознавания и на то, что ИИ мог чуть переписать слово.
 */
function similar(q: string, w: string): number {
  if (q === w) return 1
  if (q.length >= 4 && w.length >= 4 && (q.startsWith(w) || w.startsWith(q))) return 0.8
  return q.length >= 5 && w.length >= 5 && lev1(q, w) ? 0.6 : 0
}

export interface QuoteMatch {
  /** индексы первого и последнего совпавшего слова расшифровки */
  first: number
  last: number
  matched: number
}

/**
 * Ищет цитату в словах [from..to] (норм. формы). Допускает пропуск одного слова с любой стороны
 * и неточные слова. null — совпало меньше 60% слов цитаты.
 */
export function findQuote(norm: string[], from: number, to: number, text: string): QuoteMatch | null {
  const q = text.split(/\s+/).map(normWord).filter(Boolean).slice(0, 10)
  if (q.length === 0 || from > to) return null
  const need = Math.min(q.length, Math.max(2, Math.ceil(q.length * 0.6)))
  let best: QuoteMatch | null = null
  let bestScore = 0
  for (let p = Math.max(0, from); p <= to; p++) {
    for (const skip of [0, 1]) {
      if (skip >= q.length) continue
      let j = skip
      let k = p
      let m = 0
      let score = 0
      let first = -1
      let last = -1
      while (j < q.length && k <= to) {
        const sim = similar(q[j], norm[k])
        if (sim > 0) {
          if (first < 0) first = k
          last = k
          m++
          score += sim
          j++
          k++
        } else if (first < 0) {
          break
        } else if (k + 1 <= to && similar(q[j], norm[k + 1]) > 0) {
          k++ // лишнее слово в расшифровке
        } else if (j + 1 < q.length && similar(q[j + 1], norm[k]) > 0) {
          j++ // лишнее слово в цитате
        } else {
          j++
          k++
        }
      }
      // при равенстве побеждает более раннее место: точные совпадения весят больше похожих
      if (first >= 0 && m >= need && score > bestScore + 1e-9) {
        best = { first, last, matched: m }
        bestScore = score
      }
    }
  }
  return best
}

export interface ClipCandidate {
  id: number
  /** секунды от начала файла, уже с запасом по краям */
  start: number
  end: number
  /** индексы слов, целиком входящих в клип */
  firstWord: number
  lastWord: number
  score: number
  title: string
  reason: string
  description: string
  hashtags: string[]
  /** секунда в файле, где уместна рекламная вставка (после конца мысли), или null */
  overlayAt: number | null
  /** цитату ИИ не нашли — граница взята по краю реплики и может резать фразу */
  approx: boolean
}

export interface FinalizeOpts {
  minDur: number
  maxDur: number
  /** насколько клип может выйти за лимиты длины, прежде чем его выбросим, с */
  durTolerance: number
  maxClips: number
  /** запас до первого слова и после последнего, с */
  leadPad: number
  tailPad: number
  /** клипы пересекаются не больше этой доли короткого из них */
  maxOverlap: number
  /** длина файла: конец клипа не выйдет за неё */
  mediaDuration?: number
}

export const FINALIZE_DEFAULTS: FinalizeOpts = {
  minDur: 15,
  maxDur: 60,
  durTolerance: 3,
  maxClips: 10,
  leadPad: 0.12,
  tailPad: 0.3,
  maxOverlap: 0.3
}

/** Сколько кандидатов отсеяно и почему — для отладки промпта и сравнения моделей. */
export interface FinalizeStats {
  tooLong: number
  tooShort: number
  broken: number
  overlap: number
  approx: number
}

/**
 * Превращает ответ ИИ в клипы с точными границами: находит процитированные первые и последние слова,
 * отсеивает клипы вне лимита длины, добавляет запас по краям, не заходя на соседние слова,
 * убирает пересечения и оставляет лучшие.
 */
export function finalizeClips(
  words: Word[],
  segs: Segment[],
  raws: RawClip[],
  opts: Partial<FinalizeOpts> = {},
  stats?: FinalizeStats
): ClipCandidate[] {
  const o = { ...FINALIZE_DEFAULTS, ...opts }
  const st: FinalizeStats = stats ?? { tooLong: 0, tooShort: 0, broken: 0, overlap: 0, approx: 0 }
  const norm = words.map((w) => normWord(w.text))
  const near = (seg: number): [number, number] => [segs[Math.max(0, seg - 1)].first, segs[Math.min(segs.length - 1, seg + 1)].last]
  const built: Omit<ClipCandidate, 'id'>[] = []

  for (const r of raws) {
    if (r.startSeg < 0 || r.endSeg >= segs.length || r.startSeg > r.endSeg) {
      st.broken++
      continue
    }
    const s = r.startWords ? findQuote(norm, ...near(r.startSeg), r.startWords) : null
    const e = r.endWords ? findQuote(norm, ...near(r.endSeg), r.endWords) : null
    const firstWord = s ? s.first : segs[r.startSeg].first
    const lastWord = e ? e.last : segs[r.endSeg].last
    if (lastWord <= firstWord) {
      st.broken++
      continue
    }
    const dur = words[lastWord].end - words[firstWord].start
    if (dur > o.maxDur + o.durTolerance) {
      st.tooLong++
      continue
    }
    if (dur < o.minDur - o.durTolerance) {
      st.tooShort++
      continue
    }

    const prev = words[firstWord - 1]
    const next = words[lastWord + 1]
    const start = round3(Math.max(prev ? prev.end + 0.02 : 0, words[firstWord].start - o.leadPad))
    let end = words[lastWord].end + o.tailPad
    if (next) end = Math.min(end, next.start - 0.02)
    if (o.mediaDuration !== undefined) end = Math.min(end, o.mediaDuration)
    end = round3(Math.max(end, words[lastWord].end))

    // вставка только по найденной цитате: по краю реплики она легла бы посреди фразы
    let overlayAt: number | null = null
    if (r.overlaySeg !== null && r.overlayWords) {
      const ov = findQuote(norm, ...near(r.overlaySeg), r.overlayWords)
      if (ov && ov.last > firstWord && ov.last < lastWord) overlayAt = round3(words[ov.last].end)
    }

    const approx = !s || !e
    if (approx) st.approx++
    built.push({
      start,
      end,
      firstWord,
      lastWord,
      score: r.score,
      title: r.title,
      reason: r.reason,
      description: r.description,
      hashtags: r.hashtags,
      overlayAt,
      approx
    })
  }

  // при равной оценке точные границы важнее приблизительных
  built.sort((a, b) => b.score - a.score || Number(a.approx) - Number(b.approx) || a.start - b.start)
  const kept: Omit<ClipCandidate, 'id'>[] = []
  for (const c of built) {
    const clash = kept.some((k) => {
      const inter = Math.min(k.end, c.end) - Math.max(k.start, c.start)
      return inter > o.maxOverlap * Math.min(k.end - k.start, c.end - c.start)
    })
    if (clash) st.overlap++
    else kept.push(c)
    if (kept.length >= o.maxClips) break
  }
  return kept.sort((a, b) => a.start - b.start).map((c, id) => ({ id, ...c }))
}
