/**
 * Звук и склейка кусков: отделить звук от видео и вернуть, соединить разрезанные куски, линия громкости.
 * Операции чистые, как в project.ts; запрет на закреплённой дорожке и причину отказа возвращают сами.
 */
import { addPoint, clamp01, gainAt, mergeGain, movePoint } from './audio.ts'
import { finish, itemEnd, itemTrackKind, MAX_SPEED, MIN_SPEED, mediaOf, placeFree, subsOf, tlToSrc, trackOf, uid, type Item, type Project } from './project.ts'

const EPS = 0.02
const r3 = (x: number): number => Math.round(x * 1000) / 1000

const find = (p: Project, id: string): Item | undefined => p.items.find((i) => i.id === id)
const locked = (p: Project, it: Item): boolean => !!trackOf(p, it.trackId)?.locked

/** У куска есть звук, который можно показывать и править: файл со звуком и звук не отделён. */
export function hasSound(p: Project, it: Item): boolean {
  if (it.kind !== 'media') return false
  const m = mediaOf(p, it.mediaId)
  return !!m?.hasAudio && it.audio
}

// --- отделить звук / вернуть ---

export type Result = { p: Project; error?: undefined } | { p: Project; error: string }

/** Отделяет звук видеокуска: обычный звуковой кусок на первой свободной звуковой дорожке (или на новой). */
export function detachAudio(p: Project, id: string): { p: Project; id: string; error?: string } {
  const it = find(p, id)
  if (!it) return { p, id: '', error: 'Кусок не найден' }
  const m = mediaOf(p, it.mediaId)
  if (it.kind !== 'media' || itemTrackKind(p, it) !== 'video' || !m?.hasVideo) return { p, id: '', error: 'Отделить можно звук видеокуска' }
  if (!m.hasAudio || !it.audio) return { p, id: '', error: 'У этого куска нет прикреплённого звука' }
  if (locked(p, it)) return { p, id: '', error: 'Дорожка закреплена: открепи её' }
  const placed = placeFree(p, 'audio', it.start, itemEnd(it))
  const sound: Item = { ...it, id: uid('i'), trackId: placed.id, audio: true, link: null }
  const video: Item = { ...it, audio: false, volume: 1, gain: [] }
  return { p: finish({ ...placed.p, items: [...placed.p.items.map((x) => (x.id === id ? video : x)), sound] }), id: sound.id }
}

/**
 * Возвращает звук к видео: звуковой кусок из видеофайла сливается с видеокуском того же файла без звука
 * с тем же отрезком исходника; сдвиг звука относительно картинки при этом сбрасывается.
 */
export function attachAudio(p: Project, soundId: string): Result {
  const s = find(p, soundId)
  if (!s || s.kind !== 'media') return { p, error: 'Кусок не найден' }
  const m = mediaOf(p, s.mediaId)
  if (itemTrackKind(p, s) !== 'audio' || !m?.hasVideo) return { p, error: 'Вернуть можно только звук, отделённый от видео' }
  if (locked(p, s)) return { p, error: 'Дорожка закреплена: открепи её' }
  const candidates = p.items.filter(
    (v) => v.kind === 'media' && v.mediaId === s.mediaId && !v.audio && itemTrackKind(p, v) === 'video' && Math.abs(v.in - s.in) <= EPS && Math.abs(v.out - s.out) <= EPS
  )
  if (candidates.length === 0) return { p, error: 'Не нашёл видео этого файла без звука с тем же отрезком' }
  const v = candidates.reduce((a, b) => (Math.abs(b.start - s.start) < Math.abs(a.start - s.start) ? b : a))
  if (locked(p, v)) return { p, error: 'Дорожка видео закреплена: открепи её' }
  const back: Item = { ...v, audio: true, volume: s.volume, gain: s.gain }
  // скорость берётся у видео: звук возвращается в его темп
  return { p: finish({ ...p, items: p.items.filter((x) => x.id !== s.id).map((x) => (x.id === v.id ? back : x)) }) }
}

// --- склейка ---

/** Почему a и b склеить нельзя (null — можно). a — левый кусок, b — правый. */
export function joinProblem(p: Project, a: Item, b: Item): string | null {
  if (a.kind !== 'media' || b.kind !== 'media') return 'Склеиваются только куски видео и звука'
  if (a.mediaId !== b.mediaId) return 'Куски из разных файлов'
  if (a.trackId !== b.trackId) return 'Куски лежат на разных дорожках'
  if (locked(p, a)) return 'Дорожка закреплена: открепи её'
  if (Math.abs(a.out - b.in) > EPS) return 'Это не соседние отрезки файла: между ними вырезан кусок'
  if (Math.abs(itemEnd(a) - b.start) > EPS) return 'Между кусками есть пустое место или они наехали друг на друга'
  if (a.audio !== b.audio) return 'У одного звук отделён, у другого прикреплён'
  if (Math.abs(a.speed - b.speed) > 1e-6) return 'У кусков разная скорость'
  return null
}

