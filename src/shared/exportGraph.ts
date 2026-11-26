/**
 * Сборка команды ffmpeg для экспорта таймлайна. Чистая функция — проверяется тестами без ffmpeg.
 *
 * Каждый кусок — отдельный вход (-ss in -t длина -i файл). Видео: чёрный холст W×H, поверх по очереди
 * снизу вверх (от нижней дорожки к верхней) каждый кусок, вписанный в кадр и включённый только на своём отрезке.
 * Скрытая дорожка картинки не даёт. Субтитры — готовые прозрачные ролики по слоям (по одному на дорожку),
 * они встают в тот же порядок слоёв, что и видео. Звук: все куски со звуком (кроме заглушённых дорожек)
 * задерживаются на свой start и сводятся без нормализации.
 */
import { gainExpr, gainPeak } from './audio.ts'
import { effectFilters } from './effects.ts'
import { fitSize, frameFilters } from './frame.ts'
import { framingChain } from './cut.ts'
import { itemDur, itemEnd, itemTrackKind, mediaOf, projectDuration, type Framing, type Project } from './project.ts'

export type ExportFormat = 'h264' | 'prores422'
export type ExportQuality = 'high' | 'medium' | 'small'

/** Готовый прозрачный ролик одного слоя субтитров (рисуется заранее) и его место на таймлайне. */
export interface SubLayerInput {
  trackId: string
  path: string
  start: number
  end: number
}

/** Кусок файла рамки заполняет кадр 9:16 по-своему (обрезка или блюр-фон); остальные куски вписываются как обычно. */
export interface FramingOpt {
  mediaId: string
  mode: Framing
  offsetX: number
}

/** Готовая картинка надписи (PNG на весь кадр) и её время на таймлайне. */
export interface TextLayerInput {
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
  /** кадрирование файла рамки (экспорт клипа) */
  framing?: FramingOpt
  /** картинки надписей; они встают в слои по высоте своих дорожек */
  textLayers?: TextLayerInput[]
}

export interface ExportCommand {
  args: string[]
  /** длина результата, с */
  total: number
}

/** Громкость куска: число без точек, иначе выражение по времени куска (звук к этому месту уже обрезан и начинается с нуля). */
const volumeFilter = (it: Project['items'][number]): string =>
  // громкость считается до смены темпа, поэтому время в выражении — секунды файла от начала отрезка
  it.gain.length === 0 ? `volume=${it.volume.toFixed(3)}` : `volume='${gainExpr(it.gain, it.volume, it.in, it.out - it.in)}':eval=frame`

/**
 * Время кадров куска: при скорости 1 — как раньше (fps, затем сдвиг на старт); иначе сначала растягиваем время,
 * потом fps повторяет кадры до нужной частоты (без интерполяции).
 */
const retime = (speed: number, start: string, fps: number): string =>
  Math.abs(speed - 1) < 1e-6
    ? `fps=${fps},setpts=PTS-STARTPTS+${start}/TB`
    : `setpts=(PTS-STARTPTS)/${speed.toFixed(4)}+${start}/TB,fps=${fps}`

/** Стоп-кадр: один кадр размножается на всю длину куска (len секунд) и встаёт на своё время. */
const freezeTiming = (len: number, start: string, fps: number): string => {
  const n = Math.max(1, Math.round(len * fps))
  return `trim=end_frame=1,setpts=PTS-STARTPTS,fps=${fps},loop=loop=${n - 1}:size=1:start=0,setpts=PTS-STARTPTS+${start}/TB`
}

