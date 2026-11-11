/** Общие типы для main / preload / renderer. */
import type { SubtitleStyle } from './timeline'

export interface Word {
  id: number
  text: string
  /** секунды от начала файла */
  start: number
  end: number
}

export interface MediaInfo {
  path: string
  name: string
  duration: number
  hasVideo: boolean
  hasAudio: boolean
  width?: number
  height?: number
  fps?: number
}

export type ModelId = 'gigaam-v3' | 'whisper-small' | 'whisper-turbo'

export interface ModelStatus {
  id: ModelId
  title: string
  note: string
  sizeMB: number
  installed: boolean
  engine: 'sherpa' | 'whisper'
  /** лучший выбор для русского */
  recommended: boolean
  /** модель тяжела для этого ПК (мало памяти или ядер) */
  heavy: boolean
}

export interface ProgressEvent {
  stage: 'audio' | 'asr' | 'download' | 'render'
  /** 0..1 */
  value: number
  label: string
}

/** prores4444 — MOV с альфой; animation — MOV QuickTime Animation с альфой (легче); h264-green — MP4 на зелёном. */
export type RenderFormat = 'prores4444' | 'animation' | 'h264-green'
export type H264Quality = 'high' | 'medium' | 'small'

export interface RenderRequest {
  /** слова уже со сдвигом по времени */
  words: Word[]
  style: SubtitleStyle
  duration: number
  width: number
  height: number
  fps: number
  format: RenderFormat
  quality: H264Quality
  /** цвет фона для h264-green, #RRGGBB */
  greenColor: string
  /** положить в файл звук исходника (без видеодорожки исходника) */
  withAudio: boolean
  /** путь исходника; нужен только при withAudio */
  sourcePath?: string
  /** имя без расширения, для диалога сохранения */
  suggestedName: string
  suggestedDir?: string
}

export interface RenderResult {
  path: string
  seconds: number
  frames: number
  /** сколько кадров реально рисовали (остальные — повтор) */
  drawnFrames: number
  bytes: number
}

export interface SavedProject {
  words: Word[]
  savedAt: string
}

export interface UpdateEvent {
  state: 'downloading' | 'ready' | 'error'
  version?: string
  message?: string
}

export interface Api {
  pickMedia(): Promise<MediaInfo | null>
  /** Только для разработки: файл из переменной окружения TS_OPEN. */
  devInitialMedia(): Promise<MediaInfo | null>
  listModels(): Promise<ModelStatus[]>
  downloadModel(id: ModelId): Promise<void>
  transcribe(mediaPath: string, id: ModelId): Promise<Word[]>
  /** Диалог выбора файла шрифта; null — отмена или неподходящий файл */
  pickFont(): Promise<{ path: string; name: string } | null>
  /** Разрешить показ ранее выбранного шрифта после перезапуска; false — файла больше нет */
  allowFont(path: string): Promise<boolean>
  /** Сохранённые правки слов для этого файла (или null) */
  loadProject(mediaPath: string): Promise<SavedProject | null>
  saveProject(mediaPath: string, words: Word[]): Promise<void>
  /** null — пользователь закрыл диалог сохранения */
  render(req: RenderRequest): Promise<RenderResult | null>
  cancelRender(): Promise<void>
  revealFile(path: string): Promise<void>
  mediaUrl(path: string): string
  onProgress(cb: (e: ProgressEvent) => void): () => void
  /** Состояние автообновления (приходит только в собранной версии) */
  onUpdate(cb: (e: UpdateEvent) => void): () => void
  installUpdate(): Promise<void>
}
