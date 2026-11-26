import assert from 'node:assert/strict'
import { addPoint, cleanPoints, gainAt, gainExpr, gainPeak, mergeGain, movePoint, splitGain } from './audio.ts'
import { buildExport } from './exportGraph.ts'
import { tempoFilter } from './exportGraph.ts'
import { insertFreeze, setFreezeLength, addEffect, patchEffect, removeEffect, canHaveEffects } from './mix.ts'
import { effectFilters, blurSigma, sameEffects, cleanEffects, cssFilter, newEffect, EFFECT_TYPES, clampParam } from './effects.ts'
import { cleanFrame, DEFAULT_FRAME, frameFilters, frameRect, isDefaultFrame, fitSize, patchFrameValues, sameFrame } from './frame.ts'
import { patchFrame, resetFrame } from './mix.ts'
import { cropProject, orderedClips, placement, makeClip, sourceAt } from './cut.ts'
import { setSpeed, clampSpeed } from './mix.ts'
import { addGainPoint, attachAudio, canJoin, deleteGainPoint, detachAudio, hasSound, itemGainAt, joinItems, joinSelected, joinWithNeighbor, moveGainPoint, neighbors, setBaseVolume } from './mix.ts'
import { projectDuration, addMarker, addMedia, addSubtitles, applyRecognized, insertMedia, itemDur, itemEnd, moveItem, newProject, sanitizeProject, setTrack, splitAt, splitItem, subsOf, subtitleLayers, tlToSrc, trimItem, videoTracks } from './project.ts'

const V = (path, duration, extra = {}) => ({ path, name: path, duration, hasVideo: true, hasAudio: true, width: 1280, height: 720, fps: 25, needsPreview: false, ...extra })
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-3, `${msg}: ${a} != ${b}`)

