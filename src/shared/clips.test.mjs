import assert from 'node:assert/strict'
import { buildSegments, buildWindows, parseClips, finalizeClips, findQuote, normWord, mmss, segmentLine } from './clips.ts'
import { analyzeClips, estimateRun, windowCharsForTpm } from './clipsAnalyze.ts'

/** Синтетический подкаст: предложения по 8 слов (слово 0.3 с, пауза 0.05), между предложениями 0.4 с, каждое 10-е — пауза 1.5 с. */
function transcript(sentences) {
  const words = []
  let t = 5
  for (let s = 0; s < sentences; s++) {
    for (let i = 0; i < 8; i++) {
      words.push({ id: words.length, text: `сл${s}_${i}${i === 7 ? '.' : ''}`, start: t, end: t + 0.3 })
      t += 0.35
    }
    t += s % 10 === 9 ? 1.5 : 0.4
  }
  return words
}

const words = transcript(100)
const segs = buildSegments(words)

// --- реплики
assert.equal(segs.length, 100, 'реплика = предложение')
assert.equal(segs[0].first, 0)
assert.equal(segs[0].last, 7)
assert.ok(segs.every((s, i) => i === 0 || s.first === segs[i - 1].last + 1), 'реплики идут встык, без дыр и наложений')
assert.equal(segs.at(-1).last, words.length - 1)

// длинная речь без пауз и точек режется по maxWords, а не остаётся одной репликой
const stream = Array.from({ length: 130 }, (_, i) => ({ id: i, text: 'и', start: i * 0.31, end: i * 0.31 + 0.3 }))
const sSegs = buildSegments(stream)
assert.ok(sSegs.length >= 3 && sSegs.every((s) => s.last - s.first + 1 <= 45), 'длинный поток разрезан')
assert.equal(sSegs.reduce((n, s) => n + (s.last - s.first + 1), 0), 130, 'ни одно слово не потеряно')
assert.deepEqual(buildSegments([]), [])

// --- окна
const wins = buildWindows(segs, { maxChars: 2000, overlapChars: 400 })
assert.ok(wins.length > 3)
assert.equal(wins[0].firstSeg, 0)
assert.equal(wins.at(-1).lastSeg, 99, 'последнее окно доходит до конца')
for (let i = 1; i < wins.length; i++) {
  assert.ok(wins[i].firstSeg > wins[i - 1].firstSeg, 'окна идут вперёд')
  assert.ok(wins[i].firstSeg <= wins[i - 1].lastSeg + 1, 'между окнами нет дыры')
}
assert.ok(wins.every((w) => w.chars <= 2000), 'окно не больше лимита')
assert.ok(wins.slice(1).some((w, i) => w.firstSeg <= wins[i].lastSeg), 'окна перекрываются')
assert.equal(buildWindows(segs).length, 1, 'по умолчанию такой текст влезает в одно окно')
assert.equal(buildWindows([]).length, 0)
// одна реплика длиннее лимита не должна зациклить
assert.equal(buildWindows(segs.slice(0, 2), { maxChars: 5, overlapChars: 0 }).length, 2)

assert.equal(mmss(65), '01:05')
assert.equal(mmss(3725), '1:02:05')
assert.match(segmentLine(segs[3]), /^\[S3 \d\d:\d\d-\d\d:\d\d\] сл3_0 /)

