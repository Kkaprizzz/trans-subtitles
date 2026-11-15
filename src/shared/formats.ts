/**
 * Что окно приложения (Chromium) умеет показывать само. Проверено на сборке 2026-11-16:
 * видно — H.264 (8/10 бит, 4:4:4), VP9, AV1; картинки нет — HEVC 8/10 бит, ProRes;
 * не открываются — MPEG-2 (.mpg), MPEG-4 Part 2 (.avi).
 */
export const PLAYABLE_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1'])
/** Контейнеры по имени формата ffprobe. */
const PLAYABLE_CONTAINERS = [/mp4|mov/, /matroska|webm/]

/** Нужна ли H.264-копия для превью: кодек или контейнер окно не покажет. */
export function needsPreview(videoCodec: string | undefined, formatName: string | undefined): boolean {
  if (!videoCodec) return false
  if (!PLAYABLE_CODECS.has(videoCodec)) return true
  return !PLAYABLE_CONTAINERS.some((re) => re.test(formatName ?? ''))
}
