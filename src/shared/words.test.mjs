import assert from 'node:assert/strict'
import { correctEdges, sanitizeWords, MIN_DUR } from './words.ts'

const w = [
  { id: 0, text: 'а', start: 1.0, end: 1.3 },
  { id: 1, text: 'б', start: 1.32, end: 1.6 },
  { id: 2, text: 'в', start: 0.02, end: 0.2 }
]
const c = correctEdges(w, 0.06, 0.04)
assert.deepEqual(c.map((x) => x.text), ['в', 'а', 'б'], 'отсортировано')
assert.equal(c[0].start, 0, 'не уходит в минус')
assert.equal(c[1].start, 0.94)
assert.equal(c[2].start, 1.26)
assert.equal(c[1].end, 1.26, 'хвост предыдущего обрезан началом следующего — без наложений')
assert.equal(c[2].end, 1.64)
for (let i = 1; i < c.length; i++) assert.ok(c[i].start >= c[i - 1].end - 1e-9)
for (const x of c) assert.ok(x.end - x.start >= MIN_DUR - 1e-9)
assert.equal(w[0].start, 1.0, 'вход не мутируется')
assert.deepEqual(sanitizeWords([]), [])
console.log('words.ts: все проверки прошли')
