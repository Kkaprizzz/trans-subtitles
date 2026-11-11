import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import * as E from '../../shared/edit'
import { EMPTY_HIST, histReducer } from '../../shared/history'
import { fontFamilyOf } from '../../shared/fonts'
import {
  buildPhrases,
  captionAt,
  DEFAULT_STYLE,
  findActive,
  normalizeStyle,
  type SubtitleStyle
} from '../../shared/timeline'
import type { MediaInfo, ModelId, ModelStatus, ProgressEvent, UpdateEvent, Word } from '../../shared/types'
import { createCaptionView, setupStage, type CaptionView } from './caption'
import { loadCustomFont } from './customFont'
import EditPop from './EditPop'
import { fmtTime, plural } from './format'
import RenderPanel from './RenderPanel'
import { loadSettings, resolveSize, STORAGE_KEY as RENDER_KEY, type Settings as RenderSettings } from './renderSettings'
import StylePanel from './StylePanel'
import WordEditor from './WordEditor'

type Busy = null | 'download' | 'transcribe' | 'render'
type Tab = 'words' | 'style' | 'render'
type ViewMode = 'video' | 'render'

const STYLE_KEY = 'subtitle-style-v1'
const MODEL_KEY = 'model-v1'

function loadStyle(): SubtitleStyle {
  try {
    const raw = localStorage.getItem(STYLE_KEY)
    if (raw) return normalizeStyle(JSON.parse(raw) as Partial<SubtitleStyle>)
  } catch {
    /* localStorage может быть недоступен — берём умолчания */
  }
  return DEFAULT_STYLE
}

function Icon({ d }: { d: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}
const ICON_PLAY = 'M8 5l11 7-11 7z'
const ICON_PAUSE = 'M8 5v14M16 5v14'
const ICON_OPEN = 'M3 7h6l2 2h10v10H3z'
const ICON_UNDO = 'M8 6L3 11l5 5M4 11h10a5 5 0 010 10h-3'
const ICON_REDO = 'M16 6l5 5-5 5M20 11H10a5 5 0 000 10h3'

/** Поле, в котором печатают: там работает обычная отмена ввода, глобальную не трогаем. */
function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true
  if (el.tagName !== 'INPUT') return false
  return !['range', 'checkbox', 'radio', 'color', 'button'].includes((el as HTMLInputElement).type)
}

