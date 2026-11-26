/** Миниатюра файла для панели медиа: один кадр JPEG 320px, кэш в userData/thumbs. */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { FFMPEG } from './paths'

export async function thumbnail(mediaPath: string, duration: number, alpha = false): Promise<string> {
  const st = await stat(mediaPath)
  const key = createHash('sha1').update(`${mediaPath}|${st.size}|${Math.floor(st.mtimeMs)}`).digest('hex')
  const out = join(app.getPath('userData'), 'thumbs', `${key}${alpha ? '-a.png' : '.jpg'}`)
  try {
    await access(out)
    return out
  } catch {
    /* делаем */
  }
  await mkdir(join(app.getPath('userData'), 'thumbs'), { recursive: true })
  // у баннера с альфой берём кадр ближе к середине: в начале картинки обычно ещё нет
  const at = Math.min(Math.max(0, duration * (alpha ? 0.4 : 0.1)), 30)
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(2), '-i', mediaPath, '-frames:v', '1', '-vf', alpha ? 'scale=320:-2,format=rgba' : 'scale=320:-2', ...(alpha ? [] : ['-q:v', '4']), out], {
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let err = ''
  ff.stderr.on('data', (d) => (err += d))
  const code = await new Promise<number | null>((resolve, reject) => {
    ff.on('error', reject)
    ff.on('close', resolve)
  })
  if (code !== 0) throw new Error(`Миниатюра: ${err.trim().split('\n').pop() || code}`)
  return out
}
