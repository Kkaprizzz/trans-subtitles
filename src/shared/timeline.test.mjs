import assert from 'node:assert/strict'
import { buildPhrases, captionAt, DEFAULT_STYLE, displayText, ease, findActive, frameKey, normalizeStyle } from './timeline.ts'

const W = [
  { id: 0, text: 'раз', start: 1.0, end: 1.3 },
  { id: 1, text: 'два,', start: 1.4, end: 1.7 },
  { id: 2, text: 'три', start: 1.8, end: 2.1 },
  { id: 3, text: 'четыре', start: 2.2, end: 2.6 },
  { id: 4, text: 'пять.', start: 4.0, end: 4.4 } // пауза 1.4 с перед «пять»
]
const st = (p) => ({ ...DEFAULT_STYLE, ...p })

// --- findActive
assert.equal(findActive(W, 0.5), -1)
assert.equal(findActive(W, 1.0), 0)
assert.equal(findActive(W, 1.39), 0)
assert.equal(findActive(W, 3.0), 3)
assert.equal(findActive(W, 99), 4)
assert.equal(findActive([], 1), -1)

// --- buildPhrases
assert.deepEqual(buildPhrases([], st({})), [])
let ph = buildPhrases(W, st({ mode: 'word' }))
assert.equal(ph.length, 5, 'в режиме «слово» каждая фраза = слово')
ph = buildPhrases(W, st({ mode: 'highlight', maxWords: 3, pauseBreak: 0.5 }))
assert.deepEqual(ph.map((p) => [p.first, p.last]), [[0, 2], [3, 3], [4, 4]])
assert.equal(ph[0].start, 1.0)
assert.equal(ph[0].end, 2.1)
ph = buildPhrases(W, st({ mode: 'highlight', maxWords: 8, pauseBreak: 0.5 }))
assert.deepEqual(ph.map((p) => [p.first, p.last]), [[0, 3], [4, 4]], 'пауза > 0.5 с рвёт фразу')
ph = buildPhrases(W, st({ mode: 'highlight', maxWords: 8, pauseBreak: 3 }))
assert.deepEqual(ph.map((p) => [p.first, p.last]), [[0, 4]])
ph = buildPhrases(W, st({ mode: 'typewriter', maxWords: 0, pauseBreak: 3 }))
assert.equal(ph.length, 5, 'maxWords < 1 считается за 1')
// каждое слово ровно в одной фразе, по порядку
for (const p of buildPhrases(W, st({ mode: 'highlight', maxWords: 2 }))) assert.ok(p.first <= p.last)

// --- ease: границы и монотонность
assert.equal(ease(0), 0)
assert.equal(ease(1), 1)
assert.equal(ease(-1), 0)
assert.equal(ease(2), 1)
let prev = 0
for (let x = 0.01; x <= 1; x += 0.01) {
  const y = ease(x)
  assert.ok(y >= prev - 1e-9, `кривая не убывает (x=${x.toFixed(2)})`)
  assert.ok(y >= 0 && y <= 1.0001)
  prev = y
}
assert.ok(ease(0.5) > 0.5, 'ease-out: к середине пройдено больше половины')

// --- displayText
const P = { stripPunct: true }
assert.equal(displayText('два,', P), 'два')
assert.equal(displayText('«Нет».', P), 'Нет')
assert.equal(displayText('кока-кола', P), 'кока-кола', 'внутренний дефис остаётся')
assert.equal(displayText('...', P), '')
assert.equal(displayText('два,', { stripPunct: false }), 'два,')

// --- captionAt: режим «слово»
let s = st({ mode: 'word', enter: 'pop', enterDur: 0.2, hold: 0.3 })
let p = buildPhrases(W, s)
assert.equal(captionAt(W, p, s, 0.5), null, 'до первого слова пусто')
let c = captionAt(W, p, s, 1.0)
assert.equal(c.phrase, 0)
assert.equal(c.active, 0)
assert.equal(c.enter, 0, 'в момент начала появление в нуле')
assert.equal(captionAt(W, p, s, 1.25).enter, 1, 'после enterDur появление закончено')
assert.equal(captionAt(W, p, s, 4.65).phrase, 4, 'держится hold после конца')
assert.equal(captionAt(W, p, s, 4.71), null, 'после конца + hold пусто')
assert.equal(captionAt(W, p, s, 3.0), null, 'в длинной паузе пусто')
assert.equal(captionAt(W, p, st({ mode: 'word', enter: 'none' }), 1.0).enter, 1)
assert.equal(captionAt(W, p, st({ mode: 'word', enterDur: 0 }), 1.0).enter, 1)

// --- подсветка
s = st({ mode: 'highlight', maxWords: 3, pauseBreak: 0.5, enter: 'pop', enterDur: 0.1, hold: 0.3 })
p = buildPhrases(W, s)
c = captionAt(W, p, s, 1.5)
assert.equal(c.phrase, 0)
assert.equal(c.active, 1, 'подсвечено звучащее слово')
assert.ok(c.pop > 0 && c.pop <= 1)
assert.equal(captionAt(W, p, s, 1.75).active, 1, 'в короткой паузе внутри фразы подсветка остаётся')
assert.equal(captionAt(W, p, s, 2.15).active, -1, 'после конца последнего слова фразы подсветки нет')
assert.equal(captionAt(W, p, s, 2.15).phrase, 0, 'но фраза ещё на экране (hold)')

// --- машинка: счёт букв без знаков препинания
s = st({ mode: 'typewriter', maxWords: 3, pauseBreak: 0.5, stripPunct: true, hold: 0.3 })
p = buildPhrases(W, s)
assert.equal(captionAt(W, p, s, 1.0).typed, 1, 'в начале слова видна первая буква')
assert.equal(captionAt(W, p, s, 1.3).typed, 3, 'к концу слова оно набрано целиком')
assert.equal(captionAt(W, p, s, 1.4).typed, 3 + 1, 'следующее слово: «два» без запятой')
assert.equal(captionAt(W, p, s, 2.05).typed, 3 + 3 + 3, 'все три слова набраны')
assert.equal(captionAt(W, p, s, 1.0).enter, 1, 'машинка не анимирует появление фразы')
s = st({ mode: 'typewriter', maxWords: 3, pauseBreak: 0.5, stripPunct: false })
assert.equal(captionAt(W, p, s, 2.05).typed, 3 + 4 + 3, 'с запятой букв на одну больше')
// typed не убывает внутри фразы
let last = 0
s = st({ mode: 'typewriter', maxWords: 3, pauseBreak: 0.5 })
for (let t = 1.0; t < 2.3; t += 0.01) {
  const k = captionAt(W, p, s, t)
  if (k && k.phrase === 0) {
    assert.ok(k.typed >= last, `typed не уменьшается (t=${t.toFixed(2)})`)
    last = k.typed
  }
}

// --- frameKey
assert.equal(frameKey(null), '-')
const a = captionAt(W, p, s, 1.0)
assert.equal(frameKey(a), frameKey({ ...a }))
assert.notEqual(frameKey(a), frameKey(captionAt(W, p, s, 1.2)))

// --- normalizeStyle
assert.deepEqual(normalizeStyle(null), DEFAULT_STYLE)
const n = normalizeStyle({ size: 50 })
assert.equal(n.size, 50)
assert.equal(n.stripPunct, true, 'новые поля добавляются из умолчаний')
console.log('timeline.ts: все проверки прошли')