// --- разбор ответа
const ok = parseClips(
  '```json\n{"clips":[{"start_segment":2,"start_words":" а ты  знаешь ","end_segment":8,"end_words":["вот","так"],"score":9.5,"title":"  Заголовок  ","reason":"р","description":"д","hashtags":["#Тема ","тема","два слова"],"overlay_after_segment":5,"overlay_after_words":"и всё"}]}\n```',
  0,
  99
)
assert.equal(ok.length, 1)
assert.equal(ok[0].title, 'Заголовок')
assert.equal(ok[0].startWords, 'а ты знаешь')
assert.equal(ok[0].endWords, 'вот так', 'цитата массивом тоже принимается')
assert.deepEqual(ok[0].hashtags, ['#Тема', '#тема', '#дваслова'])
assert.equal(ok[0].overlaySeg, 5)
assert.equal(ok[0].overlayWords, 'и всё')
assert.equal(parseClips('{"clips":[{"start_segment":2,"end_segment":8,"overlay_after_segment":30,"overlay_after_words":"х"}]}', 0, 99)[0].overlaySeg, null, 'вставка вне клипа отброшена')
assert.equal(parseClips('Вот ответ: {"clips":[{"start_segment":"3","end_segment":"9","score":50}]} спасибо', 0, 99)[0].score, 10, 'номера строкой принимаем, оценка зажата')
assert.equal(parseClips('[{"start_segment":1,"end_segment":2}]', 0, 99).length, 1, 'голый массив тоже годится')
assert.deepEqual(parseClips('{"clips":[]}', 0, 99), [])
assert.deepEqual(
  parseClips('{"clips":[{"start_segment":50,"end_segment":60},{"start_segment":9,"end_segment":3},{"start_segment":-1,"end_segment":3},{"start_segment":1.5,"end_segment":3},null,5]}', 0, 40),
  []
)
assert.throws(() => parseClips('нет json', 0, 9), /JSON/)
assert.throws(() => parseClips('{"clips":', 0, 9))
assert.throws(() => parseClips('{"foo":1}', 0, 9), /clips/)

// --- поиск цитаты
const said = 'ну вот смотри а ты знаешь почему люди вообще боятся леса ночью потому что там темно'.split(' ')
const N = said.map(normWord)
assert.equal(normWord('Ёлка,'), 'елка')
assert.deepEqual(findQuote(N, 0, N.length - 1, 'а ты знаешь почему люди'), { first: 3, last: 7, matched: 5 })
assert.equal(findQuote(N, 0, N.length - 1, 'А ТЫ ЗНАЕШЬ, почему?').first, 3, 'регистр и знаки не мешают')
assert.equal(findQuote(N, 0, N.length - 1, 'а ты знаеш почему люди').first, 3, 'ошибка в букве не мешает')
assert.equal(findQuote(N, 0, N.length - 1, 'а ты почему люди вообще').first, 3, 'ИИ пропустил слово')
assert.equal(findQuote(N, 0, N.length - 1, 'а ты вот знаешь почему').first, 3, 'ИИ вставил лишнее слово')
assert.equal(findQuote(N, 0, N.length - 1, 'эээ ты знаешь почему люди').first, 4, 'первое слово цитаты не совпало — начало по второму')
assert.equal(findQuote(N, 0, N.length - 1, 'там темно').last, 15, 'конец цитаты = последнее слово')
assert.equal(findQuote(N, 0, N.length - 1, 'совсем другие слова здесь'), null)
assert.equal(findQuote(N, 0, N.length - 1, ''), null)
assert.equal(findQuote(N, 8, N.length - 1, 'а ты знаешь почему люди'), null, 'ищем только в своём диапазоне')

