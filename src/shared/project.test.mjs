import assert from 'node:assert/strict'
import {
  MIN_ITEM,
  NEW_TRACK,
  activeAt,
  addMarker,
  addMedia,
  addSubtitles,
  addTrackOf,
  applyRecognized,
  audioTracks,
  deleteItems,
  deleteMarker,
  deleteTlWord,
  editTlText,
  fits,
  insertMedia,
  itemEnd,
  itemTrackKind,
  itemsOn,
  mergeRanges,
  mergeTlWord,
  moveItem,
  moveMarker,
  neededRanges,
  newProject,
  patchMarker,
  projectDuration,
  removeMedia,
  removeTrack,
  sanitizeProject,
  setTlWordTiming,
  setTrack,
  snapPoints,
  snapTo,
  sourceTime,
  splitAt,
  splitItem,
  subsOf,
  subsTargets,
  subtractRanges,
  subtitleLayers,
  timelineWordRefs,
  timelineWords,
  trimItem,
  unlinkSubs,
  videoTracks
} from './project.ts'

const V = (path, duration, extra = {}) => ({ path, name: path, duration, hasVideo: true, hasAudio: true, width: 1281, height: 720, fps: 25, needsPreview: false, ...extra })
const A = (path, duration) => ({ path, name: path, duration, hasVideo: false, hasAudio: true, needsPreview: false })
const get = (p, id) => p.items.find((i) => i.id === id)
const span = (p, id) => [get(p, id).start, itemEnd(get(p, id))]

// ===== новый проект и файлы =====
let p = newProject('Тест', '2026-01-01T00:00:00Z')
assert.equal(p.version, 7)
assert.deepEqual(p.tracks.map((t) => t.kind), ['video', 'video', 'audio'], '2 видео + 1 звук')
assert.ok(p.tracks.every((t) => !t.muted && !t.hidden && !t.locked))
assert.equal(p.canvas, null)
assert.deepEqual(p.markers, [])

let r = addMedia(p, V('/a.mp4', 10))
p = r.p
const ma = r.id
assert.deepEqual(p.canvas, { w: 1280, h: 720 }, 'кадр по первому видео, чётный')
assert.equal(p.fps, 25)
assert.equal(addMedia(p, V('/a.mp4', 10)).id, ma, 'тот же файл не дублируется')
p = addMedia(p, V('/b.mp4', 6, { width: 1080, height: 1920 })).p
p = addMedia(p, V('/c.mp4', 4)).p
p = addMedia(p, A('/music.mp3', 30)).p
const [, mb, mc, mm] = p.media.map((m) => m.id)
assert.deepEqual(p.canvas, { w: 1280, h: 720 }, 'второе видео кадр не меняет')

// ===== вставка: слои, без магнита =====
const [top0, bottom0] = videoTracks(p).map((t) => t.id)
r = insertMedia(p, ma, 0)
p = r.p
const ia = r.id
assert.equal(get(p, ia).trackId, bottom0, 'по умолчанию — самая нижняя видеодорожка')
r = insertMedia(p, mb, 100)
p = r.p
const ib = r.id
assert.equal(get(p, ib).start, 100, 'никакого магнита: куски стоят где положили')
assert.equal(get(p, ib).trackId, bottom0)
r = insertMedia(p, mc, 5)
p = r.p
const ic = r.id
assert.equal(get(p, ic).trackId, top0, 'занято — ближайшая свободная выше')
assert.equal(get(p, ic).start, 5)
r = insertMedia(p, mc, 6) // занято и внизу, и вверху
p = r.p
const id2 = r.id
assert.equal(videoTracks(p).length, 3, 'нет места — новая дорожка')
assert.equal(videoTracks(p)[0].id, get(p, id2).trackId, 'новая — самый верхний слой')
assert.equal(projectDuration(p), 106)
r = insertMedia(p, mm, 3)
p = r.p
const im = r.id
assert.equal(get(p, im).trackId, audioTracks(p)[0].id, 'звук — на звуковую дорожку')
r = insertMedia(p, mm, 5)
p = r.p
assert.equal(audioTracks(p).length, 2, 'звук внахлёст — новая звуковая снизу')
assert.equal(p.tracks.at(-1).id, get(p, r.id).trackId)
p = deleteItems(p, [r.id])
assert.equal(audioTracks(p).length, 2, 'пустые дорожки остаются, сами не исчезают')
p = removeTrack(p, p.tracks.at(-1).id)
assert.equal(audioTracks(p).length, 1)
assert.equal(removeTrack(p, audioTracks(p)[0].id), p, 'последняя звуковая не удаляется')
assert.equal(removeTrack(p, get(p, ia).trackId), p, 'непустую дорожку не удалить')
p = deleteItems(p, [id2])
p = removeTrack(p, videoTracks(p)[0].id)
assert.equal(videoTracks(p).length, 2)

