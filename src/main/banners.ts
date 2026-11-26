/**
 * Библиотека баннеров: готовые анимированные оверлеи пользователя. Хранится список ссылок на файлы на диске
 * (userData/banners.json), общий для всех проектов; сами файлы не копируются и при удалении из списка не трогаются.
 */
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BannerEntry, MediaInfo } from '../shared/types'

type Stored = MediaInfo & { id: string }
const file = (): string => join(app.getPath('userData'), 'banners.json')
let cache: Stored[] | null = null

const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)

function clean(raw: unknown): Stored[] {
  if (!Array.isArray(raw)) return []
  const out: Stored[] = []
  for (const x of raw as Array<Record<string, unknown>>) {
    if (!x || typeof x.path !== 'string' || typeof x.id !== 'string' || out.some((o) => o.path === x.path)) continue
    out.push({
      id: x.id,
      path: x.path,
      name: typeof x.name === 'string' && x.name ? x.name.slice(0, 120) : x.path.split(/[\\/]/).pop() || 'Баннер',
      duration: num(x.duration) ?? 0,
      hasVideo: x.hasVideo !== false,
      hasAudio: x.hasAudio === true,
      videoCodec: typeof x.videoCodec === 'string' ? x.videoCodec : undefined,
      needsPreview: x.needsPreview === true,
      hasAlpha: x.hasAlpha === true ? true : undefined,
      width: num(x.width),
      height: num(x.height),
      fps: num(x.fps)
    })
  }
  return out
}

async function load(): Promise<Stored[]> {
  if (cache) return cache
  try {
    cache = clean(JSON.parse(await readFile(file(), 'utf8')))
  } catch {
    cache = []
  }
  return cache
}

async function save(list: Stored[]): Promise<void> {
  cache = list
  const tmp = `${file()}.part`
  await writeFile(tmp, JSON.stringify(list, null, 1), 'utf8')
  await rename(tmp, file())
}

/** Список для окна: у каждого видно, на месте ли файл. */
export async function listBanners(): Promise<BannerEntry[]> {
  return (await load()).map((b) => ({ ...b, missing: !existsSync(b.path) }))
}

/** Добавляет файлы в библиотеку (повторный путь — пропускается). Возвращает обновлённый список. */
export async function addBanners(infos: MediaInfo[]): Promise<BannerEntry[]> {
  const list = [...(await load())]
  for (const i of infos) {
    if (!i.hasVideo || list.some((b) => b.path === i.path)) continue
    list.push({ ...i, id: randomUUID() })
  }
  await save(list)
  return listBanners()
}

export async function removeBanner(id: string): Promise<BannerEntry[]> {
  await save((await load()).filter((b) => b.id !== id))
  return listBanners()
}

export async function renameBanner(id: string, name: string): Promise<BannerEntry[]> {
  const nm = name.trim().slice(0, 120)
  if (nm) await save((await load()).map((b) => (b.id === id ? { ...b, name: nm } : b)))
  return listBanners()
}
