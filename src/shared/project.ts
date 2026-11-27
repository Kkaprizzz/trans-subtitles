/**
 * Модель проекта монтажки (формат v12).
 * Надпись — кусок вида 'text' на видеодорожке: mediaId пустой, in = 0, out = длина, параметры в plate. Фигура — так же, вид 'shape',
 * параметры в shape. Надпись и фигура вместе — «слои» (isLayer): рисуются приложением, а не берутся из файла.
 * Кадр куска (frame): масштаб, положение, кроп и прозрачность картинки; эффекты (effects) — список с параметрами, среди них
 * готовые анимации (появление, зум, выезд…). Ключевые кадры (keys): положение, масштаб, прозрачность по времени куска (anim.ts).
 * Стоп-кадр — кусок вида 'freeze': in — секунда файла, кадр которой показывается, out = in + длина; звука у него нет.
 * Скорость куска (speed, 0.25–4): на таймлайне он занимает (out − in) ÷ speed секунд; in/out — всегда секунды файла. Чистые функции: каждая операция возвращает новый проект (для отмены/повтора).
 *
 * Дорожки — массив сверху вниз: сначала видеодорожки (выше дорожка — выше слой в кадре), потом звуковые.
 * Все видеодорожки одинаковые: нет «основной» и нет авто-сдвига кусков. Кусок (Item) — отрезок in..out файла
 * (секунды исходника), start — где он стоит на таймлайне. Субтитры — тоже кусок (kind 'subs') на видеодорожке:
 * слова лежат у файла (во времени исходника), кусок показывает отрезок in..out. Кусок субтитров может быть
 * связан с видеокуском (link): тогда он повторяет его границы и едет, режется и удаляется вместе с ним.
 * Метки — флажки на дорожке для удобства, на результат не влияют.
 * Клипы «Нарезки» — рамки на отдельной строке сверху: привязаны к файлу и времени исходника (не к таймлайну),
 * поэтому едут за видео; где они стоят на таймлайне, считает cut.ts.
 */
import { cleanPoints, splitGain, type GainPoint } from './audio.ts'
import { clampKeys, cleanKeys, KEY_PROPS, noKeys, shiftKeys, sliceEffects, splitKeys, type Keys } from './anim.ts'
import { cleanEffects, isAnimType, type Effect } from './effects.ts'
import { FONTS } from './fonts.ts'
import { cleanFrame, DEFAULT_FRAME, type Frame } from './frame.ts'
import { cleanPlate, type Plate } from './plate.ts'
import { cleanFace, type FaceTrack } from './face.ts'
import { cleanShape, type Shape } from './shape.ts'
import * as E from './edit.ts'
import type { SubtitleStyle } from './timeline.ts'
import type { Word } from './types.ts'

export interface MediaRef {
  id: string
  path: string
  name: string
  duration: number
  hasVideo: boolean
  hasAudio: boolean
  width?: number
  height?: number
  fps?: number
  videoCodec?: string
  /** окно не покажет этот формат напрямую — для предпросмотра нужна копия */
  needsPreview: boolean
  /** в видео есть прозрачность (оверлеи) */
  hasAlpha?: boolean
}

export type TrackKind = 'video' | 'audio'

export interface Track {
  id: string
  kind: TrackKind
  /** заглушить звук дорожки */
  muted: boolean
  /** скрыть слой: картинка дорожки пропадает в предпросмотре и экспорте (звук остаётся) */
  hidden: boolean
  /** закрепить: кусками дорожки нельзя двигать, резать, тянуть и удалять */
  locked: boolean
}

export type ItemKind = 'media' | 'subs' | 'freeze' | 'text' | 'shape'

/** Надпись или фигура: картинку рисует приложение (mediaId пустой, in = 0, out = длина). */
export const isLayer = (it: { kind: ItemKind }): boolean => it.kind === 'text' || it.kind === 'shape'

export interface Item {
  id: string
  kind: ItemKind
  /** файл: для kind 'media' — что показываем, для 'subs' — чьи слова */
  mediaId: string
  trackId: string
  /** секунды таймлайна */
  start: number
  /** отрезок исходника, секунды */
  in: number
  out: number
  /** Звук куска прикреплён к нему и звучит вместе с ним. Отделили — у видеокуска false, а звук лежит отдельным куском на звуковой дорожке. */
  audio: boolean
  /** громкость куска без точек, 0..1 (1 — как в файле); с точками линия громкости главнее */
  /** скорость воспроизведения, 1 — как в файле; тон звука сохраняется */
  speed: number
  volume: number
  /** линия громкости: точки во времени ИСХОДНИКА, между ними линейно */
  gain: GainPoint[]
  /** эффекты картинки (блюр…), действуют на весь кусок */
  effects: Effect[]
  /** масштаб, положение, кроп и прозрачность картинки в кадре проекта */
  frame: Frame
  /** ключевые кадры положения, масштаба и прозрачности (время — секунды таймлайна от начала куска) */
  keys: Keys
  /** для kind 'text': параметры надписи; у остальных null */
  plate: Plate | null
  /** для kind 'shape': параметры фигуры; у остальных null */
  shape: Shape | null
  /** трек лица (время исходника): ключи X в вертикальном проекте и кроп клипа «Нарезки» едут за ним; null — не отслежено */
  face: FaceTrack | null
  /** для kind 'subs': id видеокуска, за которым едут субтитры; null — живут сами */
  link: string | null
}

/** crop — кадр обрезается до вертикали; fit-blur — видео целиком поверх размытой копии самого себя */
export type Framing = 'crop' | 'fit-blur'

/** Рамка клипа «Нарезки»: отрезок файла (секунды исходника) + тексты и способ кадрирования в 9:16. */
export interface Clip {
  id: string
  mediaId: string
  start: number
  end: number
  title: string
  description: string
  hashtags: string[]
  /** почему ИИ выбрал этот момент */
  reason: string
  /** оценка ИИ; null — рамку поставили вручную */
  score: number | null
  /** границы ИИ приблизительные (цитата не нашлась) */
  approx: boolean
  /** подсказка «холодного зрителя»: что может быть непонятно без контекста; пусто — всё в порядке */
  note: string
  framing: Framing
  /** куда сдвинут кадр при обрезке: 0 — левый край исходника, 0.5 — центр, 1 — правый */
  offsetX: number
  /** попадает ли клип в экспорт папкой */
  enabled: boolean
}

export const MARKER_COLORS = 6

export interface Marker {
  id: string
  trackId: string
  /** секунды таймлайна */
  t: number
  /** номер цвета 0..MARKER_COLORS-1 */
  color: number
  text: string
}