// новая дорожка по запросу
let n = newProject('N')
n = addMedia(n, V('/a.mp4', 10)).p
const na = n.media[0].id
r = insertMedia(n, na, 3, NEW_TRACK)
n = r.p
assert.equal(n.tracks[0].id, get(n, r.id).trackId, 'новая видеодорожка — самая верхняя')
assert.equal(videoTracks(n).length, 3)
n = addTrackOf(n, 'audio').p
assert.equal(n.tracks.at(-1).kind, 'audio')
assert.ok(n.tracks.slice(0, 3).every((t) => t.kind === 'video'), 'видео всегда над звуком')

// ===== перенос =====
const topId = videoTracks(p)[0].id
const botId = videoTracks(p)[1].id
p = moveItem(p, ib, topId, 50)
assert.deepEqual([get(p, ib).trackId, get(p, ib).start], [topId, 50], 'на другую дорожку и в другую точку')
p = moveItem(p, ib, botId, 3) // на нижней 3..9 занято куском a (0..10) → вверх, но вверху 5..9 занято c → новая
assert.equal(videoTracks(p).length, 3)
assert.equal(get(p, ib).start, 3)
assert.notEqual(get(p, ib).trackId, botId)
assert.equal(moveItem(p, ib, audioTracks(p)[0].id, 0), p, 'видео нельзя на звуковую дорожку')
assert.equal(moveItem(p, im, botId, 0), p, 'звук нельзя на видеодорожку')
p = moveItem(p, ib, NEW_TRACK, 70)
assert.equal(videoTracks(p)[0].id, get(p, ib).trackId, 'NEW_TRACK — новая верхняя')
assert.equal(get(p, ib).start, 70)
p = moveItem(p, ib, botId, 100)
assert.equal(get(p, ib).trackId, botId)
p = moveItem(p, im, NEW_TRACK, 40)
assert.equal(p.tracks.at(-1).id, get(p, im).trackId, 'звук с NEW_TRACK — новая нижняя')
p = moveItem(p, im, audioTracks(p)[0].id, 3)
assert.equal(get(p, im).trackId, audioTracks(p)[0].id)

// ===== замок и скрытие =====
const lk = setTrack(p, botId, { locked: true })
assert.equal(moveItem(lk, ia, topId, 0), lk, 'кусок закреплённой дорожки не двигается')
assert.equal(trimItem(lk, ia, 'end', 3), lk, 'не обрезается')
assert.equal(splitItem(lk, ia, 4).id, '', 'не режется')
assert.equal(deleteItems(lk, [ia]), lk, 'не удаляется')
assert.equal(moveItem(lk, ic, botId, 20), lk, 'на закреплённую дорожку не перенести')
const lk2 = insertMedia(lk, mc, 30, botId)
assert.notEqual(get(lk2.p, lk2.id).trackId, botId, 'и вставка на закреплённую уходит выше')
assert.equal(setTrack(p, botId, { hidden: true }).tracks.find((t) => t.id === botId).hidden, true)

