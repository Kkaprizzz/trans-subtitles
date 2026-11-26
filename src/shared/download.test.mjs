import assert from 'node:assert/strict'
import { applyProgress, cleanError, cleanUrl, downloadArgs, infoArgs, isNewer, isPermanent, meterValue, newMeter, parseInfo, parseLine, sanitizeName, uniqueName, videoFormatId, ytDlpAsset } from './download.ts'

// --- ссылка
assert.equal(cleanUrl('  https://youtu.be/abc  '), 'https://youtu.be/abc')
assert.equal(cleanUrl('http://a.b/c?d=1'), 'http://a.b/c?d=1')
assert.equal(cleanUrl('file:///etc/passwd'), null, 'file:// — не ссылка')
assert.equal(cleanUrl('--exec rm'), null)
assert.equal(cleanUrl('youtube.com/watch'), null, 'без http — не принимаем')
assert.equal(cleanUrl('https://a.b/c d'), null, 'пробел внутри')
assert.equal(cleanUrl(''), null)

// --- список качеств из ответа yt-dlp
const info = {
  webpage_url: 'https://www.youtube.com/watch?v=x',
  title: 'Ролик',
  thumbnail: 'https://i.ytimg.com/vi/x/maxresdefault.jpg',
  duration: 120,
  extractor_key: 'Youtube',
  formats: [
    { height: null, vcodec: 'none', acodec: 'opus', filesize: 1_000_000 },
    { height: null, vcodec: 'none', acodec: 'mp4a.40.2', filesize: 2_000_000 },
    { height: 360, vcodec: 'avc1.4d401e', acodec: 'none', filesize: 5_000_000 },
    { height: 720, vcodec: 'avc1.64001f', acodec: 'none', filesize: 20_000_000 },
    { height: 720, vcodec: 'vp09.00.40.08', acodec: 'none', filesize: 15_000_000 },
    { height: 1080, vcodec: 'vp09.00.40.08', acodec: 'none', filesize: 40_000_000 },
    { height: 1080, vcodec: 'avc1.640028', acodec: 'none', filesize_approx: 60_000_000 },
    { height: 1440, vcodec: 'vp09.00.40.08', acodec: 'none', filesize: 90_000_000 }
  ]
}
const parsed = parseInfo(info, 'https://fallback')
assert.equal(parsed.title, 'Ролик')
assert.equal(parsed.url, 'https://www.youtube.com/watch?v=x')
assert.equal(parsed.source, 'Youtube')
assert.equal(parsed.thumbnailUrl, 'https://i.ytimg.com/vi/x/maxresdefault.jpg')
assert.deepEqual(parsed.formats.map((f) => f.label), ['1440p', '1080p', '720p', '360p', 'mp3'], 'высоты от большей, mp3 в конце')
const f1080 = parsed.formats.find((f) => f.label === '1080p')
assert.equal(f1080.filesize, 60_000_000 + 2_000_000, 'размер H.264 (приблизительный) + звук AAC')
const f720 = parsed.formats.find((f) => f.label === '720p')
assert.equal(f720.filesize, 20_000_000 + 2_000_000, 'на 720p H.264 важнее VP9, хотя VP9 меньше')
const f1440 = parsed.formats.find((f) => f.label === '1440p')
assert.equal(f1440.filesize, 92_000_000, 'на 1440p H.264 нет — берётся VP9')
const mp3 = parsed.formats.at(-1)
assert.equal(mp3.kind, 'audio')
assert.equal(mp3.formatId, 'bestaudio/best')
assert.equal(mp3.filesize, 2_000_000)
// выражение -f: сначала H.264+AAC, потом любой кодек этой высоты, потом лучшее
assert.equal(f720.formatId, 'bestvideo[height=720][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height=720]+bestaudio/best[height=720]/best')
assert.equal(videoFormatId(480).startsWith('bestvideo[height=480][vcodec^=avc1]'), true)
// порядок формата не важен: H.264 после VP9 той же высоты выигрывает, до — не вытесняется
const swapped = parseInfo({ title: 't', formats: [{ height: 720, vcodec: 'avc1', acodec: 'none', filesize: 7 }, { height: 720, vcodec: 'vp09', acodec: 'none', filesize: 5 }] }, 'u')
assert.equal(swapped.formats[0].filesize, 7)
// видео, где звук уже внутри: звук отдельно не прибавляем
const muxed = parseInfo({ title: 'm', formats: [{ height: 480, vcodec: 'avc1', acodec: 'mp4a.40.2', filesize: 9 }] }, 'u')
assert.equal(muxed.formats[0].filesize, 9)
// ни размера, ни формата
const bare = parseInfo({ formats: [] }, 'http://x')
assert.equal(bare.title, 'video')
assert.equal(bare.url, 'http://x')
assert.deepEqual(bare.formats.map((f) => f.label), ['mp3'])
assert.equal(bare.formats[0].filesize, null)
// только звук без высоты — не видео
assert.equal(parseInfo({ formats: [{ height: 0, vcodec: 'none', acodec: 'opus' }] }, 'u').formats.length, 1)

