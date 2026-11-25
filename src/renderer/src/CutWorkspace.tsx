/**
 * Режим «Нарезка»: длинное видео, рамки клипов на таймлайне, поиск моментов ИИ и рендер папкой.
 * Субтитры в предпросмотре рисует тот же код, что и в рендере (caption.ts).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fromCandidates, makeClip, MIN_CLIP, type CutClip, type Framing } from '../../shared/cut'
import { fontFamilyOf } from '../../shared/fonts'
import { buildPhrases, captionAt, type SubtitleStyle } from '../../shared/timeline'
import type { AiProvider, AiSettings, CutRenderResult, CutSubtitles, H264Quality, MediaInfo, ProgressEvent, Word } from '../../shared/types'
import { createCaptionView, setupStage, type CaptionView } from './caption'
import { fmtTime, plural } from './format'
import StylePanel from './StylePanel'
import Timeline, { type Peaks } from './Timeline'

type Tab = 'clips' | 'style' | 'render'

interface CutSettings {
  size: string
  fps: string
  quality: H264Quality
  subtitles: CutSubtitles
  writeText: boolean
  minDur: number
  maxDur: number
  count: number
}

const CUT_KEY = 'cut-settings-v1'
const CUT_DEFAULTS: CutSettings = {
  size: '1080x1920',
  fps: 'source',
  quality: 'medium',
  subtitles: 'burn',
  writeText: true,
  minDur: 30,
  maxDur: 60,
  count: 10
}

function loadCut(): CutSettings {
  try {
    const raw = localStorage.getItem(CUT_KEY)
    if (raw) return { ...CUT_DEFAULTS, ...(JSON.parse(raw) as Partial<CutSettings>) }
  } catch {
    /* без localStorage — умолчания */
  }
  return CUT_DEFAULTS
}

const SIZES = [
  { id: '1080x1920', label: '1080×1920 · 9:16' },
  { id: '720x1280', label: '720×1280 · 9:16, быстрее' },
  { id: '1080x1350', label: '1080×1350 · 4:5' },
  { id: '1080x1080', label: '1080×1080 · 1:1' }
]
const PROVIDERS: Array<{ id: AiProvider; label: string }> = [
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'groq', label: 'Groq (бесплатный)' },
  { id: 'custom', label: 'Свой (OpenAI-совместимый)' }
]

const fmtMB = (b: number): string => `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} МБ`
const cleanErr = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

interface Props {
  active: boolean
  media: MediaInfo | null
  playPath: string | null
  /** слова без сдвига — для ИИ (времена исходника) */
  rawWords: Word[]
  /** слова со сдвигом — для субтитров */
  words: Word[]
  style: SubtitleStyle
  fontTick: number
  onStyle(patch: Partial<SubtitleStyle>): void
  onStyleReset(): void
  clips: CutClip[]
  canUndo: boolean
  canRedo: boolean
  onUndo(): void
  onRedo(): void
  onClips(next: CutClip[], key?: string): void
  busy: string | null
  progress: ProgressEvent | null
  onBusy(v: 'analyze' | 'render' | null): void
  onError(msg: string | null): void
  onNotice(msg: string | null): void
}