// ===== правка краёв =====
p = moveItem(p, ia, botId, 20) // a: 20..30 на нижней
p = trimItem(p, ia, 'end', 25)
assert.deepEqual(span(p, ia), [20, 25])
p = trimItem(p, ia, 'start', 22)
assert.deepEqual([get(p, ia).in, get(p, ia).start], [2, 22], 'левый край меняет in и start')
p = trimItem(p, ia, 'start', -100)
assert.deepEqual([get(p, ia).in, get(p, ia).start], [0, 20], 'левее начала файла нельзя')
p = trimItem(p, ia, 'end', 1000)
assert.equal(get(p, ia).out, 10, 'правее конца файла нельзя')
p = trimItem(p, ia, 'end', 0)
assert.ok(Math.abs(itemEnd(get(p, ia)) - get(p, ia).start - MIN_ITEM) < 1e-9, 'не короче MIN_ITEM')
p = trimItem(p, ia, 'end', 1000)
p = moveItem(p, ib, botId, 33) // b: 33..39 на нижней
p = trimItem(p, ia, 'end', 1000)
assert.equal(itemEnd(get(p, ia)), 30)
p = moveItem(p, ia, botId, 24) // 24..34 пересекается с b (33..39) → уйдёт выше
assert.notEqual(get(p, ia).trackId, botId)
p = moveItem(p, ia, botId, 20)
p = trimItem(p, ib, 'start', 0)
assert.equal(get(p, ib).start, 33, 'левее начала файла (in = 0) тянуть нельзя')

// край упирается в соседа на той же дорожке
let nb = newProject('NB')
nb = addMedia(nb, V('/a.mp4', 10)).p
nb = addMedia(nb, V('/b.mp4', 10)).p
const nbLow = videoTracks(nb)[1].id
const na1 = insertMedia(nb, nb.media[0].id, 0)
nb = na1.p
nb = trimItem(nb, na1.id, 'end', 5) // a: 0..5
const nb2 = insertMedia(nb, nb.media[1].id, 8) // b: 8..18
nb = nb2.p
assert.equal(get(nb, nb2.id).trackId, nbLow)
nb = trimItem(nb, na1.id, 'end', 1000)
assert.equal(itemEnd(get(nb, na1.id)), 8, 'правый край a упёрся в начало b (файл позволял до 10)')
// левый край b тоже не заходит на a: двигаем b так, чтобы в файле было куда тянуть
nb = trimItem(nb, nb2.id, 'start', 12) // b: start 12, in 4
nb = moveItem(nb, nb2.id, nbLow, 9) // b: 9..15, in 4 (файл позволяет начать с 5)
nb = trimItem(nb, na1.id, 'end', 7) // a: 0..7
nb = trimItem(nb, nb2.id, 'start', 0)
assert.equal(get(nb, nb2.id).start, 7, 'левый край b упёрся в конец a, а файл позволял начать на 5 с')

// ===== разрез =====
r = splitItem(p, ia, 25)
p = r.p
const iaR = r.id
assert.deepEqual([get(p, ia).in, get(p, ia).out, get(p, iaR).in, get(p, iaR).out, get(p, iaR).start], [0, 5, 5, 10, 25])
assert.equal(get(p, iaR).trackId, get(p, ia).trackId)
assert.equal(splitItem(p, ia, 20.01).id, '', 'у самого края — не режем')
const nBefore = p.items.length
p = splitAt(p, 22)
assert.ok(p.items.length > nBefore, 'S режет всё под курсором')

// ===== снизу вверх и время исходника =====
const act = activeAt(p, 26)
const order = act.map((i) => p.tracks.findIndex((t) => t.id === i.trackId))
assert.deepEqual(order, [...order].sort((x, y) => y - x), 'порядок снизу вверх')
assert.equal(sourceTime(get(p, iaR), 27), 7)

