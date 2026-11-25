import assert from 'node:assert/strict'
import { hasAlphaPixFmt, needsPreview } from './formats.ts'

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

// прозрачность по формату пикселей (ProRes 4444 из оверлеев пользователя — yuva444p10le)
for (const f of ['yuva444p10le', 'yuva420p', 'rgba', 'bgra', 'argb', 'gbrapf32le', 'ya8']) assert.equal(hasAlphaPixFmt(f), true, f)
for (const f of ['yuv420p', 'yuv422p10le', 'yuv444p', 'rgb24', 'gray', 'pal8', undefined, '']) assert.equal(hasAlphaPixFmt(f), false, String(f))

console.log('formats.ts: все проверки прошли')
