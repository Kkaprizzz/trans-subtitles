/**
 * Выбор декодера видео для ffmpeg. В сборке без libdav1d (Windows) AV1 надо читать явно через libaom: обычный путь даёт пустой
 * поток. Здесь проверяется сборка и определяется кодек файла; сами правила — в shared/ffmpeg.ts.
 */
import { execFile } from 'node:child_process'
import { AV1_FALLBACK, needsAv1Fallback } from '../shared/ffmpeg'
import type { Project } from '../shared/project'
import { FFMPEG, FFPROBE } from './paths'

let fallback: Promise<boolean> | null = null

/** Нужен ли запасной декодер AV1 в этой сборке ffmpeg (проверяется один раз). */
export function av1Fallback(): Promise<boolean> {
  // TS_FORCE_AV1_FALLBACK=1 — для проверки на Linux, где libdav1d есть: включить запасной декодер принудительно
  if (process.env['TS_FORCE_AV1_FALLBACK'] === '1') return Promise.resolve(true)
  fallback ??= new Promise((resolve) => {
    execFile(FFMPEG, ['-hide_banner', '-decoders'], { windowsHide: true, timeout: 20000, maxBuffer: 1 << 22 }, (err, stdout) => resolve(!err && needsAv1Fallback(String(stdout))))
  })
  return fallback
}

const codecs = new Map<string, Promise<string | null>>()

/** Кодек первого видеопотока файла (null — видео нет или файл не читается). */
export function videoCodecOf(path: string): Promise<string | null> {
  let c = codecs.get(path)
  if (!c) {
    c = new Promise((resolve) => {
      execFile(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path], { windowsHide: true, timeout: 20000 }, (err, stdout) =>
        resolve(err ? null : String(stdout).trim().split('\n')[0] || null)
      )
    })
    codecs.set(path, c)
  }
  return c
}

/** Параметры входа для ffmpeg перед `-i path`: явный декодер для AV1, где без него не обойтись; иначе пусто. */
export async function videoInputArgs(path: string): Promise<string[]> {
  if (!(await av1Fallback())) return []
  return (await videoCodecOf(path)) === 'av1' ? ['-c:v', AV1_FALLBACK] : []
}

/** Проект с кодеками видео у файлов, где их не записали (старые проекты): экспорту нужно знать, где AV1. */
export async function withCodecs(p: Project): Promise<Project> {
  const media = await Promise.all(p.media.map(async (m) => (m.hasVideo && !m.videoCodec ? { ...m, videoCodec: (await videoCodecOf(m.path)) ?? undefined } : m)))
  return { ...p, media }
}
