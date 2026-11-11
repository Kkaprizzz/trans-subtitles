import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'

/** В собранном приложении бинарники лежат в app.asar.unpacked. */
const unpacked = (p: string): string => p.replace('app.asar', 'app.asar.unpacked')

if (!ffmpegStatic) throw new Error('ffmpeg-static не нашёл бинарник для этой платформы')

export const FFMPEG = unpacked(ffmpegStatic)
export const FFPROBE = unpacked(ffprobeStatic.path)
