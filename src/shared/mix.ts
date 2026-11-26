/**
 * Звук и склейка кусков: отделить звук от видео и вернуть, соединить разрезанные куски, линия громкости.
 * Операции чистые, как в project.ts; запрет на закреплённой дорожке и причину отказа возвращают сами.
 */
import { addPoint, clamp01, gainAt, mergeGain, movePoint } from './audio.ts'
import { evalKeys, joinEffects, KEY_PROPS, keysJoinGap, mergeKeys, moveKey, noKeys, propAt, setKey, type KeyProp } from './anim.ts'
import { clampParam, EFFECTS, newEffect, type EffectType } from './effects.ts'
import { DEFAULT_FRAME, patchFrameValues, sameFrame, type Frame, type FrameKey } from './frame.ts'
import { DEFAULT_PLATE_LEN, newPlate, patchPlateValues, type Plate } from './plate.ts'
import { finish, fits, itemDur, itemEnd, itemTrackKind, MAX_SPEED, MIN_ITEM, MIN_SPEED, mediaOf, splitItem, subsOf, tlToSrc, trackOf, uid, placeFree, type Item, type Project, type TrackKind } from './project.ts'

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
  // у звукового куска картинки нет: эффекты, кадр и ключи остаются у видео
  const sound: Item = { ...it, id: uid('i'), trackId: placed.id, audio: true, link: null, effects: [], frame: { ...DEFAULT_FRAME }, keys: noKeys() }
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

const partOf = (it: Item): { keys: Item['keys']; frame: Item['frame']; len: number } => ({ keys: it.keys, frame: it.frame, len: itemDur(it) })

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
  if (joinEffects(a.effects, itemDur(a), b.effects, itemDur(b)) === null) return 'У кусков разные эффекты или анимации'
  if (!sameFrame(a.frame, b.frame)) return 'У кусков разный кадр (масштаб, положение, кроп или прозрачность)'
  if (keysJoinGap(partOf(a), partOf(b))) return 'У кусков разные ключевые кадры на стыке'
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
  const merged: Item = {
    ...a,
    out: b.out,
    gain: g.points,
    volume: g.base,
    keys: mergeKeys(partOf(a), partOf(b)),
    effects: joinEffects(a.effects, itemDur(a), b.effects, itemDur(b)) ?? a.effects
  }
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

// --- стоп-кадр ---

export const DEFAULT_FREEZE = 3
export const MAX_FREEZE = 600
const FRAME = 0.04

/** Сдвигает на delta всё, что начинается не раньше from на дорожке (кроме except), и метки этой дорожки. Связанные субтитры идут за видео. */
function rippleTrack(p: Project, trackId: string, from: number, delta: number, except: string[]): Project {
  const items = p.items.map((i) =>
    i.trackId === trackId && !except.includes(i.id) && !(i.kind === 'subs' && i.link) && i.start >= from - EPS ? { ...i, start: r3(Math.max(0, i.start + delta)) } : i
  )
  const markers = p.markers.map((m) => (m.trackId === trackId && m.t >= from - EPS ? { ...m, t: r3(Math.max(0, m.t + delta)) } : m))
  return { ...p, items, markers }
}

/** Видеокусок, к которому применим стоп-кадр: на видеодорожке, из файла с видео, без блокировки. */
const freezable = (p: Project, it: Item | undefined): it is Item =>
  !!it && it.kind === 'media' && itemTrackKind(p, it) === 'video' && !!mediaOf(p, it.mediaId)?.hasVideo && !locked(p, it)

/**
 * Стоп-кадр в точке t таймлайна на куске id: видео режется вместе со звуком, между половинами встаёт кусок-стопкадр
 * длиной len (кадр в этой точке, без звука), всё правее на дорожке сдвигается на len. У самого края куска стопкадр
 * встаёт перед или после без резки.
 */
