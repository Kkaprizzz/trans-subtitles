/**
 * «Нарезка»: рамки-клипы (Clip из project.ts) — чистые операции. Рамка хранит отрезок файла (время исходника),
 * поэтому едет за видео; где она стоит на таймлайне, считает placement. Для экспорта проект обрезается под рамку
 * (cropProject), и дальше работает обычный экспорт таймлайна.
 */
import { itemEnd, itemTrackKind, mediaOf, MIN_CLIP, MIN_ITEM, srcToTl, tlToSrc, uid, type Clip, type Framing, type Item, type Project } from './project.ts'
import type { ClipCandidate } from './clips.ts'
import type { SubtitleStyle } from './timeline.ts'
import type { Word } from './types.ts'

export type { Clip, Framing }

const r3 = (x: number): number => Math.round(x * 1000) / 1000
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const sameFile = (a: Clip, b: Clip): boolean => a.mediaId === b.mediaId

export const DEFAULT_CLIP_LEN = 30

export function makeClip(mediaId: string, start: number, end: number, extra: Partial<Clip> = {}): Clip {
  return {
    id: uid('c'),
    mediaId,
    start: r3(start),
    end: r3(end),
    title: '',
    description: '',
    hashtags: [],
    reason: '',
    score: null,
    approx: false,
    note: '',
    framing: 'crop',
    offsetX: 0.5,
    enabled: true,
    ...extra
  }
}

export function fromCandidates(mediaId: string, cands: ClipCandidate[], notes: Record<number, string> = {}): Clip[] {
  return cands.map((c) =>
    makeClip(mediaId, c.start, c.end, {
      title: c.title,
      description: c.description,
      hashtags: c.hashtags,
      reason: c.reason,
      score: c.score,
      approx: c.approx,
      note: notes[c.id] ?? ''
    })
  )
}

// --- где рамка стоит на таймлайне ---

export interface Placement {
  /** секунды таймлайна */
  start: number
  end: number
  /** кусок, на котором лежит большая часть рамки */
  itemId: string
}

/** Куски файла, из которых рамка берёт картинку: звук, отделённый от видео, лежит на звуковой дорожке и не в счёт. */
function mediaItems(p: Project, mediaId: string): Item[] {
  const hasVideo = !!mediaOf(p, mediaId)?.hasVideo
  return p.items.filter((i) => i.kind === 'media' && i.mediaId === mediaId && (!hasVideo || itemTrackKind(p, i) === 'video'))
}

/**
 * Куски файла рамки, которых она касается. Если файл лежит на таймлайне несколькими отдельными местами,
 * берём то место (цепочку впритык лежащих кусков), где пересечение с рамкой больше всего.
 */
export function placement(p: Project, c: Clip): Placement | null {
  const hit = mediaItems(p, c.mediaId)
    .filter((i) => i.in < c.end - 1e-6 && i.out > c.start + 1e-6)
    .sort((a, b) => a.start - b.start)
  if (hit.length === 0) return null
  const overlap = (i: Item): number => Math.min(i.out, c.end) - Math.max(i.in, c.start)
  const chains: Item[][] = []
  for (const i of hit) {
    const last = chains[chains.length - 1]
    if (last && i.start <= itemEnd(last[last.length - 1]) + 0.05) last.push(i)
    else chains.push([i])
  }
  const best = chains.reduce((a, b) => (b.reduce((n, i) => n + overlap(i), 0) > a.reduce((n, i) => n + overlap(i), 0) ? b : a))
  const first = best[0]
  const last = best[best.length - 1]
  const start = srcToTl(first, Math.max(first.in, c.start))
  const end = srcToTl(last, Math.min(last.out, c.end))
  const main = best.reduce((a, b) => (overlap(b) > overlap(a) ? b : a))
  return { start: r3(start), end: r3(Math.max(start, end)), itemId: main.id }
}

/** Рамки в порядке на таймлайне (потом те, что без видео — по времени исходника). */
export function orderedClips(p: Project): Array<{ clip: Clip; at: Placement | null }> {
  return p.clips
    .map((clip) => ({ clip, at: placement(p, clip) }))
    .sort((a, b) => {
      if (a.at && b.at) return a.at.start - b.at.start || a.clip.start - b.clip.start
      if (a.at) return -1
      if (b.at) return 1
      return a.clip.start - b.clip.start
    })
}

