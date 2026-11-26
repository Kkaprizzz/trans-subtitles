/**
 * Поиск лиц и трекинг: модель YuNet скачивается при первом использовании (как модели речи), кадры отдаёт ffmpeg, лица ищет
 * воркер на процессоре (WASM). Здесь — модель, предпросмотр одного кадра и поиск по отрезку; привязку к человеку и
 * сглаживание делает окно (shared/face.ts).
 */
import { app, utilityProcess } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FaceScan } from '../shared/face'
import type { FacePreview, FaceStatus, ProgressEvent } from '../shared/types'
import { probeMedia } from './media'
import { FFMPEG } from './paths'

type Emit = (e: ProgressEvent) => void

const SIZE_MB = 0.23
const URLS = [
  'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
  'https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx'
]
const dir = (): string => join(app.getPath('userData'), 'models', 'yunet')
const modelFile = (): string => join(dir(), 'model.onnx')
const marker = (): string => join(dir(), '.complete')

export const faceStatus = (): FaceStatus => ({ installed: existsSync(marker()) && existsSync(modelFile()), sizeMB: SIZE_MB })

export async function downloadFaceModel(emit: Emit): Promise<void> {
  if (faceStatus().installed) return
  await mkdir(dir(), { recursive: true })
  let lastErr = ''
  for (const url of URLS) {
    try {
      emit({ stage: 'download', value: 0, label: 'Скачиваю модель поиска лиц' })
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length')) || SIZE_MB * 1e6
      const part = `${modelFile()}.part`
      let got = 0
      const src = Readable.fromWeb(res.body as never)
      src.on('data', (c: Buffer) => {
        got += c.length
        emit({ stage: 'download', value: Math.min(0.99, got / total), label: 'Скачиваю модель поиска лиц' })
      })
      await pipeline(src, createWriteStream(part))
      if (got < 100_000) throw new Error('файл слишком маленький')
      await rename(part, modelFile())
      await writeFile(marker(), '1')
      emit({ stage: 'download', value: 1, label: 'Модель поиска лиц готова' })
      return
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      await rm(`${modelFile()}.part`, { force: true })
    }
  }
  throw new Error(`Не удалось скачать модель поиска лиц: ${lastErr}. Проверь интернет и попробуй ещё раз`)
}

/** Лица на кадрах отрезка [from, to] файла: воркер + ffmpeg. signal — отмена (воркер убивается). */
export async function detectFaces(mediaPath: string, from: number, to: number, fps: number, emit: Emit, signal?: AbortSignal, speaker = false): Promise<FaceScan> {
  if (!faceStatus().installed) throw new Error('Модель поиска лиц не скачана')
  const info = await probeMedia(mediaPath)
  if (!info.hasVideo || !info.width || !info.height) throw new Error('В файле нет видео')
  if (signal?.aborted) throw new Error('Отменено')
  return new Promise<FaceScan>((resolve, reject) => {
    const child = utilityProcess.fork(join(__dirname, 'face-worker.js'), [], { serviceName: 'face-worker' })
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      child.kill()
      fn()
    }
    const onAbort = (): void => finish(() => reject(new Error('Отменено')))
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('message', (m: { type: string; value?: number; scan?: FaceScan; message?: string }) => {
      if (m.type === 'progress') emit({ stage: 'face', value: m.value ?? 0, label: speaker ? 'Ищу говорящего' : 'Ищу лицо' })
      else if (m.type === 'done') {
        // отладка: TS_FACE_DUMP=/путь/файл.json сохраняет сырой результат поиска (лица, губы, склейки, речь)
        if (process.env['TS_FACE_DUMP'] && m.scan) void writeFile(process.env['TS_FACE_DUMP'], JSON.stringify(m.scan)).catch(() => undefined)
        finish(() => resolve(m.scan ?? { samples: [], cuts: [] }))
      }
      else if (m.type === 'error') finish(() => reject(new Error(m.message)))
    })
    child.on('exit', (code) => finish(() => reject(new Error(`Поиск лиц завершился с кодом ${code}`))))
    child.postMessage({ ffmpeg: FFMPEG, media: mediaPath, from, to, fps, srcW: info.width, srcH: info.height, modelPath: modelFile(), speaker })
  })
}

/** Кадр файла в момент t картинкой (JPEG, data URL) и найденные на нём лица — для выбора человека. */
export async function facePreview(mediaPath: string, t: number, signal?: AbortSignal): Promise<FacePreview> {
  const info = await probeMedia(mediaPath)
  if (!info.width || !info.height) throw new Error('В файле нет видео')
  const image = await new Promise<string>((resolve, reject) => {
    const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', mediaPath, '-frames:v', '1', '-vf', 'scale=960:-2', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '4', 'pipe:1'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const chunks: Buffer[] = []
    let err = ''
    ff.stdout.on('data', (d: Buffer) => chunks.push(d))
    ff.stderr.on('data', (d) => (err += d))
    ff.on('error', reject)
    ff.on('close', (code) => (code === 0 && chunks.length ? resolve(`data:image/jpeg;base64,${Buffer.concat(chunks).toString('base64')}`) : reject(new Error(err.trim().split('\n').pop() || 'Не удалось взять кадр'))))
  })
  const scan = await detectFaces(mediaPath, t, t + 0.3, 4, () => undefined, signal)
  return { image, width: info.width, height: info.height, boxes: scan.samples[0]?.boxes ?? [], t }
}
