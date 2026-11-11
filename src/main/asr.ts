import { app, utilityProcess } from 'electron'
import { rm } from 'node:fs/promises'
import { cpus } from 'node:os'
import { join } from 'node:path'
import type { ModelId, ProgressEvent, Word } from '../shared/types'
import { extractAudio, probeMedia } from './media'
import { modelDir, modelEngine } from './models'
import { transcribeWithWhisper } from './whisper'

type Emit = (e: ProgressEvent) => void

export async function transcribe(mediaPath: string, id: ModelId, emit: Emit): Promise<Word[]> {
  const info = await probeMedia(mediaPath)
  const wav = join(app.getPath('temp'), `trans-subtitles-${Date.now()}.wav`)

  try {
    emit({ stage: 'audio', value: 0, label: 'Извлекаю звук' })
    await extractAudio(mediaPath, wav, info.duration, (v) =>
      emit({ stage: 'audio', value: v, label: 'Извлекаю звук' })
    )

    emit({ stage: 'asr', value: 0, label: 'Распознаю речь' })
    const threads = Math.max(2, Math.min(8, Math.floor(cpus().length / 2)))

    if (modelEngine(id) === 'whisper') {
      return await transcribeWithWhisper(wav, join(modelDir(id), 'model.bin'), threads, (v) =>
        emit({ stage: 'asr', value: v, label: 'Распознаю речь' })
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
        child.kill()
        fn()
      }

      child.on('message', (m: { type: string; value?: number; words?: Word[]; message?: string }) => {
        if (m.type === 'progress') emit({ stage: 'asr', value: m.value ?? 0, label: 'Распознаю речь' })
        else if (m.type === 'done') finish(() => resolve(m.words ?? []))
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