export type Range = [number, number]

export interface Canvas {
  w: number
  h: number
}

export interface Project {
  version: 12
  id: string
  name: string
  createdAt: string
  updatedAt: string
  /** размер кадра; null — ещё не задан (берётся у первого видео) */
  canvas: Canvas | null
  fps: number
  media: MediaRef[]
  tracks: Track[]
  items: Item[]
  markers: Marker[]
  /** слова по id файла, во времени исходника */
  words: Record<string, Word[]>
  /** какие отрезки файла уже распознаны (секунды исходника) — чтобы не распознавать дважды */
  covered: Record<string, Range[]>
  /** рамки «Нарезки», время исходника */
  clips: Clip[]
  style: SubtitleStyle | null
}

/** Короче этого кусок не сделать: его не схватить мышью. */
export const MIN_ITEM = 0.1
/** Короче этого рамку клипа не сделать: иначе её не схватить мышью и не посмотреть. */
export const MIN_CLIP = 1
/** «Новая дорожка»: при вставке/переносе туда заводится свежая дорожка нужного вида. */
export const NEW_TRACK = '__new__'

const r3 = (x: number): number => Math.round(x * 1000) / 1000
const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)

let seq = 0
export const uid = (p: string): string => `${p}${Date.now().toString(36)}${(seq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`

export const MIN_SPEED = 0.25
export const MAX_SPEED = 4
/** Длина куска на таймлайне, с: отрезок файла ÷ скорость. */
export const itemDur = (it: Item): number => (it.out - it.in) / it.speed
export const itemEnd = (it: Item): number => it.start + itemDur(it)
/** Время таймлайна -> секунды файла для куска. */
export const tlToSrc = (it: Item, t: number): number => it.in + (t - it.start) * it.speed
/** Секунды файла -> время таймлайна для куска. */
export const srcToTl = (it: Item, s: number): number => it.start + (s - it.in) / it.speed

const newTrack = (kind: TrackKind): Track => ({ id: uid('t'), kind, muted: false, hidden: false, locked: false })

export function newProject(name: string, now = new Date().toISOString()): Project {
  return {
    version: 12,
    id: uid('p'),
    name,
    createdAt: now,
    updatedAt: now,
    canvas: null,
    fps: 30,
    media: [],
    tracks: [newTrack('video'), newTrack('video'), newTrack('audio')],
    items: [],
    markers: [],
    words: {},
    covered: {},
    clips: [],
    style: null
  }
}

export const trackOf = (p: Project, id: string): Track | undefined => p.tracks.find((t) => t.id === id)
export const trackIndex = (p: Project, id: string): number => p.tracks.findIndex((t) => t.id === id)
export const mediaOf = (p: Project, id: string): MediaRef | undefined => p.media.find((m) => m.id === id)
export const itemsOn = (p: Project, trackId: string): Item[] =>
  p.items.filter((i) => i.trackId === trackId).sort((a, b) => a.start - b.start)
export const videoTracks = (p: Project): Track[] => p.tracks.filter((t) => t.kind === 'video')
export const audioTracks = (p: Project): Track[] => p.tracks.filter((t) => t.kind === 'audio')

/**
 * На какие дорожки годится кусок: картинка (видео и субтитры) — на видеодорожки, чистый звук — на звуковые.
 * Кусок, уже лежащий на дорожке, остаётся на дорожках её вида: звук, отделённый от видео, — звуковой кусок,
 * хотя файл видео. Новый (ещё без дорожки) — по файлу.
 */
export function itemTrackKind(p: Project, it: Item): TrackKind {
  if (it.kind === 'subs' || isLayer(it)) return 'video'
  const own = p.tracks.find((t) => t.id === it.trackId)
  if (own) return own.kind
  return mediaOf(p, it.mediaId)?.hasVideo ? 'video' : 'audio'
}

export function projectDuration(p: Project): number {
  let d = 0
  for (const it of p.items) d = Math.max(d, itemEnd(it))
  return r3(d)
}

/** Свободно ли место на дорожке (кроме кусков except). */
export function fits(p: Project, trackId: string, start: number, end: number, except?: string | string[]): boolean {
  const skip = Array.isArray(except) ? except : except ? [except] : []
  return !p.items.some((i) => i.trackId === trackId && !skip.includes(i.id) && start < itemEnd(i) - 1e-6 && i.start < end - 1e-6)
}

// --- дорожки ---

/** Видеодорожки всегда выше звуковых; порядок внутри групп сохраняется. */
function normalizeTracks(p: Project): Project {
  const sorted = [...p.tracks.filter((t) => t.kind === 'video'), ...p.tracks.filter((t) => t.kind === 'audio')]
  return sorted.every((t, i) => t === p.tracks[i]) ? p : { ...p, tracks: sorted }
}

/** Название дорожки: видео считаются снизу вверх («Видео 1» — самая нижняя), звуковые — сверху вниз. */
export function trackName(p: Project, id: string): string {
  const t = trackOf(p, id)
  if (!t) return ''
  const same = p.tracks.filter((x) => x.kind === t.kind)
  const i = same.findIndex((x) => x.id === id)
  return t.kind === 'video' ? `Видео ${same.length - i}` : `Звук ${i + 1}`
}

/** Новая дорожка: видео — над всеми видео (самый верхний слой), звук — под всеми звуковыми. */
export function addTrackOf(p: Project, kind: TrackKind): { p: Project; id: string } {
  const t = newTrack(kind)
  return { p: normalizeTracks({ ...p, tracks: kind === 'video' ? [t, ...p.tracks] : [...p.tracks, t] }), id: t.id }
}

/** Удалить можно только пустую дорожку; одна видео- и одна звуковая остаются всегда. */
export function removeTrack(p: Project, id: string): Project {
  const t = trackOf(p, id)
  if (!t || p.items.some((i) => i.trackId === id)) return p
  if (p.tracks.filter((x) => x.kind === t.kind).length <= 1) return p
  return { ...p, tracks: p.tracks.filter((x) => x.id !== id), markers: p.markers.filter((m) => m.trackId !== id) }
}

/**
 * Удаляет дорожки вместе с их кусками (и связанными субтитрами) и метками. Закреплённые дорожки не трогаем. Одна видео- и одна
 * звуковая дорожки остаются всегда: если выбраны все дорожки вида, самая нижняя из них не исчезает, а очищается.
 */
