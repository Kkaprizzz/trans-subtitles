/**
 * Скачивание видео и музыки по ссылке (yt-dlp). Здесь только чистые функции без Electron и файлов: разбор ответа
 * yt-dlp со списком качеств, разбор строк прогресса, аргументы запуска, понятные ошибки. Запуск и файлы — main/ytdlp.ts
 * и main/downloads.ts.
 */

export type DlKind = 'video' | 'audio'

export interface DlFormat {
  kind: DlKind
  /** «1080p» или «mp3» */
  label: string
  height: number | null
  /** выражение -f для yt-dlp */
  formatId: string
  /** примерный размер, байт (видео вместе со звуком); null — неизвестен */
  filesize: number | null
}

export interface DlInfo {
  url: string
  title: string
  /** картинка превью как data-URL (страница не ходит в сеть сама); null — нет */
  thumbnail: string | null
  duration: number | null
  source: string
  formats: DlFormat[]
}

export type DlStage = 'single' | 'video' | 'audio' | 'post'
export type DlStatus = 'queued' | 'active' | 'error'

/** Задача для окна и панели «Медиа»: что качается и как идёт. */
export interface DlTask {
  id: string
  /** проект, в библиотеку которого попадёт файл */
  projectKey: string
  url: string
  title: string
  kind: DlKind
  label: string
  status: DlStatus
  stage: DlStage | null
  /** 0..1 */
  value: number
  /** байт/с */
  speed: number | null
  /** секунд до конца */
  eta: number | null
  error: string | null
}

/** Что окно просит скачать (выбранное качество из DlInfo). */
export interface DlRequest {
  projectKey: string
  url: string
  title: string
  duration: number | null
  kind: DlKind
  label: string
  formatId: string
  filesize: number | null
}

/** Только http(s): yt-dlp понимает и file://, и пути, а ссылкой из поля это быть не должно. */
export function cleanUrl(raw: string): string | null {
  const s = String(raw ?? '').trim()
  if (!/^https?:\/\/\S+$/i.test(s)) return null
  return s
}

// --- ответ yt-dlp (-J) → список качеств ---

interface YtFormat {
  height?: number | null
  vcodec?: string | null
  acodec?: string | null
  filesize?: number | null
  filesize_approx?: number | null
}
interface YtInfo {
  webpage_url?: string
  original_url?: string
  title?: string
  thumbnail?: string
  duration?: number
  extractor_key?: string
  formats?: YtFormat[]
}

const sizeOf = (f: YtFormat): number => f.filesize || f.filesize_approx || 0
const hasVideo = (f: YtFormat): boolean => !!f.vcodec && f.vcodec !== 'none'
const hasAudio = (f: YtFormat): boolean => !!f.acodec && f.acodec !== 'none'
const isH264 = (f: YtFormat): boolean => !!f.vcodec && f.vcodec.startsWith('avc1')
const isAac = (f: YtFormat): boolean => !!f.acodec && f.acodec.startsWith('mp4a')

/**
 * Выражение -f для видео высоты h: H.264 + AAC, если они есть; иначе любой кодек этой высоты, иначе лучшее, что найдётся.
 * H.264 в mp4 гладко играет и режется в монтажке, поэтому ему отдаём предпочтение.
 */
export const videoFormatId = (h: number): string =>
  `bestvideo[height=${h}][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height=${h}]+bestaudio/best[height=${h}]/best`
export const AUDIO_FORMAT_ID = 'bestaudio/best'