export default function CutWorkspace(p: Props): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('clips')
  const [cs, setCs] = useState<CutSettings>(loadCut)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [peaks, setPeaks] = useState<Peaks | null>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [markIn, setMarkIn] = useState<number | null>(null)
  const [ai, setAi] = useState<AiSettings | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiKey, setAiKey] = useState('')
  const [aiMsg, setAiMsg] = useState<string | null>(null)
  const [result, setResult] = useState<CutRenderResult | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const capRef = useRef<HTMLDivElement>(null)
  const bgRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef<CaptionView | null>(null)
  const stopAtRef = useRef<number | null>(null)

  const media = p.media
  const duration = media?.duration ?? 0
  const clips = p.clips
  const selected = clips.find((c) => c.id === selectedId) ?? null
  const focus = clips.find((c) => c.id === focusId) ?? null
  const shown = selected ?? clips.find((c) => time >= c.start && time < c.end) ?? null
  const framing: Framing = shown?.framing ?? 'crop'
  const offsetX = shown?.offsetX ?? 0.5
  const [outW, outH] = cs.size.split('x').map(Number)

  useEffect(() => {
    try {
      localStorage.setItem(CUT_KEY, JSON.stringify(cs))
    } catch {
      /* не критично */
    }
  }, [cs])
  const patchCs = (patch: Partial<CutSettings>): void => setCs((prev) => ({ ...prev, ...patch }))

  // Новый файл: сброс выбора и волна звука.
  useEffect(() => {
    setSelectedId(null)
    setFocusId(null)
    setMarkIn(null)
    setTime(0)
    setResult(null)
    setPeaks(null)
    if (!media?.hasAudio) return
    let alive = true
    window.api.peaks(media.path).then(
      (r) => alive && setPeaks(r),
      (e: unknown) => alive && p.onError(cleanErr(e))
    )
    return () => {
      alive = false
    }
  }, [media?.path]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void window.api.getAi().then(setAi, () => {})
  }, [])

  // Ушли в другой режим — останавливаем видео.
  useEffect(() => {
    if (!p.active) videoRef.current?.pause()
  }, [p.active])

  // Удалённая (например, отменой) рамка не должна оставаться выбранной.
  useEffect(() => {
    if (selectedId && !clips.some((c) => c.id === selectedId)) setSelectedId(null)
    if (focusId && !clips.some((c) => c.id === focusId)) setFocusId(null)
  }, [clips, selectedId, focusId])

  // --- сцена ---
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  const aspect = outW / outH
  const frameW = Math.max(0, Math.min(box.w - 16, (box.h - 16) * aspect))
  const frameH = frameW / aspect

  useLayoutEffect(() => {
    if (!capRef.current) return
    setupStage(capRef.current)
    viewRef.current = createCaptionView(capRef.current)
    return () => {
      viewRef.current = null
    }
  }, [])
  const phrases = useMemo(() => buildPhrases(p.words, p.style), [p.words, p.style.mode, p.style.maxWords, p.style.pauseBreak]) // eslint-disable-line react-hooks/exhaustive-deps
  // Размер кадра и видимость тоже в зависимостях: подгонка длинных слов меряет ширину,
  // а в скрытом режиме она нулевая — после показа надо перемерить.
  useLayoutEffect(() => {
    viewRef.current?.configure(p.words, phrases, p.style, fontFamilyOf(p.style))
  }, [p.words, phrases, p.style, p.fontTick, frameW, frameH, p.active])
  const caption = useMemo(() => captionAt(p.words, phrases, p.style, time), [p.words, phrases, p.style, time])
  useLayoutEffect(() => {
    viewRef.current?.render(caption)
  }, [caption])

  // Размытый фон для «видео целиком»: перерисовываем уменьшенную копию кадра.
  useEffect(() => {
    if (framing !== 'fit-blur' || !p.active) return
    let raf = 0
    const draw = (): void => {
      const v = videoRef.current
      const cv = bgRef.current
      if (v && cv && v.videoWidth > 0) {
        const ctx = cv.getContext('2d')
        if (ctx) {
          const s = Math.max(cv.width / v.videoWidth, cv.height / v.videoHeight)
          const w = v.videoWidth * s
          const h = v.videoHeight * s
          ctx.filter = 'blur(6px)'
          ctx.drawImage(v, (cv.width - w) / 2, (cv.height - h) / 2, w, h)
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [framing, p.active])

  // Плавное время при воспроизведении + остановка в конце клипа.
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

  const seek = useCallback((t: number) => {
    const v = videoRef.current
    stopAtRef.current = null
    if (v) v.currentTime = t
    setTime(t)
  }, [])

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v || !media) return
    if (!v.paused) {
      v.pause()
      return
    }
    // внутри открытого клипа играем только его
    stopAtRef.current = focus && v.currentTime < focus.end ? focus.end : null
    void v.play()
  }, [media, focus])

  const playClip = (c: CutClip): void => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = c.start
    setTime(c.start)
    stopAtRef.current = c.end
    void v.play()
  }

  // --- правки рамок ---
  const replace = useCallback(
    (clip: CutClip, key?: string) => p.onClips(p.clips.map((c) => (c.id === clip.id ? clip : c)), key),
    [p]
  )
  const patchClip = (id: string, patch: Partial<CutClip>, key?: string): void => {
    const c = clips.find((x) => x.id === id)
    if (c) replace({ ...c, ...patch }, key)
  }
  const addClip = useCallback((c: CutClip) => p.onClips([...p.clips, c].sort((a, b) => a.start - b.start)), [p])
  const removeClip = (id: string): void => {
    p.onClips(clips.filter((c) => c.id !== id))
    if (selectedId === id) setSelectedId(null)
    if (focusId === id) setFocusId(null)
  }
  const openClip = useCallback(
    (id: string) => {
      const c = p.clips.find((x) => x.id === id)
      if (!c) return
      setSelectedId(id)
      setFocusId(id)
      seek(c.start)
    },
    [p.clips, seek]
  )

  const onTimelineChange = useCallback((c: CutClip, key: string) => replace(c, key), [replace])

  // --- клавиши (только в этом режиме) ---
  useEffect(() => {
    if (!p.active) return
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      const typing = !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes((el as HTMLInputElement).type)) || el.tagName === 'SELECT')
      if (typing) return
      const ctrl = e.ctrlKey || e.metaKey
      if (e.code === 'Space' && el?.tagName !== 'BUTTON') {
        e.preventDefault()
        togglePlay()
      } else if (ctrl && e.code === 'KeyZ') {
        e.preventDefault()
        if (e.shiftKey) p.onRedo()
        else p.onUndo()
      } else if (ctrl && e.code === 'KeyY') {
        e.preventDefault()
        p.onRedo()
      } else if ((e.code === 'Delete' || e.code === 'Backspace') && selectedId) {
        e.preventDefault()
        removeClip(selectedId)
      } else if (e.code === 'KeyI' && !ctrl) {
        setMarkIn(time)
        p.onNotice(`Начало рамки: ${fmtTime(time)}. Нажми O в месте конца`)
      } else if (e.code === 'KeyO' && !ctrl && markIn !== null) {
        const [a, b] = markIn < time ? [markIn, time] : [time, markIn]
        if (b - a >= MIN_CLIP) {
          const c = makeClip(a, Math.min(b, duration))
          addClip(c)
          setSelectedId(c.id)
          p.onNotice(null)
        }
        setMarkIn(null)
      } else if (e.code === 'Escape') {
        if (focusId) setFocusId(null)
        else setSelectedId(null)
      } else if (e.code === 'Enter' && selectedId) {
        openClip(selectedId)
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault()
        const d = (e.shiftKey ? 5 : 1) * (e.code === 'ArrowLeft' ? -1 : 1)
        seek(Math.max(0, Math.min(duration, time + d)))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // --- ИИ ---
  const analyzing = p.busy === 'analyze'
  const rendering = p.busy === 'render'
  const aiClipsCount = clips.filter((c) => c.score !== null).length

  const analyze = async (): Promise<void> => {
    if (!media || p.rawWords.length === 0) return
    if (aiClipsCount > 0 && !window.confirm(`Заменить ${aiClipsCount} ${plural(aiClipsCount, 'рамку', 'рамки', 'рамок')} ИИ новыми? Твои рамки останутся`)) return
    p.onError(null)
    p.onNotice(null)
    p.onBusy('analyze')
    try {
      const r = await window.api.analyzeClips({
        words: p.rawWords,
        minDur: cs.minDur,
        maxDur: cs.maxDur,
        count: cs.count,
        mediaDuration: duration
      })
      const manual = clips.filter((c) => c.score === null)
      p.onClips([...manual, ...fromCandidates(r.clips)].sort((a, b) => a.start - b.start))
      setSelectedId(null)
      setFocusId(null)
      const tok = r.usage.prompt + r.usage.completion
      p.onNotice(
        `ИИ нашёл ${r.clips.length} ${plural(r.clips.length, 'момент', 'момента', 'моментов')} за ${r.seconds.toFixed(0)} с` +
          (tok ? `, ${Math.round(tok / 1000)} тыс. токенов` : '') +
          (r.warnings.length ? `. ${r.warnings.join('; ')}` : '')
      )
    } catch (e) {
      const msg = cleanErr(e)
      if (msg !== 'Отменено') p.onError(msg)
    } finally {
      p.onBusy(null)
    }
  }

  const saveAi = async (patch: Parameters<typeof window.api.setAi>[0]): Promise<void> => {
    setAiMsg(null)
    try {
      setAi(await window.api.setAi(patch))
    } catch (e) {
      setAiMsg(cleanErr(e))
    }
  }

  const testAi = async (): Promise<void> => {
    setAiMsg('Проверяю…')
    try {
      setAiMsg(await window.api.testAi())
    } catch (e) {
      setAiMsg(cleanErr(e))
    }
  }

  // --- рендер ---
  const enabled = clips.filter((c) => c.enabled)
  const render = async (): Promise<void> => {
    if (!media || enabled.length === 0) return
    p.onError(null)
    setResult(null)
    p.onBusy('render')
    try {
      const fps = cs.fps === 'source' ? (media.fps && media.fps >= 1 ? media.fps : 30) : Number(cs.fps)
      const r = await window.api.renderClips({
        sourcePath: media.path,
        clips: enabled,
        words: p.words,
        style: p.style,
        width: outW,
        height: outH,
        fps,
        quality: cs.quality,
        subtitles: cs.subtitles,
        writeText: cs.writeText,
        sourceName: media.name.replace(/\.[^.]+$/, '')
      })
      if (r) setResult(r)
    } catch (e) {
      const msg = cleanErr(e)
      if (msg !== 'Отменено') p.onError(msg)
    } finally {
      p.onBusy(null)
    }
  }

  const otherBusy = p.busy !== null

  return (
    <main className="workspace cut" hidden={!p.active}>
      <section className="stage-col">
        <div className="stage cut-stage" ref={stageRef}>
          {!media && <p className="stage-empty">Открой видео, чтобы нарезать его на клипы</p>}
          <div className="cut-frame" style={{ width: frameW, height: frameH }} hidden={!media}>
            {framing === 'fit-blur' && <canvas ref={bgRef} className="cut-bg" width={Math.max(2, Math.round(frameW / 3))} height={Math.max(2, Math.round(frameH / 3))} />}
            {media && (
              <video
                ref={videoRef}
                src={p.playPath ? window.api.mediaUrl(p.playPath) : undefined}
                style={{ objectFit: framing === 'crop' ? 'cover' : 'contain', objectPosition: `${offsetX * 100}% 50%` }}
                onPlay={() => setPlaying(true)}
                onPause={() => {
                  setPlaying(false)
                  if (videoRef.current) setTime(videoRef.current.currentTime)
                }}
                onSeeked={() => videoRef.current && setTime(videoRef.current.currentTime)}
                onTimeUpdate={() => {
                  const v = videoRef.current
                  if (v && stopAtRef.current !== null && v.currentTime >= stopAtRef.current) {
                    stopAtRef.current = null
                    v.pause()
                  }
                }}
                onEnded={() => setPlaying(false)}
              />
            )}
            <div className="cut-captions" ref={capRef} />
          </div>
        </div>

        <div className="transport">
          <button className="btn icon" onClick={togglePlay} disabled={!media} aria-label={playing ? 'Пауза' : 'Играть'} title="Пробел">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
              <path d={playing ? 'M8 5v14M16 5v14' : 'M8 5l11 7-11 7z'} />
            </svg>
          </button>
          <nav className="crumbs" aria-label="Где мы">
            {focus ? (
              <>
                <button className="link" onClick={() => setFocusId(null)} title="Esc">
                  Источник
                </button>
                <span className="dim">›</span>
                <span>Клип {clips.indexOf(focus) + 1}: {focus.title || 'без названия'}</span>
              </>
            ) : (
              <span className="dim">
                {markIn !== null ? `Начало рамки ${fmtTime(markIn)} — нажми O` : 'Протяни по дорожке рамок, чтобы создать клип · I / O — начало и конец'}
              </span>
            )}
          </nav>
          <span className="mono timecode">
            {fmtTime(time)} / {fmtTime(duration)}
          </span>
        </div>

        {media && (
          <Timeline
            duration={duration}
            time={time}
            playing={playing}
            clips={clips}
            selectedId={selectedId}
            focusId={focusId}
            words={p.words}
            peaks={peaks}
            onSeek={seek}
            onSelect={setSelectedId}
            onOpen={openClip}
            onChange={onTimelineChange}
            onCreate={addClip}
          />
        )}
      </section>

      <aside className="side">
        <div className="tabs" role="tablist">
          {(
            [
              ['clips', 'Клипы'],
              ['style', 'Стиль'],
              ['render', 'Рендер']
            ] as Array<[Tab, string]>
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>

        <div className="tab-body cut-panel" hidden={tab !== 'clips'}>
          <div className="form">
            <div className="row">
              <span>Длина, с</span>
              <span className="pair">
                <input type="number" min={5} max={600} value={cs.minDur} onChange={(e) => patchCs({ minDur: Number(e.target.value) })} aria-label="Минимальная длина" />
                <span className="dim">–</span>
                <input type="number" min={6} max={900} value={cs.maxDur} onChange={(e) => patchCs({ maxDur: Number(e.target.value) })} aria-label="Максимальная длина" />
              </span>
            </div>
            <div className="row">
              <span>Клипов, до</span>
              <input type="number" min={1} max={50} value={cs.count} onChange={(e) => patchCs({ count: Number(e.target.value) })} />
            </div>
          </div>
          <div className="render-actions">
            {analyzing ? (
              <button className="btn" onClick={() => void window.api.cancelAnalyze()}>
                Остановить
              </button>
            ) : (
              <button
                className="btn primary"
                onClick={() => void analyze()}
                disabled={!media || p.rawWords.length === 0 || otherBusy || !ai?.hasKey}
                title={!ai?.hasKey ? 'Сначала задай ключ в настройках ИИ' : p.rawWords.length === 0 ? 'Сначала распознай речь' : undefined}
              >
                Найти моменты
              </button>
            )}
            <button className="link" onClick={() => setAiOpen((v) => !v)}>
              {ai ? `${PROVIDERS.find((x) => x.id === ai.provider)?.label ?? ai.provider} · ${ai.model}` : 'ИИ'}
              {ai && !ai.hasKey ? ' · нет ключа' : ''}
            </button>
          </div>
          {media && p.rawWords.length === 0 && <p className="hint">Чтобы ИИ искал моменты, сначала нажми «Распознать» вверху.</p>}

          {aiOpen && ai && (
            <fieldset className="group ai-settings">
              <legend>Настройки ИИ</legend>
              <div className="form">
                <div className="row">
                  <span>Провайдер</span>
                  <select value={ai.provider} onChange={(e) => void saveAi({ provider: e.target.value as AiProvider })}>
                    {PROVIDERS.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="row">
                  <span>Модель</span>
                  <input type="text" defaultValue={ai.model} key={`m-${ai.provider}-${ai.model}`} onBlur={(e) => e.target.value !== ai.model && void saveAi({ model: e.target.value })} />
                </div>
                {ai.provider === 'custom' && (
                  <div className="row">
                    <span>Адрес</span>
                    <input type="text" defaultValue={ai.baseUrl} key={`u-${ai.baseUrl}`} onBlur={(e) => e.target.value !== ai.baseUrl && void saveAi({ baseUrl: e.target.value })} />
                  </div>
                )}
                <div className="row">
                  <span>Ключ</span>
                  <input
                    type="password"
                    value={aiKey}
                    placeholder={ai.hasKey ? 'задан — введи новый, чтобы заменить' : 'вставь ключ API'}
                    onChange={(e) => setAiKey(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="row">
                  <span title="Бесплатный Groq — 8000. Пусто — лимита нет, весь подкаст одним запросом">Токенов/мин</span>
                  <input
                    type="number"
                    defaultValue={ai.tpm ?? ''}
                    key={`t-${ai.provider}-${ai.tpm}`}
                    placeholder="без лимита"
                    onBlur={(e) => {
                      const v = e.target.value.trim() === '' ? null : Number(e.target.value)
                      if (v !== ai.tpm) void saveAi({ tpm: v })
                    }}
                  />
                </div>
                <div className="row">
                  <span>Доп. параметры</span>
                  <input type="text" className="mono" defaultValue={ai.extra} key={`x-${ai.provider}-${ai.extra}`} onBlur={(e) => e.target.value !== ai.extra && void saveAi({ extra: e.target.value })} />
                </div>
              </div>
              <div className="render-actions">
                <button
                  className="btn"
                  disabled={!aiKey.trim()}
                  onClick={() => {
                    void saveAi({ key: aiKey }).then(() => setAiKey(''))
                  }}
                >
                  Сохранить ключ
                </button>
                <button className="btn" onClick={() => void testAi()} disabled={!ai.hasKey}>
                  Проверить
                </button>
              </div>
              {ai.weakKeyStorage && <p className="hint">В системе нет хранилища ключей: ключ сохранится почти открытым текстом в профиле приложения.</p>}
              {aiMsg && <p className="hint">{aiMsg}</p>}
            </fieldset>
          )}

          <div className="panel-title">
            <span>Клипы</span>
            <span className="title-tools">
              <button className="btn icon small" onClick={p.onUndo} disabled={!p.canUndo} aria-label="Отменить" title="Отменить (Ctrl+Z)">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
                  <path d="M8 6L3 11l5 5M4 11h10a5 5 0 010 10h-3" />
                </svg>
              </button>
              <button className="btn icon small" onClick={p.onRedo} disabled={!p.canRedo} aria-label="Повторить" title="Повторить (Ctrl+Shift+Z)">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
                  <path d="M16 6l5 5-5 5M20 11H10a5 5 0 000 10h3" />
                </svg>
              </button>
              <span className="mono dim">
                {enabled.length}/{clips.length}
              </span>
            </span>
          </div>
          <ol className="clip-list">
            {clips.length === 0 && <li className="empty">Рамок пока нет: «Найти моменты» или протяни мышью по дорожке рамок</li>}
            {clips.map((c, i) => (
              <li
                key={c.id}
                className={`clip-row${c.id === selectedId ? ' sel' : ''}${c.enabled ? '' : ' off'}`}
                onClick={() => {
                  setSelectedId(c.id)
                  seek(c.start)
                }}
                onDoubleClick={() => openClip(c.id)}
              >
                <input
                  type="checkbox"
                  checked={c.enabled}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => patchClip(c.id, { enabled: e.target.checked })}
                  aria-label="В рендер"
                  title="В рендер"
                />
                <span className="mono dim">{i + 1}</span>
                <span className="clip-title">{c.title || 'Без названия'}</span>
                <span className="mono dim">
                  {fmtTime(c.start).replace(/\.\d+$/, '')} · {(c.end - c.start).toFixed(0)} с{c.score !== null ? ` · ${c.score}/10` : ''}
                </span>
              </li>
            ))}
          </ol>

          {selected && (
            <fieldset className="group clip-card">
              <legend>Клип {clips.indexOf(selected) + 1}</legend>
              <input
                type="text"
                className="clip-name"
                value={selected.title}
                placeholder="Заголовок"
                onChange={(e) => patchClip(selected.id, { title: e.target.value }, `t-${selected.id}`)}
              />
              <textarea
                rows={2}
                value={selected.description}
                placeholder="Описание под видео"
                onChange={(e) => patchClip(selected.id, { description: e.target.value }, `d-${selected.id}`)}
              />
              <input
                type="text"
                value={selected.hashtags.join(' ')}
                placeholder="#хэштеги через пробел"
                onChange={(e) => patchClip(selected.id, { hashtags: e.target.value.split(/\s+/).filter(Boolean) }, `h-${selected.id}`)}
              />
              {selected.reason && <p className="hint">ИИ: {selected.reason}</p>}
              {selected.approx && <p className="hint warn">Границы приблизительные: ИИ не нашёл точные слова. Проверь начало и конец.</p>}
              <div className="row">
                <span>Кадр</span>
                <div className="segmented small" role="radiogroup">
                  {(
                    [
                      ['crop', 'Обрезка'],
                      ['fit-blur', 'Целиком на блюре']
                    ] as Array<[Framing, string]>
                  ).map(([id, label]) => (
                    <button key={id} role="radio" aria-checked={selected.framing === id} className={selected.framing === id ? 'on' : ''} onClick={() => patchClip(selected.id, { framing: id })}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {selected.framing === 'crop' && (
                <div className="row">
                  <span>Сдвиг кадра</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={selected.offsetX}
                    onChange={(e) => patchClip(selected.id, { offsetX: Number(e.target.value) }, `o-${selected.id}`)}
                  />
                </div>
              )}
              <div className="render-actions">
                <button className="btn" onClick={() => playClip(selected)}>
                  ▶ Прослушать
                </button>
                <button className="btn" onClick={() => openClip(selected.id)} disabled={focusId === selected.id} title="Enter">
                  Открыть
                </button>
                <button className="btn" onClick={() => removeClip(selected.id)} title="Delete">
                  Удалить
                </button>
              </div>
            </fieldset>
          )}
        </div>

        <div className="tab-body" hidden={tab !== 'style'}>
          <StylePanel style={p.style} onChange={p.onStyle} onReset={p.onStyleReset} />
        </div>

        <div className="tab-body cut-panel" hidden={tab !== 'render'}>
          <div className="form">
            <div className="row">
              <span>Размер</span>
              <select value={cs.size} onChange={(e) => patchCs({ size: e.target.value })}>
                {SIZES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="row">
              <span>FPS</span>
              <select value={cs.fps} onChange={(e) => patchCs({ fps: e.target.value })}>
                {['source', '25', '30', '60'].map((f) => (
                  <option key={f} value={f}>
                    {f === 'source' ? `Как у исходника${media?.fps ? ` (${media.fps.toFixed(0)})` : ''}` : f}
                  </option>
                ))}
              </select>
            </div>
            <div className="row">
              <span>Качество</span>
              <select value={cs.quality} onChange={(e) => patchCs({ quality: e.target.value as H264Quality })}>
                <option value="high">Высокое</option>
                <option value="medium">Среднее</option>
                <option value="small">Малый размер</option>
              </select>
            </div>
            <div className="row">
              <span>Субтитры</span>
              <select value={cs.subtitles} onChange={(e) => patchCs({ subtitles: e.target.value as CutSubtitles })}>
                <option value="burn">Вшить в видео</option>
                <option value="overlay">Отдельный файл с альфой</option>
                <option value="none">Без субтитров</option>
              </select>
            </div>
            <label className="check">
              <input type="checkbox" checked={cs.writeText} onChange={(e) => patchCs({ writeText: e.target.checked })} />
              <span>Текст рядом: заголовок, описание, хэштеги</span>
            </label>
          </div>
          {p.words.length === 0 && cs.subtitles !== 'none' && <p className="hint">Слов нет — клипы будут без субтитров.</p>}
          <div className="render-actions">
            {rendering ? (
              <button className="btn" onClick={() => void window.api.cancelRender()}>
                Отменить
              </button>
            ) : (
              <button className="btn primary" onClick={() => void render()} disabled={!media || enabled.length === 0 || otherBusy}>
                Рендер {enabled.length} {plural(enabled.length, 'клипа', 'клипов', 'клипов')}
              </button>
            )}
          </div>
          {rendering && p.progress?.stage === 'render' && <p className="render-status mono">{p.progress.label}</p>}
          {result && (
            <div className="render-result">
              <span>
                Готово: {result.clips} {plural(result.clips, 'клип', 'клипа', 'клипов')} за {result.seconds.toFixed(0)} с, {fmtMB(result.bytes)}
              </span>
              <button className="link" onClick={() => void window.api.revealFile(result.files[0] ?? result.dir)}>
                Открыть папку
              </button>
            </div>
          )}
        </div>
      </aside>
    </main>
  )
}
