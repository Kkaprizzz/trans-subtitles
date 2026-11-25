/** Анализ подкаста: окна -> запросы к ИИ -> разбор -> точные границы. Сеть передаётся снаружи (chat), поэтому всё тестируется. */
import {
  buildSegments,
  buildWindows,
  estimateTokens,
  finalizeClips,
  parseClips,
  FINALIZE_DEFAULTS,
  WINDOW_DEFAULTS,
  type ClipCandidate,
  type FinalizeOpts,
  type FinalizeStats,
  type RawClip,
  type Segment,
  type WindowOpts
} from './clips.ts'
import { coldViewerSystem, coldViewerUser, retryPrompt, systemPrompt, userPrompt, type ChatMessage } from './clipsPrompt.ts'
import type { Word } from './types.ts'

export interface ChatReply {
  text: string
  usage?: { prompt: number; completion: number }
}
export type Chat = (messages: ChatMessage[]) => Promise<ChatReply>

export interface AnalyzeOpts extends Partial<FinalizeOpts> {
  windows?: Partial<WindowOpts>
  /** сколько клипов просить у ИИ на окно; по умолчанию считается от maxClips */
  perWindow?: number
  /** после поиска проверить каждый клип «холодным зрителем» (ещё один запрос) */
  coldViewer?: boolean
}

export interface AnalyzeProgress {
  done: number
  total: number
  /** find — поиск моментов, check — проверка «холодным зрителем» */
  stage: 'find' | 'check'
}

export interface AnalyzeResult {
  clips: ClipCandidate[]
  segments: Segment[]
  windows: number
  usage: { prompt: number; completion: number }
  /** окна, которые не удалось разобрать, и прочие замечания */
  warnings: string[]
  /** сколько кандидатов ИИ предложил и почему часть отсеяна */
  proposed: number
  stats: FinalizeStats
  /** подсказки «холодного зрителя» по id клипа; нет записи — всё в порядке или проверка не удалась */
  notes: Record<number, string>
}

export interface Estimate {
  requests: number
  /** оценка токенов на вход всего прогона (транскрипт + инструкция); не точный подсчёт */
  inputTokens: number
  outputTokens: number
}

const OUTPUT_PER_WINDOW = 1800

/**
 * Размер окна под лимит «токенов в минуту» (у Groq на бесплатном/базовом плане 8000):
 * инструкция + окно + ответ (вместе с рассуждением модели) должны влезть в лимит с запасом 10%.
 * charsPerToken зависит от токенизатора модели; для русского 2.6 — осторожная оценка.
 */
export function windowCharsForTpm(tpm: number, outputReserve: number, charsPerToken = 2.6): number {
  const sys = estimateTokens(systemPrompt({ minDur: 15, maxDur: 60 }).length) + 120
  return Math.max(2_000, Math.floor((tpm * 0.9 - sys - outputReserve) * charsPerToken))
}

/** Оценка объёма до запуска, чтобы показать пользователю расход. */
export function estimateRun(words: Word[], opts: AnalyzeOpts = {}): Estimate {
  const windows = buildWindows(buildSegments(words), { ...WINDOW_DEFAULTS, ...opts.windows })
  const sys = estimateTokens(systemPrompt({ minDur: 15, maxDur: 60 }).length)
  const input = windows.reduce((n, w) => n + estimateTokens(w.chars) + sys + 60, 0)
  return { requests: windows.length, inputTokens: input, outputTokens: windows.length * OUTPUT_PER_WINDOW }
}