export default function App(): React.JSX.Element {
  const [media, setMedia] = useState<MediaInfo | null>(null)
  const [models, setModels] = useState<ModelStatus[]>([])
  const [modelId, setModelId] = useState<ModelId>(() => {
    try {
      const saved = localStorage.getItem(MODEL_KEY)
      if (saved === 'gigaam-v3' || saved === 'whisper-small' || saved === 'whisper-turbo') return saved
    } catch {
      /* без localStorage берём умолчание */
    }
    return 'gigaam-v3'
  })
  const [hist, dispatch] = useReducer(histReducer, EMPTY_HIST)
  const rawWords = hist.present
  const [selected, setSelected] = useState(-1)
  const [edit, setEdit] = useState<{ idx: number } | null>(null)
  const [editPos, setEditPos] = useState<{ x: number; y: number } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateEvent | null>(null)
  const [shiftMs, setShiftMs] = useState(0)
  const [busy, setBusy] = useState<Busy>(null)
  const [progress, setProgress] = useState<ProgressEvent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [tab, setTab] = useState<Tab>('words')
  const [style, setStyle] = useState<SubtitleStyle>(loadStyle)
  const [fontTick, setFontTick] = useState(0)
  const [rs, setRs] = useState<RenderSettings>(loadSettings)
  const [viewMode, setViewMode] = useState<ViewMode>('video')

  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<CaptionView | null>(null)
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])
  const stopAtRef = useRef<number | null>(null)
  const openEditRef = useRef<(idx: number) => void>(() => {})

  const model = models.find((m) => m.id === modelId)

  // Слова со сдвигом: он действует и на превью, и на рендер.
  const words = useMemo<Word[]>(
    () =>
      shiftMs === 0
        ? rawWords
        : rawWords.map((w) => ({ ...w, start: Math.max(0, w.start + shiftMs / 1000), end: Math.max(0, w.end + shiftMs / 1000) })),
    [rawWords, shiftMs]
  )

  const refreshModels = useCallback(async () => setModels(await window.api.listModels()), [])

  /** Новый файл: чистим состояние и поднимаем сохранённые правки, если они есть. */
  const afterOpen = useCallback(async (info: MediaInfo) => {
    setMedia(info)
    dispatch({ type: 'reset', words: [] })
    setSelected(-1)
    setEdit(null)
    setTime(0)
    setPlaying(false)
    setNotice(null)
    const saved = await window.api.loadProject(info.path)
    if (saved) {
      dispatch({ type: 'reset', words: saved.words })
      const when = saved.savedAt ? new Date(saved.savedAt).toLocaleString('ru-RU') : ''
      setNotice(`Восстановлены сохранённые слова${when ? ` (${when})` : ''}. «Распознать» заменит их новым распознаванием`)
    }
  }, [])

  useEffect(() => {
    void refreshModels()
    void window.api.devInitialMedia().then((m) => m && void afterOpen(m))
    const offProgress = window.api.onProgress(setProgress)
    const offUpdate = window.api.onUpdate(setUpdate)
    return () => {
      offProgress()
      offUpdate()
    }
  }, [refreshModels, afterOpen])

  // Автосохранение правок: через 0.6 с после последнего изменения.
  useEffect(() => {
    if (!media || rawWords.length === 0) return
    const h = setTimeout(() => {
      void window.api.saveProject(media.path, rawWords).catch(() => {})
    }, 600)
    return () => clearTimeout(h)
  }, [media, rawWords])

  // Размер сцены нужен, чтобы наложить подпись ровно на видимый кадр.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // Плавное время: timeupdate приходит ~4 раза в секунду, для слов этого мало.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = (): void => {
      const v = videoRef.current
      if (v) {
        setTime(v.currentTime)
        if (stopAtRef.current !== null && v.currentTime >= stopAtRef.current) {
          stopAtRef.current = null
          v.pause()
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v || !media) return
    stopAtRef.current = null
    if (v.paused) void v.play()
    else v.pause()
  }, [media])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (e.code === 'Space' && tag !== 'SELECT' && tag !== 'BUTTON' && tag !== 'INPUT') {
        e.preventDefault()
        togglePlay()
      } else if ((e.ctrlKey || e.metaKey) && !isTyping(e.target)) {
        if (e.code === 'KeyZ') {
          e.preventDefault()
          dispatch({ type: e.shiftKey ? 'redo' : 'undo' })
        } else if (e.code === 'KeyY') {
          e.preventDefault()
          dispatch({ type: 'redo' })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay])

  // Подпись в превью рисует тот же код, что и рендер (caption.ts).
  const out = useMemo(() => resolveSize(rs, media), [rs, media])
  const showRender = viewMode === 'render'
  const sourceAspect = media?.hasVideo && media.width && media.height ? media.width / media.height : 16 / 9
  const aspect = showRender ? out.w / out.h : sourceAspect
  const frameBg =
    !showRender ? undefined : rs.format === 'h264-green' ? rs.green : 'repeating-conic-gradient(#cfccc4 0 25%, #e6e3dc 0 50%) 0 0 / 24px 24px'
  const frameW = Math.min(box.w, box.h * aspect)
  const frameH = frameW / aspect

  useEffect(() => {
    try {
      localStorage.setItem(STYLE_KEY, JSON.stringify(style))
    } catch {
      /* не критично */
    }
  }, [style])

  useEffect(() => {
    try {
      localStorage.setItem(RENDER_KEY, JSON.stringify(rs))
    } catch {
      /* не критично */
    }
  }, [rs])

  const patchRender = useCallback((patch: Partial<RenderSettings>) => setRs((prev) => ({ ...prev, ...patch })), [])

  const patchStyle = useCallback((patch: Partial<SubtitleStyle>) => setStyle((prev) => ({ ...prev, ...patch })), [])

  const phrases = useMemo(() => buildPhrases(words, style), [words, style.mode, style.maxWords, style.pauseBreak]) // eslint-disable-line react-hooks/exhaustive-deps
  const caption = useMemo(() => captionAt(words, phrases, style, time), [words, phrases, style, time])

  // Шрифт грузится лениво: ждём его и перерисовываем (от него зависит и перенос строк).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (style.font === 'custom' && style.customFontPath) {
        const ok = (await window.api.allowFont(style.customFontPath)) && (await loadCustomFont(style.customFontPath))
        if (!ok && !cancelled) setNotice(`Не удалось загрузить шрифт «${style.customFontName || style.customFontPath}»: показываю Montserrat. Выбери файл заново на вкладке «Стиль»`)
      }
      const family = fontFamilyOf(style)
      const sample = [...new Set(words.map((w) => w.text).join(''))].join('') + 'АаЯя'
      await document.fonts.load(`${style.weight} 40px ${family}`, style.uppercase ? sample + sample.toUpperCase() : sample)
      if (!cancelled) setFontTick((n) => n + 1)
    })()
    return () => {
      cancelled = true
    }
  }, [style.font, style.customFontPath, style.customFontName, style.weight, style.uppercase, words]) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (!frameRef.current) return
    setupStage(frameRef.current)
    viewRef.current = createCaptionView(frameRef.current)
    viewRef.current.onWordClick = (idx) => openEditRef.current(idx)
    return () => {
      viewRef.current = null
      if (frameRef.current) frameRef.current.textContent = ''
    }
  }, [])

  useLayoutEffect(() => {
    viewRef.current?.configure(words, phrases, style, fontFamilyOf(style))
  }, [words, phrases, style, fontTick])

  useLayoutEffect(() => {
    viewRef.current?.render(caption)
  }, [caption])

  const shownIdx = caption?.active ?? -1
  const activeIdx = useMemo(() => findActive(words, time), [words, time])

  useEffect(() => {
    if (activeIdx >= 0) rowRefs.current[activeIdx]?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  const seek = (t: number): void => {
    if (!videoRef.current) return
    stopAtRef.current = null
    videoRef.current.currentTime = t
    setTime(t)
  }

  // --- правки слов ---
  const sel = selected >= 0 && selected < words.length ? selected : -1

  const applyEdit = (r: E.EditResult | null, key?: string): void => {
    if (!r) return
    dispatch({ type: 'commit', words: r.words, key, now: Date.now() })
    setSelected(r.focus)
  }

  /** Время в окне показано со сдвигом, а хранится без него. */
  const editTime = (idx: number, patch: { start?: number; end?: number }, key: string): void => {
    if (!media) return
    const off = shiftMs / 1000
    const next = E.setTiming(
      rawWords,
      idx,
      {
        start: patch.start === undefined ? undefined : patch.start - off,
        end: patch.end === undefined ? undefined : patch.end - off
      },
      media.duration
    )
    if (next) dispatch({ type: 'commit', words: next, key, now: Date.now() })
  }

  const nudge = (idx: number, which: 'start' | 'end', dir: 1 | -1): void => {
    const w = words[idx]
    if (w) editTime(idx, { [which]: w[which] + dir * E.NUDGE }, `n-${w.id}-${which}`)
  }

  const playWord = (idx: number): void => {
    const v = videoRef.current
    const w = words[idx]
    if (!v || !w) return
    v.currentTime = Math.max(0, w.start - 0.15)
    stopAtRef.current = w.end + 0.1
    void v.play()
  }

  const openEdit = (idx: number): void => {
    if (!words[idx]) return
    stopAtRef.current = null
    videoRef.current?.pause()
    setSelected(idx)
    setEdit({ idx })
  }
  openEditRef.current = openEdit

  const commitEdit = (text: string, move: -1 | 0 | 1): void => {
    if (!edit) return
    const idx = edit.idx
    const r = E.setText(rawWords, idx, text)
    if (r) applyEdit(r)
    if (move === 0) {
      setEdit(null)
      return
    }
    const list = r ? r.words : rawWords
    const deleted = !!r && r.words.length < rawWords.length
    const target = deleted ? (move === 1 ? idx : idx - 1) : idx + move
    if (target < 0 || target >= list.length) {
      setEdit(null)
      return
    }
    seek(list[target].start + shiftMs / 1000 + 0.03)
    setSelected(target)
    setEdit({ idx: target })
  }

  // Окошко правки встаёт под слово на сцене (или в центр кадра, если слово сейчас не нарисовано).
  useLayoutEffect(() => {
    if (!edit || !stageRef.current) {
      setEditPos(null)
      return
    }
    const stage = stageRef.current.getBoundingClientRect()
    const r = viewRef.current?.wordRect(edit.idx)
    const pos = r
      ? { x: Math.round(r.left + r.width / 2 - stage.left), y: Math.round(r.bottom - stage.top + 10) }
      : { x: Math.round(stage.width / 2), y: Math.round(stage.height * 0.72) }
    setEditPos((prev) => (prev && prev.x === pos.x && prev.y === pos.y ? prev : pos))
  }, [edit, caption, frameW, frameH, fontTick])

  const openFile = async (): Promise<void> => {
    setError(null)
    try {
      const info = await window.api.pickMedia()
      if (!info) return
      await afterOpen(info)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const download = async (): Promise<void> => {
    setError(null)
    setBusy('download')
    setProgress({ stage: 'download', value: 0, label: 'Скачиваю модель' })
    try {
      await window.api.downloadModel(modelId)
      await refreshModels()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  const recognize = async (): Promise<void> => {
    if (!media) return
    if (rawWords.length > 0 && !window.confirm('Заменить текущие слова и правки новым распознаванием?')) return
    setError(null)
    setNotice(null)
    setBusy('transcribe')
    setProgress({ stage: 'audio', value: 0, label: 'Извлекаю звук' })
    const started = performance.now()
    try {
      const result = await window.api.transcribe(media.path, modelId)
      dispatch({ type: 'reset', words: result })
      setSelected(-1)
      const sec = (performance.now() - started) / 1000
      setProgress({ stage: 'asr', value: 1, label: `Готово за ${sec.toFixed(1)} с` })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setProgress(null)
    } finally {
      setBusy(null)
    }
  }

  const setRenderBusy = useCallback((v: boolean) => {
    setBusy(v ? 'render' : null)
    if (!v) setProgress(null)
  }, [])

  const mustDownload = !!model && !model.installed
  const statusText = error
    ? error
    : progress
      ? `${progress.label}${busy && progress.stage !== 'render' ? ` — ${Math.round(progress.value * 100)}%` : ''}`
      : notice
        ? notice
        : media
        ? `${media.width && media.height ? `${media.width}×${media.height}` : 'аудио'}${media.fps ? ` · ${media.fps.toFixed(0)} fps` : ''}`
        : 'Файл не выбран'

  return (
    <div className="app">
      <header className="toolbar">
        <button className="btn" onClick={() => void openFile()} disabled={busy !== null}>
          <Icon d={ICON_OPEN} />
          Открыть файл
        </button>
        <span className="filename" title={media?.path}>
          {media ? media.name : '—'}
        </span>
        <span className="spacer" />
        {update?.state === 'ready' && (
          <button className="btn" onClick={() => void window.api.installUpdate()} title="Перезапустит приложение и поставит новую версию">
            Обновить до {update.version}
          </button>
        )}
        {update?.state === 'downloading' && <span className="dim">Скачиваю обновление {update.version}…</span>}
        <label className="field">
          <span>Модель</span>
          <select
            value={modelId}
            onChange={(e) => {
              const id = e.target.value as ModelId
              setModelId(id)
              try {
                localStorage.setItem(MODEL_KEY, id)
              } catch {
                /* не критично */
              }
            }}
            disabled={busy !== null}
            title={model?.note}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
                {m.recommended ? ' · рекомендуется' : ''}
                {m.heavy ? ' · тяжело для этого ПК' : ''}
                {m.installed ? '' : ` — ${m.sizeMB} МБ`}
              </option>
            ))}
          </select>
        </label>
        {mustDownload ? (
          <button className="btn primary" onClick={() => void download()} disabled={busy !== null}>
            Скачать модель
          </button>
        ) : (
          <button className="btn primary" onClick={() => void recognize()} disabled={!media || busy !== null}>
            Распознать
          </button>
        )}
      </header>

      <div className="progress" aria-hidden={busy === null}>
        <div className="progress-bar" style={{ transform: `scaleX(${busy ? (progress?.value ?? 0) : 0})` }} />
      </div>

      <main className="workspace">
        <section className="stage-col">
          <div className="stage" ref={stageRef}>
            {media ? (
              <video
                ref={videoRef}
                src={window.api.mediaUrl(media.path)}
                onPlay={() => setPlaying(true)}
                onPause={() => {
                  setPlaying(false)
                  if (videoRef.current) setTime(videoRef.current.currentTime)
                }}
                onSeeked={() => videoRef.current && setTime(videoRef.current.currentTime)}
                onEnded={() => setPlaying(false)}
                className={!media.hasVideo ? 'audio-only' : showRender ? 'dimmed' : ''}
              />
            ) : (
              <p className="stage-empty">Открой видео или аудио, чтобы начать</p>
            )}
            {media && !media.hasVideo && <p className="stage-empty">Только аудио</p>}
            <div className="caption-frame" ref={frameRef} style={{ width: frameW, height: frameH, background: frameBg }} />
            {edit && editPos && words[edit.idx] && (
              <EditPop
                key={edit.idx}
                text={words[edit.idx].text}
                x={editPos.x}
                y={editPos.y}
                stageW={box.w}
                onCommit={commitEdit}
                onCancel={() => setEdit(null)}
              />
            )}
          </div>

          <div className="transport">
            <button className="btn icon" onClick={togglePlay} disabled={!media} aria-label={playing ? 'Пауза' : 'Играть'}>
              <Icon d={playing ? ICON_PAUSE : ICON_PLAY} />
            </button>
            <input
              className="seek"
              type="range"
              min={0}
              max={media?.duration ?? 0}
              step={0.01}
              value={Math.min(time, media?.duration ?? 0)}
              onChange={(e) => seek(Number(e.target.value))}
              disabled={!media}
              aria-label="Позиция"
            />
            <div className="segmented small" role="radiogroup" aria-label="Что показывать на сцене">
              <button
                role="radio"
                aria-checked={!showRender}
                className={!showRender ? 'on' : ''}
                onClick={() => setViewMode('video')}
                title="Видео исходника с подписями поверх"
              >
                Видео
              </button>
              <button
                role="radio"
                aria-checked={showRender}
                className={showRender ? 'on' : ''}
                onClick={() => setViewMode('render')}
                title={`Кадр так, как попадёт в файл: ${out.w}×${out.h}, ${rs.format === 'h264-green' ? 'зелёный фон' : 'прозрачный фон'}`}
              >
                Как в рендере
              </button>
            </div>
            <span className="mono timecode">
              {fmtTime(time)} / {fmtTime(media?.duration ?? 0)}
            </span>
          </div>
        </section>

        <aside className="side">
          <div className="tabs" role="tablist">
            {(
              [
                ['words', 'Слова'],
                ['style', 'Стиль'],
                ['render', 'Рендер']
              ] as Array<[Tab, string]>
            ).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>

          <div className="tab-body" hidden={tab !== 'style'}>
            <StylePanel style={style} onChange={patchStyle} onReset={() => setStyle(DEFAULT_STYLE)} />
          </div>

          <div className="transcript" hidden={tab !== 'words'}>
            <div className="panel-title">
              <span>Расшифровка</span>
              <span className="title-tools">
                <button className="btn icon small" onClick={() => dispatch({ type: 'undo' })} disabled={hist.past.length === 0} aria-label="Отменить" title="Отменить (Ctrl+Z)">
                  <Icon d={ICON_UNDO} />
                </button>
                <button className="btn icon small" onClick={() => dispatch({ type: 'redo' })} disabled={hist.future.length === 0} aria-label="Повторить" title="Повторить (Ctrl+Shift+Z)">
                  <Icon d={ICON_REDO} />
                </button>
                <span className="mono dim">
                  {words.length} {plural(words.length, 'слово', 'слова', 'слов')}
                </span>
              </span>
            </div>
            <div className="word-list" role="list">
              {words.length === 0 && (
                <p className="empty">{media ? 'Нажми «Распознать», слова появятся здесь' : 'Пока пусто'}</p>
              )}
              {words.map((w, i) => (
                <button
                  key={w.id}
                  ref={(el) => {
                    rowRefs.current[i] = el
                  }}
                  role="listitem"
                  className={`word-row${i === shownIdx ? ' active' : ''}${i === sel ? ' selected' : ''}`}
                  onClick={() => {
                    setSelected(i)
                    seek(w.start)
                  }}
                >
                  <span className="mono dim">{fmtTime(w.start)}</span>
                  <span>{w.text}</span>
                </button>
              ))}
            </div>
            <WordEditor
              word={sel >= 0 ? words[sel] : null}
              canMerge={sel >= 0 && sel < words.length - 1}
              onText={(text) => applyEdit(E.setText(rawWords, sel, text))}
              onTime={(patch, key) => editTime(sel, patch, key)}
              onNudge={(which, dir) => nudge(sel, which, dir)}
              onMerge={() => applyEdit(E.mergeWithNext(rawWords, sel))}
              onDelete={() => applyEdit(E.deleteWord(rawWords, sel))}
              onPlay={() => playWord(sel)}
            />
          </div>

          <div className="tab-body" hidden={tab !== 'render'}>
          <RenderPanel
            media={media}
            settings={rs}
            onSettingsChange={patchRender}
            words={words}
            style={style}
            shiftMs={shiftMs}
            onShiftChange={setShiftMs}
            progress={progress}
            otherBusy={busy !== null && busy !== 'render'}
            onBusyChange={setRenderBusy}
            onError={setError}
          />
          </div>
        </aside>
      </main>

      <footer className={`statusbar${error ? ' error' : ''}`}>
        <span>{statusText}</span>
        {media && <span className="mono dim">{fmtTime(media.duration)}</span>}
      </footer>
    </div>
  )
}