/** Склеивает левый и правый куски в один; связанные субтитры и линия громкости сливаются. */
export function joinItems(p: Project, leftId: string, rightId: string): Result {
  const a = find(p, leftId)
  const b = find(p, rightId)
  if (!a || !b) return { p, error: 'Кусок не найден' }
  const bad = joinProblem(p, a, b)
  if (bad) return { p, error: bad }
  const g = mergeGain({ points: a.gain, base: a.volume, in: a.in, out: a.out }, { points: b.gain, base: b.volume, in: b.in, out: b.out })
  const merged: Item = { ...a, out: b.out, gain: g.points, volume: g.base }
  const aHasSubs = subsOf(p, a.id).length > 0
  const items = p.items
    .filter((x) => x.id !== b.id)
    .map((x) => {
      if (x.id === a.id) return merged
      // субтитры правой половины: если у левой своих нет — переезжают к склеенному куску (finish растянет), иначе уйдут вместе с ней
      if (x.kind === 'subs' && x.link === b.id) return aHasSubs ? x : { ...x, link: a.id }
      return x
    })
  return { p: finish({ ...p, items }) }
}

/** Соседи куска по его дорожке: ближайший слева и справа. */
export function neighbors(p: Project, id: string): { left: Item | null; right: Item | null } {
  const it = find(p, id)
  if (!it) return { left: null, right: null }
  const row = p.items.filter((x) => x.trackId === it.trackId && x.kind === it.kind && x.id !== id).sort((x, y) => x.start - y.start)
  const left = [...row].reverse().find((x) => itemEnd(x) <= it.start + EPS) ?? null
  const right = row.find((x) => x.start >= itemEnd(it) - EPS) ?? null
  return { left, right }
}

/** Склейка одного куска с соседом: side 'left'/'right'; error — почему нельзя. */
export function joinWithNeighbor(p: Project, id: string, side: 'left' | 'right'): Result & { id?: string } {
  const it = find(p, id)
  if (!it) return { p, error: 'Кусок не найден' }
  const n = neighbors(p, id)[side]
  if (!n) return { p, error: side === 'left' ? 'Слева нет куска' : 'Справа нет куска' }
  const r = side === 'left' ? joinItems(p, n.id, it.id) : joinItems(p, it.id, n.id)
  return r.error ? r : { ...r, id: side === 'left' ? n.id : it.id }
}

/** Можно ли склеить кусок с кем-то (для меню и подсказок). */
export function canJoin(p: Project, id: string, side: 'left' | 'right'): boolean {
  const it = find(p, id)
  const n = neighbors(p, id)[side]
  if (!it || !n) return false
  return (side === 'left' ? joinProblem(p, n, it) : joinProblem(p, it, n)) === null
}

/**
 * Ctrl+J. Один кусок — с левым соседом, если нельзя — с правым. Несколько выделенных — все смежные пары.
 * error — причина, если не склеилось ничего.
 */
export function joinSelected(p: Project, ids: string[]): { p: Project; joined: number; id?: string; error?: string } {
  if (ids.length === 0) return { p, joined: 0, error: 'Выдели кусок или несколько соседних кусков' }
  if (ids.length === 1) {
    const l = joinWithNeighbor(p, ids[0], 'left')
    if (!l.error) return { p: l.p, joined: 1, id: l.id }
    const r = joinWithNeighbor(p, ids[0], 'right')
    if (!r.error) return { p: r.p, joined: 1, id: r.id }
    return { p, joined: 0, error: l.error === 'Слева нет куска' ? r.error : l.error }
  }
  let cur = p
  let joined = 0
  let reason = ''
  // идём слева направо по дорожкам; после склейки id левого куска остаётся
  const byTrack = new Map<string, Item[]>()
  for (const id of ids) {
    const it = find(p, id)
    if (it) byTrack.set(it.trackId, [...(byTrack.get(it.trackId) ?? []), it])
  }
  for (const list of byTrack.values()) {
    list.sort((a, b) => a.start - b.start)
    let head = list[0].id
    for (let i = 1; i < list.length; i++) {
      const r = joinItems(cur, head, list[i].id)
      if (r.error) {
        reason = reason || r.error
        head = list[i].id
      } else {
        cur = r.p
        joined++
      }
    }
  }
  return joined > 0 ? { p: cur, joined } : { p, joined: 0, error: reason || 'Выдели соседние куски одного файла' }
}

