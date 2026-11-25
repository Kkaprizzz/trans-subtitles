/**
 * Волна звука для таймлайна: пики громкости PPS раз в секунду, 0..255.
 * ffmpeg декодирует только звук (моно, 4 кГц) — это быстро даже для 3-часового файла.
 * Результат кэшируется в userData/peaks/<sha1(путь|размер|mtime)>.u8.
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FFMPEG } from './paths'

export const PPS = 50
const RATE = 4000
const PER = RATE / PPS

async function cacheFile(mediaPath: string): Promise<string> {
  const st = await stat(mediaPath)
  const key = createHash('sha1').update(`${mediaPath}|${st.size}|${Math.floor(st.mtimeMs)}|${PPS}`).digest('hex')
  return join(app.getPath('userData'), 'peaks', `${key}.u8`)
}

export async function getPeaks(mediaPath: string): Promise<{ pps: number; peaks: Uint8Array }> {
  const cf = await cacheFile(mediaPath)
  try {
    return { pps: PPS, peaks: new Uint8Array(await readFile(cf)) }
  } catch {
    /* кэша нет — считаем */
  }

  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', mediaPath, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let err = ''
  ff.stderr.on('data', (d) => (err += d))
  const out: number[] = []
  let acc = 0
  let n = 0
  let carry: Buffer | null = null
  ff.stdout.on('data', (chunk: Buffer) => {
    const buf = carry ? Buffer.concat([carry, chunk]) : chunk
    const usable = buf.length - (buf.length % 2)
    for (let i = 0; i < usable; i += 2) {
      const v = Math.abs(buf.readInt16LE(i))
      if (v > acc) acc = v
      if (++n === PER) {
        // корень делает тихую речь заметной на волне
        out.push(Math.min(255, Math.round(Math.sqrt(acc / 32768) * 255)))
        acc = 0
        n = 0
      }
    }
    carry = usable < buf.length ? buf.subarray(usable) : null
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    ff.on('error', reject)
    ff.on('close', resolve)
  })
  if (code !== 0) throw new Error(`Не удалось построить волну звука: ${err.trim().split('\n').pop() || `код ${code}`}`)
  if (n > 0) out.push(Math.min(255, Math.round(Math.sqrt(acc / 32768) * 255)))
  const peaks = Uint8Array.from(out)
  await mkdir(join(app.getPath('userData'), 'peaks'), { recursive: true })
  await writeFile(cf, peaks).catch(() => {})
  return { pps: PPS, peaks }
}