export function deleteTracks(p: Project, ids: string[]): Project {
  const want = new Set(ids.filter((id) => {
    const t = trackOf(p, id)
    return !!t && !t.locked
  }))
  if (want.size === 0) return p
  const drop = new Set<string>()
  for (const kind of ['video', 'audio'] as const) {
    const list = p.tracks.filter((t) => t.kind === kind)
    const picked = list.filter((t) => want.has(t.id))
    if (picked.length === 0) continue
    const keep = picked.length === list.length ? (kind === 'video' ? list[list.length - 1] : list[0]) : undefined
    for (const t of picked) if (t !== keep) drop.add(t.id)
  }
  const gone = new Set(p.items.filter((i) => want.has(i.trackId)).map((i) => i.id))
  for (const s of p.items) if (s.kind === 'subs' && s.link && gone.has(s.link)) gone.add(s.id)
  return finish({
    ...p,
    tracks: p.tracks.filter((t) => !drop.has(t.id)),
    items: p.items.filter((i) => !gone.has(i.id) && !drop.has(i.trackId)),
    markers: p.markers.filter((m) => !want.has(m.trackId))
  })
}

export function setTrack(p: Project, id: string, patch: Partial<Pick<Track, 'muted' | 'hidden' | 'locked'>>): Project {
  return { ...p, tracks: p.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }
}

/**
 * Ищем место для куска: сначала желаемая дорожка, затем ближайшие выше (в пределах вида), иначе заводим новую.
 * Закреплённые дорожки не годятся. prefer по умолчанию: видео — самая нижняя, звук — первая звуковая.
 */
export function placeFree(p: Project, kind: TrackKind, start: number, end: number, prefer?: string, except?: string[]): { p: Project; id: string } {
  const list = p.tracks.filter((t) => t.kind === kind)
  let from = prefer ? list.findIndex((t) => t.id === prefer) : -1
  if (from < 0) from = kind === 'video' ? list.length - 1 : 0
  for (let i = from; i >= 0; i--) {
    if (!list[i].locked && fits(p, list[i].id, start, end, except)) return { p, id: list[i].id }
  }
  return addTrackOf(p, kind)
}

/** Ключи не выходят за длину своего куска: лишние убираются, на краю остаётся ключ с тем же значением линии. */
function fitKeys(p: Project): Project {
  let changed = false
  const items = p.items.map((it) => {
    const len = itemDur(it)
    let keys = it.keys
    for (const k of KEY_PROPS) {
      const c = clampKeys(it.keys[k], len)
      if (c !== it.keys[k]) {
        if (keys === it.keys) keys = { ...it.keys }
        keys[k] = c
      }
    }
    if (keys === it.keys) return it
    changed = true
    return { ...it, keys }
  })
  return changed ? { ...p, items } : p
}

/**
 * Приводит проект в порядок после любой правки: видеодорожки над звуковыми, а связанные субтитры
 * повторяют границы своего видео (нет видео — нет и субтитров). Если на дорожке субтитров стало тесно, они переезжают.
 */
export function finish(p0: Project): Project {
  let p = normalizeTracks(fitKeys(p0))
  const byId = new Map(p.items.map((i) => [i.id, i]))
  const stale: Item[] = []
  const dropped = new Set<string>()
  for (const it of p.items) {
    if (it.kind !== 'subs' || !it.link) continue
    const v = byId.get(it.link)
    if (!v || v.kind !== 'media') {
      dropped.add(it.id)
      continue
    }
    if (it.mediaId !== v.mediaId || it.start !== v.start || it.in !== v.in || it.out !== v.out || it.speed !== v.speed) stale.push(it)
  }
  if (dropped.size === 0 && stale.length === 0) return p
  p = { ...p, items: p.items.filter((i) => !dropped.has(i.id)) }
  for (const it of stale) {
    const v = byId.get(it.link as string) as Item
    const synced: Item = { ...it, mediaId: v.mediaId, start: v.start, in: v.in, out: v.out, speed: v.speed }
    const end = itemEnd(synced)
    const rest = { ...p, items: p.items.filter((i) => i.id !== it.id) }
    const placed = fits(rest, it.trackId, synced.start, end) ? { p: rest, id: it.trackId } : placeFree(rest, 'video', synced.start, end, it.trackId)
    p = { ...placed.p, items: [...placed.p.items, { ...synced, trackId: placed.id }] }
  }
  return normalizeTracks(p)
}

// --- файлы и вставка ---

export function addMedia(p: Project, m: Omit<MediaRef, 'id'> & { id?: string }): { p: Project; id: string } {
  const have = p.media.find((x) => x.path === m.path)
  if (have) return { p, id: have.id }
  const ref: MediaRef = { ...m, id: m.id ?? uid('m') }
  let next: Project = { ...p, media: [...p.media, ref] }
  // кадр и fps проекта — по первому видео
  if (!next.canvas && ref.hasVideo && ref.width && ref.height) {
    next = { ...next, canvas: { w: even(ref.width), h: even(ref.height) }, fps: ref.fps && ref.fps >= 1 ? Math.round(ref.fps * 1000) / 1000 : 30 }
  }
  return { p: next, id: ref.id }
}

/**
 * Кладёт файл на таймлайн в точку at. trackId — желаемая дорожка (NEW_TRACK — новая); не подошла или занята —
 * ближайшая свободная выше или новая.
 */
export function insertMedia(p: Project, mediaId: string, at: number, trackId?: string): { p: Project; id: string } {
  const m = mediaOf(p, mediaId)
  if (!m || m.duration < MIN_ITEM) return { p, id: '' }
  const kind: TrackKind = m.hasVideo ? 'video' : 'audio'
  const it: Item = { id: uid('i'), kind: 'media', mediaId, trackId: '', start: Math.max(0, r3(at)), in: 0, out: r3(m.duration), audio: m.hasAudio, speed: 1, volume: 1, gain: [], effects: [], frame: { ...DEFAULT_FRAME }, keys: noKeys(), plate: null, shape: null, face: null, link: null }
  const end = it.start + m.duration
  let placed: { p: Project; id: string }
  if (trackId === NEW_TRACK) placed = addTrackOf(p, kind)
  else {
    const target = trackId ? trackOf(p, trackId) : undefined
    placed = placeFree(p, kind, it.start, end, target && target.kind === kind && !target.locked ? target.id : undefined)
  }
  return { p: finish({ ...placed.p, items: [...placed.p.items, { ...it, trackId: placed.id }] }), id: it.id }
}

// --- правка кусков ---

const lockedItem = (p: Project, it: Item): boolean => !!trackOf(p, it.trackId)?.locked
/** Прямое действие над связанным куском субтитров разрывает связь. */
const unlinked = (it: Item): Item => (it.kind === 'subs' && it.link ? { ...it, link: null } : it)