// --- аргументы запуска
const run = { kind: 'video', formatId: f720.formatId, url: 'https://x/y', out: '/v/Ролик_720p.%(ext)s', jsRuntime: 'node:/bin/bobina', ffmpeg: '/bin/ffmpeg' }
const v = downloadArgs(run)
assert.ok(v.includes('--merge-output-format') && v[v.indexOf('--merge-output-format') + 1] === 'mp4')
assert.ok(!v.includes('-x'), 'видео не конвертируется в звук')
assert.equal(v.at(-1), 'https://x/y')
assert.equal(v.at(-2), '--', 'ссылка после «--»: за параметр не сойдёт')
assert.equal(v[v.indexOf('-o') + 1], '/v/Ролик_720p.%(ext)s')
assert.ok(v.includes('--no-playlist'))
assert.equal(v[v.indexOf('--js-runtimes') + 1], 'node:/bin/bobina')
assert.equal(v[v.indexOf('--ffmpeg-location') + 1], '/bin/ffmpeg')
const a = downloadArgs({ ...run, kind: 'audio', formatId: 'bestaudio/best' })
assert.ok(a.includes('-x') && a[a.indexOf('--audio-format') + 1] === 'mp3' && a[a.indexOf('--audio-quality') + 1] === '0')
assert.ok(!a.includes('--merge-output-format'))
const ia = infoArgs('https://x', 'node:/n', '/f')
assert.deepEqual(ia.slice(-3), ['--no-warnings', '--', 'https://x'])
assert.ok(ia.includes('-J'))

// --- строки вывода
assert.deepEqual(parseLine('SFLF /home/u/Видео/Бобина/Ролик_720p.mp4'), { type: 'file', path: '/home/u/Видео/Бобина/Ролик_720p.mp4' })
assert.equal(parseLine('[download] Destination: x'), null)
const p1 = parseLine('SFLP avc1.64001f|none|downloading|1000|4000|NA|500|6')
assert.deepEqual(p1, { type: 'progress', stage: 'video', status: 'downloading', downloaded: 1000, total: 4000, speed: 500, eta: 6 })
const p2 = parseLine('SFLP none|mp4a.40.2|downloading|10|NA|200|NA|NA')
assert.equal(p2.stage, 'audio')
assert.equal(p2.total, 200, 'нет точного размера — приблизительный')
assert.equal(p2.speed, null)
assert.equal(parseLine('SFLP vp9|opus|downloading|5|50|NA|1|1').stage, 'single', 'видео и звук вместе')

