// Дымовой тест СОБРАННОГО приложения (CI, Linux и Windows): node scripts/ci-smoke.mjs <путь к исполняемому файлу>
// Генерирует тестовое видео встроенным ffmpeg, гоняет самотест приложения (TS_SELFTEST) и проверяет результаты.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const app = resolve(process.argv[2] ?? '')
if (!existsSync(app)) throw new Error(`нет приложения: ${app}`)
const FFMPEG = require('ffmpeg-static')
const FFPROBE = require('ffprobe-static').path

const dir = join(tmpdir(), `ts-smoke-${Date.now()}`)
mkdirSync(dir, { recursive: true })
const video = join(dir, 'smoke.mp4')
const DUR = 8
const FPS = 30

const gen = spawnSync(FFMPEG, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', `testsrc2=s=640x360:r=${FPS}`,
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
  '-t', String(DUR), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video
], { encoding: 'utf8' })
if (gen.status !== 0) throw new Error(`ffmpeg: ${gen.stderr}`)

const words = [
  { id: 0, text: 'проверка', start: 1.0, end: 1.6 },
  { id: 1, text: 'рендера', start: 1.7, end: 2.3 },
  { id: 2, text: 'на', start: 4.0, end: 4.2 },
  { id: 3, text: 'сборке', start: 4.3, end: 5.0 }
]
const wordsFile = join(dir, 'words.json')
writeFileSync(wordsFile, JSON.stringify(words))

const failures = []
function run(name, env) {
  const out = join(dir, `${name}.json`)
  const r = spawnSync(app, [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', TS_SELFTEST: video, TS_SELFTEST_OUT: out, ...env },
    encoding: 'utf8',
    timeout: 15 * 60 * 1000
  })
  if (!existsSync(out)) {
    failures.push(`${name}: приложение не записало отчёт (код ${r.status}, сигнал ${r.signal}) ${(r.stderr || '').slice(-400)}`)
    return null
  }
  const rep = JSON.parse(readFileSync(out, 'utf8'))
  if (rep.fatal) failures.push(`${name}: ${rep.fatal}`)
  if (rep.probeError) failures.push(`${name}: ${rep.probeError}`)
  console.log(`${name}: ${JSON.stringify({ probe: rep.probe && `${rep.probe.width}x${rep.probe.height} ${rep.probe.duration}с`, words: rep.words?.length, asrSeconds: rep.asrSeconds, asrError: rep.asrError, renders: rep.renders.map((x) => x.error ?? `${x.format} ${x.result.frames} кадров`), peakMemMB: rep.peakMemMB?.total })}`)
  return rep
}

// 1) распознавание: тон вместо речи — слов может не быть, но конвейер не должен падать
const g = run('gigaam', { TS_MODEL: 'gigaam-v3' })
if (g?.asrError) failures.push(`gigaam: ${g.asrError}`)
const w = run('whisper', { TS_MODEL: 'whisper-small' })
if (w?.asrError && !/не нашёл речи/.test(w.asrError)) failures.push(`whisper: ${w.asrError}`)

// 2) рендер по готовым словам
const r = run('render', { TS_WORDS_FILE: wordsFile, TS_RENDER: 'animation,h264-green', TS_RENDER_DIR: dir, TS_RENDER_SIZE: '640x360', TS_RENDER_AUDIO: '1' })
for (const x of r?.renders ?? []) {
  if (x.error) { failures.push(`render ${x.format}: ${x.error}`); continue }
  const p = JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-count_frames', '-print_format', 'json', '-show_streams', x.result.path], { encoding: 'utf8' }).stdout)
  const v = p.streams.find((s) => s.codec_type === 'video')
  const a = p.streams.find((s) => s.codec_type === 'audio')
  const frames = Number(v.nb_read_frames)
  console.log(`  ${x.format}: ${v.codec_name} ${v.pix_fmt} ${v.width}x${v.height} кадров ${frames} звук ${a ? a.codec_name : 'нет'}`)
  if (frames !== DUR * FPS) failures.push(`render ${x.format}: кадров ${frames}, ожидалось ${DUR * FPS}`)
  if (!a) failures.push(`render ${x.format}: нет звука`)
  if (x.format === 'animation' && !/^(argb|bgra|rgba|abgr)$/.test(v.pix_fmt)) failures.push(`render animation: нет альфы (${v.pix_fmt})`)
}

rmSync(dir, { recursive: true, force: true })
if (failures.length) {
  console.error('ПРОВАЛ:\n' + failures.join('\n'))
  process.exit(1)
}
console.log('Дымовой тест собранного приложения пройден')