// ===== удаление: дыра и закрытие дыры =====
let g = newProject('G')
g = addMedia(g, V('/a.mp4', 10)).p
g = addMedia(g, V('/b.mp4', 10)).p
g = addMedia(g, V('/c.mp4', 10)).p
g = addMedia(g, V('/d.mp4', 10)).p
const [ga, gb, gc, gd] = g.media.map((m) => m.id)
const gU = videoTracks(g)[0].id
const x1 = insertMedia(g, ga, 0)
g = x1.p
const x2 = insertMedia(g, gb, 10)
g = x2.p
const x3 = insertMedia(g, gc, 20)
g = x3.p
const x4 = insertMedia(g, gd, 25, gU)
g = x4.p
assert.deepEqual([span(g, x1.id), span(g, x2.id), span(g, x3.id)], [[0, 10], [10, 20], [20, 30]])
assert.equal(get(g, x4.id).trackId, gU)
const del = deleteItems(g, [x2.id])
assert.deepEqual([span(del, x1.id), span(del, x3.id)], [[0, 10], [20, 30]], 'Delete оставляет дыру')
assert.equal(del.items.length, g.items.length - 1)
let rip = deleteItems(g, [x2.id], true)
assert.deepEqual([span(rip, x1.id), span(rip, x3.id)], [[0, 10], [10, 20]], 'Shift+Delete закрывает дыру')
assert.deepEqual(span(rip, x4.id), span(g, x4.id), 'другие дорожки не сдвигаются')
let mk = addMarker(g, get(g, x3.id).trackId, 25, 2, 'после').p
mk = deleteItems(mk, [x2.id], true)
assert.equal(mk.markers[0].t, 15, 'метка правее удалённого сдвинулась')
assert.equal(deleteItems(g, []), g)
rip = deleteItems(g, [x1.id, x2.id], true)
assert.deepEqual(span(rip, x3.id), [0, 10], 'две дырки закрыты одним сдвигом')

// ===== метки =====
let m1 = newProject('M')
const tv = videoTracks(m1)[0].id
r = addMarker(m1, tv, 12.3456, 4, 'Дописать')
m1 = r.p
assert.deepEqual(m1.markers.map((m) => [m.trackId, m.t, m.color, m.text]), [[tv, 12.346, 4, 'Дописать']])
m1 = addMarker(m1, tv, 3).p
assert.deepEqual(m1.markers.map((m) => m.t), [3, 12.346], 'метки отсортированы по времени')
assert.equal(addMarker(m1, 'нет-такой', 1).id, '', 'на несуществующую дорожку нельзя')
m1 = moveMarker(m1, r.id, 1)
assert.deepEqual(m1.markers.map((m) => m.t), [1, 3])
m1 = patchMarker(m1, r.id, { color: 99, text: 'х'.repeat(200) })
assert.equal(m1.markers[0].color, 5, 'цвет ограничен палитрой')
assert.equal(m1.markers[0].text.length, 80)
m1 = patchMarker(m1, r.id, { text: '' })
assert.equal(m1.markers[0].text, '')
m1 = deleteMarker(m1, r.id)
assert.equal(m1.markers.length, 1)
assert.equal(projectDuration(m1), 0, 'метки не влияют на длину')
m1 = addTrackOf(m1, 'video').p
const extra = m1.tracks[0].id
m1 = addMarker(m1, extra, 5).p
m1 = removeTrack(m1, extra)
assert.ok(!m1.markers.some((m) => m.trackId === extra), 'метки удалённой дорожки удалены')

