/**
 * Воркер распознавания (Electron utilityProcess).
 * Вход: { wavPath, modelDir, threads }. Выход: сообщения progress / done / error.
 * GigaAM v3 CTC через sherpa-onnx; таймстемпы посимвольные, шаг 40 мс, слова собираем по пробелам.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Word } from '../shared/types'

const sherpa = require('sherpa-onnx-node')

interface ParentPort {
  on(event: 'message', cb: (e: { data: unknown }) => void): void
  postMessage(msg: unknown): void
}
const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort

interface RunMsg {
  wavPath: string
  modelDir: string
  threads: number
}

const SR = 16000
const FRAME = 320 // 20 мс
const MAX_CHUNK_SEC = 30
const MIN_CHUNK_SEC = 15
const CHAR_DUR = 0.04 // шаг модели

/** Читает WAV PCM16 моно 16 кГц (формат, который мы сами делаем через ffmpeg) в Float32. */
function readWav16(path: string): Float32Array {
  const buf = readFileSync(path)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Промежуточный файл не похож на WAV')
  }
  let pos = 12
  let channels = 0
  let rate = 0
  let bits = 0
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2)
      rate = buf.readUInt32LE(body + 4)
      bits = buf.readUInt16LE(body + 14)
    } else if (id === 'data') {
      if (channels !== 1 || rate !== SR || bits !== 16) {
        throw new Error(`Нужен WAV моно 16 кГц 16 бит, получено ${channels} кан., ${rate} Гц, ${bits} бит`)
      }
      const end = Math.min(body + size, buf.length)
      const n = Math.floor((end - body) / 2)
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(body + i * 2) / 32768
      return out
    }
    pos = body + size + (size % 2)
  }
  throw new Error('В WAV нет блока data')
}

/** Режет запись на куски ≤30 с по самым тихим местам, чтобы не рвать слова. */
function planChunks(samples: Float32Array): Array<[number, number]> {
  const nFrames = Math.floor(samples.length / FRAME)
  const energy = new Float64Array(nFrames)
  for (let f = 0; f < nFrames; f++) {
    let s = 0
    const o = f * FRAME
    for (let i = 0; i < FRAME; i++) s += samples[o + i] * samples[o + i]
    energy[f] = s / FRAME
  }
  const smooth = (f: number): number => {
    let s = 0
    let n = 0
    for (let k = -2; k <= 2; k++) {
      const j = f + k
      if (j >= 0 && j < nFrames) {
        s += energy[j]
        n++
      }
    }
    return s / n
  }

  const chunks: Array<[number, number]> = []
  let start = 0
  while (samples.length - start > MAX_CHUNK_SEC * SR) {
    const from = Math.floor((start + MIN_CHUNK_SEC * SR) / FRAME)
    const to = Math.floor((start + MAX_CHUNK_SEC * SR) / FRAME)
    let best = from
    let bestE = Infinity
    for (let f = from; f < to && f < nFrames; f++) {
      const e = smooth(f)
      if (e < bestE) {
        bestE = e
        best = f
      }
    }
    const cut = best * FRAME + FRAME / 2
    chunks.push([start, cut])
    start = cut
  }
  chunks.push([start, samples.length])
  return chunks
}

function run(msg: RunMsg): void {
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SR, featureDim: 80 },
    modelConfig: {
      nemoCtc: { model: join(msg.modelDir, 'model.int8.onnx') },
      tokens: join(msg.modelDir, 'tokens.txt'),
      numThreads: msg.threads,
      provider: 'cpu',
      debug: 0
    }
  })

  // sherpa.readWave отдаёт «внешние» буферы, а Electron их запрещает, поэтому читаем WAV сами.
  const wave = { samples: readWav16(msg.wavPath), sampleRate: SR }

  const words: Word[] = []
  const chunks = planChunks(wave.samples)

  chunks.forEach(([a, b], idx) => {
    const stream = recognizer.createStream()
    stream.acceptWaveform({ samples: wave.samples.subarray(a, b), sampleRate: SR })
    recognizer.decode(stream)
    const r = recognizer.getResult(stream) as { tokens: string[]; timestamps: number[] }

    if (r.tokens?.length) {
      if (r.timestamps.length !== r.tokens.length) throw new Error('Модель не вернула таймстемпы')
      const offset = a / SR
      let cur: Word | null = null
      r.tokens.forEach((tok, i) => {
        if (tok === ' ') {
          cur = null
          return
        }
        const t = offset + r.timestamps[i]
        if (!cur) {
          cur = { id: words.length, text: '', start: t, end: t + CHAR_DUR }
          words.push(cur)
        }
        cur.text += tok
        cur.end = t + CHAR_DUR
      })
    }
    parentPort.postMessage({ type: 'progress', value: (idx + 1) / chunks.length })
  })

  parentPort.postMessage({ type: 'done', words })
}

parentPort.on('message', (e) => {
  try {
    run(e.data as RunMsg)
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
})
