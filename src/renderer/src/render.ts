/**
 * Страница рендера. Живёт в скрытом offscreen-окне главного процесса, который
 * вызывает __init один раз и затем __frame(t) на каждый кадр перед снимком.
 */
import './fonts'
import { fontFamilyOf } from '../../shared/fonts'
import { buildPhrases, captionAt, type Phrase, type SubtitleStyle } from '../../shared/timeline'
import type { Word } from '../../shared/types'
import { createCaptionView, setupStage, type CaptionView } from './caption'
import { loadCustomFont } from './customFont'

interface InitConfig {
  words: Word[]
  style: SubtitleStyle
  /** CSS-цвет сплошного фона или null для прозрачного */
  background: string | null
}

declare global {
  interface Window {
    __init(cfg: InitConfig): Promise<void>
    __frame(t: number): Promise<void>
  }
}

let words: Word[] = []
let phrases: Phrase[] = []
let style: SubtitleStyle
let view: CaptionView

window.__init = async (cfg) => {
  words = cfg.words
  style = cfg.style
  phrases = buildPhrases(words, style)
  const bg = cfg.background ?? 'transparent'
  document.documentElement.style.background = bg
  document.body.style.background = bg

  const stage = document.getElementById('stage')!
  setupStage(stage)
  stage.textContent = ''
  view = createCaptionView(stage)

  // Подгружаем нужное начертание заранее, чтобы первый кадр не вышел запасным шрифтом.
  if (style.font === 'custom' && style.customFontPath) {
    if (!(await loadCustomFont(style.customFontPath))) throw new Error('Не удалось загрузить файл своего шрифта')
  }
  const family = fontFamilyOf(style)
  let sample = [...new Set(words.map((w) => w.text).join(''))].join('') + 'АаЯя'
  if (style.uppercase) sample += sample.toUpperCase()
  await document.fonts.load(`${style.weight} 40px ${family}`, sample)
  await document.fonts.ready

  view.configure(words, phrases, style, family)
  view.render(null)
}

window.__frame = (t) => {
  view.render(captionAt(words, phrases, style, t))
  // два rAF: стиль применён и закоммичен в композитор до снимка
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}