// ===== субтитры: связанные куски =====
let s = newProject('S')
s = addMedia(s, V('/v.mp4', 100)).p
s = addMedia(s, V('/w.mp4', 50)).p
const sv = s.media[0].id
const sw = s.media[1].id
const sTop = videoTracks(s)[0].id
const sBot = videoTracks(s)[1].id
r = insertMedia(s, sv, 0)
s = r.p
const vid = r.id
s = splitItem(s, vid, 10).p
const firstPart = itemsOn(s, sBot)[0].id
s = deleteItems(s, [firstPart]) // остаётся 10..100 исходника на 10..100 таймлайна
const vkeep = itemsOn(s, sBot)[0]
assert.deepEqual([vkeep.start, vkeep.in, vkeep.out], [10, 10, 100])
s = applyRecognized(s, sv, 0, 100, [
  { id: 0, text: 'лишнее', start: 2, end: 2.5 },
  { id: 1, text: 'привет', start: 12, end: 12.6 },
  { id: 2, text: 'мир', start: 12.7, end: 13.2 },
  { id: 3, text: 'пока', start: 20, end: 20.5 }
])
assert.deepEqual(timelineWordRefs(s), [], 'субтитров ещё нет — слов на таймлайне нет')
s = addSubtitles(s, [vkeep.id])
const sub = subsOf(s, vkeep.id)[0]
assert.ok(sub, 'кусок субтитров создан')
assert.equal(sub.kind, 'subs')
assert.equal(sub.link, vkeep.id)
assert.equal(sub.trackId, sTop, 'по умолчанию — на самой верхней дорожке')
assert.deepEqual([sub.start, sub.in, sub.out], [10, 10, 100])
assert.equal(itemTrackKind(s, sub), 'video')
assert.equal(addSubtitles(s, [vkeep.id]).items.length, s.items.length, 'второй раз не дублируется')
let refs = timelineWordRefs(s)
assert.deepEqual(refs.map((w) => [w.text, w.start, w.idx]), [['привет', 12, 1], ['мир', 12.7, 2], ['пока', 20, 3]], 'слово до куска отброшено')
assert.ok(refs.every((w) => w.itemId === sub.id && w.trackId === sTop))

let mv = moveItem(s, vkeep.id, sBot, 50)
assert.deepEqual(span(mv, sub.id), [50, 140], 'субтитры поехали вместе с видео')
assert.deepEqual(timelineWordRefs(mv).map((w) => w.start), [52, 52.7, 60])
mv = trimItem(s, vkeep.id, 'start', 15)
assert.deepEqual([get(mv, sub.id).start, get(mv, sub.id).in], [15, 15], 'обрезка видео = обрезка субтитров')
mv = trimItem(s, vkeep.id, 'start', 12.5)
assert.deepEqual(timelineWordRefs(mv).map((w) => w.text), ['мир', 'пока'], 'слово, которое обрезали, ушло')
const sp = splitItem(s, vkeep.id, 30)
const rightVideo = sp.id
assert.equal(subsOf(sp.p, vkeep.id).length, 1)
assert.equal(subsOf(sp.p, rightVideo).length, 1, 'у правой половины видео своя половина субтитров')
assert.deepEqual(span(sp.p, subsOf(sp.p, rightVideo)[0].id), span(sp.p, rightVideo))
assert.deepEqual(span(sp.p, subsOf(sp.p, vkeep.id)[0].id), span(sp.p, vkeep.id))
assert.equal(deleteItems(s, [vkeep.id]).items.some((i) => i.kind === 'subs'), false, 'удалили видео — субтитры тоже')
assert.equal(deleteItems(s, [vkeep.id], true).items.length, 0)
assert.equal(deleteItems(setTrack(s, sBot, { locked: true }), [vkeep.id]).items.length, 2, 'видео закреплено — субтитры целы')
const detached = moveItem(s, sub.id, sTop, 60)
assert.equal(get(detached, sub.id).link, null, 'сдвинули сами субтитры — связь разорвана')
assert.deepEqual(span(detached, vkeep.id), [10, 100], 'видео осталось на месте')
assert.equal(get(trimItem(s, sub.id, 'end', 50), sub.id).link, null)
const free = unlinkSubs(s, sub.id)
assert.equal(deleteItems(free, [vkeep.id]).items.filter((i) => i.kind === 'subs').length, 1, 'несвязанные субтитры переживают видео')

