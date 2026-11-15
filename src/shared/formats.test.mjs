import assert from 'node:assert/strict'
import { needsPreview } from './formats.ts'

// имена форматов — как их отдаёт ffprobe
const MP4 = 'mov,mp4,m4a,3gp,3g2,mj2'
assert.equal(needsPreview('h264', MP4), false)
assert.equal(needsPreview('vp9', 'matroska,webm'), false)
assert.equal(needsPreview('av1', MP4), false)
assert.equal(needsPreview('hevc', MP4), true, 'HEVC (запись с iPhone) окно не показывает')
assert.equal(needsPreview('prores', MP4), true)
assert.equal(needsPreview('mpeg2video', 'mpeg'), true)
assert.equal(needsPreview('mpeg4', 'avi'), true)
assert.equal(needsPreview('h264', 'avi'), true, 'H.264 в AVI: контейнер окно не открывает')
assert.equal(needsPreview('h264', 'mpegts'), true)
assert.equal(needsPreview(undefined, 'mp3'), false, 'нет видео — копия не нужна')
console.log('formats.ts: все проверки прошли')
