/**
 * Настройки ИИ-провайдера: userData/ai.json. Ключ хранится зашифрованным через safeStorage
 * (на Linux — системное хранилище ключей; если его нет, Electron шифрует слабо — UI об этом предупреждает).
 * В страницу ключ не отдаётся никогда: только признак «ключ задан».
 */
import { app, safeStorage } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiProvider, AiSettings, AiSettingsPatch } from '../shared/types'
import { normalizeBaseUrl, type LlmConfig } from './llm'

interface Stored {
  provider: AiProvider
  baseUrl: string
  model: string
  /** лимит токенов в минуту (бесплатный Groq — 8000); null — лимита нет, весь подкаст одним запросом */
  tpm: number | null
  /** JSON с параметрами провайдера, например {"reasoning_effort":"low"} */
  extra: string
  /** ключи по провайдерам, base64 зашифрованных байт */
  keys: Partial<Record<AiProvider, string>>
}

export const PRESETS: Record<Exclude<AiProvider, 'custom'>, Omit<Stored, 'provider' | 'keys'>> = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', tpm: null, extra: '{"reasoning_effort":"low"}' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'qwen/qwen3.8-27b', tpm: 8000, extra: '{"reasoning_format":"hidden"}' }
}

const DEFAULT: Stored = { provider: 'deepseek', ...PRESETS.deepseek, keys: {} }
const file = (): string => join(app.getPath('userData'), 'ai.json')
let cache: Stored | null = null

async function load(): Promise<Stored> {
  if (cache) return cache
  try {
    const j = JSON.parse(await readFile(file(), 'utf8')) as Partial<Stored>
    cache = {
      ...DEFAULT,
      ...j,
      provider: j.provider === 'groq' || j.provider === 'custom' || j.provider === 'deepseek' ? j.provider : DEFAULT.provider,
      keys: j.keys && typeof j.keys === 'object' ? j.keys : {}
    }
  } catch {
    cache = { ...DEFAULT, keys: {} }
  }
  return cache
}

async function save(s: Stored): Promise<void> {
  cache = s
  await mkdir(app.getPath('userData'), { recursive: true })
  const tmp = `${file()}.tmp`
  await writeFile(tmp, JSON.stringify(s, null, 1), { mode: 0o600 })
  await rename(tmp, file())
}

function decrypt(b64: string | undefined): string {
  if (!b64) return ''
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'))
  } catch {
    return ''
  }
}

/** Для тестов и разработки: ключ из окружения перекрывает сохранённый. */
const envKey = (): string => process.env['TS_AI_KEY'] ?? ''

function view(s: Stored): AiSettings {
  let weak = false
  try {
    weak = process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'
  } catch {
    /* старые версии API — считаем, что хранилище нормальное */
  }
  return {
    provider: s.provider,
    baseUrl: s.baseUrl,
    model: s.model,
    tpm: s.tpm,
    extra: s.extra,
    hasKey: !!envKey() || !!s.keys[s.provider],
    weakKeyStorage: weak
  }
}

export async function getAiSettings(): Promise<AiSettings> {
  return view(await load())
}

export async function setAiSettings(patch: AiSettingsPatch): Promise<AiSettings> {
  const cur = await load()
  let next: Stored = { ...cur, keys: { ...cur.keys } }
  if (patch.provider && patch.provider !== cur.provider) {
    next.provider = patch.provider
    if (patch.provider !== 'custom') next = { ...next, ...PRESETS[patch.provider] }
  }
  if (patch.baseUrl !== undefined) next.baseUrl = normalizeBaseUrl(patch.baseUrl)
  if (patch.model !== undefined) next.model = patch.model.trim().slice(0, 120)
  if (patch.tpm !== undefined) {
    if (patch.tpm !== null && !(Number.isFinite(patch.tpm) && patch.tpm >= 1000)) throw new Error('Лимит токенов в минуту: число от 1000 или пусто')
    next.tpm = patch.tpm
  }
  if (patch.extra !== undefined) {
    const t = patch.extra.trim()
    if (t) {
      let ok = false
      try {
        const v = JSON.parse(t) as unknown
        ok = !!v && typeof v === 'object' && !Array.isArray(v)
      } catch {
        ok = false
      }
      if (!ok) throw new Error('Доп. параметры — JSON-объект, например {"reasoning_effort":"low"}')
    }
    next.extra = t
  }
  if (patch.key !== undefined) {
    const k = patch.key.trim()
    if (!k) delete next.keys[next.provider]
    else {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Шифрование недоступно в этой системе — ключ не сохранён')
      next.keys[next.provider] = safeStorage.encryptString(k).toString('base64')
    }
  }
  await save(next)
  return view(next)
}

export interface ResolvedAi {
  cfg: LlmConfig
  tpm: number | null
  extra: Record<string, unknown> | undefined
}

export async function resolveAi(): Promise<ResolvedAi> {
  const s = await load()
  const apiKey = envKey() || decrypt(s.keys[s.provider])
  if (!apiKey && !/localhost|127\.0\.0\.1/.test(s.baseUrl)) throw new Error('Не задан ключ ИИ: открой «Настройки ИИ» на вкладке «Клипы»')
  let extra: Record<string, unknown> | undefined
  if (s.extra) {
    try {
      extra = JSON.parse(s.extra) as Record<string, unknown>
    } catch {
      extra = undefined
    }
  }
  return { cfg: { baseUrl: s.baseUrl, apiKey, model: s.model }, tpm: s.tpm, extra }
}
