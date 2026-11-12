import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { MediaInfo } from '../shared/types'
import { FFMPEG, FFPROBE } from './paths'

function collect(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `код ${code}`))
    )
  })
}

interface ProbeStream {
  codec_type?: string
  width?: number
  height?: number
  r_frame_rate?: string
  disposition?: { attached_pic?: number }
}

export async function probeMedia(file: string): Promise<MediaInfo> {
  if (!existsSync(file)) throw new Error(`Файл не найден: ${basename(file)}`)
  let raw: string
  try {
    raw = await collect(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file])
  } catch {
    throw new Error(`Не удалось прочитать «${basename(file)}»: файл повреждён, не дописан или формат не поддерживается`)
  }
  const j = JSON.parse(raw) as { format?: { duration?: string }; streams?: ProbeStream[] }
  const streams = j.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const hasAudio = streams.some((s) => s.codec_type === 'audio')
  if (!video && !hasAudio) throw new Error('В файле нет ни видео, ни звука')

  let fps: number | undefined
  if (video?.r_frame_rate) {
    const [a, b] = video.r_frame_rate.split('/').map(Number)
    if (a && b) fps = a / b
  }
  return {
    path: file,
    name: basename(file),
    duration: Number(j.format?.duration ?? 0),
    hasVideo: !!video,
    hasAudio,
    width: video?.width,
    height: video?.height,
    fps
  }
}

/** Извлекает моно 16 кГц WAV для распознавания. onProgress: 0..1. */
export function extractAudio(
  file: string,
  outWav: string,
  duration: number,
  onProgress: (v: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      FFMPEG,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', file,
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
        '-progress', 'pipe:1', '-nostats',
        outWav
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.stdout.on('data', (d: Buffer) => {
      // out_time_ms на самом деле в микросекундах
      const m = /out_time_ms=(\d+)/.exec(d.toString())
      if (m && duration > 0) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration))
    })
    p.on('error', reject)
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `ffmpeg код ${code}`))
    )
  })
}
