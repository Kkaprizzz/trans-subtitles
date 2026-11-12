import assert from 'node:assert/strict'
import { parseWhisperJson, sanitizeWords } from './whisper.ts'

const seg = (from, to, text) => ({ offsets: { from, to }, text })

// формат как у настоящего whisper-cli: пустая запись в начале, слова с пробелом, знаки внутри слов
const real = {
  transcription: [
    seg(0, 0, ''),
    seg(0, 190, ' Что'),
    seg(190, 540, ' такого'),
    seg(540, 1100, ' покупают'),
    seg(4150, 4310, ' людей,'),
    seg(4310, 4560, ' о'),
    seg(6000, 6400, ' «Нет»'),
    seg(6400, 6400, '.'), // знак отдельной записью — прилипает к «Нет»
    seg(6500, 6500, ''),
    seg(6500, 7000, ' [Музыка]'), // пометка, не речь
    seg(7000, 7400, ' Рождество')
  ]
}
let w = parseWhisperJson(real)
assert.deepEqual(w.map((x) => x.text), ['Что', 'такого', 'покупают', 'людей,', 'о', '«Нет».', 'Рождество'])
assert.deepEqual(w.map((x) => x.id), [0, 1, 2, 3, 4, 5, 6])
assert.equal(w[0].start, 0)
assert.equal(w[0].end, 0.19)
assert.equal(w[3].start, 4.15)
for (let i = 0; i < w.length; i++) assert.ok(w[i].end > w[i].start, `конец позже начала у слова ${i}`)
for (let i = 1; i < w.length; i++) assert.ok(w[i].start >= w[i - 1].end - 1e-9, `без наложений у слова ${i}`)

// пустой и отсутствующий вывод
assert.deepEqual(parseWhisperJson({}), [])
assert.deepEqual(parseWhisperJson({ transcription: [seg(0, 0, ''), seg(0, 10, ' ,')] }), [])

// нулевая длительность -> минимальная
w = parseWhisperJson({ transcription: [seg(1000, 1000, ' да'), seg(1000, 1500, ' нет')] })
assert.ok(w[0].end > w[0].start)
assert.ok(w[1].start >= w[0].end)

// sanitizeWords: перемешанный порядок и наложение
const messy = [
  { id: 9, text: 'б', start: 1.0, end: 1.5 },
  { id: 3, text: 'а', start: 0.5, end: 1.2 }
]
const clean = sanitizeWords(messy)
assert.deepEqual(clean.map((x) => x.text), ['а', 'б'])
assert.equal(clean[0].end, 1.0, 'предыдущее слово обрезается по началу следующего')
assert.deepEqual(clean.map((x) => x.id), [0, 1])
assert.equal(messy[0].id, 9, 'вход не мутируется по порядку')

// совсем впритык: следующее начинается внутри минимальной длительности предыдущего
const tight = sanitizeWords([
  { id: 0, text: 'а', start: 1.0, end: 1.5 },
  { id: 1, text: 'б', start: 1.01, end: 1.3 }
])
assert.equal(tight[1].start, 1.5)
assert.ok(tight[1].end > tight[1].start)
console.log('whisper.ts: все проверки прошли')

// --- DTW: если у токенов есть t_dtw, границы берутся из него с поправками
import { DTW_LEAD, DTW_TAIL } from './whisper.ts'
const dtw = parseWhisperJson({
  transcription: [
    { offsets: { from: 0, to: 900 }, text: ' привет', tokens: [{ text: '[_BEG_]', t_dtw: 0 }, { text: ' при', t_dtw: 50 }, { text: 'вет', t_dtw: 70 }] },
    { offsets: { from: 900, to: 2000 }, text: ' мир', tokens: [{ text: ' мир', t_dtw: 160 }] },
    { offsets: { from: 2000, to: 2500 }, text: ' без', tokens: [{ text: ' без', t_dtw: -1 }] }
  ]
})
assert.equal(dtw[0].start, +(0.5 - DTW_LEAD).toFixed(3), 'начало = первый токен с буквами минус поправка; служебный [_BEG_] пропущен')
assert.equal(dtw[0].end, +(0.7 + DTW_TAIL).toFixed(3))
assert.equal(dtw[1].start, +(1.6 - DTW_LEAD).toFixed(3))
assert.equal(dtw[2].start, 2.0, 'без DTW — обычные отметки')
const early = parseWhisperJson({ transcription: [{ offsets: { from: 1000, to: 1500 }, text: ' да', tokens: [{ text: ' да', t_dtw: 105 }] }] })
assert.equal(early[0].start, 1.0, 'DTW с поправкой не уводит слово раньше начала сегмента')
console.log('whisper.ts (DTW): все проверки прошли')
