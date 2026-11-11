/**
 * Автосохранение правок слов: userData/projects/<sha1(путь|размер|mtime)>.json.
 * Ключ включает размер и время изменения, поэтому подменённый файл с тем же именем не получит чужие правки.
 */
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SavedProject, Word } from '../shared/types'

const dir = (): string => join(app.getPath('userData'), 'projects')

async function fileFor(mediaPath: string): Promise<string> {
  const st = await stat(mediaPath)
  const key = createHash('sha1').update(`${mediaPath}|${st.size}|${Math.floor(st.mtimeMs)}`).digest('hex')
  return join(dir(), `${key}.json`)
}

function validWords(raw: unknown): Word[] | null {
  if (!Array.isArray(raw)) return null
  const out: Word[] = []
  for (const w of raw as Array<Partial<Word>>) {
    if (
      typeof w?.text !== 'string' ||
      !Number.isFinite(w.start) ||
      !Number.isFinite(w.end) ||
      !Number.isInteger(w.id) ||
      (w.end as number) <= (w.start as number)
    ) {
      return null
    }
    out.push({ id: w.id as number, text: w.text, start: w.start as number, end: w.end as number })
  }
  return out
}

export async function loadProject(mediaPath: string): Promise<SavedProject | null> {
  try {
    const j = JSON.parse(await readFile(await fileFor(mediaPath), 'utf8')) as { words?: unknown; savedAt?: unknown }
    const words = validWords(j.words)
    if (!words || words.length === 0) return null
    return { words, savedAt: typeof j.savedAt === 'string' ? j.savedAt : '' }
  } catch {
    return null
  }
}

export async function saveProject(mediaPath: string, words: Word[]): Promise<void> {
  if (!validWords(words)) throw new Error('Некорректные слова для сохранения')
  const file = await fileFor(mediaPath)
  await mkdir(dir(), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), words }))
  await rename(tmp, file)
}
