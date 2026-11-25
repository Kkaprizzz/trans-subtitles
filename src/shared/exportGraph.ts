/**
 * Сборка команды ffmpeg для экспорта таймлайна. Чистая функция — проверяется тестами без ffmpeg.
 *
 * Каждый кусок — отдельный вход (-ss in -t длина -i файл). Видео: чёрный холст W×H, поверх по очереди
 * снизу вверх (от нижней дорожки к верхней) каждый кусок, вписанный в кадр и включённый только на своём отрезке.
 * Скрытая дорожка картинки не даёт. Субтитры — готовые прозрачные ролики по слоям (по одному на дорожку),
 * они встают в тот же порядок слоёв, что и видео. Звук: все куски со звуком (кроме заглушённых дорожек)
 * задерживаются на свой start и сводятся без нормализации.
 */
import { itemDur, itemEnd, mediaOf, projectDuration, type Project } from './project.ts'

export type ExportFormat = 'h264' | 'prores422'
export type ExportQuality = 'high' | 'medium' | 'small'

/** Готовый прозрачный ролик одного слоя субтитров (рисуется заранее) и его место на таймлайне. */
export interface SubLayerInput {
  trackId: string
  path: string
  start: number
  end: number
}

export interface GraphOpts {
  W: number
  H: number
  fps: number
  format: ExportFormat
  quality: ExportQuality
  /** слои субтитров; пусто — без субтитров */
  subLayers: SubLayerInput[]
}

export interface ExportCommand {
  args: string[]
  /** длина результата, с */
  total: number
}

const f3 = (x: number): string => (Math.round(x * 1000) / 1000).toFixed(3)
const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)
const CRF: Record<ExportQuality, number> = { high: 16, medium: 20, small: 25 }

export function buildExport(p: Project, o: GraphOpts, outPath: string): ExportCommand {
  const W = even(o.W)
  const H = even(o.H)
  const total = projectDuration(p)
  if (total <= 0) throw new Error('Таймлайн пуст: положи на него хотя бы одно видео')
  const trackIdx = new Map(p.tracks.map((t, i) => [t.id, i]))
  const muted = new Set(p.tracks.filter((t) => t.muted).map((t) => t.id))
  const hidden = new Set(p.tracks.filter((t) => t.hidden).map((t) => t.id))
  // снизу вверх: больший индекс дорожки — ниже; в пределах дорожки по времени
  const items = p.items
    .filter((i) => i.kind === 'media')
    .sort((a, b) => (trackIdx.get(b.trackId) ?? 0) - (trackIdx.get(a.trackId) ?? 0) || a.start - b.start)

  const inputs: string[] = []
  const graph: string[] = [`color=c=black:s=${W}x${H}:r=${o.fps}:d=${f3(total)},format=yuv420p[base]`]
  const aLabels: string[] = []
  let inputCount = 0
  let last = 'base'

  type Layer = { z: number; sort: number; apply: () => void }
  const layers: Layer[] = []

  for (const it of items) {
    const m = mediaOf(p, it.mediaId)
    if (!m) continue
    const useV = m.hasVideo && !hidden.has(it.trackId)
    const useA = m.hasAudio && !muted.has(it.trackId) && it.volume > 0
    if (!useV && !useA) continue
    const k = inputCount++
    inputs.push('-ss', f3(it.in), '-t', f3(itemDur(it)), '-i', m.path)
    const s = f3(it.start)
    const e = f3(itemEnd(it))
    if (useV) {
      layers.push({
        z: trackIdx.get(it.trackId) ?? 0,
        sort: it.start,
        apply: () => {
          graph.push(
            `[${k}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1,fps=${o.fps},setpts=PTS-STARTPTS+${s}/TB[v${k}]`,
            `[${last}][v${k}]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass:enable='between(t,${s},${e})'[o${k}]`
          )
          last = `o${k}`
        }
      })
    }
    if (useA) {
      const ms = Math.round(it.start * 1000)
      graph.push(`[${k}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${it.volume.toFixed(3)},adelay=${ms}:all=1[a${k}]`)
      aLabels.push(`a${k}`)
    }
  }

  // слои субтитров встают на свои места среди видеослоёв (нижний — раньше)
  for (const sl of o.subLayers) {
    if (hidden.has(sl.trackId)) continue
    const k = inputCount++
    inputs.push('-i', sl.path)
    const s = f3(sl.start)
    const e = f3(sl.end)
    layers.push({
      z: trackIdx.get(sl.trackId) ?? 0,
      sort: sl.start,
      apply: () => {
        graph.push(
          `[${k}:v]format=gbrap,setpts=PTS-STARTPTS+${s}/TB[s${k}]`,
          `[${last}][s${k}]overlay=x=0:y=0:format=auto:eof_action=pass:enable='between(t,${s},${e})'[o${k}]`
        )
        last = `o${k}`
      }
    })
  }
  layers.sort((a, b) => b.z - a.z || a.sort - b.sort).forEach((l) => l.apply())

  graph.push(`[${last}]format=${o.format === 'prores422' ? 'yuv422p10le' : 'yuv420p'}[vout]`)

  if (aLabels.length > 0) {
    graph.push(`${aLabels.map((l) => `[${l}]`).join('')}amix=inputs=${aLabels.length}:normalize=0:duration=longest,apad,atrim=0:${f3(total)}[aout]`)
  } else {
    graph.push(`anullsrc=r=48000:cl=stereo,atrim=0:${f3(total)}[aout]`)
  }

  const enc =
    o.format === 'prores422'
      ? ['-c:v', 'prores_ks', '-profile:v', o.quality === 'small' ? '2' : '3', '-vendor', 'apl0', '-c:a', 'pcm_s16le']
      : ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(CRF[o.quality]), '-profile:v', 'high', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart']

  const args = [
    '-hide_banner', '-loglevel', 'error', '-y', '-nostats', '-progress', 'pipe:1',
    ...inputs,
    '-filter_complex', graph.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-r', String(o.fps), '-t', f3(total),
    ...enc,
    '-ar', '48000',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    outPath
  ]
  return { args, total }
}
