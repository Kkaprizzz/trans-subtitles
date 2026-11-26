/**
 * yt-dlp: программа-загрузчик. В установщик не входит: скачивается при первом использовании в userData/bin (с проверкой
 * SHA256), потом сама обновляется (не чаще раза в 12 часов, при открытии окна «Скачать»). Версии лежат рядом
 * (yt-dlp-<версия>), current.json указывает на основную. Запуск и разбор ответов — здесь, чистая логика — в shared/download.ts.
 */
import { app } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { cleanError, cleanUrl, downloadArgs, infoArgs, isNewer, parseInfo, ytDlpAsset, type DlInfo, type DlRun } from '../shared/download'
import type { DlStatus, ProgressEvent } from '../shared/types'
import { FFMPEG } from './paths'

type Emit = (e: ProgressEvent) => void

const EXE = process.platform === 'win32' ? '.exe' : ''
const REPO = 'yt-dlp/yt-dlp'
const CHECK_EVERY = 12 * 3600 * 1000
const LABEL = 'Скачиваю загрузчик видео'

const binDir = (): string => join(app.getPath('userData'), 'bin')
const currentFile = (): string => join(binDir(), 'current.json')
const stateFile = (): string => join(binDir(), 'state.json')

interface Current {
  version: string
  file: string
}

async function readCurrent(): Promise<Current | null> {
  try {
    const cur = JSON.parse(await readFile(currentFile(), 'utf8')) as Partial<Current>
    if (cur.version && cur.file && existsSync(join(binDir(), cur.file))) return { version: cur.version, file: cur.file }
  } catch {
    /* ещё не скачан */
  }
  return null
}

/** Путь к yt-dlp или null, если он ещё не скачан. */
async function ytDlpPath(): Promise<string | null> {
  const cur = await readCurrent()
  return cur ? join(binDir(), cur.file) : null
}

export async function ytDlpStatus(): Promise<DlStatus> {
  const cur = await readCurrent()
  return { installed: !!cur, version: cur?.version ?? null }
}

/** Для YouTube нужен JS-рантайм: в Electron уже есть Node, с ELECTRON_RUN_AS_NODE=1 исполняемый файл приложения работает как node. */
const jsRuntime = (): string => `node:${process.execPath}`
// Без UTF-8 yt-dlp на Windows пишет в pipe в кодировке консоли, и путь с кириллицей приходит битым.
const runEnv = (): NodeJS.ProcessEnv => ({ ...process.env, ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' })

function binaryVersion(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, ['--version'], { windowsHide: true, timeout: 30000 }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null))
  })
}

async function get(url: string, accept?: string): Promise<Response> {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Bobina', ...(accept ? { Accept: accept } : {}) } })
  if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`)
  return res
}

async function downloadTo(url: string, dest: string, emit?: Emit): Promise<string> {
  const res = await get(url)
  if (!res.body) throw new Error('Пустой ответ')
  const total = Number(res.headers.get('content-length')) || 0
  const hash = createHash('sha256')
  let got = 0
  const src = Readable.fromWeb(res.body as never)
  src.on('data', (c: Buffer) => {
    hash.update(c)
    got += c.length
    if (total) emit?.({ stage: 'download', value: Math.min(0.99, got / total), label: LABEL })
  })
  await pipeline(src, createWriteStream(dest))
  return hash.digest('hex')
}

let installing: Promise<void> | null = null

/** Скачать свежий yt-dlp под эту платформу и сделать основным. Параллельные вызовы ждут один и тот же. */
export function installYtDlp(emit?: Emit): Promise<void> {
  if (installing) return installing
  installing = (async () => {
    const name = ytDlpAsset(process.platform, process.arch)
    const base = `https://github.com/${REPO}/releases/latest/download/`
    emit?.({ stage: 'download', value: 0, label: LABEL })
    const sums = await (await get(`${base}SHA2-256SUMS`)).text()
    const expected = sums
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .find(([, f]) => f === name)?.[0]
    if (!expected) throw new Error(`Нет контрольной суммы для ${name}`)
    await mkdir(binDir(), { recursive: true })
    const tmp = join(binDir(), `yt-dlp.download${EXE}`)
    try {
      const actual = await downloadTo(`${base}${name}`, tmp, emit)
      if (actual !== expected) throw new Error('Контрольная сумма загрузчика не совпала')
      await chmod(tmp, 0o755)
      const version = await binaryVersion(tmp)
      if (!version) throw new Error('Загрузчик не запускается на этом компьютере')
      const file = `yt-dlp-${version}${EXE}`
      await rename(tmp, join(binDir(), file))
      await writeFile(currentFile(), JSON.stringify({ version, file }))
      await writeFile(stateFile(), JSON.stringify({ checkedAt: Date.now() }))
      await cleanOld(file)
      emit?.({ stage: 'download', value: 1, label: 'Загрузчик видео готов' })
    } catch (e) {
      await rm(tmp, { force: true })
      throw e
    }
  })().finally(() => {
    installing = null
  })
  return installing
}

