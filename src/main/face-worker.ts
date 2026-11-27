/**
 * Воркер поиска лиц (Electron utilityProcess): ffmpeg отдаёт кадры (rgb24 640×640, картинка по центру на чёрном квадрате),
 * YuNet через onnxruntime-web (WASM, процессор) находит лица. Вход: { ffmpeg, media, from, to, fps, srcW, srcH, modelPath }.
 * Выход: progress (0..1) и done { scan: { samples, cuts, speech } } или error. cuts — жёсткие склейки монтажа; для режима «говорящий»
 * (speaker) ещё движение губ у лиц (act, по областям рта на кадрах в оригинальном размере) и интервалы речи в звуке. Параллельно ничего не запускаем: окно не должно тормозить.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { decodeYunet, FACE_INPUT, letterbox, type FaceSample, type FaceScan } from '../shared/face'

const ort = require('onnxruntime-web')

interface ParentPort {
  on(event: 'message', cb: (e: { data: unknown }) => void): void
  postMessage(msg: unknown): void
}
const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort

interface RunMsg {
  ffmpeg: string
  /** параметры входа для видео (запасной декодер AV1, если нужен) */
  dec: string[]
  media: string
  from: number
  to: number
  fps: number
  srcW: number
  srcH: number
  modelPath: string
  /** режим «говорящий»: считать движение губ и речь */
  speaker: boolean
}

/** Моменты жёстких склеек (ffmpeg scene > 0.3), секунды файла: подкаст часто смонтирован с нескольких камер. */
function findCuts(m: RunMsg): Promise<number[]> {
  return new Promise((resolve) => {
    const ff = spawn(
      m.ffmpeg,
      ['-hide_banner', '-loglevel', 'info', '-ss', m.from.toFixed(3), '-t', Math.max(0.05, m.to - m.from).toFixed(3), ...m.dec, '-i', m.media, '-an', '-sn', '-vf', "scale=320:-2,select='gt(scene,0.3)',showinfo", '-f', 'null', '-'],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )
    let text = ''
    ff.stderr.on('data', (d) => (text += d))
    ff.on('error', () => resolve([]))
    ff.on('close', () => {
      const cuts: number[] = []
      for (const mt of text.matchAll(/pts_time:([\d.]+)/g)) cuts.push(Math.round((m.from + Number(mt[1])) * 1000) / 1000)
      resolve(cuts)
    })
  })
}

