#!/usr/bin/env node
/**
 * Прогон выбора клипов на готовых словах — для сравнения моделей на реальном подкасте.
 *
 *   LLM_BASE_URL=https://api.x.ai/v1 LLM_MODEL=<модель> LLM_KEY=<ключ> \
 *     node scripts/clips-bench.mjs <слова.json> [результат.json]
 *
 * Слова: файл проекта приложения (~/.config/Trans Subtitles/projects/*.json) или просто массив слов.
 * Ключ берётся только из окружения: в аргументы командной строки он попал бы в историю оболочки.
 * Необязательно: LLM_TPM=8000 (лимит токенов в минуту -> размер окна), LLM_MAX_TOKENS=2500 (ответ вместе с рассуждением),
 *   LLM_CHARS_PER_TOKEN=2.6, LLM_EXTRA='{"reasoning_effort":"low"}', LLM_RETRIES=6.
 *   LLM_WINDOW_CHARS=400000 — окно в символах напрямую (для моделей с большим контекстом: весь подкаст одним запросом).
 *   Длина и число клипов: CLIP_MIN=15 CLIP_MAX=60 CLIP_COUNT=10.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { analyzeClips, estimateRun, windowCharsForTpm } from '../src/shared/clipsAnalyze.ts'
import { mmss } from '../src/shared/clips.ts'
import { chat } from '../src/main/llm.ts'

const [wordsPath, outPath] = process.argv.slice(2)
const { LLM_BASE_URL, LLM_MODEL, LLM_KEY = '' } = process.env
if (!wordsPath || !LLM_BASE_URL || !LLM_MODEL) {
  console.error('Использование: LLM_BASE_URL=… LLM_MODEL=… LLM_KEY=… node scripts/clips-bench.mjs <слова.json> [результат.json]')
  process.exit(2)
}

const raw = JSON.parse(await readFile(wordsPath, 'utf8'))
const words = Array.isArray(raw) ? raw : raw.words
if (!Array.isArray(words) || words.length === 0) {
  console.error('В файле нет слов')
  process.exit(2)
}

const env = process.env
const maxTokens = env.LLM_MAX_TOKENS ? Number(env.LLM_MAX_TOKENS) : undefined
const windows = env.LLM_WINDOW_CHARS
  ? { maxChars: Number(env.LLM_WINDOW_CHARS), overlapChars: 4000 }
  : env.LLM_TPM
    ? { maxChars: windowCharsForTpm(Number(env.LLM_TPM), maxTokens ?? 2500, Number(env.LLM_CHARS_PER_TOKEN ?? 2.6)), overlapChars: 1500 }
    : undefined
const extra = env.LLM_EXTRA ? JSON.parse(env.LLM_EXTRA) : undefined
const opts = {
  mediaDuration: words.at(-1).end,
  windows,
  minDur: Number(env.CLIP_MIN ?? 15),
  maxDur: Number(env.CLIP_MAX ?? 60),
  maxClips: Number(env.CLIP_COUNT ?? 10)
}
if (!(opts.minDur > 0 && opts.maxDur > opts.minDur)) {
  console.error('CLIP_MIN и CLIP_MAX: нужны числа, минимум меньше максимума')
  process.exit(2)
}
console.log(`Клипы: ${opts.minDur}–${opts.maxDur} с, до ${opts.maxClips} штук`)
if (windows) console.log(`Окно: ${windows.maxChars} символов`)

const est = estimateRun(words, opts)
console.log(`Слов: ${words.length}, длина ≈ ${mmss(words.at(-1).end)}, запросов: ${est.requests}, токенов на вход ≈ ${est.inputTokens} (оценка)`)

const cfg = { baseUrl: LLM_BASE_URL, apiKey: LLM_KEY, model: LLM_MODEL }
const started = Date.now()
const res = await analyzeClips(
  words,
  (messages) => chat(cfg, messages, { maxTokens, extra, retries: Number(env.LLM_RETRIES ?? 6) }),
  opts,
  (p) => process.stdout.write(`\rЗапрос ${p.done}/${p.total}`)
)
process.stdout.write('\n')

const text = (a, b) => words.slice(a, b + 1).map((w) => w.text).join(' ')
for (const c of res.clips) {
  const body = text(c.firstWord, c.lastWord)
  console.log(
    `\n#${c.id} ${mmss(c.start)}–${mmss(c.end)} (${(c.end - c.start).toFixed(1)} с) оценка ${c.score}${c.approx ? ' [границы приблизительные]' : ''}` +
      (c.overlayAt !== null ? `, вставка на ${mmss(c.overlayAt)}` : '') +
      `\n  ${c.title}\n  почему: ${c.reason}\n  начало: ${body.slice(0, 140)}\n  конец:  …${body.slice(-100)}\n  ${c.hashtags.join(' ')}`
  )
}
console.log(`\nКлипов: ${res.clips.length}; токены: вход ${res.usage.prompt}, выход ${res.usage.completion}; время ${((Date.now() - started) / 1000).toFixed(0)} с`)
console.log(`ИИ предложил ${res.proposed}; отсеяно: длинных ${res.stats.tooLong}, коротких ${res.stats.tooShort}, битых ${res.stats.broken}, пересечений ${res.stats.overlap}; приблизительных границ ${res.stats.approx}`)
for (const w of res.warnings) console.log(`! ${w}`)
if (outPath) await writeFile(outPath, JSON.stringify({ model: LLM_MODEL, ...res, segments: undefined }, null, 2))
