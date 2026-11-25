import assert from 'node:assert/strict'
import {
  MIN_CLIP,
  clipFileBase,
  clipText,
  clipWords,
  framingFilter,
  fromCandidates,
  makeClip,
  moveClip,
  overlaps,
  resizeClip,
  rulerStep,
  sanitizeClips,
  slug,
  snapToWords,
  timeToX,
  xToTime,
  zoomAt
} from './cut.ts'

const D = 100
const c = makeClip(10, 20)
assert.equal(c.framing, 'crop')
assert.equal(c.offsetX, 0.5)
assert.equal(c.enabled, true)
assert.notEqual(makeClip(0, 1).id, makeClip(0, 1).id, 'id уникальны')

// --- сдвиг и края
assert.deepEqual([moveClip(c, 5, D).start, moveClip(c, 5, D).end], [15, 25])
assert.deepEqual([moveClip(c, -50, D).start, moveClip(c, -50, D).end], [0, 10], 'не уходит в минус, длина та же')
assert.deepEqual([moveClip(c, 500, D).start, moveClip(c, 500, D).end], [90, 100], 'не выходит за конец файла')
assert.equal(resizeClip(c, 'start', 12, D).start, 12)
assert.equal(resizeClip(c, 'start', 19.9, D).start, 20 - MIN_CLIP, 'край не заходит за другой')
assert.equal(resizeClip(c, 'start', -3, D).start, 0)
assert.equal(resizeClip(c, 'end', 200, D).end, D)
assert.equal(resizeClip(c, 'end', 10.2, D).end, 10 + MIN_CLIP)
assert.equal(c.start, 10, 'вход не мутируется')

// --- привязка к словам
const W = [
  { id: 0, text: 'а', start: 1.0, end: 1.4 },
  { id: 1, text: 'б', start: 1.5, end: 2.0 },
  { id: 2, text: 'в', start: 5.0, end: 5.6 }
]
assert.equal(snapToWords(1.45, W, 'start', 0.1), 1.5, 'начало тянется к началу слова')
assert.equal(snapToWords(1.45, W, 'end', 0.1), 1.4, 'конец тянется к концу слова')
assert.equal(snapToWords(3.0, W, 'start', 0.1), 3.0, 'далеко от слов — без привязки')
assert.equal(snapToWords(5.62, W, 'end', 0.1), 5.6)
assert.equal(snapToWords(1.45, [], 'start', 0.1), 1.45)
assert.equal(snapToWords(1.45, W, 'start', 0), 1.45, 'привязка выключена')

// --- слова клипа
const cw = clipWords(W, { start: 1.2, end: 5.3 })
assert.deepEqual(cw.map((w) => w.text), ['а', 'б', 'в'], 'середины внутри рамки')
assert.equal(cw[0].start, 0, 'слово, начавшееся до рамки, обрезано по её началу')
assert.equal(cw[1].start, 0.3)
assert.equal(cw[2].end, 4.1, 'обрезано по концу рамки')
assert.deepEqual(cw.map((w) => w.id), [0, 1, 2])
assert.deepEqual(clipWords(W, { start: 1.3, end: 1.6 }).map((w) => w.text), [], 'середины снаружи — слов нет')
assert.equal(clipWords(W, { start: 0, end: 1.25 }).length, 1)

assert.ok(overlaps({ start: 0, end: 5 }, { start: 4, end: 6 }))
assert.ok(!overlaps({ start: 0, end: 5 }, { start: 5, end: 6 }), 'касание — не пересечение')

// --- фильтры кадра
const crop = framingFilter('crop', 0.25, 1080, 1920)
assert.match(crop, /^\[0:v\]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:\(iw-ow\)\*0\.2500:\(ih-oh\)\/2,setsar=1\[base\]$/)
assert.match(framingFilter('crop', 7, 1081, 1921), /crop=1080:1920:\(iw-ow\)\*1\.0000/, 'чётные размеры и сдвиг зажат')
const blur = framingFilter('fit-blur', 0.5, 1080, 1920)
assert.match(blur, /split=2/)
assert.match(blur, /boxblur/)
assert.match(blur, /force_original_aspect_ratio=decrease/)
assert.match(blur, /\[base\]$/)

// --- имена файлов и тексты
assert.equal(slug('Как я: сбежала / от "похитителей"?'), 'Как я сбежала от похитителей')
assert.equal(slug('   ...  '), '')
assert.equal(slug('a'.repeat(100)).length, 60)
assert.equal(slug('Конец.'), 'Конец')
assert.equal(clipFileBase(0, { ...c, title: 'Шторм в море' }), '01 Шторм в море')
assert.equal(clipFileBase(11, { ...c, title: '' }), '12 клип')
assert.equal(clipText({ ...c, title: 'Т', description: 'Д', hashtags: ['#а', '#б'] }), 'Т\n\nД\n\n#а #б\n')
assert.equal(clipText({ ...c, title: 'Т', description: '', hashtags: [] }), 'Т\n')

// --- из кандидатов ИИ
const fc = fromCandidates([{ id: 0, start: 1, end: 31, firstWord: 0, lastWord: 5, score: 8, title: 'Т', reason: 'р', description: 'д', hashtags: ['#х'], overlayAt: 12, approx: false }])
assert.equal(fc[0].score, 8)
assert.equal(fc[0].overlayAt, 12)
assert.equal(fc[0].framing, 'crop')

// --- проверка рамок из файла
const sc = sanitizeClips([
  { id: 'x', start: 30, end: 50, title: 'Б', framing: 'fit-blur', offsetX: 3, enabled: false, score: 7 },
  { start: 5, end: 20 },
  { start: 'плохо', end: 3 },
  { start: 10, end: 10.1 },
  null,
  { start: 95, end: 130 },
  { start: 200, end: 210 }
], 100)
assert.deepEqual(sc.map((x) => x.start), [5, 30, 95], 'отсортировано, битые выброшены, за концом файла — тоже')
assert.equal(sc[1].framing, 'fit-blur')
assert.equal(sc[1].offsetX, 1)
assert.equal(sc[1].enabled, false)
assert.equal(sc[0].score, null)
assert.equal(sc[2].end, 100, 'конец обрезан по длине файла')
assert.deepEqual(sanitizeClips('мусор'), [])

// --- таймлайн
const v = { start: 10, pps: 20 }
assert.equal(timeToX(12, v), 40)
assert.equal(xToTime(40, v), 12)
assert.equal(rulerStep(20), 5, '5 с = 100 px')
assert.equal(rulerStep(1000), 0.1)
assert.equal(rulerStep(0.001), 3600)
const z = zoomAt(v, 2, 40, 0.01, 500)
assert.equal(z.pps, 40)
assert.equal(xToTime(40, z), 12, 'время под курсором на месте')
assert.equal(zoomAt(v, 1000, 0, 0.01, 500).pps, 500, 'масштаб ограничен')
assert.equal(zoomAt({ start: 0, pps: 10 }, 0.5, 0, 0.01, 500).start, 0, 'не уезжает левее нуля')

console.log('cut.ts: все проверки прошли')
