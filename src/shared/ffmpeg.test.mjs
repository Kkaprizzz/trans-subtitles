import assert from 'node:assert/strict'
import { AV1_FALLBACK, ffmpegErrorText, needsAv1Fallback } from './ffmpeg.ts'
import { buildExport } from './exportGraph.ts'
import { addMedia, insertMedia, newProject, setTrack } from './project.ts'

// --- нужен ли запасной декодер AV1: по выводу `ffmpeg -decoders`
const withDav1d = ' V..... libdav1d             dav1d AV1 decoder by VideoLAN (codec av1)\n V....D libaom-av1           libaom AV1 (codec av1)\n V....D av1                  Alliance for Open Media AV1\n'
const gyan = ' V....D libaom-av1           libaom AV1 (codec av1)\n V....D av1                  Alliance for Open Media AV1\n VFS... h264                 H.264\n'
const nothing = ' V....D av1                  Alliance for Open Media AV1\n'
assert.equal(needsAv1Fallback(withDav1d), false, 'есть libdav1d — всё как обычно (Linux)')
assert.equal(needsAv1Fallback(gyan), true, 'нет libdav1d, есть libaom — запасной декодер (Windows)')
assert.equal(needsAv1Fallback(nothing), false, 'нет и libaom — переключаться некуда')
assert.equal(needsAv1Fallback(''), false)
assert.equal(AV1_FALLBACK, 'libaom-av1')

// --- текст ошибки: причина, а не только «ничего не записано»
const real = [
  'Input #0, mov,mp4, from "podcast.mp4":',
  '[av1 @ 0000019b] Your platform doesn\'t support hardware accelerated AV1 decoding.',
  '[av1 @ 0000019b] Failed to get pixel format.',
  '[vist#0:0/av1 @ 0000019c] Decoding error: Function not implemented',
  '[out#0/mp4 @ 000000cd063ec080] Nothing was written into output file, because at least one of its streams received no packets.',
  'Conversion failed!'
].join('\n')
assert.equal(
  ffmpegErrorText(real),
  'Failed to get pixel format. · Decoding error: Function not implemented',
  'две последние причины, служебные «Nothing was written» и «Conversion failed» убраны, приставки [фильтр @ 0x…] срезаны'
)
assert.equal(ffmpegErrorText(real, 1), 'Decoding error: Function not implemented')
assert.equal(ffmpegErrorText('Conversion failed!'), 'Conversion failed!', 'кроме служебной строки ничего нет — показываем её')
assert.equal(ffmpegErrorText(''), 'неизвестная ошибка')
assert.equal(ffmpegErrorText('  \n\nУ файла нет звука\n'), 'У файла нет звука')

// --- в команде экспорта запасной декодер стоит только перед входами AV1, где картинка нужна
const V = (path, extra = {}) => ({ path, name: path, duration: 20, hasVideo: true, hasAudio: true, width: 1280, height: 720, fps: 25, needsPreview: false, ...extra })
const build = (p, av1Decoder) => buildExport(p, { W: 1080, H: 1920, fps: 30, format: 'h264', quality: 'small', subLayers: [], av1Decoder }, '/o.mp4').args
const inputArgs = (args, path) => {
  const i = args.indexOf(path)
  assert.ok(i > 0 && args[i - 1] === '-i', `вход ${path} найден`)
  // параметры этого входа: от предыдущего «-i» (или начала) до его собственного «-i»
  const prev = args.lastIndexOf('-i', i - 2)
  return args.slice(prev + 2, i - 1)
}
let p = newProject('t')
const a = addMedia(p, V('/av1.mp4', { videoCodec: 'av1' }))
const b = addMedia(a.p, V('/h264.mp4', { videoCodec: 'h264' }))
p = insertMedia(insertMedia(b.p, a.id, 0).p, b.id, 20).p
const on = build(p, AV1_FALLBACK)
assert.deepEqual(inputArgs(on, '/av1.mp4').slice(-2), ['-c:v', 'libaom-av1'], 'AV1: запасной декодер перед -i')
assert.ok(!inputArgs(on, '/h264.mp4').includes('-c:v'), 'H.264 читается как обычно')
const off = build(p)
assert.ok(!off.includes('libaom-av1'), 'без опции (Linux, есть dav1d) команда прежняя')
// AV1 без картинки на экране (дорожка скрыта) декодировать незачем: звук идёт из другого потока
const hiddenTrack = p.items.find((i) => i.mediaId === a.id).trackId
const hidden = setTrack(p, hiddenTrack, { hidden: true })
assert.ok(!build(hidden, AV1_FALLBACK).includes('libaom-av1'), 'скрытая дорожка: видео не нужно — декодер не навязываем')
// у файла в проекте кодек не записан — опция его не знает, команда прежняя (кодеки дописывает экспорт перед сборкой)
const unknown = addMedia(newProject('u'), V('/x.mp4'))
assert.ok(!build(insertMedia(unknown.p, unknown.id, 0).p, AV1_FALLBACK).includes('libaom-av1'))

console.log('ffmpeg.ts: все проверки прошли')
