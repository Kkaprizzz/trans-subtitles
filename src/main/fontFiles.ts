import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import { CUSTOM_EXT } from '../shared/fonts'

/** Файлы шрифтов, которые разрешено отдавать окнам через font://. */
export const allowedFonts = new Set<string>()

/** Шрифт пользователя: только известные расширения и существующий файл. */
export function allowFontFile(path: string): boolean {
  if (!CUSTOM_EXT.includes(extname(path).toLowerCase()) || !existsSync(path)) return false
  allowedFonts.add(path)
  return true
}
