/** Окно настроек с разделами: распознавание, ИИ, экспорт, новый проект, кэш, обновления. */
import { useEffect, useState } from 'react'
import type {
  AiProvider,
  AiSettings,
  AiSettingsPatch,
  AppInfo,
  AppSettings,
  CacheInfo,
  ModelId,
  ModelStatus,
  ProgressEvent
} from '../../../shared/types'

export type SettingsSection = 'asr' | 'ai' | 'export' | 'download' | 'project' | 'cache' | 'updates'
export const SECTIONS: Array<[SettingsSection, string]> = [
  ['asr', 'Распознавание речи'],
  ['ai', 'ИИ для «Нарезки»'],
  ['export', 'Экспорт'],
  ['download', 'Скачивание'],
  ['project', 'Новый проект'],
  ['cache', 'Кэш'],
  ['updates', 'Обновления']
]

interface Props {
  section: SettingsSection
  progress: ProgressEvent | null
  onClose(): void
}

export const MODEL_KEY = 'model-v1'
export function loadModelId(): ModelId {
  try {
    const m = localStorage.getItem(MODEL_KEY)
    if (m === 'gigaam-v3' || m === 'whisper-small' || m === 'whisper-turbo') return m
  } catch {
    /* умолчание */
  }
  return 'gigaam-v3'
}

const PROVIDERS: Array<{ id: AiProvider; label: string }> = [
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'groq', label: 'Groq (бесплатный, с лимитами)' },
  { id: 'custom', label: 'Свой (OpenAI-совместимый)' }
]
const CANVASES = [
  { id: 'first', label: 'По первому видео' },
  { id: '1080x1920', label: '9:16 · 1080×1920' },
  { id: '1920x1080', label: '16:9 · 1920×1080' },
  { id: '1080x1080', label: '1:1 · 1080×1080' },
  { id: '1080x1350', label: '4:5 · 1080×1350' }
]
const clean = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const mb = (b: number): string => (b < 1048576 ? `${Math.round(b / 1024)} КБ` : `${(b / 1048576).toFixed(b < 104857600 ? 1 : 0)} МБ`)

