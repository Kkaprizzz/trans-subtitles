import assert from 'node:assert/strict'
import { buildExport } from './exportGraph.ts'
import { addMedia, addSubtitles, applyRecognized, insertMedia, moveItem, newProject, setTrack, videoTracks } from './project.ts'

const V = (path, duration, extra = {}) => ({ path, name: path, duration, hasVideo: true, hasAudio: true, width: 1280, height: 720, fps: 25, needsPreview: false, ...extra })
const MUSIC = { path: '/m.mp3', name: 'm', duration: 30, hasVideo: false, hasAudio: true, needsPreview: false }
const argsOf = (cmd) => cmd.args
const graphOf = (cmd) => cmd.args[cmd.args.indexOf('-filter_complex') + 1]
const inputsOf = (cmd) => cmd.args.flatMap((x, i) => (x === '-i' ? [cmd.args[i + 1]] : []))

let p = newProject('E')
p = addMedia(p, V('/a.mp4', 10)).p
p = addMedia(p, V('/b.mp4', 4, { hasAudio: false })).p
p = addMedia(p, MUSIC).p
const [ma, mb, mm] = p.media.map((m) => m.id)
const [topT, lowT] = videoTracks(p).map((t) => t.id)
const ia = insertMedia(p, ma, 0)
p = ia.p
const ib = insertMedia(p, mb, 5) // внахлёст с a → верхняя дорожка
p = ib.p
p = insertMedia(p, mm, 2).p
assert.equal(ib.p.items.find((i) => i.id === ib.id).trackId, topT)

