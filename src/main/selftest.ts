/**
 * Безголовая проверка конвейера (только для разработки и CI, включается переменными окружения).
 *
 *   TS_SELFTEST=/файл            что проверяем
 *   TS_SELFTEST_OUT=/out.json    полный результат в JSON (слова, ошибки, время, пик памяти)
 *   TS_PROBE_ONLY=1              только прочитать свойства файла
 *   TS_MODEL=gigaam-v3|whisper-small|whisper-turbo
 *   TS_WORDS_FILE=/words.json    не распознавать, взять готовые слова (для рендера)
 *   TS_RENDER=animation,prores4444,h264-green   TS_RENDER_DIR=/папка
 *   TS_RENDER_SIZE=1080x1920  TS_RENDER_FPS=30  TS_RENDER_AUDIO=1  TS_STYLE='{"mode":"highlight"}'
 *   TS_RENDER_CANCEL_MS=2000     отменить рендер через столько мс (проверка отмены)
 */
import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { normalizeStyle } from '../shared/timeline'
import type { MediaInfo, ModelId, RenderFormat, RenderResult, Word } from '../shared/types'
import { transcribe } from './asr'
import { allowFontFile } from './fontFiles'
import { probeMedia } from './media'
import { downloadModel, listModels } from './models'
import { renderOverlay } from './render'

interface Report {
  file: string
  probe?: MediaInfo
  probeError?: string
  model?: string
  asrSeconds?: number
  words?: Word[]
  asrError?: string
  renders: Array<{ format: string; size: string; fps: number; result?: RenderResult; error?: string; cancelledAfterMs?: number }>
  /** пик рабочего набора по типам процессов, МБ */
  peakMemMB: Record<string, number>
  fatal?: string
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export async function runSelfTest(file: string): Promise<void> {
  const log = (s: string): void => {
    process.stdout.write(`[selftest] ${s}\n`)
  }
  const report: Report = { file, renders: [], peakMemMB: {} }

  // замер памяти всех процессов Electron (главный, окна, utility-воркер)
  const mem = setInterval(() => {
    const sums: Record<string, number> = {}
    for (const m of app.getAppMetrics()) {
      const key = m.serviceName ? `${m.type}:${m.serviceName}` : m.type
      sums[key] = (sums[key] ?? 0) + m.memory.workingSetSize / 1024
    }
    sums['total'] = Object.values(sums).reduce((a, b) => a + b, 0)
    for (const [k, v] of Object.entries(sums)) report.peakMemMB[k] = Math.max(report.peakMemMB[k] ?? 0, Math.round(v))
  }, 300)

  const finish = (code: number): void => {
    clearInterval(mem)
    if (process.env['TS_SELFTEST_OUT']) writeFileSync(process.env['TS_SELFTEST_OUT'], JSON.stringify(report, null, 1))
    app.exit(code)
  }

  try {
    let info: MediaInfo
    try {
      info = await probeMedia(file)
      report.probe = info
      log(`файл: ${info.name}, ${info.duration.toFixed(1)} с, ${info.width ?? '-'}x${info.height ?? '-'}`)
    } catch (e) {
      report.probeError = errText(e)
      log(`ОШИБКА чтения файла: ${report.probeError}`)
      return finish(0)
    }
    if (process.env['TS_PROBE_ONLY'] === '1') return finish(0)

    let words: Word[] = []
    if (process.env['TS_WORDS_FILE']) {
      words = JSON.parse(readFileSync(process.env['TS_WORDS_FILE'], 'utf8')) as Word[]
    } else {
      const modelId = (process.env['TS_MODEL'] ?? 'gigaam-v3') as ModelId
      report.model = modelId
      const m = listModels().find((x) => x.id === modelId)
      if (!m) throw new Error(`неизвестная модель ${modelId}`)
      if (!m.installed) {
        log('скачиваю модель…')
        await downloadModel(modelId, () => undefined)
      }
      const t0 = Date.now()
      try {
        words = await transcribe(file, modelId, () => undefined)
        report.asrSeconds = (Date.now() - t0) / 1000
        report.words = words
        log(`слов: ${words.length}, время: ${report.asrSeconds.toFixed(1)} с (x${(info.duration / report.asrSeconds).toFixed(1)} от реального)`)
      } catch (e) {
        report.asrError = errText(e)
        log(`ОШИБКА распознавания: ${report.asrError}`)
        return finish(0)
      }
    }

    const formats = (process.env['TS_RENDER'] ?? '').split(',').filter(Boolean) as RenderFormat[]
    const style = normalizeStyle(JSON.parse(process.env['TS_STYLE'] ?? '{}'))
    if (style.font === 'custom' && !allowFontFile(style.customFontPath)) throw new Error('свой шрифт не найден')
    for (const format of formats) {
      const size = process.env['TS_RENDER_SIZE'] ?? `${info.width ?? 1920}x${info.height ?? 1080}`
      const [rw, rh] = size.split('x').map(Number)
      const fps = Number(process.env['TS_RENDER_FPS'] ?? 30)
      const out = `${process.env['TS_RENDER_DIR'] ?? '.'}/selftest_${format}.${format === 'h264-green' ? 'mp4' : 'mov'}`
      const cancel = { cancelled: false }
      const cancelMs = Number(process.env['TS_RENDER_CANCEL_MS'] ?? 0)
      const timer = cancelMs > 0 ? setTimeout(() => (cancel.cancelled = true), cancelMs) : null
      const entry: Report['renders'][number] = { format, size, fps }
      try {
        entry.result = await renderOverlay(
          {
            words, style, duration: info.duration, width: rw, height: rh, fps, format,
            quality: 'medium', greenColor: '#00FF00',
            withAudio: process.env['TS_RENDER_AUDIO'] === '1', sourcePath: file, suggestedName: 'x'
          },
          out,
          () => undefined,
          cancel
        )
        log(`${format}: ${(entry.result.bytes / 1048576).toFixed(1)} МБ · ${entry.result.seconds.toFixed(1)} с · кадров ${entry.result.frames}, нарисовано ${entry.result.drawnFrames}`)
      } catch (e) {
        entry.error = errText(e)
        if (cancelMs > 0) entry.cancelledAfterMs = cancelMs
        log(`${format}: ОШИБКА ${entry.error}`)
      } finally {
        if (timer) clearTimeout(timer)
      }
      report.renders.push(entry)
    }
    finish(0)
  } catch (e) {
    report.fatal = e instanceof Error ? (e.stack ?? e.message) : String(e)
    log(`ОШИБКА: ${report.fatal}`)
    finish(1)
  }
}
