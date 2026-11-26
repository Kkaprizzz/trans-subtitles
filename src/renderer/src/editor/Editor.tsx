/**
 * Монтажный стол: верхняя панель, медиа слева, плеер, инспектор справа, таймлайн с дорожками внизу.
 * Проект — в истории с отменой/повтором, автосохранение через 0.6 с после правки.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { fmtTime } from '../format'
import { addEffect, copyItems, duplicateItems, hasFrameCrop, insertFreeze, insertText, joinSelected, pasteItems, patchPlate, setPropAt, type ClipEntry } from '../../../shared/mix'
import { hasKeys } from '../../../shared/anim'
import type { Plate } from '../../../shared/plate'
import type { EffectType } from '../../../shared/effects'
import { fromCandidates, addClip, deleteClip, patchClip, placement, putClips } from '../../../shared/cut'
import { emptyHist, histReducer, type Hist, type HistAction } from '../../../shared/history'
import {
  addMarker,
  addMedia,
  addSubtitles,
  activeAt,
  addTrackOf,
  applyRecognized,
  deleteItems,
  deleteTlWord,
  editTlText,
  insertMedia,
  itemEnd,
  itemsOn,
  itemTrackKind,
  mediaOf,
  mergeTlWord,
  neededRanges,
  newProject,
  projectDuration,
  removeMedia,
  setTlWordTiming,
  sourceTime,
  splitAt,
  subsTargets,
  subtitleLayers,
  timelineWordRefs,
  videoTracks,
  type MediaRef,
  type Project,
  type TlWord
} from '../../../shared/project'
import { fontFamilyOf } from '../../../shared/fonts'
import { DEFAULT_STYLE, normalizeStyle, type SubtitleStyle } from '../../../shared/timeline'
import type { MediaInfo, ProgressEvent } from '../../../shared/types'
import { loadCustomFont } from '../customFont'
import ClipsDialog, { type ClipsParams } from './ClipsDialog'
import ExportDialog from './ExportDialog'
import Inspector from './Inspector'
import MediaPanel from './MediaPanel'
import Player, { type PlateStart } from './Player'
import type { Frame } from '../../../shared/frame'
import Transport, { useMasterVolume } from './Transport'
import { loadModelId, type SettingsSection } from './SettingsDialog'
import SubsPanel, { type SubsTab } from './SubsPanel'
import Tracks, { type Peaks } from './Tracks'

/** Команды редактора для верхнего меню (App вызывает их по пунктам меню). */
export interface EditorCommands {
  save(): Promise<void>
  saveToFile(): Promise<void>
  addMedia(): void
  exportVideo(): void
  close(): Promise<void>
  undo(): void
  redo(): void
  split(): void
  del(): void
  /** удалить и закрыть дыру (Shift+Delete) */
  delRipple(): void
  /** соединить выделенные куски обратно (Ctrl+J) */
  join(): void
  /** прервать идущее распознавание или поиск моментов */
  cancelWork(): void
  /** разрезать по курсору и вставить стоп-кадр (Shift+S) */
  freeze(): void
  /** поставить надпись на курсор */
  addText(): void
  copy(): void
  cut(): void
  paste(): void
  duplicate(): void
  /** поставить метку на курсоре */
  addMarker(): void
  selectAll(): void
  deselect(): void
  zoomIn(): void
  zoomOut(): void
  fit(): void
  home(): void
  end(): void
}

/** Что меню и строка заголовка должны знать о редакторе. */
export interface EditorState {
  name: string
  canUndo: boolean
  canRedo: boolean
  hasSel: boolean
  hasItems: boolean
  /** в буфере есть куски для вставки */
  canPaste: boolean
  duration: number
  status: string | null
  statusErr: boolean
  /** идёт работа, которую можно прервать (распознавание, поиск моментов) */
  cancellable: boolean
}

interface Props {
  projectId: string
  onClose(): void
  onError(msg: string | null): void
  commands: React.MutableRefObject<EditorCommands | null>
  onState(s: EditorState): void
  /** окно поверх (меню, настройки) — горячие клавиши редактора молчат */
  blocked: boolean
  /** открыть настройки на нужном разделе (например, скачать модель) */
  onOpenSettings(section: SettingsSection): void
}

/** Размеры панелей (тянутся мышью за границы), запоминаются между запусками. */
interface Layout {
  mw: number
  iw: number
  th: number
}
const LAYOUT_KEY = 'layout-v1'
const LAYOUT_DEFAULT: Layout = { mw: 260, iw: 300, th: 300 }
function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (raw) return { ...LAYOUT_DEFAULT, ...(JSON.parse(raw) as Partial<Layout>) }
  } catch {
    /* умолчания */
  }
  return LAYOUT_DEFAULT
}
/** Пределы: плеру всегда остаётся не меньше 420px в ширину и 200px в высоту. */
function clampLayout(l: Layout): Layout {
  const W = window.innerWidth
  const H = window.innerHeight
  const mw = Math.min(Math.max(260, l.mw), Math.max(260, Math.min(560, W - 420 - Math.max(220, l.iw))))
  const iw = Math.min(Math.max(220, l.iw), Math.max(220, Math.min(600, W - 420 - mw)))
  const th = Math.min(Math.max(150, l.th), Math.max(150, H - 44 - 200))
  return { mw: Math.round(mw), iw: Math.round(iw), th: Math.round(th) }
}

const reducer = histReducer as (h: Hist<Project>, a: HistAction<Project>) => Hist<Project>
const clean = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const toRef = (m: MediaInfo): Omit<MediaRef, 'id'> => ({
  path: m.path,
  name: m.name,
  duration: m.duration,
  hasVideo: m.hasVideo,
  hasAudio: m.hasAudio,
  width: m.width,
  height: m.height,
  fps: m.fps,
  videoCodec: m.videoCodec,
  needsPreview: m.needsPreview,
  hasAlpha: m.hasAlpha
})