export function insertFreeze(p: Project, id: string, t: number, len = DEFAULT_FREEZE): { p: Project; id: string; error?: string } {
  const it = find(p, id)
  if (!freezable(p, it)) return { p, id: '', error: it && locked(p, it) ? 'Дорожка закреплена: открепи её' : 'Стоп-кадр делается на куске видео' }
  const length = Math.min(MAX_FREEZE, Math.max(MIN_ITEM, len))
  const end = itemEnd(it)
  if (t < it.start - EPS || t > end + EPS) return { p, id: '', error: 'Поставь курсор на кусок видео' }
  let cur = p
  let at = t
  let frame: number
  if (t <= it.start + MIN_ITEM) {
    at = it.start
    frame = it.in
    cur = rippleTrack(cur, it.trackId, at, length, [])
  } else if (t >= end - MIN_ITEM) {
    at = end
    frame = Math.max(it.in, it.out - FRAME)
    cur = rippleTrack(cur, it.trackId, at, length, [])
  } else {
    frame = tlToSrc(it, t)
    const s = splitItem(cur, it.id, t)
    if (!s.id) return { p, id: '', error: 'Здесь не разрезать' }
    cur = rippleTrack(s.p, it.trackId, at, length, [])
  }
  const fz: Item = {
    id: uid('i'),
    kind: 'freeze',
    mediaId: it.mediaId,
    trackId: it.trackId,
    start: r3(at),
    in: r3(frame),
    out: r3(frame + length),
    audio: false,
    speed: 1,
    volume: 1,
    gain: [],
    effects: [],
    frame: { ...DEFAULT_FRAME },
    keys: noKeys(),
    plate: null,
    link: null
  }
  return { p: finish({ ...cur, items: [...cur.items, fz] }), id: fz.id }
}

/** Длина стопкадра: правая часть дорожки сдвигается вместе с его краем. */
export function setFreezeLength(p: Project, id: string, len: number): Result {
  const it = find(p, id)
  if (!it || it.kind !== 'freeze') return { p, error: 'Это не стоп-кадр' }
  if (locked(p, it)) return { p, error: 'Дорожка закреплена: открепи её' }
  const length = r3(Math.min(MAX_FREEZE, Math.max(MIN_ITEM, len)))
  const delta = length - (it.out - it.in)
  if (Math.abs(delta) < 1e-6) return { p }
  const moved = rippleTrack(p, it.trackId, itemEnd(it), delta, [id])
  return { p: finish({ ...moved, items: moved.items.map((x) => (x.id === id ? { ...x, out: r3(x.in + length) } : x)) }) }
}

// --- эффекты ---

/**
 * Эффекты применимы к картинке: куски видео на видеодорожках, оверлеи и стоп-кадры (не звук и не субтитры).
 * Надписи принимают только анимации (появление, зум, выезд…), блюр и цвет — нет. type — проверка конкретного эффекта.
 */
export function canHaveEffects(p: Project, it: Item, type?: EffectType): boolean {
  if (it.kind === 'subs') return false
  if (it.kind === 'text') return !type || !!EFFECTS[type]?.anim
  return itemTrackKind(p, it) === 'video' && !!mediaOf(p, it.mediaId)?.hasVideo
}

/** Раздел «Кадр» с кропом (масштаб, положение, кроп): куски с картинкой из файла, не надписи. */
export const hasFrameCrop = (p: Project, it: Item): boolean => it.kind !== 'text' && canHaveEffects(p, it)

/** Накладывает эффект на куски (с настройками по умолчанию). Если такой эффект на куске уже есть, он остаётся как был. */
export function addEffect(p: Project, ids: string[], type: EffectType): { p: Project; added: number } {
  if (!EFFECTS[type]) return { p, added: 0 }
  let added = 0
  const items = p.items.map((i) => {
    if (!ids.includes(i.id) || !canHaveEffects(p, i, type) || i.effects.some((e) => e.type === type)) return i
    added++
    return { ...i, effects: [...i.effects, newEffect(type)] }
  })
  return { p: added ? { ...p, items } : p, added }
}

export function patchEffect(p: Project, itemId: string, effectId: string, patch: { on?: boolean; key?: string; value?: number }): Project {
  return {
    ...p,
    items: p.items.map((i) => {
      if (i.id !== itemId) return i
      return {
        ...i,
        effects: i.effects.map((e) => {
          if (e.id !== effectId) return e
          const next = { ...e }
          if (patch.on !== undefined) next.on = patch.on
          if (patch.key !== undefined && patch.value !== undefined) {
            const v = clampParam(e.type, patch.key, patch.value)
            if (v !== null) next.values = { ...e.values, [patch.key]: v }
          }
          return next
        })
      }
    })
  }
}

export function removeEffect(p: Project, itemId: string, effectId: string): Project {
  return { ...p, items: p.items.map((i) => (i.id === itemId ? { ...i, effects: i.effects.filter((e) => e.id !== effectId) } : i)) }
}

// --- кадр: масштаб, положение, кроп ---