export function parseInfo(info: YtInfo, fallbackUrl: string): Omit<DlInfo, 'thumbnail'> & { thumbnailUrl: string | null } {
  const all = info.formats ?? []
  const audioOnly = all.filter((f) => !hasVideo(f) && hasAudio(f))
  // под выбранное видео yt-dlp возьмёт m4a, если он есть; размер считаем по нему
  const audioSize = Math.max(0, ...audioOnly.filter(isAac).map(sizeOf)) || Math.max(0, ...audioOnly.map(sizeOf))

  // yt-dlp сортирует форматы от худшего к лучшему: для каждой высоты берём последний, но H.264 важнее
  const byHeight = new Map<number, YtFormat>()
  for (const f of all) {
    if (!f.height || !hasVideo(f)) continue
    const have = byHeight.get(f.height)
    if (have && isH264(have) && !isH264(f)) continue
    byHeight.set(f.height, f)
  }
  const formats: DlFormat[] = [...byHeight.values()]
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
    .map((f) => {
      const size = sizeOf(f)
      return {
        kind: 'video' as const,
        label: `${f.height}p`,
        height: f.height ?? null,
        formatId: videoFormatId(f.height as number),
        filesize: size ? size + (hasAudio(f) ? 0 : audioSize) : null
      }
    })
  formats.push({ kind: 'audio', label: 'mp3', height: null, formatId: AUDIO_FORMAT_ID, filesize: audioSize || null })

  return {
    url: info.webpage_url || info.original_url || fallbackUrl,
    title: info.title || 'video',
    thumbnailUrl: info.thumbnail || null,
    duration: info.duration || null,
    source: info.extractor_key || 'Unknown',
    formats
  }
}

// --- запуск и прогресс ---

export const PROGRESS_TEMPLATE =
  'download:SFLP %(info.vcodec)s|%(info.acodec)s|%(progress.status)s|%(progress.downloaded_bytes)s|' +
  '%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s'

export interface DlRun {
  kind: DlKind
  formatId: string
  url: string
  /** путь вывода с шаблоном расширения: …/Название_720p.%(ext)s */
  out: string
  /** `node:<путь к исполняемому файлу>` — для расшифровки YouTube нужен JS-рантайм */
  jsRuntime: string
  ffmpeg: string
}

export function downloadArgs(t: DlRun): string[] {
  const common = [
    '--no-playlist',
    '--newline',
    '--no-warnings',
    '--encoding',
    'utf-8',
    '--progress',
    '--progress-template',
    PROGRESS_TEMPLATE,
    '--print',
    'after_move:SFLF %(filepath)s',
    '-o',
    t.out
  ]
  const format = t.kind === 'audio' ? ['-f', t.formatId, '-x', '--audio-format', 'mp3', '--audio-quality', '0'] : ['-f', t.formatId, '--merge-output-format', 'mp4']
  // «--» перед ссылкой: она не может сойти за параметр
  return ['--js-runtimes', t.jsRuntime, '--ffmpeg-location', t.ffmpeg, ...format, ...common, '--', t.url]
}

export const infoArgs = (url: string, jsRuntime: string, ffmpeg: string): string[] => ['--js-runtimes', jsRuntime, '--ffmpeg-location', ffmpeg, '-J', '--no-playlist', '--no-warnings', '--', url]

export type DlLine =
  | { type: 'file'; path: string }
  | { type: 'progress'; stage: 'single' | 'video' | 'audio'; status: string; downloaded: number; total: number | null; speed: number | null; eta: number | null }

const num = (v: string | undefined): number | null => {
  const n = Number(v)
  return v !== undefined && v !== 'NA' && v !== 'None' && Number.isFinite(n) ? n : null
}

/** Строка вывода yt-dlp: итоговый путь файла или прогресс; прочее — null. */
export function parseLine(line: string): DlLine | null {
  if (line.startsWith('SFLF ')) return { type: 'file', path: line.slice(5).trim() }
  if (!line.startsWith('SFLP ')) return null
  const [vcodec, acodec, status, done, total, estimate, speed, eta] = line.slice(5).split('|')
  const stage = vcodec === 'none' ? 'audio' : acodec === 'none' ? 'video' : 'single'
  return { type: 'progress', stage, status: status ?? '', downloaded: num(done) ?? 0, total: num(total) ?? num(estimate), speed: num(speed), eta: num(eta) }
}

/** Накопитель прогресса: видео и звук качаются двумя частями, потом склейка. */
export interface DlMeter {
  doneBytes: number
  downloaded: number
  total: number | null
  stage: DlStage | null
  speed: number | null
  eta: number | null
}
export const newMeter = (): DlMeter => ({ doneBytes: 0, downloaded: 0, total: null, stage: null, speed: null, eta: null })

export function applyProgress(m: DlMeter, ev: Extract<DlLine, { type: 'progress' }>): DlMeter {
  if (ev.status === 'finished') {
    // часть скачана; дальше либо следующая часть, либо склейка и конвертация
    return { doneBytes: m.doneBytes + (ev.total ?? ev.downloaded), downloaded: 0, total: null, stage: 'post', speed: null, eta: null }
  }
  return { ...m, stage: ev.stage, downloaded: ev.downloaded, total: ev.total, speed: ev.speed, eta: ev.eta }
}