export async function analyzeClips(
  words: Word[],
  chat: Chat,
  opts: AnalyzeOpts = {},
  onProgress?: (p: AnalyzeProgress) => void,
  isCancelled: () => boolean = () => false
): Promise<AnalyzeResult> {
  if (words.length === 0) throw new Error('Нет слов: сначала распознай речь')
  const fin = { ...FINALIZE_DEFAULTS, ...opts }
  const segments = buildSegments(words)
  const windows = buildWindows(segments, { ...WINDOW_DEFAULTS, ...opts.windows })
  const perWindow = opts.perWindow ?? Math.min(12, Math.max(3, Math.ceil((fin.maxClips * 1.5) / windows.length)))
  const usage = { prompt: 0, completion: 0 }
  const warnings: string[] = []
  const raws: RawClip[] = []

  for (const w of windows) {
    if (isCancelled()) throw new Error('Отменено')
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(fin) },
      { role: 'user', content: userPrompt(w, windows.length, perWindow) }
    ]
    let parsed: RawClip[] | null = null
    let lastError = ''
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      const reply = await chat(messages)
      usage.prompt += reply.usage?.prompt ?? 0
      usage.completion += reply.usage?.completion ?? 0
      try {
        parsed = parseClips(reply.text, w.firstSeg, w.lastSeg)
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
        messages.push({ role: 'assistant', content: reply.text }, { role: 'user', content: retryPrompt(lastError) })
      }
    }
    if (parsed) raws.push(...parsed)
    else warnings.push(`Часть ${w.index + 1} из ${windows.length} пропущена: ответ ИИ не разобрался (${lastError})`)
    onProgress?.({ done: w.index + 1, total: windows.length, stage: 'find' })
  }

  if (warnings.length === windows.length) throw new Error(`ИИ ни разу не вернул разбираемый ответ. ${warnings[0]}`)
  const stats: FinalizeStats = { tooLong: 0, tooShort: 0, broken: 0, overlap: 0, approx: 0 }
  const clips = finalizeClips(words, segments, raws, fin, stats)
  let notes: Record<number, string> = {}
  if (opts.coldViewer && clips.length > 0) {
    if (isCancelled()) throw new Error('Отменено')
    try {
      const r = await coldViewer(words, clips, chat)
      notes = r.notes
      usage.prompt += r.usage.prompt
      usage.completion += r.usage.completion
    } catch (e) {
      // подсказки — не главное: без них рамки всё равно годятся
      if (isCancelled()) throw new Error('Отменено')
      warnings.push(`Проверка «холодным зрителем» не удалась: ${e instanceof Error ? e.message : String(e)}`)
    }
    onProgress?.({ done: 1, total: 1, stage: 'check' })
  }
  return { clips, segments, windows: windows.length, usage, warnings, proposed: raws.length, stats, notes }
}

/** Текст клипа: слова, середина которых внутри границ. */
export function wordsText(words: Word[], c: { start: number; end: number }): string {
  return words
    .filter((w) => (w.start + w.end) / 2 >= c.start && (w.start + w.end) / 2 <= c.end)
    .map((w) => w.text)
    .join(' ')
}

/** Разбор ответа «холодного зрителя»; непонятное молча пропускаем (проверка только подсказывает). */
export function parseVerdicts(text: string, ids: number[]): Record<number, string> {
  const t = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)
  const body = fenced ? fenced[1] : t
  const a = body.indexOf('{')
  const b = body.lastIndexOf('}')
  if (a === -1 || b <= a) throw new Error('в ответе нет JSON')
  const root = JSON.parse(body.slice(a, b + 1)) as { verdicts?: unknown }
  if (!Array.isArray(root.verdicts)) throw new Error('в JSON нет списка verdicts')
  const known = new Set(ids)
  const str = (x: unknown): string => (typeof x === 'string' ? x.trim().replace(/\s+/g, ' ').slice(0, 200) : '')
  const out: Record<number, string> = {}
  for (const v of root.verdicts) {
    if (!v || typeof v !== 'object') continue
    const r = v as Record<string, unknown>
    const id = typeof r.id === 'number' ? r.id : Number(r.id)
    if (!known.has(id) || r.ok === true) continue
    const issue = str(r.issue)
    if (!issue) continue
    const fix = str(r.fix)
    out[id] = fix ? `${issue}. ${fix}` : issue
  }
  return out
}

async function coldViewer(
  words: Word[],
  clips: ClipCandidate[],
  chat: Chat
): Promise<{ notes: Record<number, string>; usage: { prompt: number; completion: number } }> {
  const items = clips.map((c) => ({ id: c.id, seconds: c.end - c.start, text: wordsText(words, c) }))
  const messages: ChatMessage[] = [
    { role: 'system', content: coldViewerSystem() },
    { role: 'user', content: coldViewerUser(items) }
  ]
  const usage = { prompt: 0, completion: 0 }
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await chat(messages)
    usage.prompt += reply.usage?.prompt ?? 0
    usage.completion += reply.usage?.completion ?? 0
    try {
      return { notes: parseVerdicts(reply.text, items.map((i) => i.id)), usage }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      messages.push({ role: 'assistant', content: reply.text }, { role: 'user', content: retryPrompt(lastError) })
    }
  }
  throw new Error(lastError)
}