/** Меняет поля «Кадра» куска (значения зажимаются в пределы; кроп не съедает картинку целиком). prefer — какую сторону кропа двигают. */
export function patchFrame(p: Project, itemId: string, patch: Partial<Frame>, prefer?: FrameKey): Project {
  return {
    ...p,
    items: p.items.map((i) => {
      if (i.id !== itemId || !canHaveEffects(p, i)) return i
      const frame = patchFrameValues(i.frame, patch, prefer)
      // у надписи кропа нет
      return { ...i, frame: i.kind === 'text' ? { ...frame, cl: 0, cr: 0, ct: 0, cb: 0 } : frame }
    })
  }
}

/** «Сбросить» кадр: значения по умолчанию и без ключей положения, масштаба и прозрачности. */
export function resetFrame(p: Project, itemId: string): Project {
  return { ...p, items: p.items.map((i) => (i.id === itemId ? { ...i, frame: { ...DEFAULT_FRAME }, keys: noKeys() } : i)) }
}

// --- ключевые кадры ---

/** Секунды от начала куска для момента таймлайна tl, в пределах куска. */
const relTime = (it: Item, tl: number): number => Math.min(itemDur(it), Math.max(0, tl - it.start))
const animatable = (p: Project, it: Item | undefined): it is Item => !!it && canHaveEffects(p, it)
const withKeys = (p: Project, id: string, fn: (it: Item) => Item): Project => ({ ...p, items: p.items.map((i) => (i.id === id && animatable(p, i) ? fn(i) : i)) })

/** Значение свойства куска (по ключам) в момент таймлайна tl — то, что показывают поля инспектора. */
export function frameValueAt(it: Item, prop: KeyProp, tl: number): number {
  return propAt(it, prop, relTime(it, tl))
}

/**
 * Правка значения свойства в момент tl. Есть ключи — ставит ключ в этот момент (или обновляет стоящий рядом), нет —
 * меняет значение «Кадра». Так работают и поля инспектора, и перетаскивание картинки в превью.
 */
export function setPropAt(p: Project, id: string, prop: KeyProp, tl: number, v: number): Project {
  return withKeys(p, id, (it) => {
    if (it.keys[prop].length === 0) return { ...it, frame: patchFrameValues(it.frame, { [prop]: v }) }
    const r = setKey(it.keys[prop], prop, relTime(it, tl), v, itemDur(it))
    return { ...it, keys: { ...it.keys, [prop]: r.keys } }
  })
}

/** Включает ромбик: в момент tl ставится ключ с текущим значением, дальше правки сами ставят ключи. */
export function enableKeys(p: Project, id: string, prop: KeyProp, tl: number): Project {
  return withKeys(p, id, (it) => {
    if (it.keys[prop].length > 0) return it
    const r = setKey([], prop, relTime(it, tl), it.frame[prop], itemDur(it))
    return { ...it, keys: { ...it.keys, [prop]: r.keys } }
  })
}

/** Выключает ромбик: ключи свойства убираются, значение «Кадра» становится тем, что было в момент tl. */
export function disableKeys(p: Project, id: string, prop: KeyProp, tl: number): Project {
  return withKeys(p, id, (it) => {
    if (it.keys[prop].length === 0) return it
    const v = evalKeys(it.keys[prop], it.frame[prop], relTime(it, tl))
    return { ...it, frame: patchFrameValues(it.frame, { [prop]: v }), keys: { ...it.keys, [prop]: [] } }
  })
}

/** Ставит ключ в момент tl со значением v (по умолчанию — текущее на линии). */
export function addKeyAt(p: Project, id: string, prop: KeyProp, tl: number, v?: number): Project {
  return withKeys(p, id, (it) => {
    const t = relTime(it, tl)
    const r = setKey(it.keys[prop], prop, t, v ?? evalKeys(it.keys[prop], it.frame[prop], t), itemDur(it))
    return { ...it, keys: { ...it.keys, [prop]: r.keys } }
  })
}

/** Двигает ключ по времени (и значению, если задано). */
export function moveKeyTo(p: Project, id: string, prop: KeyProp, index: number, tl: number, v?: number): Project {
  return withKeys(p, id, (it) => {
    const ks = it.keys[prop]
    if (index < 0 || index >= ks.length) return it
    return { ...it, keys: { ...it.keys, [prop]: moveKey(ks, prop, index, relTime(it, tl), v ?? ks[index].v, itemDur(it)) } }
  })
}