const opts = { W: 1081, H: 1920, fps: 30, format: 'h264', quality: 'medium', subLayers: [] }
let cmd = buildExport(p, opts, '/out.mp4')
let g = graphOf(cmd)
assert.equal(cmd.total, 32, 'длина = самая длинная дорожка (музыка 2..32)')
assert.match(g, /^color=c=black:s=1080x1920:r=30:d=32\.000/, 'чёрный холст чётного размера')
assert.equal(inputsOf(cmd).length, 3, 'по входу на кусок')
assert.equal(argsOf(cmd).at(-1), '/out.mp4')
// слои: нижний (a) кладётся раньше верхнего (b), b включён только с 5 до 9
assert.ok(g.indexOf('[base][v') < g.indexOf("enable='between(t,5.000,9.000)'"), 'верхний слой позже нижнего')
const ov = [...g.matchAll(/overlay=x=\(W-w\)\/2[^;]*enable='between\(t,([\d.]+),/g)].map((m) => m[1])
assert.deepEqual(ov, ['0.000', '5.000'], 'сначала нижняя дорожка, потом верхняя')
assert.match(g, /adelay=2000:all=1/, 'звук музыки с задержкой 2 с')
assert.match(g, /amix=inputs=2:normalize=0/, 'у b звука нет — свёрнуты звук a и музыка')
assert.ok(argsOf(cmd).includes('libx264') && argsOf(cmd).includes('aac'))

// скрытая дорожка: картинки нет, звук есть; заглушённая: звука нет
const hidTop = setTrack(p, topT, { hidden: true })
cmd = buildExport(hidTop, opts, '/o.mp4')
g = graphOf(cmd)
assert.equal((g.match(/overlay=x=\(W-w\)\/2/g) ?? []).length, 1, 'скрытый слой не рисуется')
assert.equal(inputsOf(cmd).length, 2, 'вход для b (без звука и скрыт) не нужен')
const mutedLow = setTrack(p, lowT, { muted: true })
cmd = buildExport(mutedLow, opts, '/o.mp4')
assert.match(graphOf(cmd), /amix=inputs=1/, 'заглушена дорожка a — остался только звук музыки')
const both = setTrack(setTrack(p, topT, { hidden: true, muted: true }), lowT, { hidden: true })
assert.doesNotThrow(() => buildExport(both, opts, '/o.mp4'))
// громкость
const quiet = { ...p, items: p.items.map((i) => (i.mediaId === ma ? { ...i, volume: 0.5 } : i)) }
assert.match(graphOf(buildExport(quiet, opts, '/o.mp4')), /volume=0\.500/)

// вход: -ss in -t длина перед файлом
const a = argsOf(buildExport(p, opts, '/o.mp4'))
const iA = a.indexOf('/a.mp4')
assert.deepEqual(a.slice(iA - 5, iA), ['-ss', '0.000', '-t', '10.000', '-i'])

// ProRes
cmd = buildExport(p, { ...opts, format: 'prores422' }, '/o.mov')
assert.match(graphOf(cmd), /format=yuv422p10le\[vout\]/)
assert.ok(argsOf(cmd).includes('prores_ks') && argsOf(cmd).includes('pcm_s16le'))

// субтитры: слой встаёт на место своей дорожки среди видеослоёв
let sp = p
sp = applyRecognized(sp, ma, 0, 10, [{ id: 0, text: 'раз', start: 1, end: 1.5 }])
sp = addSubtitles(sp, [ia.id])
const subTrack = sp.items.find((i) => i.kind === 'subs').trackId
assert.equal(subTrack, videoTracks(sp)[0].id, 'субтитры на самой верхней дорожке')
cmd = buildExport(sp, { ...opts, subLayers: [{ trackId: subTrack, path: '/tmp/sub1.mov', start: 0, end: 10 }] }, '/o.mp4')
g = graphOf(cmd)
assert.equal(inputsOf(cmd).at(-1), '/tmp/sub1.mov', 'слой субтитров — отдельный вход')
assert.match(g, /\[3:v\]format=gbrap,setpts=PTS-STARTPTS\+0\.000\/TB\[s3\]/)
// порядок: видео a (низ), видео b и субтитры лежат на одной верхней дорожке — субтитры не ниже a
const order = [...g.matchAll(/overlay=[^;]*\[(o\d)\]/g)].map((m) => m[1])
assert.equal(order.length, 3)
assert.ok(order.indexOf('o3') > order.indexOf('o0'), 'субтитры выше нижнего видео')
// субтитры под оверлеем: переносим слой субтитров на нижнюю дорожку, а оверлей оставляем наверху
let under = moveItem(sp, sp.items.find((i) => i.kind === 'subs').id, lowT, 20) // 20..30 на нижней, где a кончился на 10
const subItem = under.items.find((i) => i.kind === 'subs')
assert.equal(subItem.trackId, lowT)
cmd = buildExport(under, { ...opts, subLayers: [{ trackId: lowT, path: '/tmp/s.mov', start: 20, end: 30 }] }, '/o.mp4')
const ord2 = [...graphOf(cmd).matchAll(/overlay=[^;]*enable='between\(t,([\d.]+),([\d.]+)\)'\[(o\d)\]/g)].map((m) => `${m[1]}-${m[2]}`)
assert.deepEqual(ord2, ['0.000-10.000', '20.000-30.000', '5.000-9.000'], 'слои: нижняя дорожка (a, субтитры), затем верхняя (b)')
// слой на скрытой дорожке не добавляется
cmd = buildExport(setTrack(sp, subTrack, { hidden: true }), { ...opts, subLayers: [{ trackId: subTrack, path: '/tmp/x.mov', start: 0, end: 10 }] }, '/o.mp4')
assert.ok(!inputsOf(cmd).includes('/tmp/x.mov'), 'слой скрытой дорожки пропускается')

// без звука вообще — тишина нужной длины
let s = newProject('S')
s = addMedia(s, V('/silent.mp4', 3, { hasAudio: false })).p
s = insertMedia(s, s.media[0].id, 0).p
assert.match(graphOf(buildExport(s, opts, '/s.mp4')), /anullsrc=r=48000:cl=stereo,atrim=0:3\.000\[aout\]/)

assert.throws(() => buildExport(newProject('Пусто'), opts, '/x.mp4'), /пуст/)

console.log('exportGraph.ts: все проверки прошли')
