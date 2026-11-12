import { app } from 'electron'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cpus, totalmem } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ModelId, ModelStatus } from '../shared/types'

interface ModelFile {
  /** имя на диске */
  local: string
  /** имя на сервере */
  remote: string
}

interface ModelDef {
  title: string
  note: string
  sizeMB: number
  engine: 'sherpa' | 'whisper'
  baseUrl: string
  files: ModelFile[]
  /** оценка «тяжело»: нужно хотя бы столько ГБ памяти и столько логических ядер */
  needs: { memGB: number; cores: number }
  /** пресет выравнивания whisper.cpp (-dtw) для точных таймингов слов */
  dtw?: string
}

const HF_WHISPER = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'

const MODELS: Record<ModelId, ModelDef> = {
  'gigaam-v3': {
    title: 'GigaAM v3',
    note: 'Русский · быстро и точно · работает на CPU',
    sizeMB: 215,
    engine: 'sherpa',
    baseUrl: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16/resolve/main/',
    files: [
      { local: 'model.int8.onnx', remote: 'model.int8.onnx' },
      { local: 'tokens.txt', remote: 'tokens.txt' }
    ],
    needs: { memGB: 3, cores: 2 }
  },
  'whisper-small': {
    title: 'Whisper small',
    note: 'Со знаками препинания · легче turbo · подходит слабым ПК',
    sizeMB: 181,
    engine: 'whisper',
    baseUrl: HF_WHISPER,
    files: [{ local: 'model.bin', remote: 'ggml-small-q5_1.bin' }],
    needs: { memGB: 4, cores: 4 },
    dtw: 'small'
  },
  'whisper-turbo': {
    title: 'Whisper turbo',
    note: 'Со знаками препинания · точнее small · на CPU примерно реальное время',
    sizeMB: 547,
    engine: 'whisper',
    baseUrl: HF_WHISPER,
    files: [{ local: 'model.bin', remote: 'ggml-large-v3-turbo-q5_0.bin' }],
    needs: { memGB: 8, cores: 6 },
    dtw: 'large.v3.turbo'
  }
}

const MARKER = '.complete'

export const modelDir = (id: ModelId): string => join(app.getPath('userData'), 'models', id)

export const modelEngine = (id: ModelId): 'sherpa' | 'whisper' => MODELS[id].engine
export const modelDtw = (id: ModelId): string | undefined => MODELS[id].dtw

export function listModels(): ModelStatus[] {
  const memGB = totalmem() / 1024 ** 3
  const cores = cpus().length
  return (Object.keys(MODELS) as ModelId[]).map((id) => ({
    id,
    title: MODELS[id].title,
    note: MODELS[id].note,
    sizeMB: MODELS[id].sizeMB,
    installed: existsSync(join(modelDir(id), MARKER)),
    engine: MODELS[id].engine,
    recommended: id === 'gigaam-v3',
    heavy: memGB < MODELS[id].needs.memGB || cores < MODELS[id].needs.cores
  }))
}

/** Скачивает файлы модели во временные .part и переименовывает после проверки размера. */
export async function downloadModel(id: ModelId, onProgress: (v: number) => void): Promise<void> {
  const def = MODELS[id]
  const dir = modelDir(id)
  await mkdir(dir, { recursive: true })
  await rm(join(dir, MARKER), { force: true })

  const expectedTotal = def.sizeMB * 1024 * 1024
  let done = 0

  for (const { local: name, remote } of def.files) {
    const res = await fetch(def.baseUrl + remote, { redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`Не удалось скачать ${name}: HTTP ${res.status}`)
    const declared = Number(res.headers.get('content-length') ?? 0)

    const part = join(dir, name + '.part')
    let written = 0
    const source = Readable.fromWeb(res.body as never)
    source.on('data', (chunk: Buffer) => {
      written += chunk.length
      onProgress(Math.min(0.99, (done + written) / expectedTotal))
    })
    await pipeline(source, createWriteStream(part))

    if (declared && written !== declared) {
      await rm(part, { force: true })
      throw new Error(`Файл ${name} скачан не полностью (${written} из ${declared} байт)`)
    }
    await rename(part, join(dir, name))
    done += written
  }
  await writeFile(join(dir, MARKER), new Date().toISOString())
  onProgress(1)
}
