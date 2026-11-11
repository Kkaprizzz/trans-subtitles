/** Автообновление через GitHub Releases (electron-updater). Работает только в собранном приложении. */
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateEvent } from '../shared/types'

export function setupUpdater(emit: (e: UpdateEvent) => void): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-available', (info) => emit({ state: 'downloading', version: info.version }))
  autoUpdater.on('update-downloaded', (info) => emit({ state: 'ready', version: info.version }))
  autoUpdater.on('error', (err) => emit({ state: 'error', message: err == null ? 'неизвестная ошибка' : String(err.message ?? err) }))
  // нет сети или релизов — молча пропускаем: обновление не должно мешать работе
  void autoUpdater.checkForUpdates().catch(() => undefined)
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall()
}
