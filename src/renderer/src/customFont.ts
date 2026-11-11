/** Подключение шрифта пользователя из файла (через схему font://, см. main/index.ts). */
import { CUSTOM_FAMILY } from '../../shared/fonts'

let loaded: { path: string; face: FontFace } | null = null

export const fontUrl = (path: string): string => `font://local/${encodeURIComponent(path)}`

/** true, если шрифт загружен и зарегистрирован под именем CUSTOM_FAMILY. */
export async function loadCustomFont(path: string): Promise<boolean> {
  if (loaded?.path === path) return true
  if (loaded) {
    document.fonts.delete(loaded.face)
    loaded = null
  }
  try {
    // диапазон начертаний, чтобы браузер не рисовал «жирность» поверх единственного файла
    const face = new FontFace(CUSTOM_FAMILY, `url("${fontUrl(path)}")`, { weight: '100 900' })
    await face.load()
    document.fonts.add(face)
    loaded = { path, face }
    return true
  } catch {
    return false
  }
}