/** Время таймлайна -> время исходника для файла: берём кусок, под которым точка, иначе ближайший по краю. */
export function sourceAt(p: Project, mediaId: string, t: number): number | null {
  const items = mediaItems(p, mediaId)
  if (items.length === 0) return null
  const under = items.find((i) => t >= i.start && t <= itemEnd(i))
  if (under) return r3(tlToSrc(under, t))
  const near = items.reduce((a, b) => (Math.abs(clampTo(t, b) - t) < Math.abs(clampTo(t, a) - t) ? b : a))
  return r3(tlToSrc(near, clampTo(t, near)))
}
const clampTo = (t: number, i: Item): number => clamp(t, i.start, itemEnd(i))

// --- операции над рамками ---

const fileDuration = (p: Project, mediaId: string): number => p.media.find((m) => m.id === mediaId)?.duration ?? 0

/** Границы свободного места вокруг точки t среди рамок того же файла (кроме except). */
function freeSpan(p: Project, mediaId: string, t: number, except?: string): [number, number] {
  let lo = 0
  let hi = fileDuration(p, mediaId)
  for (const c of p.clips) {
    if (c.mediaId !== mediaId || c.id === except) continue
    if (c.end <= t + 1e-6) lo = Math.max(lo, c.end)
    else if (c.start >= t - 1e-6) hi = Math.min(hi, c.start)
  }
  return [lo, hi]
}

/** Новая рамка вручную: len секунд от start, урезанная по соседям и по файлу. null — места нет. */
export function addClip(p: Project, mediaId: string, start: number, len = DEFAULT_CLIP_LEN, extra: Partial<Clip> = {}): { p: Project; id: string } | null {
  const dur = fileDuration(p, mediaId)
  if (dur <= 0) return null
  let s = clamp(start, 0, Math.max(0, dur - MIN_CLIP))
  // точка внутри чужой рамки — ставим сразу за ней
  const inside = p.clips.find((c) => c.mediaId === mediaId && s > c.start - 1e-6 && s < c.end - 1e-6)
  if (inside) s = inside.end
  const [, hi] = freeSpan(p, mediaId, s)
  const e = Math.min(s + len, hi, dur)
  if (e - s < MIN_CLIP) return null
  const c = makeClip(mediaId, s, e, extra)
  return { p: { ...p, clips: [...p.clips, c] }, id: c.id }
}

/** Края: не заходят за соседей и файл, длина не меньше MIN_CLIP. */
export function setClipEdge(p: Project, id: string, edge: 'start' | 'end', t: number): Project {
  const c = p.clips.find((x) => x.id === id)
  if (!c) return p
  const [lo, hi] = freeSpan(p, c.mediaId, (c.start + c.end) / 2, id)
  const next = edge === 'start' ? { ...c, start: r3(clamp(t, lo, c.end - MIN_CLIP)) } : { ...c, end: r3(clamp(t, c.start + MIN_CLIP, hi)) }
  return { ...p, clips: p.clips.map((x) => (x.id === id ? next : x)) }
}

/** Сдвиг всей рамки: длина та же, упирается в соседей и файл. */
export function moveClipBy(p: Project, id: string, delta: number): Project {
  const c = p.clips.find((x) => x.id === id)
  if (!c) return p
  const len = c.end - c.start
  const [lo, hi] = freeSpan(p, c.mediaId, (c.start + c.end) / 2, id)
  const start = clamp(c.start + delta, lo, Math.max(lo, hi - len))
  return { ...p, clips: p.clips.map((x) => (x.id === id ? { ...x, start: r3(start), end: r3(start + len) } : x)) }
}

export function patchClip(p: Project, id: string, patch: Partial<Pick<Clip, 'title' | 'description' | 'hashtags' | 'framing' | 'offsetX' | 'enabled' | 'note'>>): Project {
  const safe = { ...patch }
  if (safe.offsetX !== undefined) safe.offsetX = clamp(safe.offsetX, 0, 1)
  return { ...p, clips: p.clips.map((c) => (c.id === id ? { ...c, ...safe } : c)) }
}