/** Перенос куска на дорожку trackId в точку start; занято — на ближайшую свободную выше или новую. */
export function moveItem(p: Project, id: string, trackId: string, start: number): Project {
  const it0 = p.items.find((i) => i.id === id)
  if (!it0 || lockedItem(p, it0)) return p
  const kind = itemTrackKind(p, it0)
  start = Math.max(0, r3(start))
  const it = unlinked(it0)
  const end = start + itemDur(it)
  const rest: Project = { ...p, items: p.items.filter((i) => i.id !== id) }
  let placed: { p: Project; id: string }
  if (trackId === NEW_TRACK) placed = addTrackOf(rest, kind)
  else {
    const target = trackOf(rest, trackId)
    if (!target || target.kind !== kind || target.locked) return p
    placed = fits(rest, target.id, start, end) ? { p: rest, id: target.id } : placeFree(rest, kind, start, end, target.id)
  }
  return finish({ ...placed.p, items: [...placed.p.items, { ...it, trackId: placed.id, start }] })
}

/**
 * Перетаскивание края куска в точку t таймлайна. Левый край меняет in и start, правый — out.
 * Край не выходит за файл, за другой край ближе MIN_ITEM и за соседей по дорожке.
 */
export function trimItem(p: Project, id: string, edge: 'start' | 'end', t: number): Project {
  const it0 = p.items.find((i) => i.id === id)
  // длину стоп-кадра меняет setFreezeLength (правая часть дорожки двигается вместе с ней)
  if (!it0 || it0.kind === 'freeze' || lockedItem(p, it0)) return p
  const it = unlinked(it0)
  const dur = mediaOf(p, it.mediaId)?.duration ?? it.out
  const neighbors = itemsOn(p, it.trackId).filter((x) => x.id !== id)
  let next: Item
  // надпись и фигура не привязаны к файлу: края свободны, длина = out
  if (isLayer(it)) {
    if (edge === 'start') {
      const prev = neighbors.filter((x) => itemEnd(x) <= it.start + 1e-6).pop()
      const lo = prev ? itemEnd(prev) : 0
      const nt = Math.min(itemEnd(it) - MIN_ITEM, Math.max(lo, t))
      next = { ...it, start: r3(nt), out: r3(itemEnd(it) - nt), keys: shiftAll(it.keys, nt - it.start) }
    } else {
      const nxt = neighbors.find((x) => x.start >= itemEnd(it) - 1e-6)
      const nt = Math.min(nxt ? nxt.start : Infinity, 3600 + it.start, Math.max(it.start + MIN_ITEM, t))
      next = { ...it, out: r3(nt - it.start) }
    }
    return finish({ ...p, items: p.items.map((x) => (x.id === id ? next : x)) })
  }
  if (edge === 'start') {
    let lo = Math.max(0, it.start - it.in / it.speed)
    const prev = neighbors.filter((x) => itemEnd(x) <= it.start + 1e-6).pop()
    if (prev) lo = Math.max(lo, itemEnd(prev))
    const hi = itemEnd(it) - MIN_ITEM
    const nt = Math.min(hi, Math.max(lo, t))
    next = { ...it, in: r3(tlToSrc(it, nt)), start: r3(nt), keys: shiftAll(it.keys, nt - it.start) }
  } else {
    let hi = it.start + (dur - it.in) / it.speed
    const nxt = neighbors.find((x) => x.start >= itemEnd(it) - 1e-6)
    if (nxt) hi = Math.min(hi, nxt.start)
    const nt = Math.min(hi, Math.max(it.start + MIN_ITEM, t))
    next = { ...it, out: r3(tlToSrc(it, nt)) }
  }
  return finish({ ...p, items: p.items.map((x) => (x.id === id ? next : x)) })
}

/** Сдвиг всех линий ключей при подрезке левого края на delta секунд. */
export function shiftAll(keys: Keys, delta: number): Keys {
  const out = noKeys()
  for (const k of KEY_PROPS) out[k] = shiftKeys(keys[k], delta)
  return out
}

/** Эффекты половин при резке в точке c (секунды от начала куска длиной len): анимации продолжаются без скачка, ненужные уходят. */
function splitEffects(effects: Effect[], len: number, c: number): { left: Effect[]; right: Effect[] } {
  return { left: sliceEffects(effects, len, 0, c), right: sliceEffects(effects, len, c, len) }
}

/** Разрезает кусок в точке t таймлайна; правая часть получает новый id. Связанные субтитры режутся вместе с видео. */
export function splitItem(p: Project, id: string, t: number): { p: Project; id: string } {
  const it0 = p.items.find((i) => i.id === id)
  if (!it0 || lockedItem(p, it0) || t <= it0.start + MIN_ITEM || t >= itemEnd(it0) - MIN_ITEM) return { p, id: '' }
  const it = unlinked(it0)
  const cut = r3(tlToSrc(it, t))
  // надпись и фигура делятся по длине: параметры те же у обеих половин
  if (isLayer(it)) {
    const k = splitKeys(it.keys, t - it.start)
    const fx = splitEffects(it.effects, itemDur(it), t - it.start)
    const l: Item = { ...it, out: r3(t - it.start), keys: k.left, effects: fx.left }
    const r: Item = { ...it, id: uid('i'), start: r3(t), out: r3(itemEnd(it) - t), keys: k.right, effects: fx.right }
    return { p: finish({ ...p, items: [...p.items.filter((x) => x.id !== id), l, r] }), id: r.id }
  }
  // стоп-кадр делится по длине: кадр (in) у обеих половин тот же
  if (it.kind === 'freeze') {
    const k = splitKeys(it.keys, t - it.start)
    const fx = splitEffects(it.effects, itemDur(it), t - it.start)
    const l: Item = { ...it, out: r3(it.in + (t - it.start)), keys: k.left, effects: fx.left }
    const r: Item = { ...it, id: uid('i'), start: r3(t), out: r3(it.in + (itemEnd(it) - t)), keys: k.right, effects: fx.right }
    return { p: finish({ ...p, items: [...p.items.filter((x) => x.id !== id), l, r] }), id: r.id }
  }
  const g = splitGain(it.gain, it.volume, cut)
  const k = splitKeys(it.keys, t - it.start)
  const fx = splitEffects(it.effects, itemDur(it), t - it.start)
  const left: Item = { ...it, out: cut, gain: g.left, keys: k.left, effects: fx.left }
  const right: Item = { ...it, id: uid('i'), start: r3(t), in: cut, gain: g.right, keys: k.right, effects: fx.right }
  // правая половина субтитров, связанных с этим видео, привязывается к правой половине видео
  const rightSubs: Item[] =
    it.kind === 'media'
      ? p.items.filter((s) => s.kind === 'subs' && s.link === id).map((s) => ({ ...s, id: uid('i'), link: right.id }))
      : []
  const items = [...p.items.filter((x) => x.id !== id), left, right, ...rightSubs]
  return { p: finish({ ...p, items }), id: right.id }
}

