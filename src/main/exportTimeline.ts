/**
 * Экспорт таймлайна одним файлом. Команда собирается в shared/exportGraph.ts. Каждый слой субтитров
 * (дорожка) сначала рисуется во временный прозрачный ролик тем же кодом, что и оверлей «для CapCut»,
 * потом ffmpeg вставляет эти ролики в свои слои среди видео и сводит звук.
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CLIP_H, CLIP_W, clipFileBase, clipSubtitleStyle, clipText, cropProject, orderedClips } from '../shared/cut'
import { buildExport, type FramingOpt, type SubLayerInput, type TextLayerInput } from '../shared/exportGraph'
import { itemEnd, projectDuration, subtitleLayers, timelineWords, type Project } from '../shared/project'
import { DEFAULT_STYLE, normalizeStyle, type SubtitleStyle } from '../shared/timeline'
import type { ClipsExportRequest, ClipsExportResult, ExportRequest, ExportResult, ProgressEvent } from '../shared/types'
import { FFMPEG } from './paths'
import { renderOverlay, renderPlatePng, type CancelToken } from './render'

const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)

interface Core {
  W: number
  H: number
  fps: number
  format: 'h264' | 'prores422'
  quality: ExportRequest['quality']
  burn: boolean
  style: SubtitleStyle
  framing?: FramingOpt
}

/** Один проход: слои субтитров во временные ролики, затем ffmpeg собирает всё в outPath. Прогресс — на шкале 0..1. */
async function renderCore(p: Project, o: Core, outPath: string, emit: (e: ProgressEvent) => void, cancel: CancelToken, prefix = ''): Promise<number> {
  const layers = o.burn ? subtitleLayers(p) : []
  // надписи рисуются картинками (скрытая дорожка надпись скрывает)
  const hiddenTracks = new Set(p.tracks.filter((t) => t.hidden).map((t) => t.id))
  const texts = p.items.filter((i) => i.kind === 'text' && i.plate && !hiddenTracks.has(i.trackId))
  const tmp = layers.length > 0 || texts.length > 0 ? await mkdtemp(join(app.getPath('temp'), 'ts-subs-')) : null
  // доля шкалы прогресса, отданная на рисование слоёв субтитров
  const pre = layers.length > 0 ? 0.3 : 0
  const subLayers: SubLayerInput[] = []

  try {
    for (let k = 0; k < layers.length; k++) {
      const l = layers[k]
      const dur = Math.max(0.2, l.end - l.start)
      const file = join(tmp as string, `layer${k}.mov`)
      const label = layers.length > 1 ? `Субтитры: слой ${k + 1} из ${layers.length}` : 'Субтитры'
      await renderOverlay(
        {
          words: l.words.map((w, id) => ({ id, text: w.text, start: Math.max(0, w.start - l.start), end: Math.max(0.02, w.end - l.start) })),
          style: o.style,
          duration: dur,
          width: o.W,
          height: o.H,
          fps: o.fps,
          format: 'animation',
          quality: o.quality,
          greenColor: '#00FF00',
          withAudio: false,
          suggestedName: 'layer'
        },
        file,
        (e) => emit({ stage: 'render', value: ((k + e.value) / layers.length) * pre, label: `${prefix}${label} — ${Math.round(e.value * 100)}%` }),
        cancel
      )
      subLayers.push({ trackId: l.trackId, path: file, start: l.start, end: l.start + dur })
    }

    const textLayers: TextLayerInput[] = []
    for (let k = 0; k < texts.length; k++) {
      if (cancel.cancelled) throw new Error('Отменено')
      const it = texts[k]
      const file = join(tmp as string, `plate${k}.png`)
      emit({ stage: 'render', value: pre * (k / texts.length) * 0.2, label: `${prefix}Надписи: ${k + 1} из ${texts.length}` })
      await renderPlatePng(it.plate as NonNullable<typeof it.plate>, o.W, o.H, file)
      textLayers.push({ trackId: it.trackId, path: file, start: it.start, end: itemEnd(it) })
    }
    const cmd = buildExport(p, { W: o.W, H: o.H, fps: o.fps, format: o.format, quality: o.quality, subLayers, framing: o.framing, textLayers }, outPath)
    const ff = spawn(FFMPEG, cmd.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    ff.stderr.on('data', (d) => (err += d))
    ff.stdout.on('data', (d: Buffer) => {
      const m = /out_time_us=(\d+)/.exec(d.toString())
      if (m) {
        const v = Math.min(1, Number(m[1]) / 1e6 / cmd.total)
        emit({ stage: 'render', value: pre + v * (1 - pre), label: `${prefix}Экспорт: ${Math.round(v * 100)}%` })
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
    return cmd.total
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true })
  }
}

export async function exportTimeline(
  p: Project,
  req: ExportRequest,
  outPath: string,
  emit: (e: ProgressEvent) => void,
  cancel: CancelToken
): Promise<ExportResult> {
  const started = Date.now()
  if (req.format === 'overlay') return exportOverlayOnly(p, req, outPath, emit, cancel, started)
  const duration = await renderCore(
    p,
    { W: even(req.width), H: even(req.height), fps: req.fps, format: req.format, quality: req.quality, burn: req.burnSubtitles, style: normalizeStyle(p.style ?? DEFAULT_STYLE) },
    outPath,
    emit,
    cancel
  )
  emit({ stage: 'render', value: 1, label: 'Экспорт готов' })
  return { path: outPath, seconds: (Date.now() - started) / 1000, bytes: (await stat(outPath)).size, duration }
}

/** Клипы «Нарезки» в папку: на каждую выбранную рамку — ролик 9:16 из того, что лежит на таймлайне в её границах, и .txt. */
export async function exportClips(
  p: Project,
  req: ClipsExportRequest,
  dir: string,
  emit: (e: ProgressEvent) => void,
  cancel: CancelToken
): Promise<ClipsExportResult> {
  const started = Date.now()
  const chosen = orderedClips(p).filter((c) => req.clipIds.includes(c.clip.id))
  if (chosen.length === 0) throw new Error('Не выбрано ни одного клипа')
  const missing = chosen.find((c) => !c.at)
  if (missing) throw new Error(`Клипа «${missing.clip.title || 'без названия'}» нет на таймлайне — вернуть видео или снять галочку`)
  await mkdir(dir, { recursive: true })
  const style = clipSubtitleStyle(normalizeStyle(p.style ?? DEFAULT_STYLE))
  const files: string[] = []
  let bytes = 0

  for (let k = 0; k < chosen.length; k++) {
    if (cancel.cancelled) throw new Error('Отменено')
    const { clip, at } = chosen[k]
    const a = at as NonNullable<typeof at>
    const base = clipFileBase(k, clip)
    const out = join(dir, `${base}.mp4`)
    const cp = cropProject(p, a.start, a.end)
    await renderCore(
      cp,
      { W: CLIP_W, H: CLIP_H, fps: p.fps, format: 'h264', quality: req.quality, burn: req.burnSubtitles, style, framing: { mediaId: clip.mediaId, mode: clip.framing, offsetX: clip.offsetX } },
      out,
      (e) => emit({ stage: 'render', value: (k + e.value) / chosen.length, label: e.label }),
      cancel,
      `Клип ${k + 1} из ${chosen.length}. `
    )
    files.push(out)
    bytes += (await stat(out)).size
    if (req.writeText) {
      const txt = join(dir, `${base}.txt`)
      await writeFile(txt, clipText(clip))
      files.push(txt)
    }
  }
  emit({ stage: 'render', value: 1, label: `Готово: ${chosen.length} клипов` })
  return { dir, files, clips: chosen.length, seconds: (Date.now() - started) / 1000, bytes }
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