/** Цепочка atempo для скорости (один фильтр держит 0.5–2; тон сохраняется). Пусто при скорости 1. */
export function tempoFilter(speed: number): string {
  if (Math.abs(speed - 1) < 1e-6) return ''
  const parts: number[] = []
  let s = speed
  while (s < 0.5) {
    parts.push(0.5)
    s /= 0.5
  }
  while (s > 2) {
    parts.push(2)
    s /= 2
  }
  parts.push(s)
  return parts.map((x) => `atempo=${x.toFixed(4)}`).join(',')
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
    .filter((i) => i.kind === 'media' || i.kind === 'freeze')
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
    // картинку даёт только кусок на видеодорожке (звук, отделённый от видео, лежит на звуковой); звук — если он прикреплён и не нулевой
    const useV = itemTrackKind(p, it) === 'video' && m.hasVideo && !hidden.has(it.trackId)
    const useA = it.kind === 'media' && m.hasAudio && it.audio && !muted.has(it.trackId) && gainPeak(it.gain, it.volume, it.in, it.out) > 0
    if (!useV && !useA) continue
    const k = inputCount++
    // вход режется по файлу (секунды исходника); скорость применяется фильтрами ниже
    // стоп-кадр берёт из файла один кадр с секунды in
    inputs.push('-ss', f3(it.in), '-t', it.kind === 'freeze' ? '0.5' : f3(it.out - it.in), '-i', m.path)
    const s = f3(it.start)
    const e = f3(itemEnd(it))
    if (useV) {
      layers.push({
        z: trackIdx.get(it.trackId) ?? 0,
        sort: it.start,
        apply: () => {
          const framed = o.framing && o.framing.mediaId === it.mediaId
          const timing = it.kind === 'freeze' ? freezeTiming(itemDur(it), s, o.fps) : retime(it.speed, s, o.fps)
          // эффекты кладутся на готовый кадр куска (после вписывания/кадрирования): сила блюра считается от высоты кадра
          const fx = effectFilters(it.effects, H)
          // размер вписанной картинки в кадре (для кропа и положения); у кадрированного клипа картинка занимает весь кадр
          const fit = framed ? { w: W, h: H } : fitSize(m.width ?? 0, m.height ?? 0, W, H)
          const ff = frameFilters(it.frame, fit.w, fit.h)
          // цепочка: вписывание/кадрирование → эффекты → кроп и масштаб → наложение (положение от центра кадра)
          const post = [...fx, ...(ff ? ff.chain : [])]
          const vOut = post.length ? `f${k}` : `v${k}`
          if (framed && o.framing) {
            graph.push(`[${k}:v]${timing}[r${k}]`, ...framingChain(`r${k}`, vOut, o.framing.mode, o.framing.offsetX, W, H, String(k)))
          } else {
            graph.push(`[${k}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1,${timing}[${vOut}]`)
          }
          if (post.length) graph.push(`[${vOut}]${post.join(',')}[v${k}]`)
          const pos = ff ? `x='${ff.x}':y='${ff.y}'` : 'x=(W-w)/2:y=(H-h)/2'
          graph.push(`[${last}][v${k}]overlay=${pos}:eof_action=pass:enable='between(t,${s},${e})'[o${k}]`)
          last = `o${k}`
        }
      })
    }
    if (useA) {
      const ms = Math.round(it.start * 1000)
      graph.push(`[${k}:a]aresample=48000,aformat=channel_layouts=stereo,${volumeFilter(it)}${tempoFilter(it.speed) ? `,${tempoFilter(it.speed)}` : ''},adelay=${ms}:all=1[a${k}]`)
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
  // надписи: готовые картинки на всё время куска, слой по высоте дорожки
  for (const tl of o.textLayers ?? []) {
    if (hidden.has(tl.trackId)) continue
    const k = inputCount++
    inputs.push('-loop', '1', '-framerate', String(o.fps), '-t', f3(tl.end - tl.start), '-i', tl.path)
    const s = f3(tl.start)
    const e = f3(tl.end)
    layers.push({
      z: trackIdx.get(tl.trackId) ?? 0,
      sort: tl.start,
      apply: () => {
        graph.push(
          `[${k}:v]format=rgba,setpts=PTS-STARTPTS+${s}/TB[x${k}]`,
          `[${last}][x${k}]overlay=x=0:y=0:format=auto:eof_action=pass:enable='between(t,${s},${e})'[o${k}]`
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