/** Удаляет ключ; когда последний ключ удалён, свойство перестаёт анимироваться и держит его значение. */
export function deleteKeyAt(p: Project, id: string, prop: KeyProp, index: number): Project {
  return withKeys(p, id, (it) => {
    const ks = it.keys[prop]
    if (index < 0 || index >= ks.length) return it
    if (ks.length === 1) return { ...it, frame: patchFrameValues(it.frame, { [prop]: ks[0].v }), keys: { ...it.keys, [prop]: [] } }
    return { ...it, keys: { ...it.keys, [prop]: ks.filter((_, i) => i !== index) } }
  })
}

// --- ключи на таймлайне: ромбик на куске — все ключи свойств, стоящие в одной точке времени ---

const SAME_TIME = 0.011

/** Времена (секунды от начала куска), в которых у куска есть хоть один ключ, по возрастанию без повторов. */
export function keyTimes(it: Item): number[] {
  const out: number[] = []
  for (const t of KEY_PROPS.flatMap((k) => it.keys[k].map((x) => x.t)).sort((a, b) => a - b)) if (out.length === 0 || t - out[out.length - 1] > SAME_TIME) out.push(t)
  return out
}

/** Двигает все ключи, стоящие в точке rel (от начала куска), в момент таймлайна tl. */
export function moveKeysAtTime(p: Project, id: string, rel: number, tl: number): Project {
  return withKeys(p, id, (it) => {
    const keys = { ...it.keys }
    for (const k of KEY_PROPS) {
      const i = keys[k].findIndex((x) => Math.abs(x.t - rel) <= SAME_TIME)
      if (i >= 0) keys[k] = moveKey(keys[k], k, i, relTime(it, tl), keys[k][i].v, itemDur(it))
    }
    return { ...it, keys }
  })
}

/** Удаляет все ключи в точке rel; свойство, у которого не осталось ключей, держит значение удалённого. */
export function deleteKeysAtTime(p: Project, id: string, rel: number): Project {
  let cur = p
  const it = find(p, id)
  if (!it) return p
  for (const k of KEY_PROPS) {
    const i = it.keys[k].findIndex((x) => Math.abs(x.t - rel) <= SAME_TIME)
    if (i >= 0) cur = deleteKeyAt(cur, id, k, i)
  }
  return cur
}

/** Ставит ключи во всех анимируемых свойствах куска в момент tl (со значениями линии в этой точке). */
export function addKeysAtTime(p: Project, id: string, tl: number): Project {
  let cur = p
  const it = find(p, id)
  if (!it) return p
  for (const k of KEY_PROPS) if (it.keys[k].length > 0) cur = addKeyAt(cur, id, k, tl)
  return cur
}

/** Плавность отрезков, которые начинаются в точке rel (у всех свойств). */
export function setEaseAtTime(p: Project, id: string, rel: number, easeOn: boolean): Project {
  return withKeys(p, id, (it) => {
    const keys = { ...it.keys }
    for (const k of KEY_PROPS) keys[k] = keys[k].map((x) => (Math.abs(x.t - rel) <= SAME_TIME ? { ...x, ease: easeOn } : x))
    return { ...it, keys }
  })
}

/** Плавность (ease in-out) отрезка от этого ключа до следующего. */
export function setKeyEase(p: Project, id: string, prop: KeyProp, index: number, easeOn: boolean): Project {
  return withKeys(p, id, (it) => {
    const ks = it.keys[prop]
    if (index < 0 || index >= ks.length) return it
    return { ...it, keys: { ...it.keys, [prop]: ks.map((k, i) => (i === index ? { ...k, ease: easeOn } : k)) } }
  })
}

// --- текстовые плашки ---

/**
 * Ставит надпись на время `at` длиной len на самую верхнюю свободную видеодорожку (нет места — новая сверху).
 * styleId — один из PLATE_STYLES; text — своё содержимое.
 */
export function insertText(p: Project, at: number, styleId = 'text', len = DEFAULT_PLATE_LEN, text = 'Текст'): { p: Project; id: string } {
  // начало округляется вниз: надпись, поставленная на курсор, сразу видна в этом кадре
  const start = Math.max(0, Math.floor(at * 1000 + 1e-6) / 1000)
  const top = p.tracks.find((t) => t.kind === 'video' && !t.locked)
  const placed = placeFree(p, 'video', start, start + len, top?.id)
  const it: Item = {
    id: uid('i'),
    kind: 'text',
    mediaId: '',
    trackId: placed.id,
    start,
    in: 0,
    out: r3(len),
    audio: false,
    speed: 1,
    volume: 1,
    gain: [],
    effects: [],
    frame: { ...DEFAULT_FRAME },
    keys: noKeys(),
    plate: newPlate(styleId, text),
    link: null
  }
  return { p: finish({ ...placed.p, items: [...placed.p.items, it] }), id: it.id }
}

