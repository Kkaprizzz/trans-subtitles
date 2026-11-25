import assert from 'node:assert/strict'
import { fmtTime, plural } from './format.ts'

// --- fmtTime
assert.equal(fmtTime(0), '00:00.00')
assert.equal(fmtTime(83.456), '01:23.46')
assert.equal(fmtTime(-5), '00:00.00')
assert.equal(fmtTime(NaN), '00:00.00')
assert.equal(fmtTime(59.999), '01:00.00', 'округление не даёт «00:60.00»')
assert.equal(fmtTime(119.996), '02:00.00')
assert.equal(fmtTime(3600), '60:00.00')

// --- plural
const w = (n) => plural(n, 'слово', 'слова', 'слов')
assert.deepEqual([0, 1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111, 112].map(w), [
  'слов', 'слово', 'слова', 'слова', 'слов', 'слов', 'слов', 'слов', 'слово', 'слова', 'слов', 'слово', 'слов', 'слов'
])

console.log('format.ts: все проверки прошли')
