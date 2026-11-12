/**
 * Запуск whisper.cpp (whisper-cli) как отдельного процесса и разбор его JSON.
 * Бинарник: в сборке лежит в resources/whisper, в разработке — resources/whisper/<платформа> в проекте
 * (его собирает CI; локально можно положить свою сборку).
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { parseWhisperJson, type WhisperJson } from '../shared/whisper'
import type { Word } from '../shared/types'

const exeName = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'

export function whisperBinary(): string {
  const platformKey = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`
  const candidates = [
    process.env['WHISPER_CLI'],
    join(process.resourcesPath ?? '', 'whisper', exeName),
    join(app.getAppPath(), 'resources', 'whisper', platformKey, exeName)
  ].filter((p): p is string => !!p)
  const found = candidates.find((p) => existsSync(p))
  if (!found) {
    throw new Error(
      `Не найден whisper-cli. Искал: ${candidates.join(', ')}. ` +
        'В релизе он идёт внутри установщика; для разработки положи сборку в resources/whisper/<платформа>/ или задай WHISPER_CLI.'
    )
  }
  return found
}

export function transcribeWithWhisper(
  wavPath: string,
  modelFile: string,
  threads: number,
  dtw: string | undefined,
  onProgress: (v: number) => void
): Promise<Word[]> {
  const bin = whisperBinary()
  const outBase = join(tmpdir(), `trans-subtitles-whisper-${Date.now()}`)
  const outJson = `${outBase}.json`

  return new Promise<Word[]>((resolve, reject) => {
    const child = spawn(
      bin,
      [
        '-m', modelFile,
        '-f', wavPath,
        '-l', 'ru',
        '-t', String(threads),
        '-ml', '1', '-sow',
        '-ojf', '-of', outBase,
        '-pp',
        // без подстановки предыдущего текста: иначе на длинных записях Whisper зацикливается
        // (на 30 минутах: 9.2% ошибок с петлёй «…Внезапно в инстаграм…» → 4.0% без неё)
        '-mc', '0',
        // DTW даёт точные границы слов; работает только без flash attention
        ...(dtw ? ['-dtw', dtw, '-nfa'] : [])
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        // рядом с бинарником лежат динамические библиотеки (в сборке для Linux)
        env: { ...process.env, LD_LIBRARY_PATH: [dirname(bin), process.env['LD_LIBRARY_PATH']].filter(Boolean).join(delimiter) }
      }
    )
    let err = ''
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString()
      err = (err + text).slice(-4000)
      const m = [...text.matchAll(/progress\s*=\s*(\d+)\s*%/g)].pop()
      if (m) onProgress(Math.min(1, Number(m[1]) / 100))
    })
    child.on('error', (e) => reject(new Error(`Не удалось запустить whisper-cli: ${e.message}`)))
    child.on('close', async (code) => {
      try {
        // Сборка рассчитана на процессоры с AVX2; на более старых whisper-cli падает по «недопустимой инструкции».
        if (code === null || code === 3221225501 || code === 132) {
          throw new Error('whisper-cli аварийно завершился (вероятно, процессор без AVX2). Для такого ПК выбери модель GigaAM v3')
        }
        if (code !== 0) {
          const tail = err.trim().split('\n').filter((l) => !/progress\s*=/.test(l)).pop() ?? ''
          throw new Error(`whisper-cli завершился с кодом ${code}${tail ? `: ${tail}` : ''}`)
        }
        const words = parseWhisperJson(JSON.parse(await readFile(outJson, 'utf8')) as WhisperJson)
        if (words.length === 0) throw new Error('Whisper не нашёл речи в файле')
        resolve(words)
      } catch (e) {
        reject(e)
      } finally {
        await rm(outJson, { force: true })
      }
    })
  })
}