/** Старые версии удаляем; занятые (Windows держит запущенный exe) — в следующий раз. */
async function cleanOld(keep: string): Promise<void> {
  try {
    for (const name of await readdir(binDir())) {
      if (name === keep || !name.startsWith('yt-dlp-')) continue
      await unlink(join(binDir(), name)).catch(() => {})
    }
  } catch {
    /* папки нет */
  }
}

/** Тихое обновление: не чаще раза в 12 часов, ошибки (нет сети, лимит GitHub) не важны: работаем на том, что есть. */
export async function maybeUpdateYtDlp(): Promise<void> {
  try {
    const cur = await readCurrent()
    if (!cur) return
    try {
      const st = JSON.parse(await readFile(stateFile(), 'utf8')) as { checkedAt?: number }
      if (st.checkedAt && Date.now() - st.checkedAt < CHECK_EVERY) return
    } catch {
      /* проверки ещё не было */
    }
    const rel = (await (await get(`https://api.github.com/repos/${REPO}/releases/latest`, 'application/vnd.github+json')).json()) as { tag_name?: string }
    if (rel.tag_name && isNewer(rel.tag_name, cur.version)) await installYtDlp()
    else await writeFile(stateFile(), JSON.stringify({ checkedAt: Date.now() }))
  } catch {
    /* оставляем прежний */
  }
}

/** Загрузчик есть: если нет — скачивается (с прогрессом). */
export async function ensureYtDlp(emit?: Emit): Promise<string> {
  const have = await ytDlpPath()
  if (have) return have
  try {
    await installYtDlp(emit)
  } catch (e) {
    throw new Error(`Не удалось скачать загрузчик видео: ${e instanceof Error ? e.message : String(e)}. Проверь интернет и попробуй ещё раз`)
  }
  const path = await ytDlpPath()
  if (!path) throw new Error('Загрузчик видео не установился')
  return path
}

function runCapture(bin: string, args: string[], timeoutMs = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true, env: runEnv() })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      killTree(proc)
      reject(new Error('Сайт не ответил вовремя'))
    }, timeoutMs)
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (c: string) => (stdout += c))
    proc.stderr.on('data', (c: string) => (stderr += c))
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`Не удалось запустить загрузчик: ${err.message}`))
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(cleanError(stderr) || `Загрузчик завершился с кодом ${code}`))
    })
  })
}

/** Картинка превью как data-URL: страница не ходит в сеть сама. Не вышло — без картинки. */
async function fetchThumb(url: string | null): Promise<string | null> {
  if (!url || !/^https:\/\//i.test(url)) return null
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 8000)
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Bobina' } })
    clearTimeout(timer)
    const type = res.headers.get('content-type') ?? ''
    if (!res.ok || !/^image\/(jpeg|png|webp)/.test(type)) return null
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.length > 0 && buf.length < 2_000_000 ? `data:${type.split(';')[0]};base64,${buf.toString('base64')}` : null
  } catch {
    return null
  }
}

/** Что за ролик по ссылке и какие есть качества. Загрузчик при необходимости скачивается. */
export async function extractInfo(rawUrl: string, emit?: Emit): Promise<DlInfo> {
  const url = cleanUrl(rawUrl)
  if (!url) throw new Error('Это не ссылка. Вставь адрес ролика, он начинается с http:// или https://')
  const bin = await ensureYtDlp(emit)
  const stdout = await runCapture(bin, infoArgs(url, jsRuntime(), FFMPEG))
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    throw new Error('Не удалось разобрать ответ загрузчика')
  }
  const { thumbnailUrl, ...info } = parseInfo(raw as never, url)
  return { ...info, thumbnail: await fetchThumb(thumbnailUrl) }
}

/** Запуск загрузки. Своя группа процессов (Linux): отмена убивает и yt-dlp, и ffmpeg. */
export async function spawnDownload(run: Omit<DlRun, 'jsRuntime' | 'ffmpeg'>): Promise<ChildProcess> {
  const bin = await ensureYtDlp()
  return spawn(bin, downloadArgs({ ...run, jsRuntime: jsRuntime(), ffmpeg: FFMPEG }), { windowsHide: true, env: runEnv(), detached: process.platform !== 'win32' })
}

export function killTree(proc: ChildProcess | undefined): void {
  if (!proc || proc.exitCode !== null || !proc.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
    return
  }
  try {
    process.kill(-proc.pid, 'SIGTERM')
  } catch {
    proc.kill('SIGTERM')
  }
}
