/**
 * Рендер оверлея: страница render.html в скрытом offscreen-окне -> кадры BGRA -> ffmpeg.
 *
 * Важные ограничения, найденные опытом (см. память проекта):
 *  - окно offscreen на Linux не больше экрана, поэтому размер кадра задаём не окном,
 *    а подменой вьюпорта через Emulation.setDeviceMetricsOverride;
 *  - второе offscreen-окно после destroy() не грузит страницу, поэтому окно одно на всё приложение;
 *  - кадры приходят с premultiplied-альфой, ffmpeg переводит её в обычную через unpremultiply.
 */
import { BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { once } from 'node:events'
import { join } from 'node:path'
import { buildPhrases, captionAt, frameKey } from '../shared/timeline'
import type { ProgressEvent, RenderFormat, RenderRequest, RenderResult } from '../shared/types'
import { FFMPEG } from './paths'

export interface CancelToken {
  cancelled: boolean
}

let win: BrowserWindow | null = null

function getWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    focusable: false,
    webPreferences: { offscreen: true, contextIsolation: true, sandbox: true }
  })
  win.webContents.setFrameRate(240)
  win.webContents.debugger.attach('1.3')
  return win
}

export function disposeRenderWindow(): void {
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}

async function loadRenderPage(w: BrowserWindow): Promise<void> {
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (dev) await w.loadURL(`${dev}/render.html`)
  else await w.loadFile(join(__dirname, '../renderer/render.html'))
}

const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)

const CRF: Record<RenderRequest['quality'], number> = { high: 14, medium: 18, small: 23 }

function encoderArgs(format: RenderFormat, quality: RenderRequest['quality']): string[] {
  const bt709 = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709']
  switch (format) {
    case 'prores4444':
      return [
        '-vf', 'format=gbrap,unpremultiply=inplace=1,scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le',
        '-c:v', 'prores_ks', '-profile:v', '4444', '-vendor', 'apl0', '-alpha_bits', '16',
        '-pix_fmt', 'yuva444p10le', ...bt709
      ]
    case 'animation':
      return ['-vf', 'format=gbrap,unpremultiply=inplace=1,format=argb', '-c:v', 'qtrle', '-pix_fmt', 'argb']
    case 'h264-green':
      return [
        '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', String(CRF[quality]), '-profile:v', 'high',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', ...bt709, '-color_range', 'tv'
      ]
  }
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) throw new Error(`Цвет фона должен быть вида #RRGGBB, получено «${hex}»`)
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function validate(req: RenderRequest): void {
  const ok = (v: number, lo: number, hi: number): boolean => Number.isFinite(v) && v >= lo && v <= hi
  if (!ok(req.width, 16, 7680) || !ok(req.height, 16, 7680)) throw new Error('Размер кадра вне допустимого диапазона 16…7680')
  if (!ok(req.fps, 1, 120)) throw new Error('FPS вне допустимого диапазона 1…120')
  if (!ok(req.duration, 0.1, 4 * 3600)) throw new Error('Длительность вне допустимого диапазона')
  if (req.withAudio && !req.sourcePath) throw new Error('Для звука нужен исходный файл')
  if (!Array.isArray(req.words) || req.words.length === 0) throw new Error('Нет слов для рендера: сначала распознай речь')
}

export async function renderOverlay(
  req: RenderRequest,
  outputPath: string,
  emit: (e: ProgressEvent) => void,
  cancel: CancelToken
): Promise<RenderResult> {
  validate(req)
  const W = even(req.width)
  const H = even(req.height)
  const fps = req.fps
  const total = Math.max(1, Math.ceil(req.duration * fps))
  const green = req.format === 'h264-green'
  const started = Date.now()

  const w = getWindow()
  const wc = w.webContents
  const dbg = wc.debugger

  await loadRenderPage(w)
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  const bg = green ? { ...hexToRgb(req.greenColor), a: 1 } : { r: 0, g: 0, b: 0, a: 0 }
  await dbg.sendCommand('Emulation.setDefaultBackgroundColorOverride', { color: bg })
  await wc.executeJavaScript(
    `window.__init(${JSON.stringify({ words: req.words, style: req.style, background: green ? req.greenColor : null })})`
  )

  // Звук исходника кладём в тот же файл; видеодорожку исходника не берём (map только 0:v и 1:a).
  const audioInputArgs = req.withAudio ? ['-i', req.sourcePath as string] : []
  const audioOutputArgs = req.withAudio
    ? [
        '-map', '0:v:0', '-map', '1:a:0',
        ...(green ? ['-c:a', 'aac', '-b:a', '256k'] : ['-c:a', 'pcm_s16le']),
        '-ar', '48000',
        // звук не длиннее картинки (кадров ceil, поэтому видео может быть чуть длиннее аудио)
        '-t', (total / fps).toFixed(3)
      ]
    : ['-an']

  const ff = spawn(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'bgra', '-video_size', `${W}x${H}`, '-framerate', String(fps),
      '-i', 'pipe:0',
      ...audioInputArgs,
      ...encoderArgs(req.format, req.quality),
      ...audioOutputArgs,
      outputPath
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] }
  )
  let ffErr = ''
  ff.stderr.on('data', (d) => (ffErr += d))
  let stdinError: Error | null = null
  ff.stdin.on('error', (e) => (stdinError = e))
  const exited = new Promise<number | null>((resolve) => ff.on('close', resolve))
  const spawnFailed = new Promise<never>((_, reject) => ff.on('error', reject))

  const fail = (): Error =>
    new Error(`ffmpeg: ${ffErr.trim().split('\n').pop() || (stdinError as Error | null)?.message || 'неизвестная ошибка'}`)

  const phrases = buildPhrases(req.words, req.style)
  let prevKey: string | null = null
  let buf: Buffer | null = null
  let drawn = 0

  try {
    for (let i = 0; i < total; i++) {
      if (cancel.cancelled) throw new Error('Отменено')
      if (stdinError) throw fail()

      const t = i / fps
      const key = frameKey(captionAt(req.words, phrases, req.style, t))
      if (key !== prevKey || !buf) {
        await wc.executeJavaScript(`window.__frame(${t})`)
        const img = await wc.capturePage()
        const size = img.getSize()
        if (size.width !== W || size.height !== H) {
          throw new Error(`Chromium отдал кадр ${size.width}×${size.height} вместо ${W}×${H}`)
        }
        buf = img.toBitmap()
        prevKey = key
        drawn++
      }
      if (!ff.stdin.write(buf)) await Promise.race([once(ff.stdin, 'drain'), spawnFailed])

      if (i % 20 === 0 || i === total - 1) {
        emit({ stage: 'render', value: (i + 1) / total, label: `Рендер: кадр ${i + 1} из ${total}` })
      }
    }
    ff.stdin.end()
    const code = await exited
    if (code !== 0) throw fail()
  } catch (e) {
    ff.stdin.destroy()
    ff.kill('SIGKILL')
    await exited
    const { rm } = await import('node:fs/promises')
    await rm(outputPath, { force: true })
    throw e
  }

  return {
    path: outputPath,
    seconds: (Date.now() - started) / 1000,
    frames: total,
    drawnFrames: drawn,
    bytes: (await stat(outputPath)).size
  }
}