// два видео одновременно на разных дорожках: субтитры второго уходят на новую дорожку
let two = s
const w1 = insertMedia(two, sw, 30, sBot)
two = w1.p
assert.notEqual(get(two, w1.id).trackId, sBot, 'второе видео внахлёст ушло на другую дорожку')
two = addSubtitles(two, [w1.id])
const subW = subsOf(two, w1.id)[0]
assert.notEqual(subW.trackId, sub.trackId, 'тесно — субтитры второго видео на отдельной дорожке')
assert.equal(subW.trackId, videoTracks(two)[0].id, 'новая — самая верхняя')
assert.equal(subtitleLayers(two).length, 1, 'у второго видео слов нет — слоя нет')
two = applyRecognized(two, sw, 0, 50, [{ id: 0, text: 'тест', start: 1, end: 1.5 }])
const ls = subtitleLayers(two)
assert.equal(ls.length, 2, 'два слоя субтитров')
assert.deepEqual(ls.map((l) => l.trackId), two.tracks.map((t) => t.id).filter((id) => ls.some((l) => l.trackId === id)), 'слои — сверху вниз')
const hid = setTrack(two, subW.trackId, { hidden: true })
assert.equal(subtitleLayers(hid).length, 1, 'скрытая дорожка не показывает субтитры')
assert.ok(!timelineWordRefs(hid).some((w) => w.mediaId === sw))
assert.ok(timelineWords(two).length > timelineWords(hid).length)
assert.deepEqual(timelineWords(two).map((w) => w.id), timelineWords(two).map((_, i) => i))

// ===== правка слов с обратным пересчётом =====
s = editTlText(s, timelineWordRefs(s)[0], 'здравствуй')
assert.equal(s.words[sv][1].text, 'здравствуй')
s = editTlText(s, timelineWordRefs(s)[1], 'мой мир')
assert.deepEqual(timelineWordRefs(s).map((w) => w.text), ['здравствуй', 'мой', 'мир', 'пока'])
refs = timelineWordRefs(s)
s = mergeTlWord(s, refs[1])
assert.equal(timelineWordRefs(s).length, 3, 'два слова склеены в одно')
refs = timelineWordRefs(s)
const wordBefore = s.words[sv][refs[2].idx]
s = setTlWordTiming(s, refs[2], { end: refs[2].end + 0.2 })
assert.ok(Math.abs(s.words[sv][refs[2].idx].end - (wordBefore.end + 0.2)) < 1e-9, 'сдвиг на таймлайне = сдвиг в файле')
const fresh = timelineWordRefs(s)[2]
assert.equal(setTlWordTiming(s, fresh, { end: fresh.end }), null, 'без изменений — null')
s = deleteTlWord(s, timelineWordRefs(s)[0])
assert.equal(timelineWordRefs(s).length, 2)
const keep = s.words[sv].length
assert.equal(deleteItems(s, [vkeep.id]).words[sv].length, keep, 'слова хранятся у файла, а не у куска')
assert.equal(removeMedia(s, sv).words[sv], undefined, 'убрали файл — слова ушли')
assert.equal(removeMedia(s, sv).items.length, 0, 'и все его куски, включая субтитры')

// ===== отрезки, что распознавать =====
assert.deepEqual(mergeRanges([[5, 8], [0, 3], [2, 4], [8, 9]]), [[0, 4], [5, 9]])
assert.deepEqual(mergeRanges([[0, 3], [3.5, 6]], 1), [[0, 6]])
assert.deepEqual(mergeRanges([[2, 2], [4, 3]]), [])
assert.deepEqual(subtractRanges([[0, 10]], [[2, 4], [6, 7]]), [[0, 2], [4, 6], [7, 10]])
assert.deepEqual(subtractRanges([[0, 10]], [[0, 10]]), [])
assert.deepEqual(subtractRanges([[0, 10]], [[-5, 3], [8, 20]]), [[3, 8]])
assert.deepEqual(subtractRanges([[0, 4], [6, 9]], [[3, 7]]), [[0, 3], [7, 9]])

