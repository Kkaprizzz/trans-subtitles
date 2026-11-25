import { app, utilityProcess } from 'electron'
import { rm } from 'node:fs/promises'
import { cpus } from 'node:os'
import { join } from 'node:path'
import type { ModelId, ProgressEvent, Word } from '../shared/types'
import { extractAudio, probeMedia } from './media'
import { modelDir, modelDtw, modelEngine } from './models'
import { transcribeWithWhisper } from './whisper'

type Emit = (e: ProgressEvent) => void

export async function transcribe(mediaPath: string, id: ModelId, emit: Emit, signal?: AbortSignal): Promise<Word[]> {
  return transcribeRange(mediaPath, id, emit, undefined, 'Распознаю речь', signal)
}

/**
 * Распознаёт файл целиком или только отрезок [start, end] секунд. Времена слов — во времени файла
 * (смещены на start). label — подпись в строке состояния («Субтитры 2 из 3»).
 */
export async function transcribeRange(
  mediaPath: string,
  id: ModelId,
  emit: Emit,
  range?: { start: number; end: number },
  label = 'Распознаю речь',
  signal?: AbortSignal
): Promise<Word[]> {
  if (signal?.aborted) throw new Error('Отменено')
  const info = await probeMedia(mediaPath)
  if (!info.hasAudio) throw new Error('В файле нет звуковой дорожки — распознавать нечего')
  const wav = join(app.getPath('temp'), `trans-subtitles-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`)
  const start = range ? Math.max(0, range.start) : 0
  const length = range ? Math.max(0.1, Math.min(range.end, info.duration) - start) : info.duration
  const shift = (ws: Word[]): Word[] => (start === 0 ? ws : ws.map((w) => ({ ...w, start: w.start + start, end: w.end + start })))

  try {
    emit({ stage: 'audio', value: 0, label: `${label}: извлекаю звук` })
    await extractAudio(
      mediaPath,
      wav,
      length,
      (v) => emit({ stage: 'audio', value: v, label: `${label}: извлекаю звук` }),
      range ? { start, length } : undefined,
      signal
    )

    emit({ stage: 'asr', value: 0, label })
    const threads = Math.max(2, Math.min(8, Math.floor(cpus().length / 2)))

    if (modelEngine(id) === 'whisper') {
      return shift(
        await transcribeWithWhisper(wav, join(modelDir(id), 'model.bin'), threads, modelDtw(id), (v) =>
          emit({ stage: 'asr', value: v, label }),
          signal
        )
      )
    }

    return await new Promise<Word[]>((resolve, reject) => {
      const child = utilityProcess.fork(join(__dirname, 'asr-worker.js'), [], {
        serviceName: 'asr-worker'
      })
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

      child.on('message', (m: { type: string; value?: number; words?: Word[]; message?: string }) => {
        if (m.type === 'progress') emit({ stage: 'asr', value: m.value ?? 0, label })
        else if (m.type === 'done') finish(() => resolve(shift(m.words ?? [])))
        else if (m.type === 'error') finish(() => reject(new Error(m.message)))
      })
      child.on('exit', (code) =>
        finish(() => reject(new Error(`Воркер распознавания завершился с кодом ${code}`)))
      )

      child.postMessage({
        wavPath: wav,
        modelDir: modelDir(id),
        threads
      })
    })
  } finally {
    await rm(wav, { force: true })
  }
}