/** Где в звуке есть речь: громкость по окнам 0,1 с, порог — на 14 дБ ниже обычного громкого уровня (85-й процентиль): паузы тише, речь выше; дыры до 0,4 с закрываются. */
function findSpeech(m: RunMsg): Promise<Array<[number, number]> | undefined> {
  return new Promise((resolve) => {
    const ff = spawn(m.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', m.from.toFixed(3), '-t', Math.max(0.05, m.to - m.from).toFixed(3), '-i', m.media, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], {
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const chunks: Buffer[] = []
    ff.stdout.on('data', (d: Buffer) => chunks.push(d))
    ff.on('error', () => resolve(undefined))
    ff.on('close', () => {
      const buf = Buffer.concat(chunks)
      const n = Math.floor(buf.length / 2)
      const win = 800
      if (n < win) return resolve(undefined)
      const db: number[] = []
      for (let i = 0; i + win <= n; i += win) {
        let sum = 0
        for (let j = 0; j < win; j++) {
          const v = buf.readInt16LE((i + j) * 2) / 32768
          sum += v * v
        }
        db.push(10 * Math.log10(sum / win + 1e-12))
      }
      const loud = [...db].sort((a, b) => a - b)[Math.floor(db.length * 0.85)]
      const thr = Math.max(loud - 14, -55)
      const on = db.map((v) => v > thr)
      const out: Array<[number, number]> = []
      let a = -1
      let gap = 0
      for (let k = 0; k <= on.length; k++) {
        if (k < on.length && on[k]) {
          if (a < 0) a = k
          gap = 0
        } else if (a >= 0) {
          gap++
          if (k === on.length || gap > 4) {
            const end = k - gap + 1
            if (end - a >= 3) out.push([Math.round((m.from + a * 0.1) * 1000) / 1000, Math.round((m.from + end * 0.1) * 1000) / 1000])
            a = -1
          }
        }
      }
      resolve(out)
    })
  })
}

/**
 * Движение губ: кадры в оригинальном размере (серые, ~10 в секунду); у каждого лица в планах с двумя лицами и более берём область рта и
 * смотрим, как меняется её контраст (рот открыт — тёмная полость и зубы). Голова качается — контраст области почти не меняется,
 * а говорящий даёт постоянные колебания. Результат — act у рамок (среднее изменение за кадры вокруг момента поиска).
 */
async function mouthActivity(m: RunMsg, samples: FaceSample[], cuts: number[], onProgress: (v: number) => void): Promise<void> {
  if (!samples.some((s) => s.boxes.length >= 2)) return
  const FPS = 10
  const W = Math.max(2, Math.floor(Math.min(1280, m.srcW) / 2) * 2)
  const H = Math.max(2, Math.round((m.srcH * W) / m.srcW / 2) * 2)
  const len = Math.max(0.05, m.to - m.from)
  const ff = spawn(
    m.ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-ss', m.from.toFixed(3), '-t', len.toFixed(3), ...m.dec, '-i', m.media, '-an', '-sn', '-vf', `fps=${FPS}:round=up,scale=${W}:${H},format=gray`, '-f', 'rawvideo', 'pipe:1'],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )
  // std области рта у каждой рамки на каждом кадре; группируем по кадру поиска
  const series = new Map<string, Array<[number, number]>>()
  let pending: Buffer = Buffer.alloc(0)
  const frameBytes = W * H
  let k = 0
  const total = Math.max(1, Math.ceil(len * FPS))
  for await (const chunk of ff.stdout as AsyncIterable<Buffer>) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    while (pending.length >= frameBytes) {
      const frame = pending.subarray(0, frameBytes)
      pending = pending.subarray(frameBytes)
      const j = Math.min(samples.length - 1, Math.max(0, Math.round((k / FPS) * m.fps)))
      const boxes = samples[j].boxes
      if (boxes.length >= 2) {
        boxes.forEach((b, bi) => {
          const x0 = Math.max(0, Math.floor((b.x + b.w * 0.2) * W))
          const x1 = Math.min(W, Math.ceil((b.x + b.w * 0.8) * W))
          const y0 = Math.max(0, Math.floor((b.y + b.h * 0.6) * H))
          const y1 = Math.min(H, Math.ceil((b.y + b.h * 0.98) * H))
          if (x1 - x0 < 3 || y1 - y0 < 3) return
          let sum = 0
          let sq = 0
          let cnt = 0
          for (let y = y0; y < y1; y++) {
            const row = y * W
            for (let x = x0; x < x1; x++) {
              const v = frame[row + x]
              sum += v
              sq += v * v
              cnt++
            }
          }
          const mean = sum / cnt
          const key = `${j}:${bi}`
          const arr = series.get(key) ?? []
          arr.push([m.from + k / FPS, Math.sqrt(Math.max(0, sq / cnt - mean * mean))])
          series.set(key, arr)
        })
      }
      k++
      if (k % 20 === 0) onProgress(Math.min(1, k / total))
    }
  }
  for (const [key, arr] of series) {
    if (arr.length < 2) continue
    const [j, bi] = key.split(':').map(Number)
    let d = 0
    let pairs = 0
    for (let i = 1; i < arr.length; i++) {
      // разность через склейку — другой кадр, а не губы
      if (cuts.some((c) => c > arr[i - 1][0] && c <= arr[i][0])) continue
      d += Math.abs(arr[i][1] - arr[i - 1][1])
      pairs++
    }
    if (pairs > 0) samples[j].boxes[bi].act = Math.round((d / pairs) * 100) / 100
  }
}

async function run(m: RunMsg): Promise<FaceScan> {
  const cutsJob = findCuts(m)
  const speechJob = m.speaker ? findSpeech(m) : Promise.resolve(undefined)
  ort.env.wasm.numThreads = Math.max(1, Math.min(4, Math.floor(cpus().length / 2)))
  const session = await ort.InferenceSession.create(readFileSync(m.modelPath), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
  const S = FACE_INPUT
  const lb = letterbox(m.srcW, m.srcH, S)
  const len = Math.max(0.05, m.to - m.from)
  const total = Math.max(1, Math.ceil(len * m.fps))
  const frameBytes = S * S * 3
  const ff = spawn(
    m.ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error',
      '-ss', m.from.toFixed(3), '-t', len.toFixed(3), ...m.dec, '-i', m.media,
      '-an', '-sn',
      '-vf', `fps=${m.fps}:round=up,scale=${S}:${S}:force_original_aspect_ratio=decrease,pad=${S}:${S}:(ow-iw)/2:(oh-ih)/2:black,format=rgb24`,
      '-f', 'rawvideo', 'pipe:1'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let err = ''
  ff.stderr.on('data', (d) => (err += d))
  const samples: FaceSample[] = []
  const tensor = new Float32Array(3 * S * S)
  let pending: Buffer = Buffer.alloc(0)
  let idx = 0
  for await (const chunk of ff.stdout as AsyncIterable<Buffer>) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    while (pending.length >= frameBytes) {
      const rgb = pending.subarray(0, frameBytes)
      pending = pending.subarray(frameBytes)
      // CHW, порядок BGR, значения 0..255 — как ждёт YuNet
      const plane = S * S
      for (let i = 0; i < plane; i++) {
        tensor[i] = rgb[i * 3 + 2]
        tensor[plane + i] = rgb[i * 3 + 1]
        tensor[2 * plane + i] = rgb[i * 3]
      }
      const out = await session.run({ input: new ort.Tensor('float32', tensor, [1, 3, S, S]) })
      const raw: Record<string, ArrayLike<number>> = {}
      for (const k of session.outputNames as string[]) raw[k] = out[k].data as Float32Array
      samples.push({ t: Math.round((m.from + idx / m.fps) * 1000) / 1000, boxes: decodeYunet(raw, lb) })
      idx++
      if (idx % 4 === 0) parentPort.postMessage({ type: 'progress', value: Math.min(0.99, (idx / total) * (m.speaker ? 0.75 : 1)) })
    }
  }
  const code = await new Promise<number | null>((resolve) => (ff.exitCode !== null ? resolve(ff.exitCode) : ff.on('close', resolve)))
  if (code !== 0 && samples.length === 0) throw new Error(`ffmpeg: ${err.trim().split('\n').pop() || `код ${code}`}`)
  const cuts = await cutsJob
  if (m.speaker) await mouthActivity(m, samples, cuts, (v) => parentPort.postMessage({ type: 'progress', value: 0.75 + v * 0.24 }))
  return { samples, cuts, speech: await speechJob }
}

parentPort.on('message', (e) => {
  run(e.data as RunMsg).then(
    (scan) => parentPort.postMessage({ type: 'done', scan }),
    (e2: unknown) => parentPort.postMessage({ type: 'error', message: e2 instanceof Error ? e2.message : String(e2) })
  )
})
