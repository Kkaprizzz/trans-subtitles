import assert from 'node:assert/strict'
import { fmtTime, plural } from './format.ts'
import { DEFAULTS, resolveFps, resolveSize } from './renderSettings.ts'

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

// --- resolveSize / resolveFps
const media = (p) => ({ path: '/x', name: 'x', duration: 10, hasVideo: true, hasAudio: true, ...p })
assert.deepEqual(resolveSize({ ...DEFAULTS, size: 'source' }, media({ width: 720, height: 1280 })), { w: 720, h: 1280 })
assert.deepEqual(resolveSize({ ...DEFAULTS, size: 'source' }, media({ width: 721, height: 1279 })), { w: 720, h: 1278 }, 'нечётное -> чётное')
assert.deepEqual(resolveSize({ ...DEFAULTS, size: 'source' }, media({ hasVideo: false, width: undefined, height: undefined })), { w: 1920, h: 1080 })
assert.deepEqual(resolveSize({ ...DEFAULTS, size: 'source' }, null), { w: 1920, h: 1080 })
assert.deepEqual(resolveSize({ ...DEFAULTS, size: '1080x1920' }, null), { w: 1080, h: 1920 })
assert.deepEqual(resolveSize({ ...DEFAULTS, size: 'custom', customW: 1001, customH: 3 }, null), { w: 1000, h: 2 })
assert.equal(resolveFps({ ...DEFAULTS, fps: 'source' }, media({ fps: 30000 / 1001 })).toFixed(3), '29.970')
assert.equal(resolveFps({ ...DEFAULTS, fps: 'source' }, media({ fps: undefined })), 30)
assert.equal(resolveFps({ ...DEFAULTS, fps: 'source' }, null), 30)
assert.equal(resolveFps({ ...DEFAULTS, fps: '60' }, null), 60)
console.log('format.ts, renderSettings.ts: все проверки прошли')