export function deleteClip(p: Project, id: string): Project {
  return { ...p, clips: p.clips.filter((c) => c.id !== id) }
}

/**
 * Рамки от ИИ в проект. replace — сперва убрать все рамки этого файла; иначе добавить к текущим,
 * пропуская те, что пересекаются с уже стоящими (чтобы не плодить дубли).
 */
export function putClips(p: Project, mediaId: string, add: Clip[], replace: boolean): Project {
  const base = replace ? p.clips.filter((c) => c.mediaId !== mediaId) : p.clips
  const kept = [...base]
  for (const c of add) if (!kept.some((k) => sameFile(k, c) && c.start < k.end - 1e-6 && k.start < c.end - 1e-6)) kept.push(c)
  return { ...p, clips: kept.sort((a, b) => (a.mediaId === b.mediaId ? a.start - b.start : 0)) }
}

/**
 * Привязка к границе слова: начало тянется к началам слов, конец — к концам (tol — секунды).
 * Слова отсортированы.
 */
export function snapToWords(t: number, words: Word[], edge: 'start' | 'end', tol: number): number {
  if (words.length === 0 || tol <= 0) return t
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

// --- проект под рамку ---

/**
 * Оставляет в проекте только отрезок таймлайна [a, b] и сдвигает его к нулю: куски обрезаются по краям,
 * дальние отбрасываются, метки и рамки не нужны. Связь субтитров с видео сохраняется (обрезаются одинаково).
 */
export function cropProject(p: Project, a: number, b: number): Project {
  const items: Item[] = []
  for (const it of p.items) {
    const end = itemEnd(it)
    const s = Math.max(it.start, a)
    const e = Math.min(end, b)
    if (e - s < MIN_ITEM / 2) continue
    items.push({ ...it, start: r3(s - a), in: r3(tlToSrc(it, s)), out: r3(tlToSrc(it, e)) })
  }
  return { ...p, items, markers: [], clips: [] }
}

// --- кадр 9:16 ---

const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)

/**
 * Цепочка фильтров, превращающая вход label в кадр W×H для кусков файла рамки.
 * crop: заполняем кадр (масштаб с запасом) и режем со сдвигом offsetX по горизонтали.
 * fit-blur: фон — та же картинка, уменьшенная, размытая и растянутая; сверху видео целиком.
 */
export function framingChain(input: string, output: string, framing: Framing, offsetX: number, W: number, H: number, tag: string): string[] {
  const w = even(W)
  const h = even(H)
  if (framing === 'crop') {
    const ox = clamp(offsetX, 0, 1).toFixed(4)
    return [`[${input}]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(iw-ow)*${ox}:(ih-oh)/2,setsar=1[${output}]`]
  }
  const bw = even(w / 4)
  const bh = even(h / 4)
  return [
    `[${input}]split=2[bg${tag}][fg${tag}]`,
    `[bg${tag}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=12:2,scale=${w}:${h},setsar=1[bb${tag}]`,
    `[fg${tag}]scale=${w}:${h}:force_original_aspect_ratio=decrease,setsar=1[ff${tag}]`,
    `[bb${tag}][ff${tag}]overlay=(W-w)/2:(H-h)/2[${output}]`
  ]
}

/** Размер кадра клипа и стиль субтитров под него: тот же стиль, но блок уже и в нижней трети (мимо плашек соцсетей). */
export const CLIP_W = 1080
export const CLIP_H = 1920
export function clipSubtitleStyle(s: SubtitleStyle): SubtitleStyle {
  return { ...s, posY: 72, blockWidth: Math.min(s.blockWidth, 88) }
}

// --- имена и тексты ---

/** Часть имени файла из заголовка: кириллица остаётся, запрещённые символы убираются. */
export function slug(title: string, max = 60): string {
  return title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, max)
    .trim()
}

export function clipFileBase(index: number, clip: Clip): string {
  const n = String(index + 1).padStart(2, '0')
  const s = slug(clip.title)
  return s ? `${n} — ${s}` : `${n} — клип`
}

/** Текстовый файл рядом с роликом: заголовок, описание, хэштеги — для копипасты при заливке. */
export function clipText(clip: Clip): string {
  return [clip.title, '', clip.description, '', clip.hashtags.join(' ')].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
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
