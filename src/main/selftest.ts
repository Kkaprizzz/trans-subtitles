/**
 * Безголовая проверка конвейера: TS_SELFTEST=/путь/к/файлу npm start
 * Скачивает модель при необходимости, прогоняет распознавание, печатает итог в stdout и выходит.
 */
import { app } from 'electron'
import { transcribe } from './asr'
import { probeMedia } from './media'
import { downloadModel, listModels } from './models'
import { allowFontFile } from './fontFiles'
import { renderOverlay } from './render'
import { normalizeStyle } from '../shared/timeline'
import type { ModelId, RenderFormat } from '../shared/types'

export async function runSelfTest(file: string): Promise<void> {
  const log = (s: string): void => {
    process.stdout.write(`[selftest] ${s}\n`)
  }
  try {
    const info = await probeMedia(file)
    log(`файл: ${info.name}, ${info.duration.toFixed(1)} с, ${info.width ?? '-'}x${info.height ?? '-'}`)

    const modelId = (process.env['TS_MODEL'] ?? 'gigaam-v3') as ModelId
    const m = listModels().find((x) => x.id === modelId)!
    if (!m.installed) {
      log('скачиваю модель…')
      let last = -1
      await downloadModel(modelId, (v) => {
        const p = Math.floor(v * 10)
        if (p !== last) {
          last = p
          log(`  загрузка ${p * 10}%`)
        }
      })
    }

    const t0 = Date.now()
    let lastStage = ''
    const words = await transcribe(file, modelId, (e) => {
      if (e.stage !== lastStage) {
        lastStage = e.stage
        log(`этап: ${e.label}`)
      }
    })
    const sec = (Date.now() - t0) / 1000
    log(`слов: ${words.length}, время: ${sec.toFixed(1)} с (x${(info.duration / sec).toFixed(1)} от реального)`)
    for (const w of words.slice(0, 12)) log(`  ${w.start.toFixed(2)}-${w.end.toFixed(2)} ${w.text}`)
    log(`последнее: ${words.at(-1)?.start.toFixed(2)} ${words.at(-1)?.text}`)

    // TS_RENDER=prores4444,animation,h264-green  TS_RENDER_DIR=/куда  [TS_RENDER_SIZE=1080x1920] [TS_RENDER_FPS=30]
    const formats = (process.env['TS_RENDER'] ?? '').split(',').filter(Boolean) as RenderFormat[]
    const style = normalizeStyle(JSON.parse(process.env['TS_STYLE'] ?? '{}'))
    if (style.font === 'custom' && !allowFontFile(style.customFontPath)) throw new Error('свой шрифт не найден')
    for (const format of formats) {
      const [rw, rh] = (process.env['TS_RENDER_SIZE'] ?? `${info.width ?? 1920}x${info.height ?? 1080}`).split('x').map(Number)
      const out = `${process.env['TS_RENDER_DIR'] ?? '.'}/selftest_${format}.${format === 'h264-green' ? 'mp4' : 'mov'}`
      let lastPct = -1
      const r = await renderOverlay(
        {
          words, style, duration: info.duration, width: rw, height: rh,
          fps: Number(process.env['TS_RENDER_FPS'] ?? 30), format, quality: 'medium', greenColor: '#00FF00',
          withAudio: process.env['TS_RENDER_AUDIO'] === '1', sourcePath: file, suggestedName: 'x'
        },
        out,
        (e) => {
          const p = Math.floor(e.value * 10)
          if (p !== lastPct) {
            lastPct = p
            log(`  ${format}: ${p * 10}%`)
          }
        },
        { cancelled: false }
      )
      log(`${format}: ${r.path} · ${(r.bytes / 1048576).toFixed(1)} МБ · ${r.seconds.toFixed(1)} с · кадров ${r.frames}, нарисовано ${r.drawnFrames}`)
    }
    app.exit(0)
  } catch (e) {
    log(`ОШИБКА: ${e instanceof Error ? e.stack : String(e)}`)
    app.exit(1)
  }
}