/** Разрезает все куски под курсором (как S в CapCut без выделения) или только выбранные. */
export function splitAt(p: Project, t: number, onlyIds?: string[]): Project {
  let next = p
  for (const it of p.items) {
    if (onlyIds && !onlyIds.includes(it.id)) continue
    if (t > it.start + MIN_ITEM && t < itemEnd(it) - MIN_ITEM) next = splitItem(next, it.id, t).p
  }
  return next
}

/**
 * Удаляет куски (кроме лежащих на закреплённых дорожках) вместе со связанными субтитрами.
 * ripple — закрыть дыру: всё правее удалённого на той же дорожке сдвигается влево.
 */
export function deleteItems(p: Project, ids: string[], ripple = false): Project {
  const direct = p.items.filter((i) => ids.includes(i.id) && !lockedItem(p, i))
  if (direct.length === 0) return p
  const gone = new Set(direct.map((i) => i.id))
  for (const s of p.items) if (s.kind === 'subs' && s.link && gone.has(s.link)) gone.add(s.id)
  let items = p.items.filter((i) => !gone.has(i.id))
  let markers = p.markers
  if (ripple) {
    const byTrack = new Map<string, Range[]>()
    for (const it of direct) byTrack.set(it.trackId, [...(byTrack.get(it.trackId) ?? []), [it.start, itemEnd(it)]])
    const shift = (trackId: string, t: number): number => {
      let d = 0
      for (const [a, b] of mergeRanges(byTrack.get(trackId) ?? [])) if (t >= b - 1e-9) d += b - a
      return d
    }
    items = items.map((i) => (byTrack.has(i.trackId) ? { ...i, start: r3(Math.max(0, i.start - shift(i.trackId, i.start))) } : i))
    markers = markers.map((m) => (byTrack.has(m.trackId) ? { ...m, t: r3(Math.max(0, m.t - shift(m.trackId, m.t))) } : m))
  }
  return finish({ ...p, items, markers })
}

/** Убирает файл из проекта вместе с его кусками (и субтитрами), словами и покрытием. */
export function removeMedia(p: Project, mediaId: string): Project {
  const words = { ...p.words }
  delete words[mediaId]
  const covered = { ...p.covered }
  delete covered[mediaId]
  return finish({ ...p, media: p.media.filter((m) => m.id !== mediaId), items: p.items.filter((i) => i.mediaId !== mediaId), clips: p.clips.filter((c) => c.mediaId !== mediaId), words, covered })
}

/** Разорвать связь субтитров с видео: дальше они живут сами. */
export function unlinkSubs(p: Project, subsId: string): Project {
  return { ...p, items: p.items.map((i) => (i.id === subsId && i.kind === 'subs' ? { ...i, link: null } : i)) }
}

/** Связанные с видеокуском субтитры. */
export const subsOf = (p: Project, itemId: string): Item[] => p.items.filter((i) => i.kind === 'subs' && i.link === itemId)

/**
 * Добавляет кусок субтитров к каждому из видеокусков (kind 'media'): связанный, на самой верхней свободной
 * видеодорожке (не хватает места — новая сверху). Тем, у кого субтитры уже есть, ничего не добавляется.
 */
export function addSubtitles(p: Project, itemIds: string[]): Project {
  let next = p
  const targets = p.items.filter((i) => itemIds.includes(i.id) && i.kind === 'media').sort((a, b) => a.start - b.start)
  for (const v of targets) {
    if (subsOf(next, v.id).length > 0) continue
    const top = videoTracks(next).find((t) => !t.locked)
    const placed = placeFree(next, 'video', v.start, itemEnd(v), top?.id)
    const s: Item = { id: uid('i'), kind: 'subs', mediaId: v.mediaId, trackId: placed.id, start: v.start, in: v.in, out: v.out, audio: false, speed: v.speed, volume: 1, gain: [], effects: [], frame: { ...DEFAULT_FRAME }, keys: noKeys(), plate: null, shape: null, face: null, link: v.id }
    next = { ...placed.p, items: [...placed.p.items, s] }
  }
  return finish(next)
}

/** Что показывается и звучит в момент t: куски по дорожкам, снизу вверх (порядок наложения). */
export function activeAt(p: Project, t: number): Item[] {
  const order = new Map(p.tracks.map((tr, i) => [tr.id, i]))
  return p.items
    .filter((i) => t >= i.start - 1e-6 && t < itemEnd(i) - 1e-6)
    .sort((a, b) => (order.get(b.trackId) ?? 0) - (order.get(a.trackId) ?? 0))
}

export const sourceTime = tlToSrc

// --- метки ---

const sortMarkers = (ms: Marker[]): Marker[] => [...ms].sort((a, b) => a.t - b.t)

export function addMarker(p: Project, trackId: string, t: number, color = 0, text = ''): { p: Project; id: string } {
  if (!trackOf(p, trackId)) return { p, id: '' }
  const m: Marker = { id: uid('k'), trackId, t: Math.max(0, r3(t)), color: Math.min(MARKER_COLORS - 1, Math.max(0, Math.floor(color))), text: text.slice(0, 80) }
  return { p: { ...p, markers: sortMarkers([...p.markers, m]) }, id: m.id }
}

export function moveMarker(p: Project, id: string, t: number): Project {
  return { ...p, markers: sortMarkers(p.markers.map((m) => (m.id === id ? { ...m, t: Math.max(0, r3(t)) } : m))) }
}

export function patchMarker(p: Project, id: string, patch: Partial<Pick<Marker, 'color' | 'text'>>): Project {
  return {
    ...p,
    markers: p.markers.map((m) =>
      m.id === id
        ? {
            ...m,
            color: patch.color === undefined ? m.color : Math.min(MARKER_COLORS - 1, Math.max(0, Math.floor(patch.color))),
            text: patch.text === undefined ? m.text : patch.text.slice(0, 80)
          }
        : m
    )
  }
}

export function deleteMarker(p: Project, id: string): Project {
  return { ...p, markers: p.markers.filter((m) => m.id !== id) }
}

// --- слова субтитров на таймлайне ---