export default function SettingsDialog(p: Props): React.JSX.Element {
  const [section, setSection] = useState<SettingsSection>(p.section)
  const [models, setModels] = useState<ModelStatus[]>([])
  const [modelId, setModelId] = useState<ModelId>(loadModelId)
  const [downloading, setDownloading] = useState(false)
  const [ai, setAi] = useState<AiSettings | null>(null)
  const [key, setKey] = useState('')
  const [st, setSt] = useState<AppSettings | null>(null)
  const [cache, setCache] = useState<CacheInfo | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    void window.api.listModels().then(setModels, () => {})
    void window.api.getAi().then(setAi, () => {})
    void window.api.getAppSettings().then(setSt, () => {})
    void window.api.cacheInfo().then(setCache, () => {})
    void window.api.appInfo().then(setInfo, () => {})
  }, [])
  useEffect(() => setMsg(null), [section])

  const pickModel = (id: ModelId): void => {
    setModelId(id)
    try {
      localStorage.setItem(MODEL_KEY, id)
    } catch {
      /* не критично */
    }
  }
  const model = models.find((m) => m.id === modelId)
  const download = async (): Promise<void> => {
    setMsg(null)
    setDownloading(true)
    try {
      await window.api.downloadModel(modelId)
      setModels(await window.api.listModels())
    } catch (e) {
      setMsg(clean(e))
    } finally {
      setDownloading(false)
    }
  }
  const saveAi = async (patch: AiSettingsPatch): Promise<void> => {
    setMsg(null)
    try {
      setAi(await window.api.setAi(patch))
    } catch (e) {
      setMsg(clean(e))
    }
  }
  const saveSt = async (patch: Partial<AppSettings>): Promise<void> => {
    setMsg(null)
    try {
      setSt(await window.api.setAppSettings(patch))
    } catch (e) {
      setMsg(clean(e))
    }
  }
  const run = async (fn: () => Promise<string | void>): Promise<void> => {
    setMsg('…')
    try {
      setMsg((await fn()) || null)
    } catch (e) {
      setMsg(clean(e))
    }
  }

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && !downloading && p.onClose()}>
      <div className="modal settings" role="dialog" aria-label="Настройки">
        <div className="pane-head">
          <span>Настройки</span>
          <button className="btn icon small" onClick={p.onClose} disabled={downloading} aria-label="Закрыть">
            ×
          </button>
        </div>
        <div className="set-wrap">
          <nav className="set-nav" aria-label="Разделы">
            {SECTIONS.map(([id, label]) => (
              <button key={id} className={section === id ? 'on' : ''} aria-current={section === id} onClick={() => setSection(id)}>
                {label}
              </button>
            ))}
          </nav>
          <div className="modal-body set-body">
            {section === 'asr' && (
              <>
                <label className="insp-row">
                  <span>Модель</span>
                  <select value={modelId} onChange={(e) => pickModel(e.target.value as ModelId)} disabled={downloading}>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.title}
                        {m.recommended ? ' · рекомендуется' : ''}
                        {m.heavy ? ' · тяжело для этого ПК' : ''}
                        {m.installed ? '' : ` — не скачана, ${m.sizeMB} МБ`}
                      </option>
                    ))}
                  </select>
                </label>
                {model && <p className="hint">{model.note}</p>}
                {model && !model.installed && (
                  <div className="set-actions">
                    <button className="btn" onClick={() => void download()} disabled={downloading}>
                      {downloading ? 'Скачиваю…' : `Скачать (${model.sizeMB} МБ)`}
                    </button>
                    {downloading && p.progress?.stage === 'download' && <span className="mono dim">{Math.round(p.progress.value * 100)}%</span>}
                  </div>
                )}
              </>
            )}

            {section === 'ai' && ai && (
              <>
                <label className="insp-row">
                  <span>Провайдер</span>
                  <select value={ai.provider} onChange={(e) => void saveAi({ provider: e.target.value as AiProvider })}>
                    {PROVIDERS.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="insp-row">
                  <span>Модель</span>
                  <input type="text" defaultValue={ai.model} key={`m-${ai.provider}-${ai.model}`} onBlur={(e) => e.target.value !== ai.model && void saveAi({ model: e.target.value })} />
                </label>
                {ai.provider === 'custom' && (
                  <label className="insp-row">
                    <span>Адрес API</span>
                    <input type="text" defaultValue={ai.baseUrl} key={`u-${ai.baseUrl}`} onBlur={(e) => e.target.value !== ai.baseUrl && void saveAi({ baseUrl: e.target.value })} />
                  </label>
                )}
                <label className="insp-row">
                  <span>Ключ</span>
                  <input type="password" value={key} placeholder={ai.hasKey ? 'задан — введи новый, чтобы заменить' : 'вставь ключ API'} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
                </label>
                <label className="insp-row">
                  <span>Токенов/мин</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    defaultValue={ai.tpm ?? ''}
                    key={`t-${ai.provider}-${ai.tpm}`}
                    placeholder="без лимита — весь подкаст одним запросом"
                    onBlur={(e) => {
                      const v = e.target.value.trim() === '' ? null : Number(e.target.value)
                      if (v !== ai.tpm) void saveAi({ tpm: v })
                    }}
                  />
                </label>
                <label className="insp-row">
                  <span>Доп. параметры</span>
                  <input type="text" className="mono" defaultValue={ai.extra} key={`x-${ai.provider}-${ai.extra}`} onBlur={(e) => e.target.value !== ai.extra && void saveAi({ extra: e.target.value })} />
                </label>
                <div className="set-actions">
                  <button className="btn" disabled={!key.trim()} onClick={() => void saveAi({ key }).then(() => setKey(''))}>
                    Сохранить ключ
                  </button>
                  <button className="btn" onClick={() => void run(() => window.api.testAi())} disabled={!ai.hasKey}>
                    Проверить
                  </button>
                </div>
                {ai.weakKeyStorage && <p className="hint warn">В системе нет хранилища ключей: ключ сохранится почти открытым текстом в профиле приложения.</p>}
              </>
            )}

            {section === 'export' && st && (
              <>
                <div className="insp-row">
                  <span>Папка</span>
                  <span className="set-path mono" title={st.exportDir ?? ''}>
                    {st.exportDir ?? 'системная «Видео»'}
                  </span>
                  <span className="set-actions">
                    <button
                      className="btn small"
                      onClick={() => void window.api.pickFolder('Папка для экспорта по умолчанию').then((d) => d && void saveSt({ exportDir: d }))}
                    >
                      Выбрать
                    </button>
                    {st.exportDir && (
                      <button className="btn small" onClick={() => void saveSt({ exportDir: null })}>
                        Сбросить
                      </button>
                    )}
                  </span>
                </div>
                <label className="insp-row">
                  <span>Формат</span>
                  <select value={st.exportFormat} onChange={(e) => void saveSt({ exportFormat: e.target.value as AppSettings['exportFormat'] })}>
                    <option value="h264">MP4 · H.264 — для публикации</option>
                    <option value="prores422">MOV · ProRes 422 — мастер-копия</option>
                  </select>
                </label>
                <label className="insp-row">
                  <span>Качество</span>
                  <select value={st.exportQuality} onChange={(e) => void saveSt({ exportQuality: e.target.value as AppSettings['exportQuality'] })}>
                    <option value="high">Высокое</option>
                    <option value="medium">Среднее</option>
                    <option value="small">Малый размер</option>
                  </select>
                </label>
                <p className="hint">С этими значениями открывается окно экспорта; в нём их можно поменять для конкретного файла.</p>
              </>
            )}

            {section === 'download' && st && (
              <>
                <div className="insp-row">
                  <span>Папка</span>
                  <span className="set-path mono" title={st.downloadDir ?? ''}>
                    {st.downloadDir ?? 'Видео / Бобина'}
                  </span>
                  <span className="set-actions">
                    <button className="btn small" onClick={() => void window.api.pickFolder('Папка для скачанных файлов').then((d) => d && void saveSt({ downloadDir: d }))}>
                      Выбрать
                    </button>
                    {st.downloadDir && (
                      <button className="btn small" onClick={() => void saveSt({ downloadDir: null })}>
                        Сбросить
                      </button>
                    )}
                  </span>
                </div>
              </>
            )}

            {section === 'project' && st && (
              <>
                <label className="insp-row">
                  <span>Кадр</span>
                  <select value={st.newCanvas} onChange={(e) => void saveSt({ newCanvas: e.target.value })}>
                    {CANVASES.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="insp-row">
                  <span>FPS</span>
                  <select value={String(st.newFps)} onChange={(e) => void saveSt({ newFps: Number(e.target.value) })}>
                    <option value="0">По первому видео</option>
                    {[24, 25, 30, 50, 60].map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="hint">Действует на новые проекты. В открытом проекте кадр и FPS меняются в инспекторе, когда ничего не выделено.</p>
              </>
            )}

            {section === 'cache' && cache && (
              <>
                <dl className="insp-grid mono">
                  <dt>Копии для просмотра</dt>
                  <dd>{mb(cache.previews)}</dd>
                  <dt>Миниатюры</dt>
                  <dd>{mb(cache.thumbs)}</dd>
                  <dt>Волны звука</dt>
                  <dd>{mb(cache.peaks)}</dd>
                </dl>
                <p className="hint">Всё это пересоздаётся само при следующем открытии файлов. Проекты, модели и настройки не трогаются.</p>
                <div className="set-actions">
                  <button
                    className="btn"
                    onClick={() => {
                      if (window.confirm('Очистить кэш? Копии для просмотра больших файлов будут делаться заново')) void run(async () => {
                        setCache(await window.api.clearCache())
                        return 'Кэш очищен'
                      })
                    }}
                  >
                    Очистить
                  </button>
                  <button className="btn" onClick={() => void window.api.openDataDir()}>
                    Открыть папку данных
                  </button>
                </div>
                <p className="hint mono" title={cache.dataDir}>
                  {cache.dataDir}
                </p>
              </>
            )}

            {section === 'updates' && st && (
              <>
                <p className="mono">
                  Версия {info?.version ?? '…'}
                  {info && !info.packaged ? ' · режим разработки' : ''}
                </p>
                <label className="check">
                  <input type="checkbox" checked={st.autoUpdate} onChange={(e) => void saveSt({ autoUpdate: e.target.checked })} />
                  <span>Проверять обновления при запуске и скачивать в фоне</span>
                </label>
                <div className="set-actions">
                  <button className="btn" onClick={() => void run(() => window.api.checkUpdates())}>
                    Проверить сейчас
                  </button>
                </div>
              </>
            )}

            {msg && <p className={`hint${/не |ошиб|нет |неверн|не удалось/i.test(msg) ? ' warn' : ''}`}>{msg}</p>}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn primary" onClick={p.onClose} disabled={downloading}>
            Готово
          </button>
        </div>
      </div>
    </div>
  )
}