/** Доля готовности 0..0.99 (единицу ставит сам конец загрузки). estimate — размер из списка качеств. */
export function meterValue(m: DlMeter, estimate: number | null): number {
  if (m.stage === 'post') return 0.99
  const all = estimate && estimate > 0 ? estimate : m.total ? m.doneBytes + m.total : null
  if (!all) return 0
  return Math.max(0, Math.min(0.99, (m.doneBytes + m.downloaded) / all))
}

// --- ошибки ---

// Частые ошибки yt-dlp по-русски; остальные показываем как есть.
const KNOWN_ERRORS: Array<[RegExp, string]> = [
  [/video is unavailable|video unavailable/i, 'Видео недоступно'],
  [/private video/i, 'Это приватное видео'],
  [/requested format is not available/i, 'Это качество больше недоступно'],
  [/unsupported url/i, 'Сайт не поддерживается'],
  [/sign in to confirm your age|age-restricted/i, 'Видео с возрастным ограничением'],
  [/members-only/i, 'Видео только для подписчиков канала'],
  [/HTTP Error 404/i, 'Страница не найдена (404)'],
  [/unable to download webpage|getaddrinfo|timed out|connection/i, 'Нет связи с сайтом']
]

export function cleanError(stderr: string): string {
  const lines = String(stderr)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const errors = lines.filter((l) => l.startsWith('ERROR:'))
  const line = errors.length ? errors[errors.length - 1] : (lines[lines.length - 1] ?? '')
  const body = line.replace(/^ERROR:\s*/, '')
  // известную ошибку ищем в полной строке: «[generic] Unsupported URL: …» после чистки префикса теряет смысл
  const known = KNOWN_ERRORS.find(([re]) => re.test(body))
  if (known) return known[1]
  return body.replace(/^\[[^\]]+\]\s*[^:]+:\s*/, '').replace(/\s*Use --list-formats.*$/i, '')
}

/** Ошибки, которые повтор не исправит: показываем сразу, без автоповтора (и по-русски, и исходный английский текст). */
const PERMANENT = /недоступно|приватное|не поддерживается|возрастным|подписчиков|404|unavailable|private video|unsupported url|not available|has been removed|copyright|sign in to confirm your age|members-only|age-restricted/i
export const isPermanent = (message: string): boolean => PERMANENT.test(message)

// --- имена файлов и версии ---

export function sanitizeName(name: string): string {
  return String(name ?? '')
    .replace(/[<>:"/\\|?*\n\r\t]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150)
}

/** Имя без «занято»: «Название_720p», при совпадении «Название_720p (2)», «… (3)». */
export function uniqueName(title: string, label: string, taken: (name: string) => boolean): string {
  const t = sanitizeName(title) || 'video'
  const base = sanitizeName(label ? `${t}_${label}` : t) || 'video'
  if (!taken(base)) return base
  for (let i = 2; ; i += 1) {
    const candidate = `${base} (${i})`
    if (!taken(candidate)) return candidate
  }
}

/** «2026.08.19» новее «2026.03.17». */
export function isNewer(latest: string, current: string | null): boolean {
  const a = String(latest).replace(/^v/, '').split(/[.-]/).map(Number)
  const b = String(current ?? '').replace(/^v/, '').split(/[.-]/).map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (Number.isNaN(x) || Number.isNaN(y)) return String(latest) !== String(current)
    if (x !== y) return x > y
  }
  return false
}

/** Имя файла yt-dlp в релизе GitHub под платформу. */
export function ytDlpAsset(platform: string, arch: string): string {
  if (platform === 'win32') return arch === 'arm64' ? 'yt-dlp_arm64.exe' : arch === 'ia32' ? 'yt-dlp_x86.exe' : 'yt-dlp.exe'
  if (platform === 'darwin') return 'yt-dlp_macos'
  if (arch === 'arm64') return 'yt-dlp_linux_aarch64'
  if (arch === 'arm') return 'yt-dlp_linux_armv7l'
  return 'yt-dlp_linux'
}
