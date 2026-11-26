import assert from 'node:assert/strict'
import {
  CLIP_H,
  CLIP_W,
  addClip,
  clipFileBase,
  clipSubtitleStyle,
  clipText,
  cropProject,
  deleteClip,
  framingChain,
  makeClip,
  moveClipBy,
  orderedClips,
  patchClip,
  placement,
  putClips,
  rulerStep,
  setClipEdge,
  slug,
  snapToWords,
  sourceAt,
  timeToX,
  xToTime,
  zoomAt
} from './cut.ts'
import { addMedia, addSubtitles, applyRecognized, insertMedia, moveItem, newProject, removeMedia, sanitizeProject, splitAt, subtitleLayers, deleteItems } from './project.ts'
import { buildExport } from './exportGraph.ts'

const V = (path, duration) => ({ path, name: path, duration, hasVideo: true, hasAudio: true, width: 1280, height: 720, fps: 25, needsPreview: false })

let p = newProject('Н')
p = addMedia(p, V('/pod.mp4', 100)).p
p = addMedia(p, V('/ov.mov', 5)).p
const [pod, ov] = p.media.map((m) => m.id)
const ins = insertMedia(p, pod, 0)
p = ins.p
const podItem = ins.id

// --- создание и урезание
const a = addClip(p, pod, 10, 30)
assert.ok(a)
p = a.p
assert.deepEqual([p.clips[0].start, p.clips[0].end], [10, 40])
assert.equal(p.clips[0].framing, 'crop')
assert.equal(p.clips[0].offsetX, 0.5)
// точка внутри чужой рамки — встаёт сразу за ней
const b = addClip(p, pod, 20, 30)
assert.equal(b.p.clips[1].start, 40, 'ставится за существующей рамкой')
p = b.p
// упирается в следующую рамку: длина урезана
const c = addClip(p, pod, 70, 40)
p = c.p
assert.equal(p.clips.find((x) => x.id === c.id).end, 100, 'урезана по концу файла')
// упирается в соседа: между началом файла и первой рамкой 10 секунд
const head = addClip(deleteClip(p, c.id), pod, 0, 30)
assert.deepEqual([head.p.clips.at(-1).start, head.p.clips.at(-1).end], [0, 10], 'длина урезана по соседу')
assert.equal(addClip(p, pod, 99.5, 30), null, 'в конце файла места нет')
assert.equal(addClip(p, 'нет', 0), null)

// --- края и сдвиг не пересекают соседей
const [c1, c2] = p.clips
let q = setClipEdge(p, c1.id, 'end', 200)
assert.equal(q.clips.find((x) => x.id === c1.id).end, c2.start, 'конец упирается в соседа')
q = setClipEdge(p, c1.id, 'start', -5)
assert.equal(q.clips.find((x) => x.id === c1.id).start, 0, 'начало не уходит за файл')
q = setClipEdge(p, c1.id, 'start', 39.9)
assert.equal(q.clips.find((x) => x.id === c1.id).start, c1.end - 1, 'не короче одной секунды')
q = moveClipBy(p, c2.id, -100)
assert.equal(q.clips.find((x) => x.id === c2.id).start, c1.end, 'сдвиг упирается в соседа слева')
assert.equal(q.clips.find((x) => x.id === c2.id).end - q.clips.find((x) => x.id === c2.id).start, c2.end - c2.start, 'длина та же')
q = patchClip(p, c1.id, { offsetX: 7, framing: 'fit-blur', title: 'Т' })
assert.equal(q.clips.find((x) => x.id === c1.id).offsetX, 1, 'сдвиг зажат в 0..1')
assert.equal(deleteClip(p, c1.id).clips.length, p.clips.length - 1)

// --- замена и добавление пачкой
const fresh = [makeClip(pod, 0, 5), makeClip(pod, 41, 50)]
const added = putClips(p, pod, fresh, false)
assert.ok(added.clips.some((x) => x.id === fresh[0].id), 'не пересекающаяся рамка добавлена')
assert.ok(!added.clips.some((x) => x.id === fresh[1].id), 'пересекающаяся с уже стоящей не добавлена')
const replaced = putClips(p, pod, fresh, true)
assert.deepEqual(replaced.clips.map((x) => x.id).sort(), fresh.map((x) => x.id).sort(), 'замена убирает старые')
const clash = putClips(p, pod, [makeClip(pod, 12, 20)], false)
assert.equal(clash.clips.length, p.clips.length, 'пересекающаяся с уже стоящей не добавляется')

