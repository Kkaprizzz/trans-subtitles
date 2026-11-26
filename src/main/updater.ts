/** Автообновление через GitHub Releases (electron-updater). Работает только в собранном приложении. */
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateEvent } from '../shared/types'

let wired = false
/** версия, которую нашли и качаем: ошибки показываем только после этого (нет сети при проверке — не повод беспокоить) */
let found: string | null = null
const RECHECK_MS = 6 * 3600 * 1000

function wire(emit: (e: UpdateEvent) => void): void {
  if (wired) return
  wired = true
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-available', (info) => {
    found = info.version
    emit({ state: 'downloading', version: info.version, percent: 0 })
  })
  autoUpdater.on('download-progress', (p) => emit({ state: 'downloading', version: found ?? undefined, percent: Math.max(0, Math.min(100, Math.round(p.percent))) }))
  autoUpdater.on('update-downloaded', (info) => emit({ state: 'ready', version: info.version }))
  autoUpdater.on('error', (err) => {
    if (found) emit({ state: 'error', version: found, message: err == null ? 'неизвестная ошибка' : String(err.message ?? err) })
  })
}

/** Автопроверка при старте (если включена в настройках). */
export function setupUpdater(emit: (e: UpdateEvent) => void, auto: boolean): void {
  // TS_FAKE_UPDATE=ok|error — показать в окне, как выглядит обновление (для проверки вида; в обычной работе не задаётся)
  if (process.env['TS_FAKE_UPDATE']) return fakeUpdate(emit, process.env['TS_FAKE_UPDATE'])
  if (!app.isPackaged) return
  wire(emit)
  // нет сети или релизов — молча пропускаем: обновление не должно мешать работе
  const check = (): void => void autoUpdater.checkForUpdates().catch(() => undefined)
  if (auto) {
    check()
    // приложение могут держать открытым днями: проверяем ещё раз каждые 6 часов
    setInterval(check, RECHECK_MS).unref()
  }
}

function fakeUpdate(emit: (e: UpdateEvent) => void, mode: string): void {
  const v = '9.9.9'
  const steps: Array<[number, UpdateEvent]> =
    mode === 'error'
      ? [
          [1500, { state: 'downloading', version: v, percent: 0 }],
          [3000, { state: 'downloading', version: v, percent: 40 }],
          [4500, { state: 'error', version: v, message: 'net::ERR_CONNECTION_RESET' }]
        ]
      : [
          [1500, { state: 'downloading', version: v, percent: 0 }],
          [3000, { state: 'downloading', version: v, percent: 45 }],
          [4500, { state: 'downloading', version: v, percent: 90 }],
          [6000, { state: 'ready', version: v }]
        ]
  for (const [ms, e] of steps) setTimeout(() => emit(e), ms)
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