function Icon({ d }: { d: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}
const I = {
  back: 'M15 5l-7 7 7 7',
  undo: 'M8 6L3 11l5 5M4 11h10a5 5 0 010 10h-3',
  redo: 'M16 6l5 5-5 5M20 11H10a5 5 0 000 10h3',
  play: 'M8 5l11 7-11 7z',
  pause: 'M8 5v14M16 5v14',
  split: 'M12 3v18M7 8l-3 4 3 4M17 8l3 4-3 4',
  del: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  gear: 'M12 9a3 3 0 100 6 3 3 0 000-6zM19 12l2-1-1-3-2.2.3-1.3-1.3L17 4.8 14 4l-1 2h-2l-1-2-3 .8.5 2.2-1.3 1.3L5 8l-1 3 2 1v0l-2 1 1 3 2.2-.3 1.3 1.3L7 19.2l3 .8 1-2h2l1 2 3-.8-.5-2.2 1.3-1.3 2.2.3 1-3z',
  out: 'M12 15V3M7 8l5-5 5 5M5 14v6h14v-6',
  freeze: 'M4 5h16v14H4zM10 9v6M14 9v6',
  text: 'M5 6h14M12 6v13M9 19h6'
}

export default function Editor(p: Props): React.JSX.Element {
  const [hist, dispatch] = useReducer(reducer, emptyHist<Project>(newProject('…')))
  const project = hist.present
  const [loaded, setLoaded] = useState(false)
  const [missing, setMissing] = useState<Set<string>>(new Set())
  const [time, setTime] = useState(0)
  const timeRef = useRef(0)
  timeRef.current = time
  const getTime = useCallback(() => timeRef.current, [])
  const [playing, setPlaying] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [previewing, setPreviewing] = useState<Record<string, number>>({})
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [peaks, setPeaks] = useState<Record<string, Peaks>>({})
  const [exportOpen, setExportOpen] = useState(false)
  const [savedNote, setSavedNote] = useState<string | null>(null)
  // субтитры: выбранная дорожка, вкладка, слово, окошко правки в кадре, идёт ли распознавание
  const [subsSel, setSubsSel] = useState(false)
  const [subsTab, setSubsTab] = useState<SubsTab>('words')
  const [wordSel, setWordSel] = useState(-1)
  const [editWord, setEditWord] = useState<TlWord | null>(null)
  const [selectedTrack, setSelectedTrack] = useState<string | null>(null)
  const [markerPopId, setMarkerPopId] = useState<string | null>(null)
  const [asrBusy, setAsrBusy] = useState(false)
  // «Нарезка»: выбранная рамка, фокус на рамке, окошко и ход работы
  const [selectedClip, setSelectedClip] = useState<string | null>(null)
  const [leftTab, setLeftTab] = useState<'media' | 'fx' | 'text'>('media')
  const [focusClipId, setFocusClipId] = useState<string | null>(null)
  const [clipsOpen, setClipsOpen] = useState(false)
  const [clipsBusy, setClipsBusy] = useState(false)
  const [clipsError, setClipsError] = useState<string | null>(null)
  // отмена нажата: следующие шаги цепочки (распознавание → ИИ) не начинаются
  const cancelledRef = useRef(false)
  // буфер копирования живёт, пока открыт этот проект
  const clipRef = useRef<ClipEntry[]>([])
  const [clipCount, setClipCount] = useState(0)
  useEffect(() => {
    clipRef.current = []
    setClipCount(0)
  }, [p.projectId])
  const [fontTick, setFontTick] = useState(0)
  const stopAtRef = useRef<number | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [layout, setLayout] = useState<Layout>(() => clampLayout(loadLayout()))
  const [resizing, setResizing] = useState<keyof Layout | null>(null)
  const resizeRef = useRef<{ which: keyof Layout; x: number; y: number; start: Layout } | null>(null)
  useEffect(() => {
    const h = setTimeout(() => {
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
      } catch {
        /* не критично */
      }
    }, 300)
    return () => clearTimeout(h)
  }, [layout])
  useEffect(() => {
    const onResize = (): void => setLayout((l) => clampLayout(l))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const splitter = (which: keyof Layout, cls: string): React.JSX.Element => (
    <div
      className={`splitter ${which === 'th' ? 'h' : 'v'} ${cls}${resizing === which ? ' drag' : ''}`}
      role="separator"
      aria-orientation={which === 'th' ? 'horizontal' : 'vertical'}
      title="Тяни, чтобы изменить размер · двойной щелчок — как было"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        resizeRef.current = { which, x: e.clientX, y: e.clientY, start: layout }
        setResizing(which)
      }}
      onPointerMove={(e) => {
        const r = resizeRef.current
        if (!r) return
        const dx = e.clientX - r.x
        const dy = e.clientY - r.y
        const next = { ...r.start }
        if (r.which === 'mw') next.mw = r.start.mw + dx
        else if (r.which === 'iw') next.iw = r.start.iw - dx
        else next.th = r.start.th - dy
        setLayout(clampLayout(next))
      }}
      onPointerUp={() => {
        resizeRef.current = null
        setResizing(null)
      }}
      onPointerCancel={() => {
        resizeRef.current = null
        setResizing(null)
      }}
      onDoubleClick={() => setLayout((l) => clampLayout({ ...l, [which]: LAYOUT_DEFAULT[which] }))}
    />
  )
  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState<ProgressEvent | null>(null)
  const [fitTick, setFitTick] = useState(0)
  const [zoomTick, setZoomTick] = useState({ n: 0, factor: 1 })
  const [saveError, setSaveError] = useState<string | null>(null)
  const prepared = useRef(new Set<string>())
  const projectRef = useRef(project)
  projectRef.current = project

  const commit = useCallback((next: Project, key?: string) => dispatch({ type: 'commit', words: next, key, now: Date.now() }), [])
  const duration = projectDuration(project)
  const tlWords = useMemo<TlWord[]>(() => timelineWordRefs(project), [project.items, project.words, project.tracks]) // eslint-disable-line react-hooks/exhaustive-deps
  const layers = useMemo(() => subtitleLayers(project), [project.items, project.words, project.tracks]) // eslint-disable-line react-hooks/exhaustive-deps
  const style = useMemo(() => normalizeStyle(project.style ?? DEFAULT_STYLE), [project.style])
  const clipsPlaced = useMemo(() => project.clips.map((clip) => ({ clip, at: placement(project, clip) })), [project.clips, project.items]) // eslint-disable-line react-hooks/exhaustive-deps
  const focusClip = focusClipId ? project.clips.find((c) => c.id === focusClipId) : undefined
  const focusAt = focusClip ? placement(project, focusClip) : null
  const focusRange = focusAt ? { start: focusAt.start, end: focusAt.end } : null
  const focusRef = useRef(focusRange)
  focusRef.current = focusRange
  const clipView = useMemo(() => (focusClip && focusAt ? { mediaId: focusClip.mediaId, mode: focusClip.framing, offsetX: focusClip.offsetX } : null), [focusClip?.mediaId, focusClip?.framing, focusClip?.offsetX, !!focusAt]) // eslint-disable-line react-hooks/exhaustive-deps
  // у выделенного одного куска картинки (видео, оверлей, стоп-кадр) в превью рамка: тянуть — положение, угол — масштаб
  const frameItemId = useMemo(() => {
    const it = selected.length === 1 && !selectedClip ? project.items.find((i) => i.id === selected[0]) : undefined
    return it && hasFrameCrop(project, it) ? it.id : null
  }, [selected, selectedClip, project]) // eslint-disable-line react-hooks/exhaustive-deps
  // выделенная надпись: в превью её можно таскать
  const plateItemId = useMemo(() => {
    const it = selected.length === 1 && !selectedClip ? project.items.find((i) => i.id === selected[0]) : undefined
    return it?.kind === 'text' ? it.id : null
  }, [selected, selectedClip, project]) // eslint-disable-line react-hooks/exhaustive-deps
  // инспектору время нужно только у куска с ключами (значения полей идут за курсором); иначе не перерисовываем его на каждый кадр
  const inspTime = useMemo(() => {
    const it = selected.length === 1 ? project.items.find((i) => i.id === selected[0]) : undefined
    return it && hasKeys(it.keys) ? time : -1
  }, [selected, project, time]) // eslint-disable-line react-hooks/exhaustive-deps
  const chosenClip = selectedClip ? (project.clips.find((c) => c.id === selectedClip) ?? null) : null
  const selectedWordRef = wordSel >= 0 && tlWords[wordSel] ? { itemId: tlWords[wordSel].itemId, idx: tlWords[wordSel].idx } : null
  // панель слов и стиля: после щелчка по слову или когда выделен кусок субтитров
  const subsSelected = selected.some((id) => project.items.find((i) => i.id === id)?.kind === 'subs')

  // Шрифт грузится лениво: ждём его и перерисовываем подписи (от шрифта зависит и перенос строк).
  useEffect(() => {
    if (tlWords.length === 0) return
    let cancelled = false
    void (async () => {
      if (style.font === 'custom' && style.customFontPath) {
        const ok = (await window.api.allowFont(style.customFontPath)) && (await loadCustomFont(style.customFontPath))
        if (!ok && !cancelled) p.onError(`Не удалось загрузить шрифт «${style.customFontName || style.customFontPath}»: показываю запасной. Выбери файл заново на вкладке «Стиль»`)
      }
      const family = fontFamilyOf(style)
      const sample = [...new Set(tlWords.map((w) => w.text).join(''))].join('') + 'АаЯя'
      await document.fonts.load(`${style.weight} 40px ${family}`, style.uppercase ? sample + sample.toUpperCase() : sample)
      if (!cancelled) setFontTick((n) => n + 1)
    })()
    return () => {
      cancelled = true
    }
  }, [style.font, style.customFontPath, style.customFontName, style.weight, style.uppercase, tlWords]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- загрузка ---
  useEffect(() => {
    let alive = true
    window.api.openProject(p.projectId).then(
      (r) => {
        if (!alive) return
        dispatch({ type: 'reset', words: r.project })
        setMissing(new Set(r.missing))
        setLoaded(true)
        if (r.missing.length) p.onError(`Не найдено файлов: ${r.missing.length}. Они отмечены в «Медиа»`)
      },
      (e: unknown) => {
        p.onError(clean(e))
        p.onClose()
      }
    )
    return () => {
      alive = false
    }
  }, [p.projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- автосохранение ---
  const firstSave = useRef(true)
  useEffect(() => {
    if (!loaded) return
    if (firstSave.current) {
      firstSave.current = false
      return
    }
    const h = setTimeout(() => {
      window.api.writeProject(project).then(
        () => setSaveError(null),
        (e: unknown) => setSaveError(clean(e))
      )
    }, 600)
    return () => clearTimeout(h)
  }, [project, loaded])

  // --- подготовка файлов: миниатюры, волна, копия для просмотра ---
  useEffect(() => {
    for (const m of project.media) {
      if (prepared.current.has(m.id) || missing.has(m.path)) continue
      prepared.current.add(m.id)
      if (m.hasVideo) void window.api.thumbnail(m.path, m.duration).then((t) => setThumbs((x) => ({ ...x, [m.id]: t })), () => {})
      if (m.hasAudio) void window.api.peaks(m.path).then((pk) => setPeaks((x) => ({ ...x, [m.id]: pk })), () => {})
      if (m.needsPreview) {
        setPreviewing((x) => ({ ...x, [m.id]: 0 }))
        void window.api.preparePreview(m.path).then(
          (path) => {
            setPreviews((x) => ({ ...x, [m.id]: path }))
            setPreviewing((x) => {
              const n = { ...x }
              delete n[m.id]
              return n
            })
          },
          (e: unknown) => p.onError(`Копия для просмотра «${m.name}»: ${clean(e)}`)
        )
      }
    }
  }, [project.media, missing]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const offProg = window.api.onProgress(setProgress)
    const offPrev = window.api.onPreviewProgress((e) => {
      const m = projectRef.current.media.find((x) => x.path === e.mediaPath)
      if (m) setPreviewing((x) => (m.id in x ? { ...x, [m.id]: e.value } : x))
    })
    return () => {
      offProg()
      offPrev()
    }
  }, [])

  // --- добавление файлов ---
  const addFiles = useCallback(
    (infos: MediaInfo[]) => {
      if (infos.length === 0) return
      let next = projectRef.current
      const wasEmpty = next.items.length === 0
      const ids: string[] = []
      for (const info of infos) {
        const r = addMedia(next, toRef(info))
        next = r.p
        ids.push(r.id)
      }
      // пустой таймлайн — сразу кладём видео друг за другом (как удобно в начале работы)
      if (wasEmpty) {
        for (const id of ids) {
          const m = next.media.find((x) => x.id === id)
          if (m?.hasVideo) next = insertMedia(next, id, projectDuration(next)).p
        }
      }
      commit(next)
    },
    [commit]
  )
  useEffect(() => {
    const off = window.api.onMediaDropped((r) => {
      if (r.errors.length) p.onError(r.errors.join('; '))
      addFiles(r.infos)
    })
    return off
  }, [addFiles]) // eslint-disable-line react-hooks/exhaustive-deps

  const importFiles = async (): Promise<void> => {
    try {
      addFiles(await window.api.importMedia())
    } catch (e) {
      p.onError(clean(e))
    }
  }

  // --- часы воспроизведения ---
  const clock = useRef({ t0: 0, p0: 0 })
  useEffect(() => {
    if (!playing) return
    clock.current = { t0: time, p0: performance.now() }
    let raf = 0
    const tick = (): void => {
      const t = clock.current.t0 + (performance.now() - clock.current.p0) / 1000
      const end = projectDuration(projectRef.current)
      // фокус на клипе: проигрываем по кругу в границах рамки
      const f = focusRef.current
      if (f && t >= f.end) {
        clock.current = { t0: f.start, p0: performance.now() }
        setTime(f.start)
        raf = requestAnimationFrame(tick)
        return
      }
      if (stopAtRef.current !== null && t >= stopAtRef.current) {
        stopAtRef.current = null
        setTime(t)
        setPlaying(false)
        return
      }
      if (t >= end) {
        setTime(end)
        setPlaying(false)
        return
      }
      setTime(t)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing]) // eslint-disable-line react-hooks/exhaustive-deps

  const seek = useCallback((t: number) => {
    stopAtRef.current = null
    const f = focusRef.current
    const c = f ? Math.max(f.start, Math.min(t, f.end)) : Math.max(0, Math.min(t, projectDuration(projectRef.current)))
    clock.current = { t0: c, p0: performance.now() }
    setTime(c)
  }, [])
  // перетаскивание по полосе: на время — пауза, после отпускания играем дальше, если играло
  const master = useMasterVolume()
  const scrubResume = useRef(false)
  const scrubStart = useCallback(() => {
    scrubResume.current = playing
    if (playing) setPlaying(false)
  }, [playing])
  const scrubEnd = useCallback(() => {
    if (!scrubResume.current) return
    scrubResume.current = false
    setPlaying(true)
  }, [])
  const togglePlay = useCallback(() => {
    stopAtRef.current = null
    if (duration <= 0) return
    const f = focusRef.current
    if (!playing && time >= (f ? f.end : duration) - 0.01) seek(f ? f.start : 0)
    setPlaying((v) => !v)
  }, [playing, time, duration, seek])

  // --- правки ---
  const split = useCallback(() => {
    commit(splitAt(projectRef.current, time, selected.length ? selected : undefined))
  }, [commit, time, selected])
  const del = useCallback(
    (ripple = false) => {
      if (selected.length === 0) return
      commit(deleteItems(projectRef.current, selected, ripple))
      setSelected([])
    },
    [commit, selected]
  )
  // метка на курсоре: на выделенной дорожке, иначе на дорожке выделенного куска, иначе на самой нижней видеодорожке
  const addMarkerHere = useCallback(() => {
    const pr = projectRef.current
    const track =
      selectedTrack && pr.tracks.some((t) => t.id === selectedTrack)
        ? selectedTrack
        : (pr.items.find((i) => selected.includes(i.id))?.trackId ?? videoTracks(pr).at(-1)?.id)
    if (!track) return
    const r = addMarker(pr, track, time, 0, '')
    if (!r.id) return
    commit(r.p)
    setMarkerPopId(r.id)
  }, [commit, selectedTrack, selected, time])
  // Shift+S: разрезать по курсору и вставить стоп-кадр. Берёт выделенный кусок видео под курсором, иначе кусок на выбранной
  // дорожке, иначе на самой нижней видеодорожке.
  const freezeHere = (): void => {
    const pr = projectRef.current
    const cand = pr.items.filter(
      (i) => i.kind === 'media' && itemTrackKind(pr, i) === 'video' && !!mediaOf(pr, i.mediaId)?.hasVideo && time >= i.start - 1e-6 && time <= itemEnd(i) + 1e-6
    )
    const order = (i: (typeof cand)[number]): number => pr.tracks.findIndex((t) => t.id === i.trackId)
    const it = cand.find((i) => selected.includes(i.id)) ?? cand.find((i) => i.trackId === selectedTrack) ?? [...cand].sort((a, b) => order(b) - order(a))[0]
    if (!it) {
      p.onError('Поставь курсор на кусок видео, чтобы вставить стоп-кадр')
      return
    }
    const r = insertFreeze(pr, it.id, time)
    if (r.error) {
      p.onError(r.error)
      return
    }
    p.onError(null)
    commit(r.p)
    setSelected([r.id])
    setSelectedClip(null)
  }
  /** Ставит надпись на курсор (3 с) на самую верхнюю свободную видеодорожку; styleId — готовый стиль. */
  const addTextHere = (styleId = 'text'): void => {
    const r = insertText(projectRef.current, time, styleId)
    p.onError(null)
    commit(r.p)
    setSelected([r.id])
    setSelectedClip(null)
  }
  /**
   * Потянули картинку в превью: положение и масштаб идут через setPropAt — есть ключи, ставится ключ в точке курсора,
   * нет — меняется «Кадр».
   */
  const onFrameDrag = (id: string, patch: Partial<Frame>): void => {
    let next = projectRef.current
    for (const k of ['x', 'y', 'scale'] as const) if (patch[k] !== undefined) next = setPropAt(next, id, k, timeRef.current, patch[k] as number)
    commit(next, `frd-${id}`)
  }
  /** Потянули надпись: ось с ключами двигает ключ, ось без ключей — положение самой плашки. */
  const onPlateMove = (id: string, dx: number, dy: number, start: PlateStart): void => {
    const pr = projectRef.current
    const it = pr.items.find((i) => i.id === id)
    if (!it || !it.plate) return
    let next = pr
    const patch: Partial<Plate> = {}
    if (it.keys.x.length) next = setPropAt(next, id, 'x', timeRef.current, start.x + dx)
    else patch.x = start.px + dx
    if (it.keys.y.length) next = setPropAt(next, id, 'y', timeRef.current, start.y + dy)
    else patch.y = start.py + dy
    if (Object.keys(patch).length) next = patchPlate(next, id, patch)
    commit(next, `pld-${id}`)
  }
  /** Накладывает эффект на выделенные куски (или на один кусок, если его указали: перетащили карточку). */
  const applyEffect = (type: EffectType, itemId?: string): void => {
    const ids = itemId ? [itemId] : selected
    if (ids.length === 0) {
      p.onError('Выдели кусок, на который наложить эффект')
      return
    }
    const r = addEffect(projectRef.current, ids, type)
    if (r.added === 0) {
      p.onError('Эффект уже наложен или кусок не подходит (звук и субтитры без эффектов, на надписи — только анимации)')
      return
    }
    p.onError(null)
    commit(r.p)
  }
  // --- копирование и вставка (Ctrl+C / X / V / D) ---
  /** Выбрать вставленное: сами куски, а не их связанные субтитры (иначе справа открылась бы панель слов). */
  const selectPasted = (pr: Project, ids: string[]): void => {
    const main = ids.filter((id) => pr.items.find((i) => i.id === id)?.kind !== 'subs')
    setSelected(main.length ? main : ids)
    setSelectedClip(null)
    setSubsSel(false)
  }
  const copySel = (): boolean => {
    if (selected.length === 0) {
      p.onError('Выдели куски, которые нужно скопировать')
      return false
    }
    const entries = copyItems(projectRef.current, selected)
    if (entries.length === 0) return false
    clipRef.current = entries
    setClipCount(entries.length)
    p.onError(null)
    flash(`Скопировано кусков: ${entries.filter((e) => e.item.kind !== 'subs').length}`)
    return true
  }
  const cutSel = (): void => {
    if (copySel()) del(false)
  }
  const pasteHere = (): void => {
    if (clipRef.current.length === 0) {
      p.onError('Буфер пуст: скопируй куски (Ctrl+C)')
      return
    }
    const r = pasteItems(projectRef.current, clipRef.current, time)
    if (r.ids.length === 0) {
      p.onError('Файлов этих кусков в проекте больше нет — вставлять нечего')
      return
    }
    p.onError(null)
    commit(r.p)
    selectPasted(r.p, r.ids)
    flash(`Вставлено${r.skipped ? ` (пропущено: ${r.skipped} — файла нет в проекте)` : ''}`)
  }
  const duplicateSel = (): void => {
    if (selected.length === 0) {
      p.onError('Выдели куски, которые нужно продублировать')
      return
    }
    const r = duplicateItems(projectRef.current, selected)
    if (r.ids.length === 0) return
    p.onError(null)
    commit(r.p)
    selectPasted(r.p, r.ids)
  }
  // Ctrl+J: соединить выделенные куски обратно; не вышло — говорим почему
  const joinSel = (): void => {
    const r = joinSelected(projectRef.current, selected)
    if (r.error) {
      p.onError(r.error)
      return
    }
    p.onError(null)
    commit(r.p)
    if (r.id) setSelected([r.id])
    flash(r.joined > 1 ? `Соединено стыков: ${r.joined}` : 'Куски соединены')
  }
  const undo = (): void => dispatch({ type: 'undo' })
  const redo = (): void => dispatch({ type: 'redo' })

  // отменой можно вернуть состояние без выделенного куска — чистим выделение
  useEffect(() => {
    setSelected((s) => (s.every((id) => project.items.some((i) => i.id === id)) ? s : s.filter((id) => project.items.some((i) => i.id === id))))
  }, [project.items])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      if (el && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes((el as HTMLInputElement).type)))) return
      if (exportOpen || clipsOpen || p.blocked) return
      if (e.code === 'Escape' && markerPopId) {
        setMarkerPopId(null)
        return
      }
      const ctrl = e.ctrlKey || e.metaKey
      const frame = 1 / (project.fps || 30)
      if (ctrl && e.code === 'KeyS') {
        e.preventDefault()
        void (e.shiftKey ? cmds.saveToFile() : cmds.save())
        return
      }
      if (ctrl && e.code === 'KeyI') {
        e.preventDefault()
        cmds.addMedia()
        return
      }
      if (ctrl && e.code === 'KeyE') {
        e.preventDefault()
        cmds.exportVideo()
        return
      }
      if (ctrl && e.code === 'KeyW') {
        e.preventDefault()
        void cmds.close()
        return
      }
      if (ctrl && !e.shiftKey && (e.code === 'KeyC' || e.code === 'KeyX' || e.code === 'KeyV' || e.code === 'KeyD')) {
        e.preventDefault()
        if (e.code === 'KeyC') copySel()
        else if (e.code === 'KeyX') cutSel()
        else if (e.code === 'KeyV') pasteHere()
        else duplicateSel()
        return
      }
      if (ctrl && e.code === 'KeyJ') {
        e.preventDefault()
        joinSel()
        return
      }
      if (ctrl && e.code === 'KeyA') {
        e.preventDefault()
        cmds.selectAll()
        return
      }
      if (!ctrl && e.shiftKey && e.code === 'KeyZ') {
        e.preventDefault()
        cmds.fit()
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (ctrl && e.code === 'KeyZ') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (ctrl && e.code === 'KeyY') {
        e.preventDefault()
        redo()
      } else if (!ctrl && e.shiftKey && e.code === 'KeyS') {
        e.preventDefault()
        freezeHere()
      } else if (!ctrl && e.code === 'KeyS') {
        e.preventDefault()
        split()
      } else if (!ctrl && e.code === 'KeyM') {
        e.preventDefault()
        addMarkerHere()
      } else if (e.code === 'Delete' || e.code === 'Backspace') {
        e.preventDefault()
        // рамка выбрана, а кусков нет — удаляем рамку
        if (selectedClip && selected.length === 0) commit(deleteClip(projectRef.current, selectedClip))
        else del(e.shiftKey)
      } else if (e.code === 'Escape') {
        if (markerPopId) setMarkerPopId(null)
        else if (focusClipId) exitFocus()
        else if (selectedClip) setSelectedClip(null)
        else setSelected([])
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault()
        const d = (e.shiftKey ? 1 : frame) * (e.code === 'ArrowLeft' ? -1 : 1)
        seek(time + d)
      } else if (e.code === 'Home') seek(0)
      else if (e.code === 'End') seek(duration)
      else if (ctrl && (e.code === 'Equal' || e.code === 'NumpadAdd')) {
        e.preventDefault()
        setZoomTick((z) => ({ n: z.n + 1, factor: 1.5 }))
      } else if (ctrl && (e.code === 'Minus' || e.code === 'NumpadSubtract')) {
        e.preventDefault()
        setZoomTick((z) => ({ n: z.n + 1, factor: 1 / 1.5 }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // --- распознавание (для субтитров и для «Нарезки») ---
  /** Модель распознавания скачана? Нет — говорим об этом и открываем настройки. */
  const ensureModel = async (): Promise<boolean> => {
    const modelId = loadModelId()
    try {
      const m = (await window.api.listModels()).find((x) => x.id === modelId)
      if (m && !m.installed) {
        const msg = `Модель «${m.title}» не скачана. Скачай её в настройках («Распознавание речи»)`
        p.onError(msg)
        setClipsError(msg)
        p.onOpenSettings('asr')
        return false
      }
    } catch {
      /* без проверки — пусть распознавание само скажет, что не так */
    }
    return true
  }
  type Recognized = { mediaId: string; from: number; to: number; words: import('../../../shared/types').Word[] }
  /** Распознаёт недостающие отрезки; слова во времени файла. Применяются к проекту отдельно (за время работы его могли править). */
  const recognize = async (pr: Project, jobs: ReturnType<typeof neededRanges>, base: string): Promise<Recognized[]> => {
    const modelId = loadModelId()
    const results: Recognized[] = []
    for (let k = 0; k < jobs.length; k++) {
      if (cancelledRef.current) throw new Error('Отменено')
      const j = jobs[k]
      const m = mediaOf(pr, j.mediaId)
      if (!m) continue
      const label = jobs.length > 1 ? `${base} ${k + 1} из ${jobs.length}` : base
      results.push({ ...j, words: await window.api.transcribeRange(m.path, modelId, j.from, j.to, label) })
    }
    return results
  }
  const applyAll = (pr: Project, results: Recognized[]): Project => results.reduce((acc, r) => applyRecognized(acc, r.mediaId, r.from, r.to, r.words), pr)

  // --- субтитры ---
  const subtitles = async (): Promise<void> => {
    if (asrBusy) return
    const pr = projectRef.current
    const targets = subsTargets(pr, selected)
    if (targets.length === 0) {
      p.onError('Нет видео или звука со звуковой дорожкой: положи файл на таймлайн')
      return
    }
    if (!(await ensureModel())) return
    const jobs = neededRanges(pr, targets)
    cancelledRef.current = false
    setAsrBusy(true)
    setProgress(null)
    p.onError(null)
    try {
      const results = await recognize(pr, jobs, 'Субтитры')
      if (!mounted.current) return
      if (cancelledRef.current) throw new Error('Отменено')
      let next = applyAll(projectRef.current, results)
      next = addSubtitles(next, targets.map((i) => i.id))
      commit(next)
      // выделяем созданные куски субтитров: справа сразу панель слов и стиля
      setSelected(next.items.filter((i) => i.kind === 'subs' && i.link && targets.some((t) => t.id === i.link)).map((i) => i.id))
      setSelectedClip(null)
      setSubsSel(false)
      setSubsTab('words')
      setWordSel(-1)
      flash(jobs.length === 0 ? 'Слова уже были распознаны — субтитры включены' : `Субтитры готовы: ${results.reduce((n, r) => n + r.words.length, 0)} слов`)
    } catch (e) {
      // отмена — не ошибка: проект остался как был
      if (mounted.current) {
        if (clean(e) === 'Отменено') flash('Отменено')
        else p.onError(clean(e))
      }
    } finally {
      if (mounted.current) {
        setAsrBusy(false)
        setProgress(null)
      }
    }
  }

  // --- «Нарезка» ---
  /** Видео, над которым работает «Нарезка»: выделенное, иначе на самой нижней дорожке (как у субтитров). */
  const clipsTarget = useMemo(() => {
    const t = subsTargets(project, selected).filter((i) => mediaOf(project, i.mediaId)?.hasVideo)
    return t[0] ?? null
  }, [project, selected])
  /** Отмена распознавания и поиска моментов: процессы прерываются, проект остаётся как был. */
  const cancelWork = (): void => {
    cancelledRef.current = true
    void window.api.cancelAsr()
    void window.api.cancelAnalyze()
  }
  const openClips = (): void => {
    if (!clipsTarget) {
      p.onError('Положи на таймлайн видео со звуком и нажми «Нарезка»')
      return
    }
    p.onError(null)
    setClipsError(null)
    setClipsOpen(true)
  }
  const runClips = async (o: ClipsParams): Promise<void> => {
    const target = clipsTarget
    if (!target || clipsBusy) return
    setClipsError(null)
    cancelledRef.current = false
    setClipsBusy(true)
    setProgress(null)
    try {
      if (!(await ensureModel())) return
      const pr = projectRef.current
      const jobs = neededRanges(pr, [target])
      const results = await recognize(pr, jobs, 'Распознаю речь для нарезки')
      if (cancelledRef.current) throw new Error('Отменено')
      const withWords = applyAll(projectRef.current, results)
      const media = mediaOf(withWords, target.mediaId)
      const words = (withWords.words[target.mediaId] ?? []).filter((w) => w.start >= target.in && w.end <= target.out)
      if (!media || words.length === 0) throw new Error('В этом отрезке нет речи: клипы искать негде')
      const res = await window.api.analyzeClips({ words, minDur: o.minDur, maxDur: o.maxDur, count: o.count, mediaDuration: media.duration })
      if (!mounted.current) return
      if (res.clips.length === 0) {
        // распознанные слова всё равно сохраняем: второй раз распознавать не придётся
        if (results.length > 0) commit(withWords)
        throw new Error(`ИИ не нашёл подходящих моментов${res.warnings.length ? `. ${res.warnings[0]}` : ''}. Попробуй изменить длину или число клипов`)
      }
      let next = applyAll(projectRef.current, results)
      // субтитры нужны, чтобы вшить их в ролики; кусок мог исчезнуть за время работы
      if (next.items.some((i) => i.id === target.id)) next = addSubtitles(next, [target.id])
      const found = fromCandidates(target.mediaId, res.clips, res.notes)
      next = putClips(next, target.mediaId, found, o.replace)
      commit(next)
      const added = found.filter((c) => next.clips.some((k) => k.id === c.id))
      setSelected([])
      setSelectedClip(added[0]?.id ?? null)
      setClipsOpen(false)
      flash(`Найдено рамок: ${added.length}${res.warnings.length ? ' (часть ответов ИИ не разобрана)' : ''}`)
    } catch (e) {
      const msg = clean(e)
      if (mounted.current) {
        if (msg === 'Отменено') flash('Отменено')
        else setClipsError(msg)
      }
    } finally {
      if (mounted.current) {
        setClipsBusy(false)
        setProgress(null)
      }
    }
  }
  /** Рамка вручную: 30 с от курсора на видео под курсором. */
  const addClipHere = (): void => {
    const pr = projectRef.current
    const under = activeAt(pr, time).filter((i) => i.kind === 'media' && mediaOf(pr, i.mediaId)?.hasVideo)
    const it = under.at(-1) ?? clipsTarget
    if (!it) {
      p.onError('Поставь курсор на видео, чтобы отметить клип')
      return
    }
    const at = time >= it.start && time <= itemEnd(it) ? sourceTime(it, time) : it.in
    const r = addClip(pr, it.mediaId, at)
    if (!r) {
      p.onError('Здесь уже стоит другая рамка или файл закончился: подвинь курсор')
      return
    }
    p.onError(null)
    commit(r.p)
    setSelected([])
    setSubsSel(false)
    setSelectedClip(r.id)
  }
  const onSelectClip = (id: string | null): void => {
    setSelectedClip(id)
    if (id) {
      setSelected([])
      setSubsSel(false)
    }
  }
  const enterFocus = (id: string): void => {
    const c = projectRef.current.clips.find((x) => x.id === id)
    const at = c ? placement(projectRef.current, c) : null
    if (!at) return
    setPlaying(false)
    setFocusClipId(id)
    onSelectClip(id)
    clock.current = { t0: at.start, p0: performance.now() }
    setTime(at.start)
  }
  const exitFocus = (): void => setFocusClipId(null)
  // рамку удалили или убрали видео — из фокуса выходим
  useEffect(() => {
    if (focusClipId && !focusRange) setFocusClipId(null)
    if (selectedClip && !project.clips.some((c) => c.id === selectedClip)) setSelectedClip(null)
  }, [project.clips, focusRange, focusClipId, selectedClip])

  const indexOfWord = (w: TlWord): number => tlWords.findIndex((x) => x.itemId === w.itemId && x.idx === w.idx)
  const onWordClick = (w: TlWord): void => {
    stopAtRef.current = null
    setPlaying(false)
    setSelected([w.itemId])
    setSubsSel(true)
    setSubsTab('words')
    setWordSel(indexOfWord(w))
    setEditWord(w)
  }
  const onWordPick = (w: TlWord): void => {
    setSubsSel(true)
    setSubsTab('words')
    setWordSel(indexOfWord(w))
    seek(w.start)
  }
  const wordAt = (i: number): TlWord | undefined => tlWords[i]
  const applyWord = (next: Project | null, key?: string): void => {
    if (next) commit(next, key)
  }
  const editText = (i: number, text: string): void => {
    const w = wordAt(i)
    if (w) applyWord(editTlText(projectRef.current, w, text))
  }
  const editTime = (i: number, patch: { start?: number; end?: number }, key: string): void => {
    const w = wordAt(i)
    if (w) applyWord(setTlWordTiming(projectRef.current, w, patch), key)
  }
  const mergeWord = (i: number): void => {
    const w = wordAt(i)
    if (w) applyWord(mergeTlWord(projectRef.current, w))
  }
  const deleteWord = (i: number): void => {
    const w = wordAt(i)
    if (!w) return
    applyWord(deleteTlWord(projectRef.current, w))
    setWordSel(-1)
  }
  const playWord = (i: number): void => {
    const w = wordAt(i)
    if (!w) return
    clock.current = { t0: Math.max(0, w.start - 0.15), p0: performance.now() }
    setTime(clock.current.t0)
    stopAtRef.current = w.end + 0.1
    setPlaying(true)
  }
  const commitEdit = (text: string, move: -1 | 0 | 1): void => {
    const w = editWord
    if (!w) return
    const idx = indexOfWord(w)
    const next = editTlText(projectRef.current, w, text)
    if (next) commit(next)
    if (move === 0 || idx < 0) {
      setEditWord(null)
      return
    }
    const list = next ? timelineWordRefs(next) : tlWords
    const deleted = !!next && list.length < tlWords.length
    const target = deleted ? (move === 1 ? idx : idx - 1) : idx + move
    if (target < 0 || target >= list.length) {
      setEditWord(null)
      return
    }
    seek(list[target].start + 0.03)
    setWordSel(target)
    setEditWord(list[target])
  }
  const patchStyle = (patch: Partial<SubtitleStyle>): void => commit({ ...projectRef.current, style: { ...style, ...patch } }, 'style')
  const selectItems = useCallback((ids: string[]) => {
    setSelected(ids)
    if (ids.length > 0) {
      setSubsSel(false)
      setSelectedClip(null)
    }
  }, [])

  const usedIds = useMemo(() => new Set(project.items.map((i) => i.mediaId)), [project.items])
  /** Двойной щелчок в «Медиа»: в конец самой нижней видеодорожки (звук — в конец первой звуковой). */
  const appendToLowest = useCallback(
    (id: string) => {
      const pr = projectRef.current
      const m = pr.media.find((x) => x.id === id)
      const lane = m?.hasVideo ? videoTracks(pr).at(-1) : pr.tracks.find((t) => t.kind === 'audio')
      const lastItem = lane ? itemsOn(pr, lane.id).at(-1) : undefined
      commit(insertMedia(pr, id, lastItem ? itemEnd(lastItem) : 0, lane?.id).p)
    },
    [commit]
  )
  const onDropMedia = useCallback((id: string, trackId: string | null, at: number) => commit(insertMedia(projectRef.current, id, at, trackId ?? undefined).p), [commit])
  const addTrack = (kind: 'video' | 'audio'): void => commit(addTrackOf(projectRef.current, kind).p)
  const onRemoveMedia = useCallback((id: string) => commit(removeMedia(projectRef.current, id)), [commit])

  const back = async (): Promise<void> => {
    setPlaying(false)
    try {
      await window.api.writeProject(projectRef.current)
    } catch (e) {
      if (!window.confirm(`Не удалось сохранить: ${clean(e)}. Всё равно выйти?`)) return
    }
    p.onClose()
  }

  const saveNow = async (): Promise<boolean> => {
    try {
      await window.api.writeProject(projectRef.current)
      setSaveError(null)
      return true
    } catch (e) {
      setSaveError(clean(e))
      return false
    }
  }
  const flash = (t: string): void => {
    setSavedNote(t)
    setTimeout(() => setSavedNote((x) => (x === t ? null : x)), 2500)
  }
  const cmds: EditorCommands = {
    save: async () => {
      if (await saveNow()) flash('Сохранено')
    },
    saveToFile: async () => {
      if (!(await saveNow())) return
      try {
        const f = await window.api.exportProjectFile(projectRef.current.id)
        if (f) flash(`Проект сохранён в файл ${f.split(/[\\/]/).pop()}`)
      } catch (e) {
        p.onError(clean(e))
      }
    },
    addMedia: () => void importFiles(),
    exportVideo: () => duration > 0 && setExportOpen(true),
    close: back,
    undo,
    redo,
    split,
    del: () => del(false),
    delRipple: () => del(true),
    join: joinSel,
    cancelWork,
    freeze: freezeHere,
    addText: () => addTextHere(),
    copy: copySel,
    cut: cutSel,
    paste: pasteHere,
    duplicate: duplicateSel,
    addMarker: addMarkerHere,
    selectAll: () => setSelected(projectRef.current.items.map((i) => i.id)),
    deselect: () => setSelected([]),
    zoomIn: () => setZoomTick((z) => ({ n: z.n + 1, factor: 1.5 })),
    zoomOut: () => setZoomTick((z) => ({ n: z.n + 1, factor: 1 / 1.5 })),
    fit: () => setFitTick((n) => n + 1),
    home: () => seek(0),
    end: () => seek(duration)
  }
  p.commands.current = cmds

  const asrLabel = asrBusy || clipsBusy ? `${progress?.label ?? (clipsBusy ? 'Нарезка: готовлю' : 'Субтитры: готовлю')}${progress?.stage === 'asr' ? ` — ${Math.round(progress.value * 100)}%` : ''}` : null
  const status = saveError ? `Не сохранено: ${saveError}` : asrLabel ?? (exporting && progress ? progress.label : savedNote)
  const stateKey = [clipCount, asrBusy, clipsBusy, project.name, hist.past.length > 0, hist.future.length > 0, selected.length > 0, project.items.length > 0, duration, status, !!saveError].join('|')
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    p.onState({
      name: project.name,
      canUndo: hist.past.length > 0,
      canRedo: hist.future.length > 0,
      hasSel: selected.length > 0,
      hasItems: project.items.length > 0,
      canPaste: clipCount > 0,
      duration,
      status,
      statusErr: !!saveError,
      cancellable: asrBusy || clipsBusy
    })
  }, [stateKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!loaded) return <main className="editor loading">Открываю проект…</main>

  return (
    <main
      className={`editor${resizing ? ' resizing' : ''}`}
      style={{ '--mw': `${layout.mw}px`, '--iw': `${layout.iw}px`, '--th': `${layout.th}px` } as React.CSSProperties}
    >
      {splitter('mw', 'sv1')}
      {splitter('iw', 'sv2')}
      {splitter('th', 'sh')}

      <MediaPanel
        media={project.media}
        thumbs={thumbs}
        missing={missing}
        previewing={previewing}
        usedIds={usedIds}
        onImport={() => void importFiles()}
        onAppend={appendToLowest}
        onRemove={onRemoveMedia}
        tab={leftTab}
        onTab={setLeftTab}
        onEffect={(t) => applyEffect(t)}
        onText={addTextHere}
      />

      <section className="ed-center">
        <Player
          project={project}
          time={time}
          playing={playing}
          previews={previews}
          fontTick={fontTick}
          layers={layers}
          masterVolume={master.level}
          editWord={editWord}
          onWordClick={onWordClick}
          onEditCommit={commitEdit}
          onEditCancel={() => setEditWord(null)}
          clipView={clipView}
          frameItemId={frameItemId}
          plateItemId={plateItemId}
          onPlateMove={onPlateMove}
          onFrameDrag={onFrameDrag}
          onOffset={focusClip ? (v) => commit(patchClip(projectRef.current, focusClip.id, { offsetX: v }), `co-${focusClip.id}`) : undefined}
        />
        <Transport
          time={focusRange ? Math.max(0, time - focusRange.start) : time}
          duration={focusRange ? focusRange.end - focusRange.start : duration}
          playing={playing}
          onTogglePlay={togglePlay}
          onSeek={(t) => seek(focusRange ? focusRange.start + t : t)}
          onScrubStart={scrubStart}
          onScrubEnd={scrubEnd}
          level={master.level}
          volume={master.volume}
          muted={master.muted}
          onVolume={master.setVolume}
          onToggleMute={master.toggleMute}
          info={clipView ? `1080×1920 · ${project.fps} fps` : `${project.canvas ? `${project.canvas.w}×${project.canvas.h}` : 'кадр — по первому видео'} · ${project.fps} fps`}
        />
      </section>

      {(subsSel || subsSelected) && tlWords.length > 0 ? (
        <SubsPanel
          words={tlWords}
          time={time}
          style={style}
          selected={wordSel}
          tab={subsTab}
          onTab={setSubsTab}
          onPick={(i) => {
            setWordSel(i)
            const w = tlWords[i]
            if (w) seek(w.start)
          }}
          onText={editText}
          onTime={editTime}
          onMerge={mergeWord}
          onDelete={deleteWord}
          onPlay={playWord}
          onStyle={patchStyle}
          onStyleReset={() => commit({ ...projectRef.current, style: null }, 'style')}
        />
      ) : (
        <Inspector project={project} selected={selected} time={inspTime} getTime={getTime} onCommit={commit} onSeek={seek} onMarkerPop={setMarkerPopId} onMessage={(m) => p.onError(m)} clip={chosenClip} onFocusClip={enterFocus} onClipGone={() => setSelectedClip(null)} />
      )}

      <section className="ed-timeline">
        {focusClip && focusRange && (
          <div className="tl-crumb">
            <button className="btn small" onClick={exitFocus} title="Выйти из фокуса (Esc)">
              ← К проекту
            </button>
            <span>
              {mediaOf(project, focusClip.mediaId)?.name ?? 'Источник'} <span className="sep">›</span> <b>{focusClip.title || 'Клип'}</b>
            </span>
            <span className="mono dim">
              {fmtTime(focusRange.end - focusRange.start)} · кадр 9:16 · {focusClip.framing === 'crop' ? 'кроп' : 'целиком на блюре'}
            </span>
          </div>
        )}
        <div className="tl-tools">
          <button className="btn icon ghost" onClick={undo} disabled={hist.past.length === 0} title="Отменить (Ctrl+Z)" aria-label="Отменить">
            <Icon d={I.undo} />
          </button>
          <button className="btn icon ghost" onClick={redo} disabled={hist.future.length === 0} title="Повторить (Ctrl+Shift+Z)" aria-label="Повторить">
            <Icon d={I.redo} />
          </button>
          <span className="tl-sep" />
          <button className="btn ghost" onClick={split} disabled={project.items.length === 0} title="Разрезать по курсору (S)">
            <Icon d={I.split} /> Разрезать
          </button>
          <button className="btn ghost" onClick={freezeHere} disabled={project.items.length === 0} title="Разрезать по курсору и вставить стоп-кадр на 3 с (Shift+S)">
            <Icon d={I.freeze} /> Стоп-кадр
          </button>
          <button className="btn ghost" onClick={() => addTextHere()} title="Поставить надпись на курсор на 3 с">
            <Icon d={I.text} /> Текст
          </button>
          <button className="btn ghost" onClick={() => del(false)} disabled={selected.length === 0} title="Удалить выделенное, дыра остаётся (Delete). Shift+Delete — удалить и закрыть дыру">
            <Icon d={I.del} /> Удалить
          </button>
          <span className="tl-sep" />
          <button className="btn ghost" onClick={() => addTrack('video')} title="Добавить видеодорожку (самый верхний слой)">
            <Icon d={I.plus} /> Видео
          </button>
          <button className="btn ghost" onClick={() => addTrack('audio')} title="Добавить звуковую дорожку">
            <Icon d={I.plus} /> Звук
          </button>
          <span className="tl-sep" />
          <button
            className="btn"
            onClick={() => (asrBusy ? cancelWork() : void subtitles())}
            disabled={clipsBusy || (!asrBusy && project.items.length === 0)}
            title="Распознать речь выделенного видео (без выделения — видео на самой нижней дорожке) и положить субтитры отдельным куском"
          >
            {asrBusy ? 'Отменить' : 'Субтитры'}
          </button>
          <button className="btn" onClick={openClips} disabled={project.items.length === 0 || clipsBusy} title="ИИ найдёт цельные моменты в выделенном видео (без выделения — в видео на самой нижней дорожке) и поставит рамки на строку «Клипы»">
            Нарезка
          </button>
          <button className="btn ghost" onClick={addClipHere} disabled={project.items.length === 0} title="Поставить рамку клипа на 30 с от курсора">
            <Icon d={I.plus} /> Клип
          </button>
          <span className="spacer" />
          <button className="btn icon ghost" onClick={() => setZoomTick((z) => ({ n: z.n + 1, factor: 1 / 1.5 }))} title="Отдалить (Ctrl+−)" aria-label="Отдалить">
            <Icon d={I.minus} />
          </button>
          <button className="btn icon ghost" onClick={() => setFitTick((n) => n + 1)} title="Показать весь таймлайн" aria-label="Показать всё">
            <Icon d={I.fit} />
          </button>
          <button className="btn icon ghost" onClick={() => setZoomTick((z) => ({ n: z.n + 1, factor: 1.5 }))} title="Приблизить (Ctrl+=)" aria-label="Приблизить">
            <Icon d={I.plus} />
          </button>
        </div>
        <Tracks
          project={project}
          time={time}
          playing={playing}
          selected={selected}
          selectedTrack={selectedTrack}
          peaks={peaks}
          words={tlWords}
          selectedWord={selectedWordRef}
          onSeek={seek}
          onSelect={selectItems}
          onSelectTrack={setSelectedTrack}
          onCommit={commit}
          onDropMedia={onDropMedia}
          onWordPick={onWordPick}
          markerPopId={markerPopId}
          onMarkerPop={setMarkerPopId}
          clips={clipsPlaced}
          selectedClip={selectedClip}
          onSelectClip={onSelectClip}
          onClipOpen={enterFocus}
          onMessage={(m) => p.onError(m)}
          onDropEffect={(id, t) => applyEffect(t, id)}
          canPaste={clipCount > 0}
          onCopy={copySel}
          onCut={cutSel}
          onPaste={pasteHere}
          onDuplicate={duplicateSel}
          focus={focusRange}
          fitTick={fitTick}
          zoomTick={zoomTick}
        />
      </section>

      {clipsOpen && clipsTarget && (
        <ClipsDialog
          project={project}
          target={clipsTarget}
          hasClips={project.clips.some((c) => c.mediaId === clipsTarget.mediaId)}
          busy={clipsBusy}
          progress={progress}
          error={clipsError}
          onRun={(o) => void runClips(o)}
          onCancel={cancelWork}
          onClose={() => setClipsOpen(false)}
          onOpenSettings={() => p.onOpenSettings('ai')}
          settingsOpen={p.blocked}
        />
      )}
      {exportOpen && <ExportDialog project={project} progress={progress} onClose={() => setExportOpen(false)} onBusy={setExporting} />}
    </main>
  )
}