// --- линия громкости: чистая математика
const pts = [{ t: 0, v: 0 }, { t: 2, v: 1 }, { t: 8, v: 1 }, { t: 10, v: 0.2 }]
near(gainAt(pts, 0.5, 1), 0.5, 'подъём линейный')
near(gainAt(pts, 0.5, 5), 1, 'плато')
near(gainAt(pts, 0.5, 9), 0.6, 'спад')
near(gainAt(pts, 0.5, -3), 0, 'до первой точки держится первая')
near(gainAt(pts, 0.5, 99), 0.2, 'после последней держится последняя')
near(gainAt([], 0.7, 5), 0.7, 'без точек — постоянный уровень')
assert.equal(gainPeak(pts, 0.5, 0, 1), 0.5)
assert.equal(gainPeak(pts, 0.5, 0, 5), 1)
assert.deepEqual(cleanPoints([{ t: 3, v: 2 }, { t: 1, v: -1 }, { t: 'x', v: 1 }, null, { t: -1, v: 1 }]), [{ t: 1, v: 0 }, { t: 3, v: 1 }], 'мусор выброшен, значения в 0..1, по времени')
// добавление / движение
let a = addPoint(pts, 1, 5)
assert.equal(a.points.length, 5)
assert.equal(a.points[a.index].v, 1, 'новая точка — на уровне линии')
const near2 = addPoint(pts, 1, 2.002, 0.4).points
assert.equal(near2.length, pts.length, 'на месте уже стоящей точки новая заменяет её, а не плодится')
assert.ok(near2.some((p) => p.t === 2.002 && p.v === 0.4) && !near2.some((p) => p.t === 2))
const moved = movePoint(pts, 1, 20, 3, 0, 10)
assert.ok(moved[1].t < pts[2].t && moved[1].v === 1, 'время зажато соседом, уровень — 0..1')
assert.equal(movePoint(pts, 0, -5, 0.5, 0, 10)[0].t, 0, 'не выходит за границу куска')
// резка / склейка
const sp = splitGain(pts, 1, 5)
assert.deepEqual(sp.left.at(-1), { t: 5, v: 1 })
assert.deepEqual(sp.right[0], { t: 5, v: 1 })
assert.equal(sp.left.length + sp.right.length, pts.length + 2 - 0, 'точки поделены, на стыке по одной у каждой половины (2 уже на 2 и 8: 2 слева + 2 справа + стык)')
assert.deepEqual(splitGain([], 0.5, 3), { left: [], right: [] })
// выражение для ffmpeg: время от начала куска, края учтены
const ex = gainExpr([{ t: 4, v: 0 }, { t: 6, v: 1 }], 1, 5, 3)
assert.match(ex, /^if\(lt\(t,1\.0000\)/, 'первый отрезок до точки в 6 с (1 с от начала куска)')
assert.equal(gainExpr([], 0.25, 0, 5), '0.2500')
const mg = mergeGain({ points: [], base: 0.5, in: 0, out: 5 }, { points: [], base: 1, in: 5, out: 10 })
assert.ok(mg.points.length === 4 && mg.base === 1 && gainAt(mg.points, 1, 2) === 0.5 && gainAt(mg.points, 1, 8) === 1, 'разные уровни запекаются в точки')
assert.deepEqual(mergeGain({ points: [], base: 0.5, in: 0, out: 5 }, { points: [], base: 0.5, in: 5, out: 10 }), { points: [], base: 0.5 })

// --- проект
let p = newProject('М')
p = addMedia(p, V('/a.mp4', 20)).p
p = addMedia(p, V('/mute.mp4', 6, { hasAudio: false })).p
p = addMedia(p, { path: '/m.mp3', name: 'm', duration: 30, hasVideo: false, hasAudio: true, needsPreview: false }).p
const [ma, mm, mus] = p.media.map((m) => m.id)
const ia = insertMedia(p, ma, 0)
p = ia.p
const vi = p.items.find((i) => i.id === ia.id)
assert.equal(vi.audio, true, 'звук прикреплён по умолчанию')
assert.deepEqual(vi.gain, [])
const im = insertMedia(p, mm, 30)
assert.equal(im.p.items.find((i) => i.id === im.id).audio, false, 'у файла без звука нечего прикреплять')
assert.equal(hasSound(p, vi), true)
const iu = insertMedia(p, mus, 0)
assert.equal(iu.p.items.find((i) => i.id === iu.id).audio, true, 'аудиофайл — со звуком')
p = iu.p
const sound = iu.id

// --- отделить звук
const det = detachAudio(p, ia.id)
assert.ok(!det.error)
const vd = det.p.items.find((i) => i.id === ia.id)
const au = det.p.items.find((i) => i.id === det.id)
assert.equal(vd.audio, false)
assert.deepEqual([au.start, au.in, au.out, au.audio], [0, 0, 20, true])
assert.equal(det.p.tracks.find((t) => t.id === au.trackId).kind, 'audio')
assert.notEqual(au.trackId, p.items.find((i) => i.id === sound).trackId, 'занятая музыкой дорожка не подходит — другая')
assert.equal(detachAudio(det.p, ia.id).error, 'У этого куска нет прикреплённого звука')
assert.match(detachAudio(det.p, det.id).error, /видеокуска/)
const lockedTrack = setTrack(p, vi.trackId, { locked: true })
assert.match(detachAudio(lockedTrack, ia.id).error, /закреплена/)
// экспорт: картинка есть, звука у видео нет; звук отделённый идёт без картинки
const opts = { W: 1280, H: 720, fps: 25, format: 'h264', quality: 'medium', subLayers: [] }
const graph = (pr) => {
  const c = buildExport(pr, opts, '/o.mp4')
  return c.args[c.args.indexOf('-filter_complex') + 1]
}
const gAttached = graph(p)
const gDetached = graph(det.p)
assert.equal((gAttached.match(/\[\d+:a\]/g) ?? []).length, 2, 'звука два: видео и музыка')
assert.equal((gDetached.match(/\[\d+:a\]/g) ?? []).length, 2, 'после отделения тоже два (отделённый и музыка)')
assert.equal((gDetached.match(/overlay=x=\(W-w\)\/2/g) ?? []).length, 1, 'картинка одна: у звуковой дорожки её нет')
assert.ok(!/volume=0\.000/.test(gDetached))
// вернуть
const back = attachAudio(det.p, det.id)
assert.ok(!back.error)
assert.equal(back.p.items.length, p.items.length)
assert.equal(back.p.items.find((i) => i.id === ia.id).audio, true)
// сдвинули звук — возвращается на место картинки; другой отрезок — нельзя
const shifted = moveItem(det.p, det.id, au.trackId, 5)
assert.equal(attachAudio(shifted, det.id).p.items.find((i) => i.id === ia.id).start, 0)
const trimmed = trimItem(det.p, det.id, 'end', 15)
assert.match(attachAudio(trimmed, det.id).error, /Не нашёл/)
assert.match(attachAudio(p, sound).error, /отделённый|Вернуть/)

// --- линия громкости на куске
const mid = addGainPoint(p, ia.id, 10)
assert.equal(mid.index, 0)
let g = mid.p
assert.deepEqual(g.items.find((i) => i.id === ia.id).gain, [{ t: 10, v: 1 }])
g = addGainPoint(g, ia.id, 0, 0).p
g = addGainPoint(g, ia.id, 2, 1).p
assert.deepEqual(g.items.find((i) => i.id === ia.id).gain.map((x) => [x.t, x.v]), [[0, 0], [2, 1], [10, 1]])
near(itemGainAt(g.items.find((i) => i.id === ia.id), 1), 0.5, 'линия: плавное нарастание')
g = moveGainPoint(g, ia.id, 1, 3, 0.8)
assert.deepEqual(g.items.find((i) => i.id === ia.id).gain[1], { t: 3, v: 0.8 })
g = moveGainPoint(g, ia.id, 1, 100, 2)
assert.ok(g.items.find((i) => i.id === ia.id).gain[1].t < 10 && g.items.find((i) => i.id === ia.id).gain[1].v === 1)
// убрали все точки — линия ровная на уровне последней
let gd = g
for (let i = 0; i < 3; i++) gd = deleteGainPoint(gd, ia.id, 0)
const flat = gd.items.find((i) => i.id === ia.id)
assert.deepEqual(flat.gain, [])
assert.equal(flat.volume, 1, 'последняя точка отдала уровень')
assert.equal(setBaseVolume(p, ia.id, 0.4).items.find((i) => i.id === ia.id).volume, 0.4)
assert.equal(setBaseVolume(p, ia.id, 7).items.find((i) => i.id === ia.id).volume, 1, 'выше 100% нет')
assert.equal(setBaseVolume(det.p, ia.id, 0.4).items.find((i) => i.id === ia.id).volume, 1, 'у видео без звука линии нет')
assert.deepEqual(addGainPoint(lockedTrack, ia.id, 4), { p: lockedTrack, index: -1 }, 'закреплённая дорожка — не правим')
// экспорт: выражение по времени и нулевой кусок
assert.match(graph(g), /volume='if\(lt\(t,/)
assert.match(graph(g), /:eval=frame/)
const silent = setBaseVolume(p, ia.id, 0)
assert.equal((graph(silent).match(/\[\d+:a\]/g) ?? []).length, 1, 'нулевой кусок не тащит звук')

// --- резка делит линию, подрезка не двигает
const gs = splitItem(g, ia.id, 6)
const L = gs.p.items.find((i) => i.id === ia.id)
const R = gs.p.items.find((i) => i.id === gs.id)
near(L.gain.at(-1).t, 6, 'на стыке точка слева')
near(R.gain[0].t, 6, 'и справа')
near(L.gain.at(-1).v, R.gain[0].v, 'тот же уровень на стыке')
assert.equal(L.audio && R.audio, true)
near(itemGainAt(R, 6), itemGainAt(g.items.find((i) => i.id === ia.id), 6), 'звук после резки не меняется')
const tr = trimItem(g, ia.id, 'start', 4)
assert.deepEqual(tr.items.find((i) => i.id === ia.id).gain, g.items.find((i) => i.id === ia.id).gain, 'подрезка не двигает точки (они во времени исходника)')

// --- склейка
const cut = splitAt(p, 7) // видео 0..20 -> 0..7 + 7..20, музыка на другой дорожке тоже режется
const parts = cut.items.filter((i) => i.mediaId === ma)
assert.equal(parts.length, 2)
const [pa, pb] = parts.sort((x, y) => x.start - y.start)
assert.equal(canJoin(cut, pa.id, 'right'), true)
assert.equal(canJoin(cut, pb.id, 'right'), false)
assert.equal(canJoin(cut, pb.id, 'left'), true)
const j = joinItems(cut, pa.id, pb.id)
assert.ok(!j.error)
const joined = j.p.items.filter((i) => i.mediaId === ma)
assert.equal(joined.length, 1)
assert.deepEqual([joined[0].start, joined[0].in, joined[0].out], [0, 0, 20])
// склейка вернула куски и звук в исходный вид
assert.equal(joined[0].audio, true)
// отказы
const moved2 = moveItem(cut, pb.id, pb.trackId, 9)
assert.match(joinItems(moved2, pa.id, pb.id).error, /пустое место/)
const gapCut = trimItem(cut, pa.id, 'end', 6) // у левого подрезан конец: в файле дыра
assert.match(joinItems(gapCut, pa.id, pb.id).error, /вырезан/)
assert.match(joinItems(setTrack(cut, pa.trackId, { locked: true }), pa.id, pb.id).error, /закреплена/)
assert.match(joinItems(cut, pb.id, pa.id).error ?? '', /./, 'в обратном порядке не склеить')
// разное состояние звука
const mixed = detachAudio(cut, pa.id)
assert.match(joinItems(mixed.p, pa.id, pb.id).error, /звук отделён/)
// линии громкости сливаются
let withLine = addGainPoint(p, ia.id, 3, 0.2).p
withLine = splitAt(withLine, 7)
const [wa, wb] = withLine.items.filter((i) => i.mediaId === ma).sort((x, y) => x.start - y.start)
const wj = joinItems(withLine, wa.id, wb.id)
const wm = wj.p.items.find((i) => i.mediaId === ma)
near(itemGainAt(wm, 3), 0.2, 'точка на месте')
near(itemGainAt(wm, 15), 0.2, 'после — как было (плато)')
// резка и склейка возвращают линию в исходный вид (без лишних точек на стыке)
const cutJoin = splitItem(g, ia.id, 6)
const back2 = joinItems(cutJoin.p, ia.id, cutJoin.id)
assert.deepEqual(back2.p.items.find((i) => i.id === ia.id).gain, g.items.find((i) => i.id === ia.id).gain, 'точки на стыке убраны')
// но точка, которую поставили руками прямо на стыке, остаётся
const handmade = addGainPoint(g, ia.id, 6, 0.3).p
const cj = splitItem(handmade, ia.id, 6)
assert.ok(joinItems(cj.p, ia.id, cj.id).p.items.find((i) => i.id === ia.id).gain.some((x) => x.v === 0.3), 'нужная точка не пропала')
// у одной половины громкость 0.5, у другой 1 — звук не меняется после склейки
let lv = setBaseVolume(cut, pa.id, 0.5)
const lj = joinItems(lv, pa.id, pb.id)
const lm = lj.p.items.find((i) => i.mediaId === ma)
near(itemGainAt(lm, 3), 0.5, 'левая часть тише')
near(itemGainAt(lm, 15), 1, 'правая как была')
// соседи и Ctrl+J
const nn = neighbors(cut, pa.id)
assert.equal(nn.right.id, pb.id)
assert.equal(nn.left, null)
assert.match(joinWithNeighbor(cut, pa.id, 'left').error, /нет куска/)
const js = joinSelected(cut, [pb.id]) // один кусок: слева можно
assert.equal(js.joined, 1)
const js2 = joinSelected(cut, [pa.id]) // слева нет — берёт правого
assert.equal(js2.joined, 1)
const three = splitAt(splitAt(p, 5), 12)
assert.equal(three.items.filter((i) => i.mediaId === ma).length, 3)
const all = joinSelected(three, three.items.filter((i) => i.mediaId === ma).map((i) => i.id))
assert.equal(all.joined, 2)
assert.equal(all.p.items.filter((i) => i.mediaId === ma).length, 1, 'несколько выделенных склеиваются цепочкой')
assert.match(joinSelected(cut, []).error, /Выдели/)
assert.match(joinSelected(moved2, [pa.id, pb.id]).error, /пустое/)

// --- связанные субтитры склеиваются
let sb = applyRecognized(p, ma, 0, 20, [{ id: 0, text: 'раз', start: 1, end: 1.4 }, { id: 1, text: 'два', start: 12, end: 12.4 }])
sb = addSubtitles(sb, [ia.id])
sb = splitAt(sb, 7, [ia.id])
const sv = sb.items.filter((i) => i.kind === 'media' && i.mediaId === ma).sort((x, y) => x.start - y.start)
assert.equal(sb.items.filter((i) => i.kind === 'subs').length, 2)
const sj = joinItems(sb, sv[0].id, sv[1].id)
const subs = sj.p.items.filter((i) => i.kind === 'subs')
assert.equal(subs.length, 1, 'субтитры склеены вместе с видео')
assert.deepEqual([subs[0].start, subs[0].in, subs[0].out], [0, 0, 20])
assert.equal(subs[0].link, sj.p.items.find((i) => i.kind === 'media' && i.mediaId === ma).id)

// --- миграция
const v5 = JSON.parse(JSON.stringify(p))
v5.version = 5
for (const it of v5.items) {
  delete it.audio
  delete it.gain
  it.volume = 0.5
}
const mig = sanitizeProject(v5)
assert.equal(mig.version, 9)
const mv = mig.items.find((i) => i.mediaId === ma)
assert.deepEqual([mv.audio, mv.volume, mv.gain], [true, 0.5, []], 'звук прикреплён, уровень сохранён')
assert.equal(mig.items.find((i) => i.mediaId === mus).audio, true)
const v5loud = JSON.parse(JSON.stringify(v5))
v5loud.items[0].volume = 3
assert.equal(sanitizeProject(v5loud).items[0].volume, 1, 'выше 100% не бывает')
const dirty = JSON.parse(JSON.stringify(g))
dirty.items.find((i) => i.id === ia.id).gain = [{ t: 5, v: 9 }, { t: 1, v: 0.3 }, 'мусор']
assert.deepEqual(sanitizeProject(dirty).items.find((i) => i.id === ia.id).gain, [{ t: 1, v: 0.3 }, { t: 5, v: 1 }])
assert.equal(sanitizeProject(det.p).items.find((i) => i.id === ia.id).audio, false, 'отделённый звук сохраняется')
assert.equal(videoTracks(p).length >= 2, true)
void subsOf

// === скорость ===
{
  let q = newProject('С')
  q = addMedia(q, V('/a.mp4', 20)).p
  q = addMedia(q, V('/b.mp4', 10)).p
  const [qa, qb] = q.media.map((m) => m.id)
  const a1 = insertMedia(q, qa, 0)
  q = a1.p
  const b1 = insertMedia(q, qb, 20, q.items.find((i) => i.id === a1.id).trackId)
  q = b1.p
  const trackV = q.items.find((i) => i.id === a1.id).trackId
  assert.equal(q.items.find((i) => i.id === b1.id).start, 20, 'второй идёт сразу за первым на одной дорожке')
  const mk = addMarker(q, trackV, 25, 0, '').p
  q = mk
  const other = insertMedia(q, qb, 0)
  q = other.p
  assert.notEqual(q.items.find((i) => i.id === other.id).trackId, trackV)

  // длина и пересчёт времени
  const at2 = setSpeed(q, [a1.id], 2)
  assert.ok(!at2.error)
  const x2 = at2.p.items.find((i) => i.id === a1.id)
  assert.equal(x2.speed, 2)
  near(itemDur(x2), 10, 'вдвое быстрее — вдвое короче')
  near(itemEnd(x2), 10, 'конец')
  near(tlToSrc(x2, 5), 10, 'пятая секунда таймлайна = десятая файла')
  near(at2.p.items.find((i) => i.id === b1.id).start, 10, 'следующий сдвинулся влево на разницу')
  near(at2.p.markers[0].t, 15, 'метка этой дорожки тоже')
  near(at2.p.items.find((i) => i.id === other.id).start, 0, 'куски на других дорожках не тронуты')
  // медленнее: сдвиг вправо, на пресеты и зажим
  const slow = setSpeed(q, [a1.id], 0.5)
  near(itemDur(slow.p.items.find((i) => i.id === a1.id)), 40, 'вдвое медленнее — вдвое длиннее')
  near(slow.p.items.find((i) => i.id === b1.id).start, 40, 'сосед уехал вправо')
  assert.equal(setSpeed(q, [a1.id], 9).p.items.find((i) => i.id === a1.id).speed, 4, 'не быстрее 4×')
  assert.equal(setSpeed(q, [a1.id], 0.01).p.items.find((i) => i.id === a1.id).speed, 0.25, 'не медленнее 0.25×')
  assert.equal(clampSpeed(1.2345), 1.23)
  assert.equal(setSpeed(q, [a1.id], 1).p, q, 'то же значение — ничего не меняется')
  assert.match(setSpeed(setTrack(q, trackV, { locked: true }), [a1.id], 2).error, /закреплена/)
  // несколько кусков на одной дорожке: сдвиги копятся
  const both = setSpeed(q, [a1.id, b1.id], 2)
  near(both.p.items.find((i) => i.id === b1.id).start, 10)
  near(itemEnd(both.p.items.find((i) => i.id === b1.id)), 15, 'второй: 10 с файла ÷ 2')
  // вернулись к 1 — всё как было
  const back1 = setSpeed(at2.p, [a1.id], 1)
  assert.deepEqual(back1.p.items.map((i) => [i.id, i.start, i.speed]).sort(), q.items.map((i) => [i.id, i.start, i.speed]).sort())
  assert.deepEqual(back1.p.markers.map((m) => m.t), [25])

  // резка и подрезка с учётом скорости
  const sp = splitItem(at2.p, a1.id, 4) // 4-я секунда таймлайна = 8-я файла
  const L = sp.p.items.find((i) => i.id === a1.id)
  const R = sp.p.items.find((i) => i.id === sp.id)
  near(L.out, 8, 'левая часть до 8 с файла')
  near(R.in, 8)
  assert.equal(L.speed + R.speed, 4)
  near(itemEnd(L), 4)
  near(itemEnd(R), 10, 'правая часть кончается там же, где кончался кусок')
  assert.ok(joinItems(sp.p, a1.id, sp.id).error === undefined, 'склейка при той же скорости')
  const diffSpeed = setSpeed(sp.p, [sp.id], 1)
  assert.match(joinItems(diffSpeed.p, a1.id, sp.id).error ?? '', /скорость/, 'при разной скорости не склеить')
  const tr = trimItem(at2.p, a1.id, 'end', 6) // конец на 6-й секунде таймлайна = 12-я файла
  near(tr.items.find((i) => i.id === a1.id).out, 12)
  const trs = trimItem(at2.p, a1.id, 'start', 2)
  near(trs.items.find((i) => i.id === a1.id).in, 4)
  near(trs.items.find((i) => i.id === a1.id).start, 2)
  // начало нельзя сдвинуть левее начала файла: при 2× влево помещается in/speed
  const left0 = trimItem(trs, a1.id, 'start', 0)
  near(left0.items.find((i) => i.id === a1.id).in, 0)

  // субтитры идут в темпе видео
  let sb = applyRecognized(q, qa, 0, 20, [{ id: 0, text: 'раз', start: 4, end: 6 }, { id: 1, text: 'два', start: 12, end: 14 }])
  sb = addSubtitles(sb, [a1.id])
  const sbFast = setSpeed(sb, [a1.id], 2).p
  const sv = sbFast.items.find((i) => i.kind === 'subs')
  assert.equal(sv.speed, 2, 'связанные субтитры взяли скорость видео')
  assert.deepEqual(subtitleLayers(sbFast).flatMap((l) => l.words.map((w) => [w.text, w.start, w.end])), [['раз', 2, 3], ['два', 6, 7]], 'слова сжались вдвое')

  // рамки «Нарезки»
  let cl = { ...at2.p, clips: [makeClip(qa, 4, 12)] }
  const pl = placement(cl, cl.clips[0])
  near(pl.start, 2)
  near(pl.end, 6, 'рамка из 8 с файла при 2× занимает 4 с')
  near(sourceAt(cl, qa, 3), 6)
  const cp = cropProject(cl, 2, 6)
  const ci = cp.items.find((i) => i.mediaId === qa)
  assert.deepEqual([ci.start, ci.in, ci.out, ci.speed], [0, 4, 12, 2])

  // экспорт: время кадров, atempo, громкость до смены темпа
  const opts2 = { W: 1280, H: 720, fps: 25, format: 'h264', quality: 'medium', subLayers: [] }
  const gx = (pr) => {
    const c = buildExport(pr, opts2, '/o.mp4')
    return { g: c.args[c.args.indexOf('-filter_complex') + 1], total: c.total, args: c.args }
  }
  const e2 = gx(at2.p)
  near(e2.total, 20, 'длина экспорта: первый 10 с, второй 10 с')
  assert.match(e2.g, /setpts=\(PTS-STARTPTS\)\/2\.0000\+0\.000\/TB,fps=25/, 'картинка: время сжато, потом fps')
  assert.match(e2.g, /atempo=2\.0000/, 'звук: atempo')
  const ia2 = e2.args.indexOf('/a.mp4')
  assert.deepEqual(e2.args.slice(ia2 - 5, ia2), ['-ss', '0.000', '-t', '20.000', '-i'], 'вход режется по файлу')
  assert.match(gx(slow.p).g, /atempo=0\.5000/)
  assert.doesNotMatch(gx(q).g, /atempo/, 'на скорости 1 всё как раньше')
  assert.match(gx(q).g, /fps=25,setpts=PTS-STARTPTS/)
  assert.equal(tempoFilter(0.25), 'atempo=0.5000,atempo=0.5000')
  assert.equal(tempoFilter(4), 'atempo=2.0000,atempo=2.0000')
  assert.equal(tempoFilter(0.75), 'atempo=0.7500')
  assert.equal(tempoFilter(1), '')
  const withLine = addGainPoint(at2.p, a1.id, 5, 0.3).p
  assert.match(gx(withLine).g, /volume='if\(lt\(t,[\d.]+\)[^']*':eval=frame,atempo=2\.0000/, 'громкость до atempo')

  // отдельный звук хранит свою скорость; возврат берёт скорость видео
  const dv = detachAudio(at2.p, a1.id)
  assert.equal(dv.p.items.find((i) => i.id === dv.id).speed, 2, 'отделённый звук унаследовал скорость')
  const dvSlow = setSpeed(dv.p, [a1.id], 1).p
  assert.equal(dvSlow.items.find((i) => i.id === dv.id).speed, 2, 'смена скорости видео звук не трогает')
  assert.equal(attachAudio(dvSlow, dv.id).p.items.find((i) => i.id === a1.id).speed, 1, 'вернули — темп видео')

  // сохранение и миграция
  const saved = sanitizeProject(JSON.parse(JSON.stringify(at2.p)))
  assert.equal(saved.items.find((i) => i.id === a1.id).speed, 2)
  assert.equal(saved.version, 9)
  const v6 = JSON.parse(JSON.stringify(q))
  v6.version = 6
  for (const it of v6.items) delete it.speed
  assert.ok(sanitizeProject(v6).items.every((i) => i.speed === 1), 'старые проекты: скорость 1')
  const wild = JSON.parse(JSON.stringify(q))
  wild.items[0].speed = 99
  wild.items[1].speed = -3
  assert.deepEqual(sanitizeProject(wild).items.slice(0, 2).map((i) => i.speed), [4, 0.25], 'значения зажаты в 0.25–4')
  void orderedClips
}

// === стоп-кадр и эффекты ===
{
  let q = newProject('Ф')
  q = addMedia(q, V('/a.mp4', 20)).p
  q = addMedia(q, { path: '/m.mp3', name: 'm', duration: 30, hasVideo: false, hasAudio: true, needsPreview: false }).p
  const [qa, qm] = q.media.map((m) => m.id)
  const a1 = insertMedia(q, qa, 0)
  q = a1.p
  const trackV = q.items.find((i) => i.id === a1.id).trackId
  const tail = insertMedia(q, qa, 20, trackV)
  q = tail.p
  q = addMarker(q, trackV, 25, 0, '').p
  const mus = insertMedia(q, qm, 0)
  q = mus.p
  q = applyRecognized(q, qa, 0, 20, [{ id: 0, text: 'раз', start: 8, end: 9 }, { id: 1, text: 'два', start: 12, end: 13 }])
  q = addSubtitles(q, [a1.id])
  q = addGainPoint(q, a1.id, 5, 0.4).p

  const r = insertFreeze(q, a1.id, 10)
  assert.ok(!r.error)
  const items = r.p.items
  const fz = items.find((i) => i.id === r.id)
  assert.deepEqual([fz.kind, fz.start, fz.in, fz.out, fz.audio], ['freeze', 10, 10, 13, false], 'кадр в точке 10 с, длина 3 с, без звука')
  const halves = items.filter((i) => i.kind === 'media' && i.mediaId === qa).sort((x, y) => x.start - y.start)
  assert.equal(halves.length, 3, 'левая, правая и хвост')
  assert.deepEqual([halves[0].start, halves[0].out], [0, 10])
  assert.deepEqual([halves[1].start, halves[1].in, halves[1].out], [13, 10, 20], 'правая половина сдвинута на 3 с и продолжает с того же места')
  near(halves[2].start, 23, 'всё правее на дорожке сдвинулось')
  assert.equal(items.find((i) => i.id === mus.id).start, 0, 'другие дорожки не тронуты')
  near(r.p.markers[0].t, 28, 'метка дорожки сдвинулась')
  // звук делится вместе с видео: линия громкости на стыке одна и та же
  assert.ok(halves[0].audio && halves[1].audio)
  near(itemGainAt(halves[1], 13), itemGainAt(halves[0], 10), 'громкость на стыке не прыгает')
  // субтитры порезаны вместе с видео, на стоп-кадре их нет
  const subs = items.filter((i) => i.kind === 'subs').sort((x, y) => x.start - y.start)
  assert.equal(subs.length, 2)
  assert.deepEqual([subs[1].start, subs[1].in], [13, 10], 'правая часть субтитров сдвинулась с видео')
  assert.deepEqual(subtitleLayers(r.p).flatMap((l) => l.words.map((w) => [w.text, w.start])), [['раз', 8], ['два', 15]], 'слова: до стопкадра на месте, после — сдвинуты на 3 с')
  assert.equal(projectDuration(r.p) >= 43 - 1e-6, true, 'длина проекта выросла на 3 с')
  // у самого края: без резки
  const atStart = insertFreeze(q, a1.id, 0.02)
  assert.equal(atStart.p.items.find((i) => i.id === atStart.id).start, 0)
  assert.equal(atStart.p.items.find((i) => i.id === a1.id).start, 3, 'видео сдвинулось на 3 с')
  assert.equal(atStart.p.items.filter((i) => i.kind === 'media' && i.mediaId === qa).length, 2, 'ничего не разрезано')
  const atEnd = insertFreeze(q, a1.id, 19.99)
  const fe = atEnd.p.items.find((i) => i.id === atEnd.id)
  assert.equal(fe.start, 20)
  near(fe.in, 19.96, 'последний кадр куска')
  near(atEnd.p.items.find((i) => i.id === tail.id).start, 23)
  // отказы
  assert.match(insertFreeze(q, mus.id, 5).error, /куске видео/, 'у звука стоп-кадра нет')
  assert.match(insertFreeze(q, a1.id, 25).error, /курсор/)
  assert.match(insertFreeze(setTrack(q, trackV, { locked: true }), a1.id, 10).error, /закреплена/)
  // длина стопкадра
  const longer = setFreezeLength(r.p, r.id, 5)
  assert.ok(!longer.error)
  near(longer.p.items.find((i) => i.id === r.id).out, 15, 'out = in + длина')
  near(longer.p.items.filter((i) => i.kind === 'media' && i.mediaId === qa).sort((x, y) => x.start - y.start)[1].start, 15, 'правая часть сдвинулась ещё на 2 с')
  const shorter = setFreezeLength(r.p, r.id, 1)
  near(shorter.p.items.filter((i) => i.kind === 'media' && i.mediaId === qa).sort((x, y) => x.start - y.start)[1].start, 11)
  near(setFreezeLength(r.p, r.id, 0).p.items.find((i) => i.id === r.id).out - 10, 0.1, 'не короче 0.1 с')
  assert.match(setFreezeLength(r.p, halves[0].id, 3).error, /не стоп-кадр/)
  // стоп-кадр режется, двигается; trimItem его не трогает
  const sf = splitItem(r.p, r.id, 11)
  const [f1, f2] = [sf.p.items.find((i) => i.id === r.id), sf.p.items.find((i) => i.id === sf.id)]
  assert.deepEqual([f1.in, f1.out, f2.in, f2.out], [10, 11, 10, 12], 'кадр один, длина делится')
  assert.equal(trimItem(r.p, r.id, 'end', 12), r.p)
  // склейка стоп-кадра не берётся
  assert.match(joinItems(r.p, halves[0].id, r.id).error, /видео и звука|разных/)

  // рамки «Клипы» и экспорт клипов: стоп-кадр внутри рамки — её часть
  // второй такой же кусок файла (хвост) в расчёт не берём: берём проект без него
  const clipP = { ...r.p, items: r.p.items.filter((i) => i.id !== tail.id), clips: [makeClip(qa, 5, 15)] }
  const pc = placement(clipP, clipP.clips[0])
  near(pc.start, 5)
  near(pc.end, 18, 'рамка 5–15 с файла вместе со стоп-кадром 3 с')
  const cpf = cropProject(clipP, pc.start, pc.end)
  const cfz = cpf.items.find((i) => i.kind === 'freeze')
  assert.deepEqual([cfz.start, cfz.out - cfz.in], [5, 3])

  // эффекты
  const e1 = addEffect(r.p, [a1.id, r.id, mus.id], 'blur')
  assert.equal(e1.added, 2, 'на видео и стоп-кадр; на звук нельзя')
  assert.equal(e1.p.items.find((i) => i.id === r.id).effects[0].values.strength, 50)
  assert.equal(addEffect(e1.p, [a1.id], 'blur').added, 0, 'второй такой же не добавляется')
  assert.equal(canHaveEffects(r.p, r.p.items.find((i) => i.kind === 'subs')), false)
  assert.equal(canHaveEffects(r.p, r.p.items.find((i) => i.id === mus.id)), false)
  const effId = e1.p.items.find((i) => i.id === a1.id).effects[0].id
  const e2 = patchEffect(e1.p, a1.id, effId, { key: 'strength', value: 80, on: false })
  assert.deepEqual([e2.items.find((i) => i.id === a1.id).effects[0].values.strength, e2.items.find((i) => i.id === a1.id).effects[0].on], [80, false])
  assert.equal(patchEffect(e1.p, a1.id, effId, { key: 'strength', value: 500 }).items.find((i) => i.id === a1.id).effects[0].values.strength, 100)
  assert.equal(removeEffect(e2, a1.id, effId).items.find((i) => i.id === a1.id).effects.length, 0)
  // резка копирует эффекты, склейка не склеивает разные
  const ef = addEffect(q, [a1.id], 'blur').p
  const cutE = splitAt(ef, 7)
  const pe = cutE.items.filter((i) => i.kind === 'media' && i.mediaId === qa && i.start < 20).sort((x, y) => x.start - y.start)
  assert.ok(pe.every((x) => x.effects.length === 1), 'обе половины с эффектом')
  assert.ok(!joinItems(cutE, pe[0].id, pe[1].id).error, 'одинаковые эффекты склеиваются')
  const diff = patchEffect(cutE, pe[1].id, pe[1].effects[0].id, { key: 'strength', value: 10 })
  assert.match(joinItems(diff, pe[0].id, pe[1].id).error, /эффекты/)
  assert.equal(sameEffects(pe[0].effects, pe[1].effects), true)
  // реестр и фильтры
  near(blurSigma(100, 1080), 43.2)
  near(blurSigma(50, 1920), 38.4)
  assert.deepEqual(effectFilters([{ id: 'x', type: 'blur', on: true, values: { strength: 50 } }], 1000), ['gblur=sigma=20.00:steps=2'])
  assert.deepEqual(effectFilters([{ id: 'x', type: 'blur', on: false, values: { strength: 50 } }], 1000), [], 'выключенный не применяется')
  assert.deepEqual(effectFilters([{ id: 'x', type: 'blur', on: true, values: { strength: 0 } }], 1000), [])
  assert.deepEqual(cleanEffects([{ type: 'blur', strength: 999 }, { type: 'blur', values: { strength: 12 } }, { type: 'wow' }, null]).map((e) => [e.type, e.values.strength, e.on]), [['blur', 100, true], ['blur', 12, true]], 'формат v8 (strength) читается, мусор выброшен')

  // граф экспорта: стоп-кадр и эффект
  const optsF = { W: 1280, H: 720, fps: 25, format: 'h264', quality: 'medium', subLayers: [] }
  const gf = (pr) => {
    const c = buildExport(pr, optsF, '/o.mp4')
    return { g: c.args[c.args.indexOf('-filter_complex') + 1], args: c.args, total: c.total }
  }
  const x = gf(e1.p)
  assert.match(x.g, /trim=end_frame=1,setpts=PTS-STARTPTS,fps=25,loop=loop=74:size=1:start=0,setpts=PTS-STARTPTS\+10\.000\/TB/, 'стоп-кадр 3 с = 75 кадров')
  assert.match(x.g, /gblur=sigma=14\.40:steps=2/, 'блюр 50% от высоты 720')
  assert.equal((x.g.match(/\[\d+:a\]/g) ?? []).length, 4, 'звук: левая, правая, хвост и музыка; у стоп-кадра звука нет')
  const ifz = x.args.findIndex((a, i) => a === '-t' && x.args[i + 1] === '0.5')
  assert.ok(ifz > 0 && x.args[ifz - 2] === '-ss' && x.args[ifz - 1] === '10.000', 'вход стоп-кадра: -ss 10.000 -t 0.5')
  assert.match(gf(removeEffect(removeEffect(e1.p, a1.id, effId), r.id, e1.p.items.find((i) => i.id === r.id).effects[0].id)).g, /^((?!gblur).)*$/s, 'без эффектов блюра в графе нет')
  // кадрирование клипа: стоп-кадр тоже кадрируется
  const gc = buildExport(cropProject(clipP, 5, 18), { ...optsF, W: 1080, H: 1920, framing: { mediaId: qa, mode: 'crop', offsetX: 0.5 } }, '/o.mp4')
  assert.match(gc.args[gc.args.indexOf('-filter_complex') + 1], /loop=loop=74:size=1:start=0,setpts=PTS-STARTPTS\+5\.000\/TB\[r\d\];\[r\d\]scale=1080:1920:force_original_aspect_ratio=increase/)

  // сохранение и миграция
  const saved = sanitizeProject(JSON.parse(JSON.stringify(e1.p)))
  assert.equal(saved.version, 9)
  assert.equal(saved.items.find((i) => i.kind === 'freeze').effects[0].type, 'blur')
  assert.equal(saved.version, 9)
  const v7 = JSON.parse(JSON.stringify(q))
  v7.version = 7
  for (const it of v7.items) delete it.effects
  assert.ok(sanitizeProject(v7).items.every((i) => Array.isArray(i.effects) && i.effects.length === 0), 'старые проекты: эффектов нет')
  const badFz = JSON.parse(JSON.stringify(r.p))
  badFz.items.find((i) => i.kind === 'freeze').trackId = badFz.tracks.find((t) => t.kind === 'audio').id
  assert.ok(!sanitizeProject(badFz).items.some((i) => i.kind === 'freeze'), 'стоп-кадр на звуковой дорожке выброшен')
}

// === новые эффекты и кадр ===
{
  assert.deepEqual(EFFECT_TYPES, ['blur', 'bw', 'color'])
  const bw = newEffect('bw')
  assert.equal(bw.values.strength, 100, 'ч/б по умолчанию полностью')
  assert.deepEqual(effectFilters([bw], 720), ['hue=s=0.000'])
  assert.deepEqual(effectFilters([{ ...bw, values: { strength: 40 } }], 720), ['hue=s=0.600'])
  assert.deepEqual(effectFilters([{ ...bw, values: { strength: 0 } }], 720), [], 'нулевая сила — ничего')
  const col = newEffect('color')
  assert.deepEqual(col.values, { brightness: 0, contrast: 0, saturation: 0 })
  assert.deepEqual(effectFilters([col], 720), [], 'нули ничего не меняют — фильтра нет')
  assert.deepEqual(effectFilters([{ ...col, values: { brightness: 20, contrast: -50, saturation: 100 } }], 720), ['eq=brightness=0.100:contrast=0.500:saturation=2.000'])
  assert.equal(clampParam('color', 'contrast', 500), 100)
  assert.equal(clampParam('color', 'wow', 5), null)
  assert.equal(cssFilter([bw], 700), 'grayscale(1.000)')
  assert.equal(cssFilter([col], 700), '')
  assert.match(cssFilter([{ ...col, values: { brightness: 0, contrast: 50, saturation: 0 } }], 700), /contrast\(1\.500\)/)
  assert.match(cssFilter([newEffect('blur'), bw], 1000), /^blur\(20\.0px\) grayscale/, 'порядок — по списку')
  assert.ok(sameEffects([bw], [{ ...bw }]) && !sameEffects([bw], [{ ...bw, values: { strength: 3 } }]))

  // кадр
  assert.ok(isDefaultFrame(DEFAULT_FRAME))
  assert.equal(frameFilters(DEFAULT_FRAME, 1280, 720), null, 'по умолчанию граф не меняется')
  assert.deepEqual(cleanFrame({ scale: 9999, x: -500, cl: 99, cr: 99, ct: 'x' }), { scale: 400, x: -100, y: 0, cl: 90, cr: 5, ct: 0, cb: 0 }, 'зажато, кроп не съедает картинку')
  assert.deepEqual(cleanFrame(null), DEFAULT_FRAME)
  assert.equal(patchFrameValues(DEFAULT_FRAME, { cl: 80 }).cl, 80)
  const both = patchFrameValues({ ...DEFAULT_FRAME, cr: 60 }, { cl: 80 }, 'cl')
  assert.equal(both.cl, 80)
  assert.equal(both.cr, 15, 'уступает противоположная сторона')
  assert.ok(sameFrame(DEFAULT_FRAME, { ...DEFAULT_FRAME }))
  const ff = frameFilters({ ...DEFAULT_FRAME, scale: 50, x: 10, y: -20, cl: 20 }, 1280, 720)
  assert.deepEqual(ff.chain, ['crop=iw*0.8:ih*1:iw*0.2:ih*0', 'scale=trunc(iw*0.5/2)*2:trunc(ih*0.5/2)*2'])
  assert.match(ff.x, /^W\/2\+W\*0\.1\+-?[\d.]+-w\/2$/)
  near(Number(/\+(-?[\d.]+)-w/.exec(ff.x)[1]), 64, 'кроп слева 20% при масштабе 50%: центр остатка сдвинут вправо на 10% ширины × 0.5')
  near(fitSize(1280, 720, 1080, 1920).h, 607.5)
  const rect = frameRect({ ...DEFAULT_FRAME, scale: 200, x: 25 }, 1600, 900, 800, 450)
  near(rect.w, 1600); near(rect.h, 900); near(rect.x, 400 + 200 - 800, 'центр сдвинут на 25% ширины кадра')

  let q = newProject('К')
  q = addMedia(q, V('/a.mp4', 20)).p
  const [qa] = q.media.map((m) => m.id)
  const a1 = insertMedia(q, qa, 0)
  q = a1.p
  const q1 = patchFrame(q, a1.id, { scale: 50, x: 25 })
  assert.deepEqual([q1.items[0].frame.scale, q1.items[0].frame.x], [50, 25])
  assert.equal(patchFrame(q, a1.id, { scale: 1 }).items[0].frame.scale, 10, 'не меньше 10%')
  assert.ok(isDefaultFrame(resetFrame(q1, a1.id).items[0].frame))
  // звук не имеет кадра
  let qm = addMedia(q, { path: '/m.mp3', name: 'm', duration: 30, hasVideo: false, hasAudio: true, needsPreview: false })
  const mu = insertMedia(qm.p, qm.id, 0)
  assert.equal(patchFrame(mu.p, mu.id, { scale: 50 }).items.find((i) => i.id === mu.id).frame.scale, 100)
  // разрез копирует кадр, склейка разного не склеивает
  const cutF = splitAt(q1, 8)
  const [f1, f2] = cutF.items.filter((i) => i.kind === 'media').sort((x, y) => x.start - y.start)
  assert.ok(sameFrame(f1.frame, f2.frame))
  assert.ok(!joinItems(cutF, f1.id, f2.id).error, 'одинаковый кадр склеивается')
  assert.match(joinItems(patchFrame(cutF, f2.id, { x: 0 }), f1.id, f2.id).error, /кадр/)
  // граф экспорта: кроп → масштаб → положение; эффекты до кропа
  const og = { W: 1280, H: 720, fps: 25, format: 'h264', quality: 'medium', subLayers: [] }
  const gq = (pr) => { const c = buildExport(pr, og, '/o.mp4'); return c.args[c.args.indexOf('-filter_complex') + 1] }
  assert.doesNotMatch(gq(q), /crop=|scale=trunc/, 'кадр по умолчанию — старый граф')
  const withAll = patchFrame(addEffect(q, [a1.id], 'bw').p, a1.id, { scale: 50, x: 10, cl: 20 })
  const g2 = gq(withAll)
  assert.match(g2, /hue=s=0\.000,crop=iw\*0\.8:ih\*1:iw\*0\.2:ih\*0,scale=trunc\(iw\*0\.5\/2\)\*2:trunc\(ih\*0\.5\/2\)\*2\[v0\]/, 'эффект → кроп → масштаб')
  assert.match(g2, /overlay=x='W\/2\+W\*0\.1\+[-\d.]+-w\/2':y='H\/2\+H\*0\+[-\d.]+-h\/2'/, 'положение от центра')
  // стоп-кадр и сохранение/миграция
  const fzF = insertFreeze(q1, a1.id, 5)
  assert.ok(sameFrame(fzF.p.items.find((i) => i.id === fzF.id).frame, DEFAULT_FRAME), 'стоп-кадр с кадром по умолчанию')
  const rt = sanitizeProject(JSON.parse(JSON.stringify(q1)))
  assert.equal(rt.version, 9)
  assert.equal(rt.items[0].frame.scale, 50)
  const v8 = JSON.parse(JSON.stringify(q1))
  v8.version = 8
  for (const it of v8.items) { delete it.frame; it.effects = [{ id: 'e', type: 'blur', on: true, strength: 70 }] }
  const mig8 = sanitizeProject(v8)
  assert.ok(isDefaultFrame(mig8.items[0].frame), 'v8: кадр по умолчанию')
  assert.equal(mig8.items[0].effects[0].values.strength, 70, 'v8: блюр переехал без потерь')
}

console.log('mix.ts, audio.ts: все проверки прошли')