// --- размещение на таймлайне
p = { ...p, clips: [p.clips.find((x) => x.start === 10)] } // 10..40
let at = placement(p, p.clips[0])
assert.deepEqual([at.start, at.end, at.itemId], [10, 40, podItem], 'видео с нуля: время таймлайна = времени исходника')
// сдвинули видео — рамка за ним
let moved = moveItem(p, podItem, p.tracks[1].id, 5)
at = placement(moved, moved.clips[0])
assert.deepEqual([at.start, at.end], [15, 45])
// вырезали кусок из середины видео (по границе рамки): рамка охватывает оба куска
let cut = splitAt(p, 20)
cut = splitAt(cut, 25)
const mids = cut.items.filter((i) => i.in === 20)
cut = deleteItems(cut, mids.map((i) => i.id), true) // вырезано 20..25, хвост сдвинут
at = placement(cut, cut.clips[0])
assert.equal(at.start, 10)
assert.equal(at.end, 35, 'рамка стала короче на вырезанное')
// видео удалили — рамки на таймлайне нет
assert.equal(placement(deleteItems(p, [podItem]), p.clips[0]), null)
// рамка вне использованного отрезка
let trimmed = p
trimmed = { ...trimmed, items: trimmed.items.map((i) => ({ ...i, in: 50, out: 60 })) }
assert.equal(placement(trimmed, p.clips[0]), null, 'использован другой отрезок файла')

// порядок
let two = addClip(p, pod, 60, 10).p
const ord = orderedClips({ ...two, items: two.items.map((i) => ({ ...i, start: 100 - i.start })) })
assert.equal(ord.length, 2)

// sourceAt
assert.equal(sourceAt(p, pod, 12.5), 12.5)
assert.equal(sourceAt(moved, pod, 20), 15)
assert.equal(sourceAt(p, 'нет', 1), null)

// --- обрезка проекта под рамку, субтитры едут
let s = applyRecognized(p, pod, 0, 100, [
  { id: 0, text: 'до', start: 5, end: 5.4 },
  { id: 1, text: 'внутри', start: 12, end: 12.5 },
  { id: 2, text: 'после', start: 50, end: 50.5 }
])
s = addSubtitles(s, [podItem])
const ovIns = insertMedia(s, ov, 20) // оверлей внахлёст лежит выше
s = ovIns.p
const cp = cropProject(s, 10, 40)
assert.equal(cp.clips.length, 0)
assert.equal(cp.markers.length, 0)
assert.ok(cp.items.every((i) => i.start >= 0 && i.start + (i.out - i.in) <= 30 + 1e-6), 'всё внутри 0..30')
const vid = cp.items.find((i) => i.kind === 'media' && i.mediaId === pod)
assert.deepEqual([vid.start, vid.in, vid.out], [0, 10, 40])
const ovc = cp.items.find((i) => i.mediaId === ov)
assert.deepEqual([ovc.start, ovc.in, ovc.out], [10, 0, 5], 'оверлей сдвинут на начало рамки')
const lay = subtitleLayers(cp)
assert.deepEqual(lay.flatMap((l) => l.words.map((w) => [w.text, w.start])), [['внутри', 2]], 'в слоях только слова рамки, время от начала рамки')
// рамка обрезает кусок посередине
const half = cropProject(s, 12, 14)
assert.deepEqual([half.items.find((i) => i.kind === 'media' && i.mediaId === pod).in, half.items.find((i) => i.kind === 'media' && i.mediaId === pod).out], [12, 14])

// --- граф экспорта клипа
const opts = { W: CLIP_W, H: CLIP_H, fps: 30, format: 'h264', quality: 'medium', subLayers: [] }
let cmd = buildExport(cp, { ...opts, framing: { mediaId: pod, mode: 'crop', offsetX: 0.25 } }, '/o.mp4')
let g = cmd.args[cmd.args.indexOf('-filter_complex') + 1]
assert.equal(cmd.total, 30, 'длина ролика = длине рамки')
assert.match(g, /scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:\(iw-ow\)\*0\.2500/, 'подкаст обрезан в вертикаль со сдвигом')
assert.match(g, /scale=1080:1920:force_original_aspect_ratio=decrease,setsar=1,fps=30/, 'оверлей вписан как обычно')
cmd = buildExport(cp, { ...opts, framing: { mediaId: pod, mode: 'fit-blur', offsetX: 0.5 } }, '/o.mp4')
g = cmd.args[cmd.args.indexOf('-filter_complex') + 1]
assert.match(g, /boxblur/, 'блюр-фон')
assert.match(g, /split=2\[bg\d+\]\[fg\d+\]/)
assert.doesNotThrow(() => cmd)