// --- границы клипов
const raw = (a, b, extra = {}) => ({
  startSeg: a, endSeg: b, startWords: '', endWords: '', score: 7, title: 't', reason: 'r', description: 'd', hashtags: [], overlaySeg: null, overlayWords: '', ...extra
})
const wq = (s, i, n = 4) => words.slice(s * 8 + i, s * 8 + i + n).map((w) => w.text).join(' ')
// начало с 3-го слова 10-й реплики, конец на 5-м слове 19-й — посреди реплик
const [c1] = finalizeClips(words, segs, [raw(10, 19, { startWords: wq(10, 3), endWords: wq(19, 1), overlaySeg: 14, overlayWords: wq(14, 2, 3) })])
assert.equal(c1.firstWord, 10 * 8 + 3, 'начало точно по цитате')
assert.equal(c1.lastWord, 19 * 8 + 4, 'конец точно по цитате')
assert.equal(c1.approx, false)
const prevEnd = words[c1.firstWord - 1].end
const nextStart = words[c1.lastWord + 1].start
assert.ok(c1.start > prevEnd && c1.start < words[c1.firstWord].start, 'запас в начале, но не залезает на предыдущее слово')
assert.ok(c1.end < nextStart && c1.end > words[c1.lastWord].end, 'запас в конце, но не залезает на следующее слово')
assert.equal(c1.overlayAt, Math.round(words[14 * 8 + 4].end * 1000) / 1000, 'вставка после процитированных слов')
// ИИ ошибся номером реплики на 1 — цитата всё равно находится
assert.equal(finalizeClips(words, segs, [raw(10, 19, { startWords: wq(11, 0) })])[0].firstWord, 88)
// цитаты нет — граница по краю реплики и пометка
const [ap] = finalizeClips(words, segs, [raw(10, 19, { startWords: 'чего нет в тексте' })])
assert.equal(ap.approx, true)
assert.equal(ap.firstWord, segs[10].first)
// вставка без слов или вне клипа — не ставится
assert.equal(finalizeClips(words, segs, [raw(10, 19, { overlaySeg: 14 })])[0].overlayAt, null)
assert.equal(finalizeClips(words, segs, [raw(10, 15, { endWords: wq(15, 0), overlaySeg: 15, overlayWords: wq(16, 0) })])[0].overlayAt, null, 'цитата вставки за концом клипа')

// длина: вне лимита с допуском — выбрасываем, а не режем посреди фразы
const stats = { tooLong: 0, tooShort: 0, broken: 0, overlap: 0, approx: 0 }
assert.deepEqual(finalizeClips(words, segs, [raw(0, 40)], {}, stats), [])
assert.deepEqual(finalizeClips(words, segs, [raw(30, 31)], {}, stats), [])
assert.deepEqual(finalizeClips(words, segs, [raw(30, 30, { startWords: wq(30, 4), endWords: wq(30, 0) })], {}, stats), [], 'конец раньше начала')
assert.deepEqual(stats, { tooLong: 1, tooShort: 1, broken: 1, overlap: 0, approx: 0 })
// 4 реплики ≈ 12.4 с — в пределах допуска 3 с от минимума 15
assert.equal(finalizeClips(words, segs, [raw(30, 33)]).length, 1)
// не лезет за конец файла и не уходит в минус
const [tail] = finalizeClips(words, segs, [raw(88, 99)], { mediaDuration: words.at(-1).end + 0.1 })
assert.ok(tail.end <= words.at(-1).end + 0.1 + 1e-9)
const [head] = finalizeClips(words, segs, [raw(0, 6)])
assert.ok(head.start >= 0)
// пересечения: остаётся лучший, лимит клипов соблюдается, итог по времени
const st2 = { tooLong: 0, tooShort: 0, broken: 0, overlap: 0, approx: 0 }
const mixed = finalizeClips(words, segs, [
  raw(10, 19, { score: 6 }),
  raw(12, 21, { score: 9 }),
  raw(40, 49, { score: 5 }),
  raw(70, 79, { score: 8 })
], {}, st2)
assert.equal(mixed.length, 3)
assert.equal(st2.overlap, 1)
assert.ok(!mixed.some((c) => c.firstWord === segs[10].first), 'слабый клип с пересечением выкинут')
assert.deepEqual(mixed.map((c) => c.id), [0, 1, 2])
assert.ok(mixed.every((c, i) => i === 0 || c.start > mixed[i - 1].start), 'отсортировано по времени')
// при равной оценке точный клип побеждает приблизительный
const tie = finalizeClips(words, segs, [raw(10, 19, { startWords: 'нет такого' }), raw(11, 20, { startWords: wq(11, 0), endWords: wq(20, 4) })])
assert.equal(tie.length, 1)
assert.equal(tie[0].approx, false)
assert.equal(finalizeClips(words, segs, [raw(0, 9), raw(20, 29), raw(40, 49)], { maxClips: 2 }).length, 2)
assert.deepEqual(finalizeClips(words, segs, []), [])
assert.deepEqual(finalizeClips(words, segs, [raw(0, 500)]), [], 'выдуманный номер реплики не роняет')