let r1 = newProject('R')
r1 = addMedia(r1, V('/long.mp4', 5000)).p
r1 = addMedia(r1, A('/b.mp3', 20)).p
r1 = addMedia(r1, V('/mute.mp4', 10, { hasAudio: false })).p
const [lg, au, mu] = r1.media.map((m) => m.id)
const lowT = videoTracks(r1)[1].id
const ins = insertMedia(r1, lg, 0)
r1 = splitItem(ins.p, ins.id, 20).p
const lp = itemsOn(r1, lowT)
r1 = { ...r1, items: r1.items.map((i) => (i.id === lp[0].id ? { ...i, in: 100, out: 120, start: 0 } : i.id === lp[1].id ? { ...i, in: 3000, out: 3010, start: 20 } : i)) }
r1 = insertMedia(r1, mu, 100).p
r1 = insertMedia(r1, au, 0).p
const lowItems = itemsOn(r1, lowT).filter((i) => i.mediaId === lg)
assert.deepEqual(subsTargets(r1, []).map((i) => i.id), lowItems.map((i) => i.id), 'без выделения — видео со звуком на самой нижней занятой дорожке')
const audioItem = r1.items.find((i) => i.mediaId === au)
assert.deepEqual(subsTargets(r1, [audioItem.id]).map((i) => i.id), [audioItem.id], 'выделенное со звуком')
assert.deepEqual(subsTargets(r1, [r1.items.find((i) => i.mediaId === mu).id]).map((i) => i.mediaId), [lg, lg], 'выделено немое — берём нижнюю дорожку')
assert.deepEqual(neededRanges(r1, lowItems), [{ mediaId: lg, from: 99, to: 121 }, { mediaId: lg, from: 2999, to: 3011 }])
assert.deepEqual(neededRanges(r1, [audioItem]), [{ mediaId: au, from: 0, to: 20 }], 'запас не выходит за файл')
r1 = applyRecognized(r1, lg, 99, 121, [{ id: 0, text: 'раз', start: 100.5, end: 101 }, { id: 1, text: 'два', start: 110, end: 110.4 }])
assert.deepEqual(r1.covered[lg], [[99, 121]])
assert.deepEqual(neededRanges(r1, lowItems), [{ mediaId: lg, from: 2999, to: 3011 }], 'первая часть уже распознана')
assert.deepEqual(neededRanges(r1, [{ ...lowItems[0], in: 100, out: 130 }]), [{ mediaId: lg, from: 121, to: 131 }])
r1 = applyRecognized(r1, lg, 3000, 3010, [{ id: 0, text: 'там', start: 3001, end: 3001.5 }])
r1 = applyRecognized(r1, lg, 99, 121, [{ id: 0, text: 'новое', start: 105, end: 105.5 }])
assert.deepEqual(r1.words[lg].map((w) => w.text), ['новое', 'там'])

// ===== привязка =====
assert.deepEqual(snapPoints(g), [0, 10, 20, 25, 30, 35])
assert.equal(snapTo(9.95, [0, 10], 0.1), 10)
assert.equal(snapTo(9.5, [0, 10], 0.1), 9.5)
const gLow = get(g, x1.id).trackId
assert.ok(fits(g, gLow, 30, 40))
assert.ok(!fits(g, gLow, 25, 40))
assert.ok(fits(g, gLow, 25, 40, x3.id))