// фильтр кадра сам по себе
const crop = framingChain('r0', 'v0', 'crop', 0.5, 1081, 1921, '0')
assert.equal(crop.length, 1)
assert.match(crop[0], /^\[r0\]scale=1080:1920/)
assert.equal(framingChain('r0', 'v0', 'fit-blur', 0.5, 1080, 1920, '0').length, 4)

// --- субтитры: стиль для 9:16
assert.deepEqual([clipSubtitleStyle({ posY: 90, blockWidth: 95, size: 7 }).posY, clipSubtitleStyle({ posY: 90, blockWidth: 95, size: 7 }).blockWidth], [72, 88])
assert.equal(clipSubtitleStyle({ posY: 10, blockWidth: 60, size: 7 }).blockWidth, 60, 'узкий блок не расширяется')

// --- удаление файла убирает его рамки
assert.equal(removeMedia(p, pod).clips.length, 0)

// --- сохранение и чтение: v5 сохраняет рамки, битые выбрасывает, нахлёст обрезает
const saved = JSON.parse(JSON.stringify(p))
const back = sanitizeProject(saved)
assert.equal(back.version, 12)
assert.deepEqual(back.clips.map((x) => [x.start, x.end]), [[10, 40]])
const dirty = sanitizeProject({
  ...saved,
  clips: [
    { id: 'a', mediaId: pod, start: 0, end: 20, title: 'А' },
    { id: 'b', mediaId: pod, start: 10, end: 30, hashtags: ['#х', 5] },
    { id: 'c', mediaId: pod, start: 28, end: 28.2 },
    { id: 'd', mediaId: 'нет', start: 0, end: 5 },
    { id: 'e', mediaId: pod, start: 90, end: 500, framing: 'zzz', offsetX: 9 },
    'мусор'
  ]
})
assert.deepEqual(dirty.clips.map((x) => [x.id, x.start, x.end]), [['a', 0, 20], ['b', 20, 30], ['e', 90, 100]], 'нахлёст обрезан, мусор и чужие файлы выброшены, конец в пределах файла')
assert.equal(dirty.clips[1].hashtags.length, 1)
assert.equal(dirty.clips[2].framing, 'crop')
assert.equal(dirty.clips[2].offsetX, 1)
// старый формат рамки (секунды таймлайна, без mediaId) не переносится
assert.equal(sanitizeProject({ ...saved, version: 4, clips: [{ id: 'x', start: 1, end: 9 }] }).clips.length, 0)

// --- привязка к словам
const W = [
  { id: 0, text: 'а', start: 1.0, end: 1.4 },
  { id: 1, text: 'б', start: 1.5, end: 2.0 },
  { id: 2, text: 'в', start: 5.0, end: 5.6 }
]
assert.equal(snapToWords(1.45, W, 'start', 0.1), 1.5)
assert.equal(snapToWords(1.45, W, 'end', 0.1), 1.4)
assert.equal(snapToWords(3.0, W, 'start', 0.1), 3.0)
assert.equal(snapToWords(5.62, W, 'end', 0.1), 5.6)
assert.equal(snapToWords(1.45, [], 'start', 0.1), 1.45)
assert.equal(snapToWords(1.45, W, 'start', 0), 1.45)

// --- имена и тексты
assert.equal(slug('Как мы: "выжили" в лесу?'), 'Как мы выжили в лесу')
assert.equal(slug('///'), '')
const t = makeClip(pod, 0, 5, { title: 'Страшный лес', description: 'О том, как...', hashtags: ['#лес', '#подкаст'] })
assert.equal(clipFileBase(0, t), '01 — Страшный лес')
assert.equal(clipFileBase(11, makeClip(pod, 0, 5)), '12 — клип')
assert.equal(clipText(t), 'Страшный лес\n\nО том, как...\n\n#лес #подкаст\n')
assert.equal(clipText(makeClip(pod, 0, 5)), '\n', 'пустой текст не ломается')

// --- математика таймлайна
const v = { start: 10, pps: 20 }
assert.equal(timeToX(11, v), 20)
assert.equal(xToTime(20, v), 11)
assert.equal(rulerStep(100), 1)
const z = zoomAt(v, 2, 100, 1, 1000)
assert.equal(xToTime(100, z), xToTime(100, v), 'время под курсором на месте')

console.log('cut.ts: все проверки прошли')