// --- прогресс: видео, потом звук, потом склейка
let m = newMeter()
const est = 1000
m = applyProgress(m, { type: 'progress', stage: 'video', status: 'downloading', downloaded: 400, total: 800, speed: 100, eta: 4 })
assert.equal(meterValue(m, est), 0.4)
m = applyProgress(m, { type: 'progress', stage: 'video', status: 'finished', downloaded: 800, total: 800, speed: null, eta: null })
assert.equal(m.doneBytes, 800)
assert.equal(m.stage, 'post')
m = applyProgress(m, { type: 'progress', stage: 'audio', status: 'downloading', downloaded: 100, total: 200, speed: 50, eta: 2 })
assert.equal(meterValue(m, est), 0.9, 'видео 800 + звук 100 из 1000')
m = applyProgress(m, { type: 'progress', stage: 'audio', status: 'finished', downloaded: 200, total: 200, speed: null, eta: null })
assert.equal(meterValue(m, est), 0.99, 'склейка: почти готово, единицу ставит конец загрузки')
// оценка меньше факта — выше 0.99 не уходим
m = applyProgress(newMeter(), { type: 'progress', stage: 'single', status: 'downloading', downloaded: 5000, total: 5000, speed: 1, eta: 0 })
assert.equal(meterValue(m, 1000), 0.99)
// нет оценки — по размеру текущей части
m = applyProgress(newMeter(), { type: 'progress', stage: 'single', status: 'downloading', downloaded: 50, total: 200, speed: 1, eta: 1 })
assert.equal(meterValue(m, null), 0.25)
// ничего не известно
assert.equal(meterValue(newMeter(), null), 0)

// --- ошибки по-русски
assert.equal(cleanError('ERROR: [youtube] abc: Video unavailable'), 'Видео недоступно')
assert.equal(cleanError('WARNING: x\nERROR: [youtube] abc: Private video. Sign in'), 'Это приватное видео')
assert.equal(cleanError('ERROR: [generic] Unsupported URL: https://x'), 'Сайт не поддерживается')
assert.equal(cleanError('ERROR: Unable to download webpage: getaddrinfo failed'), 'Нет связи с сайтом')
assert.equal(cleanError('ERROR: [youtube] abc: Requested format is not available. Use --list-formats for a list'), 'Это качество больше недоступно')
assert.equal(cleanError('ERROR: [site] 1: Что-то странное'), 'Что-то странное', 'незнакомая ошибка — как есть, без служебного префикса')
assert.equal(cleanError(''), '')
assert.equal(isPermanent('Видео недоступно'), true)
assert.equal(isPermanent('Это приватное видео'), true)
assert.equal(isPermanent('Нет связи с сайтом'), false, 'сеть — повторяем')
assert.equal(isPermanent('HTTP Error 503'), false)

// --- имена
assert.equal(sanitizeName('Что?: «ролик» / *1*\n'), 'Что «ролик» 1')
assert.equal(sanitizeName('a'.repeat(300)).length, 150)
assert.equal(uniqueName('Ролик', '720p', () => false), 'Ролик_720p')
assert.equal(uniqueName('Ролик', '720p', (n) => n === 'Ролик_720p'), 'Ролик_720p (2)')
assert.equal(uniqueName('Ролик', '720p', (n) => n === 'Ролик_720p' || n === 'Ролик_720p (2)'), 'Ролик_720p (3)')
assert.equal(uniqueName('///', '', () => false), 'video', 'после чистки пусто — запасное имя')
assert.equal(uniqueName('', '720p', () => false), 'video_720p')

// --- версии yt-dlp
assert.equal(isNewer('2026.08.19', '2026.03.17'), true)
assert.equal(isNewer('2026.03.17', '2026.03.17'), false)
assert.equal(isNewer('2026.03.17', '2026.08.19'), false)
assert.equal(isNewer('v2026.10.01', null), true)
assert.equal(isNewer('2026.3.9', '2026.03.10'), false)
assert.equal(ytDlpAsset('linux', 'x64'), 'yt-dlp_linux')
assert.equal(ytDlpAsset('linux', 'arm64'), 'yt-dlp_linux_aarch64')
assert.equal(ytDlpAsset('win32', 'x64'), 'yt-dlp.exe')
assert.equal(ytDlpAsset('win32', 'arm64'), 'yt-dlp_arm64.exe')
assert.equal(ytDlpAsset('darwin', 'arm64'), 'yt-dlp_macos')

console.log('download.ts: все проверки прошли')
