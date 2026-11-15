import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Api, MediaInfo, ProgressEvent, UpdateEvent } from '../shared/types'

type DropResult = { info?: MediaInfo; error?: string }
const dropListeners = new Set<(r: DropResult) => void>()
const cleanError = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

// Перетаскивание файла в окно. Путь к файлу узнаём здесь, в preload: странице он недоступен,
// и сама страница не может подсунуть произвольный путь (принимаем только настоящие события мыши).
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => {
  e.preventDefault()
  if (!e.isTrusted) return
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  const path = webUtils.getPathForFile(file)
  if (!path) return
  ipcRenderer.invoke('media:drop', path).then(
    (info: MediaInfo) => dropListeners.forEach((cb) => cb({ info })),
    (err: unknown) => dropListeners.forEach((cb) => cb({ error: cleanError(err) }))
  )
})

const api: Api = {
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
  pickFont: () => ipcRenderer.invoke('font:pick'),
  allowFont: (path) => ipcRenderer.invoke('font:allow', path),
  loadProject: (mediaPath) => ipcRenderer.invoke('project:load', mediaPath),
  saveProject: (mediaPath, words) => ipcRenderer.invoke('project:save', mediaPath, words),
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