// --- линия громкости ---

const editable = (p: Project, it: Item | undefined): it is Item => !!it && hasSound(p, it) && !locked(p, it)
const put = (p: Project, it: Item): Project => ({ ...p, items: p.items.map((x) => (x.id === it.id ? it : x)) })

/** Уровень куска без точек (линию без точек тянут целиком). */
export function setBaseVolume(p: Project, id: string, v: number): Project {
  const it = find(p, id)
  return editable(p, it) ? put(p, { ...it, volume: Math.round(clamp01(v) * 1000) / 1000 }) : p
}

/** Новая точка в момент t таймлайна (уровень — текущий на линии, если v не задан). index — её номер или -1. */
export function addGainPoint(p: Project, id: string, tl: number, v?: number): { p: Project; index: number } {
  const it = find(p, id)
  if (!editable(p, it)) return { p, index: -1 }
  const t = Math.min(it.out, Math.max(it.in, tlToSrc(it, tl)))
  const r = addPoint(it.gain, it.volume, t, v)
  return r.index < 0 ? { p, index: -1 } : { p: put(p, { ...it, gain: r.points }), index: r.index }
}

/** Тащит точку: tl — время на таймлайне, v — уровень. Время зажато между соседями и краями куска. */
export function moveGainPoint(p: Project, id: string, index: number, tl: number, v: number): Project {
  const it = find(p, id)
  if (!editable(p, it)) return p
  return put(p, { ...it, gain: movePoint(it.gain, index, tlToSrc(it, tl), v, it.in, it.out) })
}

/** Убирает точку. Последняя точка уходит — линия становится ровной на её уровне. */
export function deleteGainPoint(p: Project, id: string, index: number): Project {
  const it = find(p, id)
  if (!editable(p, it) || index < 0 || index >= it.gain.length) return p
  const gain = it.gain.filter((_, i) => i !== index)
  const volume = gain.length === 0 ? it.gain[index].v : it.volume
  return put(p, { ...it, gain, volume })
}

/** Итоговый уровень куска в момент t таймлайна (для предпросмотра и проверок). */
export function itemGainAt(it: Item, tl: number): number {
  return gainAt(it.gain, it.volume, r3(tlToSrc(it, tl)))
}

// --- скорость ---

export const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]
export const clampSpeed = (v: number): number => Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round((Number.isFinite(v) ? v : 1) * 100) / 100))

/**
 * Скорость выделенных кусков видео и звука. Длина кусков на таймлайне меняется, поэтому всё, что стоит правее на той же
 * дорожке (и метки этой дорожки), сдвигается на разницу. Куски на других дорожках не трогаются; связанные субтитры
 * идут за своим видео. Закреплённая дорожка — отказ.
 */
export function setSpeed(p: Project, ids: string[], value: number): Result {
  const speed = clampSpeed(value)
  const targets = p.items.filter((i) => ids.includes(i.id) && i.kind === 'media' && Math.abs(i.speed - speed) > 1e-6)
  if (targets.length === 0) return { p }
  if (targets.some((i) => locked(p, i))) return { p, error: 'Дорожка закреплена: открепи её' }
  const changed = new Map(targets.map((i) => [i.id, i]))
  const dur = (i: Item, s: number): number => (i.out - i.in) / s
  // разница длины каждого изменённого куска и его старый конец — по дорожкам
  const byTrack = new Map<string, Array<{ end: number; delta: number }>>()
  for (const it of targets) {
    byTrack.set(it.trackId, [...(byTrack.get(it.trackId) ?? []), { end: itemEnd(it), delta: dur(it, speed) - dur(it, it.speed) }])
  }
  const shift = (trackId: string, t: number): number => (byTrack.get(trackId) ?? []).reduce((d, x) => (t >= x.end - EPS ? d + x.delta : d), 0)
  const items = p.items.map((i) => {
    if (changed.has(i.id)) return { ...i, speed, start: r3(Math.max(0, i.start + shift(i.trackId, i.start))) }
    if (!byTrack.has(i.trackId) || (i.kind === 'subs' && i.link)) return i
    return { ...i, start: r3(Math.max(0, i.start + shift(i.trackId, i.start))) }
  })
  const markers = p.markers.map((m) => (byTrack.has(m.trackId) ? { ...m, t: r3(Math.max(0, m.t + shift(m.trackId, m.t))) } : m))
  return { p: finish({ ...p, items, markers }) }
}
