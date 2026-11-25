/**
 * Экспорт таймлайна одним файлом. Команда собирается в shared/exportGraph.ts. Каждый слой субтитров
 * (дорожка) сначала рисуется во временный прозрачный ролик тем же кодом, что и оверлей «для CapCut»,
 * потом ffmpeg вставляет эти ролики в свои слои среди видео и сводит звук.
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { buildExport, type SubLayerInput } from '../shared/exportGraph'
import { projectDuration, subtitleLayers, timelineWords, type Project } from '../shared/project'
import { DEFAULT_STYLE, normalizeStyle } from '../shared/timeline'
import type { ExportRequest, ExportResult, ProgressEvent } from '../shared/types'
import { FFMPEG } from './paths'
import { renderOverlay, type CancelToken } from './render'

const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)

export async function exportTimeline(
  p: Project,
  req: ExportRequest,
  outPath: string,
  emit: (e: ProgressEvent) => void,
  cancel: CancelToken
): Promise<ExportResult> {
  const started = Date.now()
  if (req.format === 'overlay') return exportOverlayOnly(p, req, outPath, emit, cancel, started)

  const W = even(req.width)
  const H = even(req.height)
  const layers = req.burnSubtitles ? subtitleLayers(p) : []
  const tmp = layers.length > 0 ? await mkdtemp(join(app.getPath('temp'), 'ts-subs-')) : null
  // доля шкалы прогресса, отданная на рисование слоёв субтитров
  const pre = layers.length > 0 ? 0.3 : 0
  const subLayers: SubLayerInput[] = []

  try {
    const style = normalizeStyle(p.style ?? DEFAULT_STYLE)
    for (let k = 0; k < layers.length; k++) {
      const l = layers[k]
      const dur = Math.max(0.2, l.end - l.start)
      const file = join(tmp as string, `layer${k}.mov`)
      const label = layers.length > 1 ? `Субтитры: слой ${k + 1} из ${layers.length}` : 'Субтитры'
      await renderOverlay(
        {
          words: l.words.map((w, id) => ({ id, text: w.text, start: Math.max(0, w.start - l.start), end: Math.max(0.02, w.end - l.start) })),
          style,
          duration: dur,
          width: W,
          height: H,
          fps: req.fps,
          format: 'animation',
          quality: req.quality,
          greenColor: '#00FF00',
          withAudio: false,
          suggestedName: 'layer'
        },
        file,
        (e) => emit({ stage: 'render', value: ((k + e.value) / layers.length) * pre, label: `${label} — ${Math.round(e.value * 100)}%` }),
        cancel
      )
      subLayers.push({ trackId: l.trackId, path: file, start: l.start, end: l.start + dur })
    }

    const cmd = buildExport(p, { W, H, fps: req.fps, format: req.format, quality: req.quality, subLayers }, outPath)
    const ff = spawn(FFMPEG, cmd.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    ff.stderr.on('data', (d) => (err += d))
    ff.stdout.on('data', (d: Buffer) => {
      const m = /out_time_us=(\d+)/.exec(d.toString())
      if (m) {
        const v = Math.min(1, Number(m[1]) / 1e6 / cmd.total)
        emit({ stage: 'render', value: pre + v * (1 - pre), label: `Экспорт: ${Math.round(v * 100)}%` })
      }
    })
    const exited = new Promise<number | null>((resolve) => ff.on('close', resolve))
    const spawnFailed = new Promise<never>((_, reject) => ff.on('error', reject))
    const watch = setInterval(() => {
      if (cancel.cancelled) ff.kill('SIGKILL')
    }, 200)
    try {
      const code = await Promise.race([exited, spawnFailed])
      if (cancel.cancelled) throw new Error('Отменено')
      if (code !== 0) throw new Error(`ffmpeg: ${err.trim().split('\n').pop() || 'неизвестная ошибка'}`)
    } catch (e) {
      ff.kill('SIGKILL')
      await exited
      await rm(outPath, { force: true })
      throw e
    } finally {
      clearInterval(watch)
    }
    emit({ stage: 'render', value: 1, label: 'Экспорт готов' })
    return { path: outPath, seconds: (Date.now() - started) / 1000, bytes: (await stat(outPath)).size, duration: cmd.total }
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true })
  }
}

/** Только субтитры: прозрачный (или зелёный) ролик на всю длину таймлайна — для наложения в другом редакторе. */
async function exportOverlayOnly(
  p: Project,
  req: ExportRequest,
  outPath: string,
  emit: (e: ProgressEvent) => void,
  cancel: CancelToken,
  started: number
): Promise<ExportResult> {
  const words = timelineWords(p)
  if (words.length === 0) throw new Error('На таймлайне нет субтитров: нажми «Субтитры»')
  const duration = projectDuration(p)
  const r = await renderOverlay(
    {
      words,
      style: normalizeStyle(p.style ?? DEFAULT_STYLE),
      duration,
      width: req.width,
      height: req.height,
      fps: req.fps,
      format: req.overlayFormat ?? 'animation',
      quality: req.quality,
      greenColor: req.greenColor ?? '#00FF00',
      withAudio: false,
      suggestedName: 'subs'
    },
    outPath,
    emit,
    cancel
  )
  return { path: r.path, seconds: (Date.now() - started) / 1000, bytes: r.bytes, duration }
}
