/** Настройки приложения (userData/app-settings.json) и кэш: копии для просмотра, миниатюры, волны. */
import { app } from 'electron'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppSettings, CacheInfo } from '../shared/types'

export const APP_DEFAULTS: AppSettings = {
  exportDir: null,
  exportFormat: 'h264',
  exportQuality: 'medium',
  newCanvas: 'first',
  newFps: 0,
  autoUpdate: true,
  downloadDir: null
}

const file = (): string => join(app.getPath('userData'), 'app-settings.json')
let cache: AppSettings | null = null

export async function getAppSettings(): Promise<AppSettings> {
  if (cache) return cache
  try {
    cache = sanitize(JSON.parse(await readFile(file(), 'utf8')))
  } catch {
    cache = { ...APP_DEFAULTS }
  }
  return cache
}

function sanitize(raw: unknown): AppSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppSettings>
  const canvasOk = r.newCanvas === 'first' || (typeof r.newCanvas === 'string' && /^\d{2,4}x\d{2,4}$/.test(r.newCanvas))
  return {
    exportDir: typeof r.exportDir === 'string' && r.exportDir ? r.exportDir : null,
    exportFormat: r.exportFormat === 'prores422' ? 'prores422' : 'h264',
    exportQuality: r.exportQuality === 'high' || r.exportQuality === 'small' ? r.exportQuality : 'medium',
    newCanvas: canvasOk ? (r.newCanvas as string) : 'first',
    newFps: typeof r.newFps === 'number' && [0, 24, 25, 30, 50, 60].includes(r.newFps) ? r.newFps : 0,
    autoUpdate: r.autoUpdate !== false,
    downloadDir: typeof r.downloadDir === 'string' && r.downloadDir ? r.downloadDir : null
  }
}

export async function setAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = sanitize({ ...(await getAppSettings()), ...patch })
  cache = next
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(`${file()}.tmp`, JSON.stringify(next, null, 1))
  await rename(`${file()}.tmp`, file())
  return next
}

/** Папки кэша: всё в них пересоздаётся само при следующем открытии файлов. */
const CACHE_DIRS = { previews: 'previews', thumbs: 'thumbs', peaks: 'peaks' } as const

async function dirSize(dir: string): Promise<number> {
  let total = 0
  try {
    for (const f of await readdir(dir)) {
      try {
        total += (await stat(join(dir, f))).size
      } catch {
        /* файл исчез — пропускаем */
      }
    }
  } catch {
    /* папки нет */
  }
  return total
}

export async function cacheInfo(): Promise<CacheInfo> {
  const ud = app.getPath('userData')
  const [previews, thumbs, peaks] = await Promise.all(Object.values(CACHE_DIRS).map((d) => dirSize(join(ud, d))))
  return { previews, thumbs, peaks, dataDir: ud }
}

export async function clearCache(): Promise<CacheInfo> {
  const ud = app.getPath('userData')
  for (const d of Object.values(CACHE_DIRS)) await rm(join(ud, d), { recursive: true, force: true })
  return cacheInfo()
}
