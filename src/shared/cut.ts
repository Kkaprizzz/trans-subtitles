/**
 * Режим «Нарезка»: рамки-клипы на длинном видео. Чистые функции — модель клипа, операции над рамками
 * (сдвиг, края, привязка к словам), слова клипа во времени клипа, фильтры ffmpeg для кадра и имена файлов.
 */
import type { ClipCandidate } from './clips.ts'
import type { Word } from './types.ts'

/** crop — кадр обрезается до формата холста; fit-blur — видео целиком поверх размытой копии самого себя */
export type Framing = 'crop' | 'fit-blur'

export interface CutClip {
  id: string
  /** секунды исходника */
  start: number
  end: number
  title: string
  description: string
  hashtags: string[]
  reason: string
  /** оценка ИИ; null — рамку поставили вручную */
  score: number | null
  /** границы ИИ приблизительные (цитата не нашлась) */
  approx: boolean
  framing: Framing
  /** куда сдвинут кадр при обрезке: 0 — левый край исходника, 0.5 — центр, 1 — правый */
  offsetX: number
  /** место для рекламной вставки, секунды исходника (пригодится на этапе оверлеев) */
  overlayAt: number | null
  /** попадает ли клип в рендер папкой */
  enabled: boolean
}

/** Короче этого рамку не сделать: иначе её не схватить мышью и не посмотреть. */
export const MIN_CLIP = 1

const r3 = (x: number): number => Math.round(x * 1000) / 1000
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

let seq = 0
export const newClipId = (): string => `c${Date.now().toString(36)}${(seq++).toString(36)}`

export function makeClip(start: number, end: number, extra: Partial<CutClip> = {}): CutClip {
  return {
    id: newClipId(),
    start: r3(start),
    end: r3(end),
    title: '',
    description: '',
    hashtags: [],
    reason: '',
    score: null,
    approx: false,
    framing: 'crop',
    offsetX: 0.5,
    overlayAt: null,
    enabled: true,
    ...extra
  }
}

export function fromCandidates(cands: ClipCandidate[]): CutClip[] {
  return cands.map((c) =>
    makeClip(c.start, c.end, {
      title: c.title,
      description: c.description,
      hashtags: c.hashtags,
      reason: c.reason,
      score: c.score,
      approx: c.approx,
      overlayAt: c.overlayAt
    })
  )
}

/** Сдвиг всей рамки: длина сохраняется, рамка не выходит за файл. */
export function moveClip(c: CutClip, delta: number, duration: number): CutClip {
  const len = c.end - c.start
  const start = clamp(c.start + delta, 0, Math.max(0, duration - len))
  return { ...c, start: r3(start), end: r3(start + len) }
}

/** Перетаскивание края: край не заходит за другой ближе MIN_CLIP и не выходит за файл. */
export function resizeClip(c: CutClip, edge: 'start' | 'end', t: number, duration: number): CutClip {
  if (edge === 'start') return { ...c, start: r3(clamp(t, 0, c.end - MIN_CLIP)) }
  return { ...c, end: r3(clamp(t, c.start + MIN_CLIP, duration)) }
}

/**
 * Привязка к границе слова: начало клипа тянется к началам слов, конец — к концам.
 * tol — в секундах (на экране это несколько пикселей при текущем масштабе). Слова отсортированы.
 */
export function snapToWords(t: number, words: Word[], edge: 'start' | 'end', tol: number): number {
  if (words.length === 0 || tol <= 0) return t
  // бинарный поиск ближайшего слова
  let lo = 0
  let hi = words.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (words[mid].end < t) lo = mid + 1
    else hi = mid
  }
  let best = t
  let bestD = tol
  for (let i = Math.max(0, lo - 2); i <= Math.min(words.length - 1, lo + 2); i++) {
    const b = edge === 'start' ? words[i].start : words[i].end
    const d = Math.abs(b - t)
    if (d <= bestD) {
      best = b
      bestD = d
    }
  }
  return best
}

/**
 * Слова клипа во времени клипа (0 = начало клипа): берём слова, середина которых внутри рамки,
 * и обрезаем их по краям рамки. id — по порядку, как ждёт рендер подписей.
 */
export function clipWords(words: Word[], clip: { start: number; end: number }): Word[] {
  const dur = clip.end - clip.start
  const out: Word[] = []
  for (const w of words) {
    const mid = (w.start + w.end) / 2
    if (mid < clip.start || mid > clip.end) continue
    const start = clamp(w.start - clip.start, 0, dur)
    const end = clamp(w.end - clip.start, 0, dur)
    if (end - start < 0.02) continue
    out.push({ id: out.length, text: w.text, start: r3(start), end: r3(end) })
  }
  return out
}