/** Слово на таймлайне вместе с «адресом» слова файла, из которого оно получено. */
export interface TlWord extends Word {
  mediaId: string
  /** кусок субтитров, который это слово показывает */
  itemId: string
  trackId: string
  /** индекс в p.words[mediaId] */
  idx: number
}

/** Куски субтитров на видимых дорожках. */
function visibleSubs(p: Project): Item[] {
  return p.items.filter((i) => i.kind === 'subs' && !trackOf(p, i.trackId)?.hidden)
}

function wordsOfItem(p: Project, it: Item): TlWord[] {
  const out: TlWord[] = []
  const ws = p.words[it.mediaId]
  if (!ws) return out
  const end = itemEnd(it)
  ws.forEach((w, idx) => {
    const mid = (w.start + w.end) / 2
    if (mid < it.in || mid >= it.out) return
    const s = Math.max(it.start, srcToTl(it, w.start))
    const e = Math.min(end, srcToTl(it, w.end))
    if (e - s < 0.02) return
    out.push({ id: 0, text: w.text, start: r3(s), end: r3(e), mediaId: it.mediaId, itemId: it.id, trackId: it.trackId, idx })
  })
  return out
}

/** Слова одного слоя (дорожки): по порядку, без наложений друг на друга. */
function layerWords(p: Project, items: Item[]): TlWord[] {
  const out = items.flatMap((it) => wordsOfItem(p, it)).sort((a, b) => a.start - b.start)
  for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].end) out[i - 1].end = Math.max(out[i - 1].start + 0.02, out[i].start)
  return out.map((w, id) => ({ ...w, id }))
}

export interface SubLayer {
  trackId: string
  /** слова слоя; id — номер внутри слоя */
  words: TlWord[]
  start: number
  end: number
}

/** Слои субтитров по дорожкам, сверху вниз (скрытые дорожки не входят). */
export function subtitleLayers(p: Project): SubLayer[] {
  const subs = visibleSubs(p)
  const out: SubLayer[] = []
  for (const t of p.tracks) {
    const items = subs.filter((i) => i.trackId === t.id)
    if (items.length === 0) continue
    const words = layerWords(p, items)
    if (words.length === 0) continue
    out.push({ trackId: t.id, words, start: Math.min(...items.map((i) => i.start)), end: Math.max(...items.map(itemEnd)) })
  }
  return out
}

/** Все слова субтитров списком по времени (для правки); id — номер в этом списке. */
export function timelineWordRefs(p: Project): TlWord[] {
  const all = subtitleLayers(p).flatMap((l) => l.words)
  return all.sort((a, b) => a.start - b.start).map((w, id) => ({ ...w, id }))
}

/** То же чистыми словами, без наложений между слоями (для общего файла «только субтитры»). */
export function timelineWords(p: Project): Word[] {
  const all = subtitleLayers(p).flatMap((l) => l.words).sort((a, b) => a.start - b.start)
  const out = all.map((w) => ({ ...w }))
  for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].end) out[i - 1].end = Math.max(out[i - 1].start + 0.02, out[i].start)
  return out.map((w, id) => ({ id, text: w.text, start: w.start, end: w.end }))
}

/**
 * Куски, к которым применяются субтитры: выделенные со звуком; без выделения — видео со звуком на самой нижней
 * видеодорожке, где что-то лежит (там обычно основной ролик).
 */
export function subsTargets(p: Project, selected: string[]): Item[] {
  const hasAudio = (i: Item): boolean => i.kind === 'media' && !!mediaOf(p, i.mediaId)?.hasAudio
  const sel = p.items.filter((i) => selected.includes(i.id) && hasAudio(i))
  if (sel.length > 0) return sel
  const vt = [...videoTracks(p)].reverse().find((t) => itemsOn(p, t.id).some(hasAudio))
  return vt ? itemsOn(p, vt.id).filter(hasAudio) : []
}

// --- распознавание: что уже распознано и что осталось ---

/** Склеивает пересекающиеся и ближе gap друг к другу отрезки. */
export function mergeRanges(rs: Range[], gap = 0): Range[] {
  const sorted = rs.filter((r) => r[1] > r[0]).map((r) => [r[0], r[1]] as Range).sort((a, b) => a[0] - b[0])
  const out: Range[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1] + gap) last[1] = Math.max(last[1], r[1])
    else out.push(r)
  }
  return out
}

/** Что останется от отрезков rs, если убрать cut. */
export function subtractRanges(rs: Range[], cut: Range[]): Range[] {
  const cuts = mergeRanges(cut)
  const out: Range[] = []
  for (const r of mergeRanges(rs)) {
    let from = r[0]
    for (const c of cuts) {
      if (c[1] <= from) continue
      if (c[0] >= r[1]) break
      if (c[0] > from) out.push([from, c[0]])
      from = Math.max(from, c[1])
    }
    if (from < r[1]) out.push([from, r[1]])
  }
  return out
}

export interface RecogJob {
  mediaId: string
  /** секунды исходника */
  from: number
  to: number
}

/** Какие отрезки файлов ещё нужно распознать, чтобы покрыть использованные части кусков (с запасом pad по краям). */
export function neededRanges(p: Project, items: Item[], pad = 1): RecogJob[] {
  const byMedia = new Map<string, Range[]>()
  for (const it of items) {
    const m = mediaOf(p, it.mediaId)
    if (!m) continue
    const r: Range = [Math.max(0, it.in - pad), Math.min(m.duration, it.out + pad)]
    byMedia.set(it.mediaId, [...(byMedia.get(it.mediaId) ?? []), r])
  }
  const jobs: RecogJob[] = []
  for (const [mediaId, rs] of byMedia) {
    // близкие отрезки распознаём одним куском: меньше запусков и нет разрывов слов на стыках
    const todo = subtractRanges(mergeRanges(rs, 2), p.covered[mediaId] ?? [])
    for (const [from, to] of mergeRanges(todo, 0.3)) if (to - from >= 0.3) jobs.push({ mediaId, from: r3(from), to: r3(to) })
  }
  return jobs
}

/** Кладёт результат распознавания отрезка [from, to] файла: старые слова с серединой в отрезке заменяются. */
export function applyRecognized(p: Project, mediaId: string, from: number, to: number, words: Word[]): Project {
  const old = (p.words[mediaId] ?? []).filter((w) => {
    const mid = (w.start + w.end) / 2
    return mid < from || mid >= to
  })
  const fresh = words.filter((w) => w.end > w.start).map((w) => ({ id: 0, text: w.text, start: r3(w.start), end: r3(w.end) }))
  const merged = [...old, ...fresh].sort((a, b) => a.start - b.start).map((w, id) => ({ ...w, id }))
  return {
    ...p,
    words: { ...p.words, [mediaId]: merged },
    covered: { ...p.covered, [mediaId]: mergeRanges([...(p.covered[mediaId] ?? []), [from, to]], 0.05) }
  }
}

