/**
 * Проекты монтажки: userData/projects-v3/<id>.json. Список для стартового экрана, атомарная запись,
 * копия, удаление, экспорт в файл и импорт из файла.
 */
import { app } from 'electron'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { projectDuration, sanitizeProject, uid, type Project } from '../shared/project'
import type { ProjectSummary } from '../shared/types'

const dir = (): string => join(app.getPath('userData'), 'projects-v3')
const SAFE_ID = /^[a-z0-9]{4,40}$/i
const fileOf = (id: string): string => {
  if (!SAFE_ID.test(id)) throw new Error('Неверный id проекта')
  return join(dir(), `${id}.json`)
}

export async function listProjects(): Promise<ProjectSummary[]> {
  await mkdir(dir(), { recursive: true })
  const out: ProjectSummary[] = []
  for (const f of await readdir(dir())) {
    if (!f.endsWith('.json')) continue
    try {
      const p = sanitizeProject(JSON.parse(await readFile(join(dir(), f), 'utf8')))
      if (!p) continue
      out.push({
        id: p.id,
        name: p.name,
        updatedAt: p.updatedAt || (await stat(join(dir(), f))).mtime.toISOString(),
        duration: projectDuration(p),
        files: p.media.length,
        canvas: p.canvas
      })
    } catch {
      /* битый файл пропускаем */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function readProject(id: string): Promise<Project> {
  const p = sanitizeProject(JSON.parse(await readFile(fileOf(id), 'utf8')))
  if (!p) throw new Error('Файл проекта повреждён')
  return { ...p, id }
}

export async function writeProject(p: Project): Promise<Project> {
  const clean = sanitizeProject(p)
  if (!clean) throw new Error('Некорректный проект')
  const next = { ...clean, updatedAt: new Date().toISOString() }
  await mkdir(dir(), { recursive: true })
  const f = fileOf(next.id)
  await writeFile(`${f}.tmp`, JSON.stringify(next))
  await rename(`${f}.tmp`, f)
  return next
}

export async function deleteProject(id: string): Promise<void> {
  await rm(fileOf(id), { force: true })
}

export async function duplicateProject(id: string): Promise<Project> {
  const p = await readProject(id)
  return writeProject({ ...p, id: uid('p'), name: `${p.name} (копия)`, createdAt: new Date().toISOString() })
}

/** Импорт: новый id, чтобы не затереть свой проект с тем же id. */
export async function importProjectFile(path: string): Promise<Project> {
  const p = sanitizeProject(JSON.parse(await readFile(path, 'utf8')))
  if (!p) throw new Error('Это не файл проекта Trans Subtitles или он повреждён')
  return writeProject({ ...p, id: uid('p'), createdAt: p.createdAt || new Date().toISOString() })
}

export async function exportProjectFile(id: string, path: string): Promise<void> {
  const p = await readProject(id)
  await writeFile(path, JSON.stringify(p, null, 1))
}
