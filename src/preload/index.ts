import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Api, MediaInfo, ProgressEvent, UpdateEvent } from '../shared/types'

type DropResult = { infos: MediaInfo[]; errors: string[] }
const dropListeners = new Set<(r: DropResult) => void>()
const cleanError = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

// Перетаскивание файла в окно. Путь к файлу узнаём здесь, в preload: странице он недоступен,
// и сама страница не может подсунуть произвольный путь (принимаем только настоящие события мыши).
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => {
  e.preventDefault()
  if (!e.isTrusted) return
  // один бросок — одна пачка, в порядке файлов (иначе быстрый файл обгонял медленный)
  const paths = Array.from(e.dataTransfer?.files ?? [])
    .map((f) => webUtils.getPathForFile(f))
    .filter(Boolean)
  if (paths.length === 0) return
  void Promise.allSettled(paths.map((p) => ipcRenderer.invoke('media:drop', p) as Promise<MediaInfo>)).then((rs) => {
    const infos = rs.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    const errors = rs.flatMap((r) => (r.status === 'rejected' ? [cleanError(r.reason)] : []))
    dropListeners.forEach((cb) => cb({ infos, errors }))
  })
})

const api: Api = {
  getAppSettings: () => ipcRenderer.invoke('app:get-settings'),
  setAppSettings: (patch) => ipcRenderer.invoke('app:set-settings', patch),
  pickFolder: (title) => ipcRenderer.invoke('app:pick-folder', title),
  cacheInfo: () => ipcRenderer.invoke('cache:info'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
  openDataDir: () => ipcRenderer.invoke('app:open-data'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  openExternal: (url) => ipcRenderer.invoke('app:external', url),
  quit: () => ipcRenderer.invoke('app:quit'),
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winToggleMax: () => ipcRenderer.invoke('win:toggle-max'),
  winClose: () => ipcRenderer.invoke('win:close'),
  winIsMax: () => ipcRenderer.invoke('win:is-max'),
  onWinState: (cb) => {
    const h = (_e: unknown, s: { maximized: boolean }): void => cb(s)
    ipcRenderer.on('win-state', h)
    return () => ipcRenderer.removeListener('win-state', h)
  },
  listProjects: () => ipcRenderer.invoke('projects:list'),
  createProject: (name) => ipcRenderer.invoke('projects:create', name),
  openProject: (id) => ipcRenderer.invoke('projects:open', id),
  writeProject: (p) => ipcRenderer.invoke('projects:write', p),
  deleteProject: (id) => ipcRenderer.invoke('projects:delete', id),
  duplicateProject: (id) => ipcRenderer.invoke('projects:duplicate', id),
  exportProjectFile: (id) => ipcRenderer.invoke('projects:export-file', id),
  importProjectFile: () => ipcRenderer.invoke('projects:import-file'),
  importMedia: () => ipcRenderer.invoke('media:import'),
  thumbnail: (mediaPath, duration) => ipcRenderer.invoke('media:thumb', mediaPath, duration),
  exportTimeline: (p, req) => ipcRenderer.invoke('export:timeline', p, req),
  pickMedia: () => ipcRenderer.invoke('media:pick'),
  preparePreview: (mediaPath) => ipcRenderer.invoke('media:preview', mediaPath),
  onPreviewProgress: (cb) => {
    const handler = (_e: unknown, p: { mediaPath: string; value: number }): void => cb(p)
    ipcRenderer.on('preview-progress', handler)
    return () => ipcRenderer.removeListener('preview-progress', handler)
  },
  onMediaDropped: (cb) => {
    dropListeners.add(cb)
    return () => dropListeners.delete(cb)
  },
  devInitialMedia: () => ipcRenderer.invoke('media:dev-initial'),
  listModels: () => ipcRenderer.invoke('models:list'),
  downloadModel: (id) => ipcRenderer.invoke('models:download', id),
  transcribe: (mediaPath, id) => ipcRenderer.invoke('asr:transcribe', mediaPath, id),
  transcribeRange: (mediaPath, id, start, end, label) => ipcRenderer.invoke('asr:transcribe-range', mediaPath, id, start, end, label),
  pickFont: () => ipcRenderer.invoke('font:pick'),
  allowFont: (path) => ipcRenderer.invoke('font:allow', path),
  peaks: (mediaPath) => ipcRenderer.invoke('cut:peaks', mediaPath),
  getAi: () => ipcRenderer.invoke('ai:get'),
  setAi: (patch) => ipcRenderer.invoke('ai:set', patch),
  testAi: () => ipcRenderer.invoke('ai:test'),
  analyzeClips: (req) => ipcRenderer.invoke('clips:analyze', req),
  cancelAnalyze: () => ipcRenderer.invoke('clips:cancel'),
  exportClips: (p, req) => ipcRenderer.invoke('export:clips', p, req),
  render: (req) => ipcRenderer.invoke('render:start', req),
  cancelRender: () => ipcRenderer.invoke('render:cancel'),
  revealFile: (path) => ipcRenderer.invoke('app:reveal', path),
  mediaUrl: (path) => `media://local/${encodeURIComponent(path)}`,
  onUpdate: (cb) => {
    const handler = (_e: unknown, p: UpdateEvent): void => cb(p)
    ipcRenderer.on('update', handler)
    return () => ipcRenderer.removeListener('update', handler)
  },
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onProgress: (cb) => {
    const handler = (_e: unknown, p: ProgressEvent): void => cb(p)
    ipcRenderer.on('progress', handler)
    return () => ipcRenderer.removeListener('progress', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