// --- правка слов, показанных на таймлайне: пересчёт обратно в слова файла ---

const withMediaWords = (p: Project, mediaId: string, words: Word[]): Project => ({ ...p, words: { ...p.words, [mediaId]: words } })

export function editTlText(p: Project, w: TlWord, text: string): Project | null {
  const r = E.setText(p.words[w.mediaId] ?? [], w.idx, text)
  return r ? withMediaWords(p, w.mediaId, r.words) : null
}

export function deleteTlWord(p: Project, w: TlWord): Project | null {
  const r = E.deleteWord(p.words[w.mediaId] ?? [], w.idx)
  return r ? withMediaWords(p, w.mediaId, r.words) : null
}

export function mergeTlWord(p: Project, w: TlWord): Project | null {
  const r = E.mergeWithNext(p.words[w.mediaId] ?? [], w.idx)
  return r ? withMediaWords(p, w.mediaId, r.words) : null
}

/** Двигает начало/конец слова; время patch — таймлайна, внутри пересчитывается во время файла. */
export function setTlWordTiming(p: Project, w: TlWord, patch: { start?: number; end?: number }): Project | null {
  const it = p.items.find((i) => i.id === w.itemId)
  const m = mediaOf(p, w.mediaId)
  if (!it || !m) return null
  const toSrc = (t: number): number => tlToSrc(it, t)
  const next = E.setTiming(
    p.words[w.mediaId] ?? [],
    w.idx,
    { start: patch.start === undefined ? undefined : toSrc(patch.start), end: patch.end === undefined ? undefined : toSrc(patch.end) },
    m.duration
  )
  return next ? withMediaWords(p, w.mediaId, next) : null
}

/** Края кусков и ноль — точки привязки для перетаскивания. */
export function snapPoints(p: Project, exceptId?: string): number[] {
  const pts = new Set<number>([0])
  for (const it of p.items) {
    if (it.id === exceptId) continue
    pts.add(it.start)
    pts.add(r3(itemEnd(it)))
  }
  return [...pts].sort((a, b) => a - b)
}

export function snapTo(t: number, points: number[], tol: number): number {
  let best = t
  let d = tol
  for (const x of points) {
    const dd = Math.abs(x - t)
    if (dd <= d) {
      best = x
      d = dd
    }
  }
  return best
}


const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d)
const str = (x: unknown, d = ''): string => (typeof x === 'string' ? x : d)

const r4 = (x: number): number => Math.round(x * 1000) / 1000

/** Рамки из файла: битые выбрасываем, поля приводим к типам, границы — в пределах файла, без пересечений в одном файле. */
function sanitizeClips(raw: unknown, media: MediaRef[]): Clip[] {
  if (!Array.isArray(raw)) return []
  const dur = new Map(media.map((m) => [m.id, m.duration]))
  const text = (x: unknown, max: number): string => (typeof x === 'string' ? x.slice(0, max) : '')
  const out: Clip[] = []
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const c = x as Record<string, unknown>
    const d = dur.get(c.mediaId as string)
    if (d === undefined) continue
    const start = num(c.start, -1)
    const end = Math.min(d, num(c.end, -1))
    if (start < 0 || end - start < MIN_CLIP / 2) continue
    out.push({
      id: typeof c.id === 'string' && c.id ? c.id.slice(0, 40) : uid('c'),
      mediaId: c.mediaId as string,
      start: r4(start),
      end: r4(end),
      title: text(c.title, 120),
      description: text(c.description, 1000),
      hashtags: Array.isArray(c.hashtags) ? c.hashtags.filter((h): h is string => typeof h === 'string').slice(0, 12) : [],
      reason: text(c.reason, 400),
      score: typeof c.score === 'number' && Number.isFinite(c.score) ? c.score : null,
      approx: c.approx === true,
      note: text(c.note, 400),
      framing: c.framing === 'fit-blur' ? 'fit-blur' : 'crop',
      offsetX: Math.min(1, Math.max(0, num(c.offsetX, 0.5))),
      enabled: c.enabled !== false
    })
  }
  // рамки одного файла не пересекаются: нахлёст обрезаем по началу следующей
  out.sort((a, b) => (a.mediaId === b.mediaId ? a.start - b.start : a.mediaId < b.mediaId ? -1 : 1))
  const res: Clip[] = []
  for (const c of out) {
    const prev = res[res.length - 1]
    if (prev && prev.mediaId === c.mediaId && c.start < prev.end) {
      if (c.end - prev.end < MIN_CLIP / 2) continue
      res.push({ ...c, start: prev.end })
    } else res.push(c)
  }
  return res
}

