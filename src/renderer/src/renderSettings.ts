import type { H264Quality, MediaInfo, RenderFormat } from '../../shared/types'

export interface Settings {
  format: RenderFormat
  size: string
  customW: number
  customH: number
  fps: string
  quality: H264Quality
  green: string
  withAudio: boolean
}

export const DEFAULTS: Settings = {
  format: 'animation',
  size: 'source',
  customW: 1080,
  customH: 1920,
  fps: 'source',
  quality: 'medium',
  green: '#00FF00',
  withAudio: false
}

export const STORAGE_KEY = 'render-settings-v1'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    /* localStorage может быть недоступен — работаем с умолчаниями */
  }
  return DEFAULTS
}

const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)

export function resolveSize(s: Settings, media: MediaInfo | null): { w: number; h: number } {
  if (s.size === 'custom') return { w: even(s.customW), h: even(s.customH) }
  if (s.size === 'source') {
    return media?.width && media.height ? { w: even(media.width), h: even(media.height) } : { w: 1920, h: 1080 }
  }
  const [w, h] = s.size.split('x').map(Number)
  return { w, h }
}

export function resolveFps(s: Settings, media: MediaInfo | null): number {
  if (s.fps === 'source') return media?.fps && media.fps >= 1 ? media.fps : 30
  return Number(s.fps)
}