/** Пересекаются ли рамки (для подсветки на таймлайне). */
export const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }): boolean =>
  a.start < b.end && b.start < a.end

const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)

/**
 * Цепочка ffmpeg-фильтров, которая из входа [0:v] делает кадр W×H и называет его [base].
 * crop: заполняем холст (масштаб с запасом) и режем со сдвигом offsetX по горизонтали.
 * fit-blur: фон — та же картинка, уменьшенная, размытая и растянутая; сверху видео целиком.
 */
export function framingFilter(framing: Framing, offsetX: number, W: number, H: number): string {
  const w = even(W)
  const h = even(H)
  const ox = clamp(offsetX, 0, 1).toFixed(4)
  if (framing === 'crop') {
    return `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(iw-ow)*${ox}:(ih-oh)/2,setsar=1[base]`
  }
  const bw = even(w / 4)
  const bh = even(h / 4)
  return (
    `[0:v]split=2[fbg][ffg];` +
    `[fbg]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=12:2,scale=${w}:${h},setsar=1[bg];` +
    `[ffg]scale=${w}:${h}:force_original_aspect_ratio=decrease,setsar=1[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`
  )
}

/** Часть имени файла из заголовка: кириллица остаётся, запрещённые в Windows/Linux символы убираются. */
export function slug(title: string, max = 60): string {
  const s = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, max)
    .trim()
  return s
}

export function clipFileBase(index: number, clip: CutClip): string {
  const n = String(index + 1).padStart(2, '0')
  const s = slug(clip.title)
  return s ? `${n} ${s}` : `${n} клип`
}

/** Текстовый файл рядом с роликом: заголовок, описание, хэштеги — для копипасты при заливке. */
export function clipText(clip: CutClip): string {
  return [clip.title, '', clip.description, '', clip.hashtags.join(' ')].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/** Проверка рамок из файла проекта: битые выбрасываем, поля приводим к типам. */
export function sanitizeClips(raw: unknown, duration?: number): CutClip[] {
  if (!Array.isArray(raw)) return []
  const out: CutClip[] = []
  const str = (x: unknown, max = 400): string => (typeof x === 'string' ? x.slice(0, max) : '')
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue
    const r = it as Record<string, unknown>
    const start = Number(r.start)
    const end = Number(r.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < MIN_CLIP / 2) continue
    if (duration !== undefined && start >= duration) continue
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id.slice(0, 40) : newClipId(),
      start: r3(start),
      end: r3(duration !== undefined ? Math.min(end, duration) : end),
      title: str(r.title, 120),
      description: str(r.description),
      hashtags: Array.isArray(r.hashtags) ? r.hashtags.filter((x): x is string => typeof x === 'string').slice(0, 12) : [],
      reason: str(r.reason),
      score: typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : null,
      approx: r.approx === true,
      framing: r.framing === 'fit-blur' ? 'fit-blur' : 'crop',
      offsetX: typeof r.offsetX === 'number' && Number.isFinite(r.offsetX) ? clamp(r.offsetX, 0, 1) : 0.5,
      overlayAt: typeof r.overlayAt === 'number' && Number.isFinite(r.overlayAt) ? r.overlayAt : null,
      enabled: r.enabled !== false
    })
  }
  return out.sort((a, b) => a.start - b.start)
}

// --- математика таймлайна ---

export interface TimelineView {
  /** время у левого края, с */
  start: number
  /** пикселей в секунде */
  pps: number
}

export const timeToX = (t: number, v: TimelineView): number => (t - v.start) * v.pps
export const xToTime = (x: number, v: TimelineView): number => v.start + x / v.pps

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]

/** Шаг подписей линейки: самый мелкий, при котором подписи не ближе minPx друг к другу. */
export function rulerStep(pps: number, minPx = 80): number {
  for (const s of STEPS) if (s * pps >= minPx) return s
  return STEPS[STEPS.length - 1]
}

/** Масштаб вокруг точки под курсором: время под курсором остаётся на месте. */
export function zoomAt(v: TimelineView, factor: number, x: number, minPps: number, maxPps: number): TimelineView {
  const pps = clamp(v.pps * factor, minPps, maxPps)
  const t = xToTime(x, v)
  return { pps, start: Math.max(0, t - x / pps) }
}
