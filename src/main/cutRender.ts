/**
 * Рендер клипов «Нарезки» в папку: на каждый клип один проход ffmpeg —
 * кусок исходника -> кадр холста (обрезка или видео на размытом фоне) -> подписи поверх -> H.264 + AAC.
 * Подписи рисует то же offscreen-окно, что и оверлей, и кадры идут в ffmpeg через stdin без временных файлов.
 * Вариант «подписи отдельным оверлеем» кладёт рядом второй файл с альфой (тот же рендер, что в режиме «Субтитры»).
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { clipFileBase, clipText, clipWords, framingFilter, type CutClip } from '../shared/cut'
import type { SubtitleStyle } from '../shared/timeline'
import type { CutRenderRequest, CutRenderResult, ProgressEvent, Word } from '../shared/types'
import { FFMPEG } from './paths'
import { openCaptionFrames, renderOverlay, type CancelToken } from './render'

const CRF = { high: 16, medium: 20, small: 25 } as const
const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)

interface ClipJob {
  source: string
  clip: CutClip
  words: Word[]
  style: SubtitleStyle
  W: number
  H: number
  fps: number
  quality: keyof typeof CRF
  burn: boolean
  out: string
}

async function renderOne(job: ClipJob, onFrame: (i: number, total: number) => void, cancel: CancelToken): Promise<void> {
  const dur = job.clip.end - job.clip.start
  const total = Math.max(1, Math.round(dur * job.fps))
  const subs = job.burn && job.words.length > 0
  const frames = subs ? await openCaptionFrames(job.words, job.style, job.W, job.H, null) : null

  const graph = [
    framingFilter(job.clip.framing, job.clip.offsetX, job.W, job.H),
    subs
      ? `[1:v]format=gbrap,unpremultiply=inplace=1[sub];[base][sub]overlay=0:0:format=auto:eof_action=pass,format=yuv420p[v]`
      : `[base]format=yuv420p[v]`
  ].join(';')

  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', job.clip.start.toFixed(3), '-t', dur.toFixed(3), '-i', job.source,
    ...(subs ? ['-f', 'rawvideo', '-pix_fmt', 'bgra', '-video_size', `${job.W}x${job.H}`, '-framerate', String(job.fps), '-i', 'pipe:0'] : []),
    '-filter_complex', graph,
    '-map', '[v]', '-map', '0:a:0?',
    '-r', String(job.fps), '-t', dur.toFixed(3),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(CRF[job.quality]), '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    job.out
  ]
  const ff = spawn(FFMPEG, args, { stdio: [subs ? 'pipe' : 'ignore', 'ignore', 'pipe'] })
  let ffErr = ''
  ff.stderr!.on('data', (d) => (ffErr += d))
  const exited = new Promise<number | null>((resolve) => ff.on('close', resolve))
  const spawnFailed = new Promise<never>((_, reject) => ff.on('error', reject))
  let stdinError: Error | null = null
  ff.stdin?.on('error', (e) => (stdinError = e))
  const fail = (): Error => new Error(`ffmpeg: ${ffErr.trim().split('\n').pop() || stdinError?.message || 'неизвестная ошибка'}`)

  // без подписей ffmpeg работает сам; прогресс по времени не считаем, просто ждём (и следим за отменой)
  const watch = subs
    ? null
    : setInterval(() => {
        if (cancel.cancelled) ff.kill('SIGKILL')
      }, 200)
  try {
    if (frames && ff.stdin) {
      for (let i = 0; i < total; i++) {
        if (cancel.cancelled) throw new Error('Отменено')
        if (stdinError) throw fail()
        const buf = await frames.frame(i / job.fps)
        if (!ff.stdin.write(buf)) await Promise.race([once(ff.stdin, 'drain'), spawnFailed])
        if (i % 15 === 0 || i === total - 1) onFrame(i + 1, total)
      }
      ff.stdin.end()
    }
    const code = await Promise.race([exited, spawnFailed])
    if (cancel.cancelled) throw new Error('Отменено')
    if (code !== 0) throw fail()
  } catch (e) {
    ff.stdin?.destroy()
    ff.kill('SIGKILL')
    await exited
    await rm(job.out, { force: true })
    throw e
  } finally {
    if (watch) clearInterval(watch)
  }
}

function validate(req: CutRenderRequest): void {
  const ok = (v: number, lo: number, hi: number): boolean => Number.isFinite(v) && v >= lo && v <= hi
  if (!ok(req.width, 16, 7680) || !ok(req.height, 16, 7680)) throw new Error('Размер кадра вне допустимого диапазона')
  if (!ok(req.fps, 1, 120)) throw new Error('FPS вне допустимого диапазона 1…120')
  if (!Array.isArray(req.clips) || req.clips.length === 0) throw new Error('Нет клипов для рендера: отметь хотя бы один')
  for (const c of req.clips) {
    if (!(c.end > c.start) || c.start < 0) throw new Error(`У клипа «${c.title || c.id}» неверные границы`)
    if (c.end - c.start > 15 * 60) throw new Error(`Клип «${c.title || c.id}» длиннее 15 минут — так не задумано`)
  }
}

/** Рендер всех клипов в папку: ролик + текст на каждый клип, по порядку на таймлайне. */
export async function renderClips(
  req: CutRenderRequest,
  dir: string,
  emit: (e: ProgressEvent) => void,
  cancel: CancelToken
): Promise<CutRenderResult> {
  validate(req)
  await mkdir(dir, { recursive: true })
  const W = even(req.width)
  const H = even(req.height)
  const started = Date.now()
  const clips = [...req.clips].sort((a, b) => a.start - b.start)
  const files: string[] = []
  let bytes = 0

  for (let k = 0; k < clips.length; k++) {
    if (cancel.cancelled) throw new Error('Отменено')
    const clip = clips[k]
    const base = clipFileBase(k, clip)
    const words = clipWords(req.words, clip)
    const label = (extra: string): string => `Клип ${k + 1} из ${clips.length}${extra}`
    const out = join(dir, `${base}.mp4`)
    emit({ stage: 'render', value: k / clips.length, label: label('') })

    await renderOne(
      { source: req.sourcePath, clip, words, style: req.style, W, H, fps: req.fps, quality: req.quality, burn: req.subtitles === 'burn', out },
      (i, total) => emit({ stage: 'render', value: (k + i / total) / clips.length, label: label(`: кадр ${i} из ${total}`) }),
      cancel
    )
    files.push(out)
    bytes += (await stat(out)).size

    if (req.subtitles === 'overlay' && words.length > 0) {
      const ovr = join(dir, `${base} — субтитры.mov`)
      emit({ stage: 'render', value: (k + 0.9) / clips.length, label: label(': оверлей субтитров') })
      await renderOverlay(
        {
          words,
          style: req.style,
          duration: clip.end - clip.start,
          width: W,
          height: H,
          fps: req.fps,
          format: 'animation',
          quality: req.quality,
          greenColor: '#00FF00',
          withAudio: false,
          suggestedName: base
        },
        ovr,
        () => {},
        cancel
      )
      files.push(ovr)
      bytes += (await stat(ovr)).size
    }

    if (req.writeText) {
      const txt = join(dir, `${base}.txt`)
      await writeFile(txt, clipText(clip))
      files.push(txt)
    }
  }
  emit({ stage: 'render', value: 1, label: `Готово: ${clips.length} клипов` })
  return { dir, files, clips: clips.length, seconds: (Date.now() - started) / 1000, bytes }
}
