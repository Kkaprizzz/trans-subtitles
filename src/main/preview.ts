/**
 * Копия видео для превью. Окно (Chromium) показывает только H.264, VP8/VP9 и AV1 в MP4/MOV/MKV/WebM;
 * HEVC (запись с iPhone), ProRes, AVI, MPEG-2 и т.п. выводят звук без картинки или не открываются.
 * Для таких файлов делаем лёгкую H.264-копию до 960 px и кэшируем её. Распознавание и рендер
 * по-прежнему работают с оригиналом.
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { videoInputArgs } from './decoder'
import { FFMPEG } from './paths'

export { needsPreview } from '../shared/formats'

const KEEP = 8
const dir = (): string => join(app.getPath('userData'), 'previews')
const inflight = new Map<string, Promise<string>>()

async function previewFile(src: string, alpha: boolean): Promise<string> {
  const st = await stat(src)
  const key = createHash('sha1').update(`${src}|${st.size}|${Math.floor(st.mtimeMs)}${alpha ? '|alpha' : ''}`).digest('hex')
  return join(dir(), `${key}.${alpha ? 'webm' : 'mp4'}`)
}

/** Оставляем только последние KEEP копий (по времени использования). */
async function prune(keep: string): Promise<void> {
  const files = (await readdir(dir())).filter((f) => f.endsWith('.mp4') || f.endsWith('.webm'))
  const withTime = await Promise.all(files.map(async (f) => ({ f, t: (await stat(join(dir(), f))).mtimeMs })))
  withTime.sort((a, b) => b.t - a.t)
  for (const { f } of withTime.slice(KEEP)) if (join(dir(), f) !== keep) await rm(join(dir(), f), { force: true })
}

/**
 * alpha — у видео есть прозрачность: копия делается VP9 с альфой в WebM (H.264 прозрачность не держит),
 * иначе оверлей в окне лежал бы на чёрном фоне. Окно Chromium такой WebM показывает с прозрачностью.
 */
export async function buildPreview(src: string, duration: number, onProgress: (v: number) => void, alpha = false): Promise<string> {
  const out = await previewFile(src, alpha)
  if (existsSync(out)) {
    const now = new Date()
    await utimes(out, now, now) // отметка «недавно использовали»
    return out
  }
  const running = inflight.get(out)
  if (running) return running

  const job = (async () => {
    await mkdir(dir(), { recursive: true })
    const part = `${out}.part`
    const dec = await videoInputArgs(src)
    await new Promise<void>((resolve, reject) => {
      const p = spawn(
        FFMPEG,
        [
          '-hide_banner', '-loglevel', 'error', '-y',
          ...dec,
          '-i', src,
          '-map', '0:v:0', '-map', '0:a:0?',
          '-vf', `scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=${alpha ? 'yuva420p' : 'yuv420p'}`,
          ...(alpha
            ? [
                // для альфы libvpx-vp9 нужен -auto-alt-ref 0; realtime — копия готова за секунды
                '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', '34',
                '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-g', '15',
                '-c:a', 'libopus', '-b:a', '128k', '-ac', '2'
              ]
            : [
                // замер на 5 мин HEVC 1080×1920: время почти не зависит от пресета (основное — чтение HEVC),
                // а размер — сильно: 1280/ultrafast/23 = 232 МБ, 960/veryfast/28 = 20 МБ при тех же ~25 с.
                // Частые ключевые кадры — быстрая перемотка.
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-g', '15',
                '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
                '-movflags', '+faststart'
              ]),
          '-progress', 'pipe:1', '-nostats',
          '-f', alpha ? 'webm' : 'mp4', part
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let err = ''
      p.stderr.on('data', (d) => (err += d))
      p.stdout.on('data', (d: Buffer) => {
        const m = /out_time_ms=(\d+)/.exec(d.toString())
        if (m && duration > 0) onProgress(Math.min(0.99, Number(m[1]) / 1e6 / duration))
      })
      p.on('error', reject)
      p.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`Не удалось подготовить превью: ${err.trim().split('\n').pop() || `код ${code}`}`))
      )
    }).catch(async (e) => {
      await rm(part, { force: true })
      throw e
    })
    await rename(part, out)
    onProgress(1)
    await prune(out).catch(() => undefined)
    return out
  })()
  inflight.set(out, job)
  try {
    return await job
  } finally {
    inflight.delete(out)
  }
}
