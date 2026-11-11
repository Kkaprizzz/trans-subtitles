import assert from 'node:assert/strict'
import { EMPTY_HIST, histReducer as r, HIST_LIMIT } from './history.ts'

const w = (n) => [{ id: 0, text: String(n), start: 0, end: 1 }]
let h = r(EMPTY_HIST, { type: 'reset', words: w(0) })
assert.equal(h.past.length, 0)
h = r(h, { type: 'commit', words: w(1), now: 1000 })
h = r(h, { type: 'commit', words: w(2), now: 1100 })
assert.equal(h.past.length, 2)
h = r(h, { type: 'undo' }); assert.equal(h.present[0].text, '1')
h = r(h, { type: 'undo' }); assert.equal(h.present[0].text, '0')
h = r(h, { type: 'undo' }); assert.equal(h.present[0].text, '0', 'дальше начала не уходим')
h = r(h, { type: 'redo' }); assert.equal(h.present[0].text, '1')
h = r(h, { type: 'redo' }); assert.equal(h.present[0].text, '2')
h = r(h, { type: 'redo' }); assert.equal(h.present[0].text, '2')
// новая правка после отмены стирает «будущее»
h = r(h, { type: 'undo' })
h = r(h, { type: 'commit', words: w(9), now: 5000 })
assert.equal(h.future.length, 0)
// склейка: одинаковый ключ в пределах 800 мс — одна запись отмены
let g = r(EMPTY_HIST, { type: 'reset', words: w(0) })
g = r(g, { type: 'commit', words: w(1), key: 'nudge', now: 1000 })
g = r(g, { type: 'commit', words: w(2), key: 'nudge', now: 1300 })
g = r(g, { type: 'commit', words: w(3), key: 'nudge', now: 1600 })
assert.equal(g.past.length, 1, 'три нажатия подряд = одна отмена')
g = r(g, { type: 'undo' }); assert.equal(g.present[0].text, '0')
// склейка не работает после паузы и при другом ключе
g = r(g, { type: 'commit', words: w(1), key: 'nudge', now: 10000 })
g = r(g, { type: 'commit', words: w(2), key: 'nudge', now: 12000 })
assert.equal(g.past.length, 2)
g = r(g, { type: 'commit', words: w(3), key: 'other', now: 12100 })
assert.equal(g.past.length, 3)
// тот же массив — не запись
const same = g.present
assert.equal(r(g, { type: 'commit', words: same, now: 99999 }), g)
// лимит
let l = r(EMPTY_HIST, { type: 'reset', words: w(0) })
for (let i = 1; i <= HIST_LIMIT + 50; i++) l = r(l, { type: 'commit', words: w(i), now: i * 10000 })
assert.equal(l.past.length, HIST_LIMIT)
// reset очищает историю
l = r(l, { type: 'reset', words: w(5) }); assert.equal(l.past.length, 0); assert.equal(l.future.length, 0)
console.log('history.ts: все проверки прошли')
