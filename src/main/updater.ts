/** Автообновление через GitHub Releases (electron-updater). Работает только в собранном приложении. */
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateEvent } from '../shared/types'

let wired = false

function wire(emit: (e: UpdateEvent) => void): void {
  if (wired) return
  wired = true
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-available', (info) => emit({ state: 'downloading', version: info.version }))
  autoUpdater.on('update-downloaded', (info) => emit({ state: 'ready', version: info.version }))
  autoUpdater.on('error', (err) => emit({ state: 'error', message: err == null ? 'неизвестная ошибка' : String(err.message ?? err) }))
}

/** Автопроверка при старте (если включена в настройках). */
export function setupUpdater(emit: (e: UpdateEvent) => void, auto: boolean): void {
  if (!app.isPackaged) return
  wire(emit)
  // нет сети или релизов — молча пропускаем: обновление не должно мешать работе
  if (auto) void autoUpdater.checkForUpdates().catch(() => undefined)
}

/** Ручная проверка из настроек. */
export async function checkNow(emit: (e: UpdateEvent) => void): Promise<string> {
  if (!app.isPackaged) return 'В режиме разработки обновления не проверяются'
  wire(emit)
  const r = await autoUpdater.checkForUpdates()
  const v = r?.updateInfo?.version
  if (!v || v === app.getVersion()) return `Установлена последняя версия ${app.getVersion()}`
  return `Найдена версия ${v} — скачиваю, после загрузки появится кнопка «Обновить»`
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall()
}
