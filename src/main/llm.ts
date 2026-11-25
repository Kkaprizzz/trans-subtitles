/**
 * Клиент OpenAI-совместимого API (xAI, DeepSeek, Groq, OpenRouter, Gemini, Ollama...).
 * Ключ уходит только на указанный адрес: https, либо http для локальной машины (Ollama).
 */
import type { ChatMessage } from '../shared/clipsPrompt.ts'
import type { ChatReply } from '../shared/clipsAnalyze.ts'

export interface LlmConfig {
  /** например https://api.x.ai/v1 */
  baseUrl: string
  apiKey: string
  model: string
}

export interface ChatOptions {
  signal?: AbortSignal
  temperature?: number
  maxTokens?: number
  /** сколько попыток при 429/5xx/обрыве сети */
  retries?: number
  timeoutMs?: number
  /** параметры конкретного провайдера, например { reasoning_effort: 'low' } для gpt-oss */
  extra?: Record<string, unknown>
}

/** Ошибка, после которой повторять запрос бессмысленно (неверный ключ, адрес, формат ответа). */
class FatalError extends Error {}

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/

export function normalizeBaseUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new Error('Адрес API указан неверно. Пример: https://api.x.ai/v1')
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL.test(u.hostname))) {
    throw new Error('Ключ можно отправлять только на https-адрес (http допустим для localhost)')
  }
  u.username = ''
  u.password = ''
  return u.toString().replace(/\/+$/, '')
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new Error('Отменено'))
    })
  })

/** Подпись ошибки без утечки ключа и без простыни из тела ответа. */
function httpMessage(status: number, body: string): string {
  const hint =
    status === 401 || status === 403
      ? 'ключ не принят'
      : status === 404
        ? 'адрес или модель не найдены'
        : status === 413
          ? 'запрос больше лимита токенов в минуту — уменьши окно'
          : status === 429
            ? 'превышен лимит запросов'
            : ''
  const detail = body.replace(/\s+/g, ' ').slice(0, 200)
  return `ИИ-сервис ответил ${status}${hint ? ` (${hint})` : ''}${detail ? `: ${detail}` : ''}`
}

export async function chat(cfg: LlmConfig, messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatReply> {
  const url = `${normalizeBaseUrl(cfg.baseUrl)}/chat/completions`
  if (!cfg.apiKey.trim() && !LOCAL.test(new URL(url).hostname)) throw new Error('Не задан ключ API')
  if (!cfg.model.trim()) throw new Error('Не задана модель')

  const retries = opts.retries ?? 3
  let jsonMode = true
  let lastErr: Error = new Error('нет ответа')

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw new Error('Отменено')
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 180_000)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: opts.temperature ?? 0.3,
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
          ...opts.extra
        }),
        signal
      })
      if (res.ok) {
        const data = (await res.json()) as {
          choices?: { message?: { content?: string } }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        const text = data.choices?.[0]?.message?.content
        if (typeof text !== 'string') throw new FatalError('ИИ-сервис вернул ответ без текста')
        return {
          text,
          usage: data.usage ? { prompt: data.usage.prompt_tokens ?? 0, completion: data.usage.completion_tokens ?? 0 } : undefined
        }
      }
      const body = await res.text().catch(() => '')
      // Не все провайдеры знают response_format: повторяем без него, не тратя попытку.
      if (res.status === 400 && jsonMode && /response_format|json/i.test(body)) {
        jsonMode = false
        attempt--
        continue
      }
      lastErr = new Error(httpMessage(res.status, body))
      if (res.status !== 429 && res.status < 500) throw new FatalError(lastErr.message)
      if (attempt >= retries) break
      const retryAfter = Number(res.headers.get('retry-after'))
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 1000 * 2 ** attempt, opts.signal)
    } catch (e) {
      if (opts.signal?.aborted) throw new Error('Отменено')
      if (e instanceof FatalError) throw e
      const err = e instanceof Error ? e : new Error(String(e))
      lastErr = err.name === 'TimeoutError' ? new Error('ИИ-сервис не ответил вовремя') : new Error(`Нет связи с ИИ-сервисом: ${err.message}`)
      if (attempt < retries) await sleep(1000 * 2 ** attempt, opts.signal)
    }
  }
  throw lastErr
}