// ===== сохранение и миграция =====
const round = sanitizeProject(JSON.parse(JSON.stringify(two)))
const key = (q) => q.items.map((i) => [i.id, i.kind, i.start, i.link]).sort()
assert.deepEqual(key(round), key(two), 'v4 переживает сохранение как есть')
assert.deepEqual(round.tracks, two.tracks)
assert.deepEqual(round.covered[sw], two.covered[sw])
const withMark = addMarker(two, two.tracks[0].id, 7, 3, 'тест').p
assert.deepEqual(sanitizeProject(JSON.parse(JSON.stringify(withMark))).markers, withMark.markers, 'метки сохраняются')
assert.equal(sanitizeProject({ version: 2 }), null)
assert.equal(sanitizeProject('мусор'), null)

// v3: «Основная» дорожка становится обычной, флаг subs — связанным куском
const legacy = {
  version: 3,
  id: 'pold',
  name: 'Старый',
  media: [{ id: 'm1', path: '/x.mp4', duration: 10, hasVideo: true, hasAudio: true }],
  tracks: [
    { id: 'tv', kind: 'video', main: false, muted: false },
    { id: 'tm', kind: 'video', main: true, muted: true },
    { id: 'ta', kind: 'audio', main: false, muted: false }
  ],
  items: [{ id: 'i1', mediaId: 'm1', trackId: 'tm', start: 0, in: 2, out: 8, subs: true, volume: 0.5 }],
  words: { m1: [{ id: 0, text: 'а', start: 3, end: 3.4 }] },
  covered: { m1: [[0, 10]] }
}
const mig = sanitizeProject(legacy)
assert.equal(mig.version, 7)
assert.deepEqual(mig.tracks.map((t) => t.id), ['tv', 'tm', 'ta'])
assert.equal(mig.tracks[1].muted, true, 'настройки дорожки сохранились')
assert.ok(mig.tracks.every((t) => t.locked === false && t.hidden === false))
assert.equal(mig.items.find((i) => i.kind === 'media').volume, 0.5)
const migSub = mig.items.find((i) => i.kind === 'subs')
assert.ok(migSub && migSub.link === 'i1', 'субтитры стали связанным куском')
assert.equal(migSub.trackId, 'tv', 'на верхней свободной дорожке')
assert.deepEqual(timelineWordRefs(mig).map((w) => [w.text, w.start]), [['а', 1]])

const broken = sanitizeProject({
  version: 4,
  name: 'Б',
  media: [{ id: 'm1', path: '/x.mp4', duration: 10, hasVideo: true }, { id: 'bad' }],
  tracks: [{ id: 't1', kind: 'video' }, { id: 't2', kind: 'zzz' }],
  items: [
    { id: 'i1', mediaId: 'm1', trackId: 't1', start: 50, in: 0, out: 4 },
    { id: 'i2', mediaId: 'нет', trackId: 't1', start: 0, in: 0, out: 4 },
    { id: 'i3', mediaId: 'm1', trackId: 't1', start: 1, in: 2, out: 2 },
    { id: 'i4', kind: 'subs', mediaId: 'm1', trackId: 'ta-нет', start: 0, in: 0, out: 2, link: 'i1' },
    { id: 'i5', kind: 'subs', mediaId: 'm1', trackId: 't1', start: 0, in: 0, out: 2, link: 'i-удалён' }
  ],
  markers: [{ id: 'k1', trackId: 't1', t: 3, color: 9, text: 'ок' }, { id: 'k2', trackId: 'нет', t: 3 }, { id: 'k3', trackId: 't1', t: -1 }],
  words: { m1: [{ text: 'а', start: 0, end: 1 }, { text: 'б', start: 2, end: 1 }], чужой: [] }
})
assert.deepEqual(broken.items.map((i) => i.id), ['i1'], 'битые куски выброшены, осиротевшие субтитры убраны')
assert.ok(broken.tracks.some((t) => t.kind === 'audio'), 'звуковая дорожка добавлена')
assert.deepEqual(broken.markers.map((m) => [m.id, m.color]), [['k1', 5]], 'битые метки выброшены, цвет ограничен')
assert.deepEqual(broken.words.m1.map((w) => w.text), ['а'])

console.log('project.ts: все проверки прошли')
