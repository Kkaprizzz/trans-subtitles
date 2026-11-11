import { contextBridge, ipcRenderer } from 'electron'
import type { Api, ProgressEvent, UpdateEvent } from '../shared/types'

const api: Api = {
  pickMedia: () => ipcRenderer.invoke('media:pick'),
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