/** Меняет параметры надписи (числа зажимаются в пределы). */
export function patchPlate(p: Project, id: string, patch: Partial<Plate>): Project {
  return { ...p, items: p.items.map((i) => (i.id === id && i.kind === 'text' && i.plate && !locked(p, i) ? { ...i, plate: patchPlateValues(i.plate, patch) } : i)) }
}

// --- копирование и вставка ---

/** Кусок в буфере: его полная копия и вид дорожки, на которой он лежал (звук из видеофайла остаётся звуком). */
export interface ClipEntry {
  item: Item
  kind: TrackKind
}

/**
 * Копирует выделенные куски целиком (картинка, звук, линия громкости, скорость, эффекты, кадр, надпись). Субтитры,
 * связанные с копируемым видео, берутся вместе с ним. Метки и рамки «Клипы» не копируются.
 */
export function copyItems(p: Project, ids: string[]): ClipEntry[] {
  const picked = new Set(ids.filter((id) => p.items.some((i) => i.id === id)))
  for (const i of p.items) if (i.kind === 'subs' && i.link && picked.has(i.link)) picked.add(i.id)
  return p.items
    .filter((i) => picked.has(i.id))
    .sort((a, b) => a.start - b.start)
    .map((i) => ({ item: JSON.parse(JSON.stringify(i)) as Item, kind: itemTrackKind(p, i) }))
}

/**
 * Вставляет копии так, что начало самого раннего куска встаёт на at, остальные сохраняют расстояния между собой и свои
 * дорожки. Место занято, дорожка закреплена или удалена — ближайшая свободная дорожка того же вида или новая. Файлы,
 * которых в проекте уже нет, пропускаются (skipped). Правая часть дорожки не двигается.
 */
export function pasteItems(p: Project, entries: ClipEntry[], at: number): { p: Project; ids: string[]; skipped: number } {
  if (entries.length === 0) return { p, ids: [], skipped: 0 }
  const t0 = Math.min(...entries.map((e) => e.item.start))
  const shift = Math.max(0, at) - t0
  const hasFile = (it: Item): boolean => it.kind === 'text' || !!mediaOf(p, it.mediaId)
  const idMap = new Map<string, string>()
  let cur = p
  let skipped = 0
  const ids: string[] = []
  const place = (e: ClipEntry): void => {
    const it = e.item
    const start = r3(it.start + shift)
    const end = start + itemDur(it)
    const own = cur.tracks.find((t) => t.id === it.trackId && t.kind === e.kind)
    const target = own && !own.locked && fits(cur, own.id, start, end) ? { p: cur, id: own.id } : placeFree(cur, e.kind, start, end, own?.id)
    const copy: Item = { ...(JSON.parse(JSON.stringify(it)) as Item), id: uid('i'), trackId: target.id, start }
    idMap.set(it.id, copy.id)
    ids.push(copy.id)
    cur = { ...target.p, items: [...target.p.items, copy] }
  }
  // сначала всё, кроме субтитров, потом субтитры: их связь переводится на копии видео
  const rest = entries.filter((e) => e.item.kind !== 'subs')
  for (const e of rest) {
    if (!hasFile(e.item)) {
      skipped++
      continue
    }
    place(e)
  }
  for (const e of entries.filter((x) => x.item.kind === 'subs')) {
    if (!hasFile(e.item) || (e.item.link && !idMap.has(e.item.link) && entries.some((x) => x.item.id === e.item.link))) {
      skipped++
      continue
    }
    place(e)
  }
  // связи субтитров: на копию видео, а если видео не копировалось — субтитры живут сами
  const items = cur.items.map((i) => (ids.includes(i.id) && i.kind === 'subs' ? { ...i, link: i.link ? (idMap.get(i.link) ?? null) : null } : i))
  return { p: finish({ ...cur, items }), ids, skipped }
}

/** Дублирование: копия выделенного встаёт сразу после конца оригинала. Буфер не трогается. */
export function duplicateItems(p: Project, ids: string[]): { p: Project; ids: string[] } {
  const entries = copyItems(p, ids)
  if (entries.length === 0) return { p, ids: [] }
  const end = Math.max(...entries.map((e) => itemEnd(e.item)))
  const r = pasteItems(p, entries, end)
  return { p: r.p, ids: r.ids }
}
