/** Общие типы для main / preload / renderer. */
import type { ClipCandidate } from './clips'
import type { Canvas, Project } from './project'
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
  /** кодек видео по ffprobe (h264, hevc, prores…) */
  videoCodec?: string
  /** окно не покажет картинку этого файла — нужна копия для превью */
  needsPreview: boolean
  /** в видео есть прозрачность (оверлеи): копия для превью делается с альфой */
  hasAlpha?: boolean
  width?: number
  height?: number
  fps?: number
}

/** Баннер в общей библиотеке: файл на диске + название; missing — файла больше нет. */
export interface BannerEntry extends MediaInfo {
  id: string
  missing: boolean
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
  stage: 'audio' | 'asr' | 'download' | 'render' | 'ai'
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

/** Строка списка проектов на стартовом экране. */
export interface ProjectSummary {
  id: string
  name: string
  updatedAt: string
  duration: number
  files: number
  canvas: Canvas | null
}

export interface OpenedProject {
  project: Project
  /** файлы проекта, которых нет на диске (или они больше не читаются) */
  missing: string[]
}

export type VideoFormat = 'h264' | 'prores422'

export interface ExportRequest {
  /** overlay — только субтитры отдельным файлом (с альфой или на зелёном) */
  format: VideoFormat | 'overlay'
  /** для overlay: формат файла субтитров */
  overlayFormat?: RenderFormat
  /** для overlay на зелёном: цвет фона #RRGGBB */
  greenColor?: string
  quality: H264Quality
  width: number
  height: number
  fps: number
  /** вшить субтитры кусков, у которых они включены */
  burnSubtitles: boolean
}

/** Экспорт клипов «Нарезки» в папку: по ролику 9:16 на выбранную рамку. */
export interface ClipsExportRequest {
  clipIds: string[]
  quality: H264Quality
  /** вшить субтитры (кусков субтитров на таймлайне в рамке) */
  burnSubtitles: boolean
  /** класть рядом .txt с заголовком, описанием и хэштегами */
  writeText: boolean
}

export interface ClipsExportResult {
  dir: string
  files: string[]
  clips: number
  seconds: number
  bytes: number
}

export interface ExportResult {
  path: string
  seconds: number
  bytes: number
  /** длина ролика, с */
  duration: number
}

/** Настройки приложения. */
export interface AppSettings {
  /** папка, которую по умолчанию предлагает экспорт; null — системная «Видео» */
  exportDir: string | null
  exportFormat: VideoFormat
  exportQuality: H264Quality
  /** кадр нового проекта: 'first' — по первому видео, иначе «ШxВ» */
  newCanvas: string
  /** FPS нового проекта; 0 — по первому видео */
  newFps: number
  autoUpdate: boolean
}

export interface CacheInfo {
  previews: number
  thumbs: number
  peaks: number
  dataDir: string
}

export interface AppInfo {
  version: string
  packaged: boolean
  repo: string
}

export type AiProvider = 'deepseek' | 'groq' | 'custom'

/** Настройки ИИ так, как их видит страница: сам ключ сюда не попадает. */
export interface AiSettings {
  provider: AiProvider
  baseUrl: string
  model: string
  tpm: number | null
  extra: string
  hasKey: boolean
  /** ключ хранится без системного хранилища ключей — предупредить */
  weakKeyStorage: boolean
}

export interface AiSettingsPatch {
  provider?: AiProvider
  baseUrl?: string
  model?: string
  tpm?: number | null
  extra?: string
  /** новый ключ; пустая строка — удалить */
  key?: string
}

export interface AnalyzeRequest {
  words: Word[]
  minDur: number
  maxDur: number
  count: number
  mediaDuration: number
}

export interface AnalyzeResponse {
  clips: ClipCandidate[]
  warnings: string[]
  proposed: number
  /** подсказки «холодного зрителя» по id клипа */
  notes: Record<number, string>
  usage: { prompt: number; completion: number }
  seconds: number
}

export interface UpdateEvent {
  state: 'downloading' | 'ready' | 'error'
  version?: string
  message?: string
}

export interface Api {
  getAppSettings(): Promise<AppSettings>
  setAppSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  /** диалог выбора папки; null — отмена */
  pickFolder(title: string): Promise<string | null>
  cacheInfo(): Promise<CacheInfo>
  clearCache(): Promise<CacheInfo>
  openDataDir(): Promise<void>
  appInfo(): Promise<AppInfo>
  /** проверить обновления сейчас; ответ — подпись для пользователя */
  checkUpdates(): Promise<string>
  openExternal(url: string): Promise<void>
  quit(): Promise<void>
  winMinimize(): Promise<void>
  /** развернуть/вернуть; ответ — развёрнуто ли теперь */
  winToggleMax(): Promise<boolean>
  winClose(): Promise<void>
  winIsMax(): Promise<boolean>
  onWinState(cb: (s: { maximized: boolean }) => void): () => void
  listProjects(): Promise<ProjectSummary[]>
  createProject(name: string): Promise<Project>
  openProject(id: string): Promise<OpenedProject>
  /** сохраняет проект; возвращает его с обновлённой датой */
  writeProject(p: Project): Promise<Project>
  deleteProject(id: string): Promise<void>
  duplicateProject(id: string): Promise<Project>
  /** диалог «Сохранить как»; null — отмена */
  exportProjectFile(id: string): Promise<string | null>
  /** диалог открытия файла проекта; null — отмена */
  importProjectFile(): Promise<Project | null>
  /** диалог выбора файлов (несколько) для панели медиа */
  importMedia(): Promise<MediaInfo[]>
  /** alpha — миниатюра PNG с прозрачностью (для баннеров), иначе JPEG */
  thumbnail(mediaPath: string, duration: number, alpha?: boolean): Promise<string>
  /** библиотека баннеров: список, добавить (диалог / по путям уже открытых в приложении файлов), убрать, переименовать */
  listBanners(): Promise<BannerEntry[]>
  addBanners(): Promise<BannerEntry[]>
  addBannerFiles(paths: string[]): Promise<BannerEntry[]>
  removeBanner(id: string): Promise<BannerEntry[]>
  renameBanner(id: string, name: string): Promise<BannerEntry[]>
  /** экспорт таймлайна одним файлом (диалог «Сохранить как»); null — отмена */
  exportTimeline(p: Project, req: ExportRequest): Promise<ExportResult | null>
  pickMedia(): Promise<MediaInfo | null>
  /** Только для разработки: файл из переменной окружения TS_OPEN. */
  devInitialMedia(): Promise<MediaInfo | null>
  listModels(): Promise<ModelStatus[]>
  downloadModel(id: ModelId): Promise<void>
  transcribe(mediaPath: string, id: ModelId): Promise<Word[]>
  /** распознать отрезок файла; слова — во времени файла. label — подпись в строке состояния */
  transcribeRange(mediaPath: string, id: ModelId, start: number, end: number, label: string): Promise<Word[]>
  /** Диалог выбора файла шрифта; null — отмена или неподходящий файл */
  pickFont(): Promise<{ path: string; name: string } | null>
  /** Разрешить показ ранее выбранного шрифта после перезапуска; false — файла больше нет */
  allowFont(path: string): Promise<boolean>
  /** Сделать (или взять из кэша) копию видео для превью; возвращает путь к копии */
  preparePreview(mediaPath: string): Promise<string>
  onPreviewProgress(cb: (e: { mediaPath: string; value: number }) => void): () => void
  /** Файлы, перетащенные в окно одним броском (только настоящее перетаскивание мышью) */
  onMediaDropped(cb: (r: { infos: MediaInfo[]; errors: string[] }) => void): () => void
  /** Волна звука для таймлайна: pps пиков в секунду, 0..255 */
  peaks(mediaPath: string): Promise<{ pps: number; peaks: Uint8Array }>
  getAi(): Promise<AiSettings>
  setAi(patch: AiSettingsPatch): Promise<AiSettings>
  /** Короткий запрос к ИИ: проверить ключ и модель. Возвращает подпись для пользователя */
  testAi(): Promise<string>
  analyzeClips(req: AnalyzeRequest): Promise<AnalyzeResponse>
  /** прервать идущее распознавание речи (если его нет — ничего не делает) */
  cancelAsr(): Promise<void>
  cancelAnalyze(): Promise<void>
  /** экспорт папки клипов 9:16; null — пользователь закрыл диалог выбора папки */
  exportClips(p: Project, req: ClipsExportRequest): Promise<ClipsExportResult | null>
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