/** Проверка проекта из файла: битое выбрасываем, инварианты восстанавливаем. Формат v3 (с «Основной» дорожкой) переносится. */
export function sanitizeProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const ver = typeof r.version === 'number' ? r.version : 0
  if (ver < 3 || ver > 12) return null
  const media: MediaRef[] = Array.isArray(r.media)
    ? (r.media as Array<Record<string, unknown>>)
        .filter((m) => m && typeof m.path === 'string' && typeof m.id === 'string' && num(m.duration, 0) > 0)
        .map((m) => ({
          id: m.id as string,
          path: m.path as string,
          name: str(m.name, (m.path as string).split(/[\\/]/).pop()),
          duration: num(m.duration, 0),
          hasVideo: m.hasVideo === true,
          hasAudio: m.hasAudio === true,
          width: typeof m.width === 'number' ? m.width : undefined,
          height: typeof m.height === 'number' ? m.height : undefined,
          fps: typeof m.fps === 'number' ? m.fps : undefined,
          videoCodec: typeof m.videoCodec === 'string' ? m.videoCodec : undefined,
          needsPreview: m.needsPreview === true,
          hasAlpha: m.hasAlpha === true ? true : undefined
        }))
    : []
  const mediaIds = new Set(media.map((m) => m.id))
  const mediaOf1 = (id: string): MediaRef | undefined => media.find((m) => m.id === id)
  let tracks: Track[] = Array.isArray(r.tracks)
    ? (r.tracks as Array<Record<string, unknown>>)
        .filter((t) => t && typeof t.id === 'string' && (t.kind === 'video' || t.kind === 'audio'))
        .map((t) => ({ id: t.id as string, kind: t.kind as TrackKind, muted: t.muted === true, hidden: t.kind === 'video' && t.hidden === true, locked: t.locked === true }))
    : []
  if (!tracks.some((t) => t.kind === 'video')) tracks.unshift(newTrack('video'))
  if (!tracks.some((t) => t.kind === 'audio')) tracks.push(newTrack('audio'))
  tracks = [...tracks.filter((t) => t.kind === 'video'), ...tracks.filter((t) => t.kind === 'audio')]
  const trackIds = new Set(tracks.map((t) => t.id))

  const legacySubs: string[] = []
  const items: Item[] = Array.isArray(r.items)
    ? (r.items as Array<Record<string, unknown>>)
        .filter((i) => i && typeof i.id === 'string' && (mediaIds.has(i.mediaId as string) || i.kind === 'text' || i.kind === 'shape') && trackIds.has(i.trackId as string))
        .map((i) => {
          const kind: ItemKind = i.kind === 'subs' ? 'subs' : i.kind === 'freeze' ? 'freeze' : i.kind === 'text' ? 'text' : i.kind === 'shape' ? 'shape' : 'media'
          const layer = kind === 'text' || kind === 'shape'
          // v3: у куска был флаг «показывать субтитры» — теперь это связанный кусок субтитров
          if (ver === 3 && i.subs === true) legacySubs.push(i.id as string)
          const media = mediaOf1(i.mediaId as string)
          return {
            id: i.id as string,
            kind,
            mediaId: layer ? '' : (i.mediaId as string),
            trackId: i.trackId as string,
            start: Math.max(0, num(i.start, 0)),
            in: layer ? 0 : Math.max(0, num(i.in, 0)),
            out: layer ? Math.min(3600, num(i.out, 0)) : num(i.out, 0),
            // до v6 звук всегда играл вместе с видео; у субтитров звука нет
            audio: kind === 'media' && !!media?.hasAudio && i.audio !== false,
            // у надписи — только анимации (без блюра и цвета) и «Кадр» без кропа
            effects: kind === 'subs' ? [] : layer ? cleanEffects(i.effects).filter((e) => isAnimType(e.type)) : cleanEffects(i.effects),
            frame: kind === 'subs' ? { ...DEFAULT_FRAME } : layer ? { ...cleanFrame(i.frame), cl: 0, cr: 0, ct: 0, cb: 0 } : cleanFrame(i.frame),
            keys: kind === 'subs' ? noKeys() : cleanKeys(i.keys),
            plate: kind === 'text' ? cleanPlate(i.plate, FONTS.map((f) => f.id)) : null,
            shape: kind === 'shape' ? cleanShape(i.shape) : null,
            face: kind === 'media' ? cleanFace(i.face) : null,
            speed: kind === 'media' ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, num(i.speed, 1))) : 1,
            volume: Math.min(1, Math.max(0, num(i.volume, 1))),
            gain: kind === 'media' ? cleanPoints(i.gain) : [],
            link: kind === 'subs' && typeof i.link === 'string' ? i.link : null
          }
        })
        .filter((i) => i.out - i.in >= MIN_ITEM / 2)
    : []
  // кусок субтитров может лежать только на видеодорожке
  const videoIds = new Set(tracks.filter((t) => t.kind === 'video').map((t) => t.id))
  // кусок субтитров и стоп-кадр — только на видеодорожке; стоп-кадр — только из файла с видео, кадр внутри файла, длина разумная
  const okItems = items
    .filter((i) => i.kind === 'media' || videoIds.has(i.trackId))
    .filter((i) => i.kind !== 'freeze' || (!!mediaOf1(i.mediaId)?.hasVideo && i.in <= (mediaOf1(i.mediaId)?.duration ?? 0) && i.out - i.in <= 3600))

  const words: Record<string, Word[]> = {}
  if (r.words && typeof r.words === 'object') {
    for (const [k, v] of Object.entries(r.words as Record<string, unknown>)) {
      if (!mediaIds.has(k) || !Array.isArray(v)) continue
      words[k] = (v as Array<Record<string, unknown>>)
        .filter((w) => typeof w?.text === 'string' && num(w.end, -1) > num(w.start, 0))
        .map((w, id) => ({ id, text: w.text as string, start: num(w.start, 0), end: num(w.end, 0) }))
    }
  }
  const covered: Record<string, Range[]> = {}
  if (r.covered && typeof r.covered === 'object') {
    for (const [k, v] of Object.entries(r.covered as Record<string, unknown>)) {
      if (!mediaIds.has(k) || !Array.isArray(v)) continue
      covered[k] = mergeRanges(
        (v as unknown[]).flatMap((x) => (Array.isArray(x) && num(x[0], -1) >= 0 && num(x[1], -1) > num(x[0], 0) ? [[num(x[0], 0), num(x[1], 0)] as Range] : []))
      )
    }
  }
  const markers: Marker[] = Array.isArray(r.markers)
    ? sortMarkers(
        (r.markers as Array<Record<string, unknown>>)
          .filter((m) => m && typeof m.id === 'string' && trackIds.has(m.trackId as string) && num(m.t, -1) >= 0)
          .map((m) => ({
            id: m.id as string,
            trackId: m.trackId as string,
            t: num(m.t, 0),
            color: Math.min(MARKER_COLORS - 1, Math.max(0, Math.floor(num(m.color, 0)))),
            text: str(m.text).slice(0, 80)
          }))
      )
    : []
  const canvas =
    r.canvas && typeof r.canvas === 'object' && num((r.canvas as Canvas).w, 0) >= 16 && num((r.canvas as Canvas).h, 0) >= 16
      ? { w: even((r.canvas as Canvas).w), h: even((r.canvas as Canvas).h) }
      : null
  let p: Project = {
    version: 12,
    id: str(r.id) || uid('p'),
    name: str(r.name, 'Проект').slice(0, 120) || 'Проект',
    createdAt: str(r.createdAt),
    updatedAt: str(r.updatedAt),
    canvas,
    fps: Math.min(120, Math.max(1, num(r.fps, 30))),
    media,
    tracks,
    items: okItems,
    markers,
    words,
    covered,
    // в v3/v4 рамок в этом виде не было (там лежали рамки старого режима в секундах таймлайна) — их не переносим
    clips: ver >= 5 ? sanitizeClips(r.clips, media) : [],
    style: r.style && typeof r.style === 'object' ? (r.style as SubtitleStyle) : null
  }
  if (legacySubs.length > 0) p = addSubtitles(p, legacySubs)
  return finish(p)
}