// --- оркестратор с поддельным ИИ
const lineWords = (text, seg) => new RegExp(`\\[S${seg} [^\\]]+\\] (.+)`).exec(text)[1].split(' ')
const fake = async (messages) => {
  calls.push(messages)
  const user = messages.find((m) => m.role === 'user').content
  const m = /куски S(\d+)–S(\d+)/.exec(user) ?? [null, '0', '99']
  const lo = Number(m[1])
  const a = lineWords(user, lo + 2)
  const b = lineWords(user, lo + 11)
  const clips = [{ start_segment: lo + 2, start_words: a.slice(0, 5).join(' '), end_segment: lo + 11, end_words: b.slice(-5).join(' '), score: 8, title: 'Т', reason: 'р', description: 'д', hashtags: ['а'] }]
  return { text: JSON.stringify({ clips }), usage: { prompt: 1000, completion: 100 } }
}
let calls = []
const small = { windows: { maxChars: 2200, overlapChars: 300 }, maxClips: 20 }
const progress = []
const res = await analyzeClips(words, fake, small, (p) => progress.push(p.done))
assert.ok(res.windows > 3)
assert.equal(calls.length, res.windows, 'один запрос на окно')
assert.equal(res.usage.prompt, 1000 * res.windows)
assert.deepEqual(progress, Array.from({ length: res.windows }, (_, i) => i + 1))
assert.ok(res.clips.length >= 3, 'клипы из разных окон собраны')
assert.ok(res.clips.every((c) => !c.approx), 'цитаты из текста окна находятся')
assert.equal(res.proposed, res.windows)
assert.ok(calls[0][0].content.includes('15') && calls[0][0].role === 'system')
assert.ok(calls[0][1].content.includes('Это часть 1 из'), 'ИИ знает, что видит часть выпуска')

// битый ответ: одна повторная попытка, потом окно пропускается, остальные работают
calls = []
let n = 0
const flaky = async (messages) => {
  n++
  if (n <= 2) {
    calls.push(messages)
    return { text: 'извините, не могу' }
  }
  return fake(messages)
}
const res2 = await analyzeClips(words, flaky, small)
assert.equal(res2.warnings.length, 1, 'пропущено одно окно')
assert.match(res2.warnings[0], /Часть 1/)
assert.ok(res2.clips.length > 0)
assert.ok(calls[1].some((x) => x.role === 'user' && /не удалось разобрать/.test(x.content)), 'повтор с объяснением')
n = 0
const res3 = await analyzeClips(words, async (m) => (++n === 1 ? { text: 'не json' } : fake(m)), small)
assert.equal(res3.warnings.length, 0)
await assert.rejects(analyzeClips(words, async () => ({ text: 'мусор' }), small), /ни разу/)
await assert.rejects(analyzeClips(words, async () => { throw new Error('ключ не принят') }, small), /ключ не принят/)
await assert.rejects(analyzeClips(words, fake, small, undefined, () => true), /Отменено/)
await assert.rejects(analyzeClips([], fake), /Нет слов/)

// --- оценка расхода
const est = estimateRun(words, small)
assert.equal(est.requests, res.windows)
assert.ok(est.inputTokens > 0 && est.outputTokens > 0)
// реальный масштаб: 3 часа речи ≈ 30 тыс. слов
const three = transcript(3750)
const e3 = estimateRun(three)
assert.ok(e3.requests >= 2 && e3.requests <= 12, `3 часа ≈ ${e3.requests} запросов`)
assert.ok(e3.inputTokens > 50_000 && e3.inputTokens < 400_000)

// окно под лимит 8000 токенов/мин: запрос целиком (инструкция + окно + ответ) влезает с запасом
const wc = windowCharsForTpm(8000, 2500)
assert.ok(wc > 5000 && wc < 14000, `окно ${wc}`)
assert.equal(windowCharsForTpm(100, 5000), 2000, 'нижний предел')

console.log('clips.ts, clipsAnalyze.ts: все проверки прошли')
