/**
 * Оболочка приложения: верхняя строка (меню, название, «Экспорт»), под ней стартовый экран или монтажный стол.
 * Здесь же окна настроек и справки, общие сочетания клавиш, заставка, ошибки и автообновление.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProgressEvent, UpdateEvent } from '../../shared/types'
import './editor/editor.css'
import Editor, { type EditorCommands, type EditorState } from './editor/Editor'
import { AboutDialog, HotkeysDialog } from './editor/InfoDialogs'
import MenuBar, { type Menu } from './editor/MenuBar'
import SettingsDialog, { type SettingsSection } from './editor/SettingsDialog'
import StartScreen from './editor/StartScreen'
import { hideSplash, splashStep } from './splash'
import { BrandMark } from './BrandMark'

type Dialog = null | { kind: 'settings'; section: SettingsSection } | { kind: 'hotkeys' } | { kind: 'about' }
const clean = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export default function App(): React.JSX.Element {
  const [projectId, setProjectId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateEvent | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [ed, setEd] = useState<EditorState | null>(null)
  const [progress, setProgress] = useState<ProgressEvent | null>(null)
  const [listTick, setListTick] = useState(0)
  const cmds = useRef<EditorCommands | null>(null)
  const [maxed, setMaxed] = useState(true)

  useEffect(() => {
    splashStep('Загружаю проекты', 0.6)
    // Для автотестов: TS_OPEN=<файл> — сразу проект с этим файлом на таймлайне.
    const dev = window.api.devInitialMedia().then(async (m) => {
      if (!m) return
      const pr = await window.api.createProject(`Тест · ${m.name}`)
      await window.api.writeProject({
        ...pr,
        canvas: m.width && m.height ? { w: Math.floor(m.width / 2) * 2, h: Math.floor(m.height / 2) * 2 } : null,
        fps: m.fps && m.fps >= 1 ? m.fps : 30,
        media: [{ id: 'mdev', path: m.path, name: m.name, duration: m.duration, hasVideo: m.hasVideo, hasAudio: m.hasAudio, width: m.width, height: m.height, fps: m.fps, videoCodec: m.videoCodec, needsPreview: m.needsPreview }],
        items: [{ id: 'idev', kind: 'media', mediaId: 'mdev', trackId: pr.tracks.filter((t) => t.kind === 'video').at(-1)!.id, start: 0, in: 0, out: m.duration, audio: m.hasAudio, speed: 1, volume: 1, gain: [], effects: [], frame: { scale: 100, x: 0, y: 0, cl: 0, cr: 0, ct: 0, cb: 0, opacity: 100, flipH: 0, flipV: 0 }, keys: { x: [], y: [], scale: [], opacity: [] }, plate: null, shape: null, face: null, link: null }]
      })
      setProjectId(pr.id)
    })
    void Promise.allSettled([dev, window.api.listProjects()]).then(() => hideSplash())
    void window.api.winIsMax().then(setMaxed, () => {})
    const offWin = window.api.onWinState((st) => setMaxed(st.maximized))
    const offUpd = window.api.onUpdate(setUpdate)
    const offProg = window.api.onProgress(setProgress)
    return () => {
      offWin()
      offUpd()
      offProg()
    }
  }, [])

  useEffect(() => {
    if (!error) return
    const h = setTimeout(() => setError(null), 8000)
    return () => clearTimeout(h)
  }, [error])

  const onError = useCallback((msg: string | null) => setError(msg), [])
  const inEditor = projectId !== null && ed !== null

  // --- команды уровня приложения ---
  const newProject = useCallback(async () => {
    try {
      if (cmds.current && projectId) await cmds.current.save()
      const pr = await window.api.createProject(
        `Проект ${new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
      )
      setEd(null)
      setProjectId(pr.id)
    } catch (e) {
      setError(clean(e))
    }
  }, [projectId])
  const openList = useCallback(async () => {
    if (cmds.current && projectId) await cmds.current.close()
    else setListTick((n) => n + 1)
  }, [projectId])
  const importProject = useCallback(async () => {
    try {
      const pr = await window.api.importProjectFile()
      if (!pr) return
      if (cmds.current && projectId) await cmds.current.save()
      setEd(null)
      setProjectId(pr.id)
    } catch (e) {
      setError(clean(e))
    }
  }, [projectId])
  const quit = useCallback(async () => {
    if (cmds.current && projectId) await cmds.current.save()
    void window.api.quit()
  }, [projectId])
  const closeEditor = useCallback(() => {
    cmds.current = null
    setEd(null)
    setProjectId(null)
    setListTick((n) => n + 1)
  }, [])

  // Ctrl+N / Ctrl+O / Ctrl+Q работают везде; остальные сочетания — в редакторе
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || dialog) return
      if (e.code === 'KeyN') {
        e.preventDefault()
        void newProject()
      } else if (e.code === 'KeyO') {
        e.preventDefault()
        void openList()
      } else if (e.code === 'KeyQ') {
        e.preventDefault()
        void quit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog, newProject, openList, quit])

  const c = (): EditorCommands | null => cmds.current
  const settings = (section: SettingsSection) => () => setDialog({ kind: 'settings', section })
  const menus: Menu[] = [
    {
      label: 'Файл',
      items: [
        { label: 'Новый проект', shortcut: 'Ctrl+N', action: () => void newProject() },
        { label: 'Открыть…', shortcut: 'Ctrl+O', action: () => void openList() },
        'sep',
        { label: 'Сохранить', shortcut: 'Ctrl+S', disabled: !inEditor, action: () => void c()?.save() },
        { label: 'Сохранить проект в файл…', shortcut: 'Ctrl+Shift+S', disabled: !inEditor, action: () => void c()?.saveToFile() },
        { label: 'Импорт проекта из файла…', action: () => void importProject() },
        'sep',
        { label: 'Добавить медиа…', shortcut: 'Ctrl+I', disabled: !inEditor, action: () => c()?.addMedia() },
        { label: 'Скачать по ссылке…', disabled: !inEditor, action: () => c()?.download() },
        { label: 'Экспорт видео…', shortcut: 'Ctrl+E', disabled: !inEditor || !ed?.canExport, action: () => c()?.exportVideo() },
        'sep',
        { label: 'Закрыть проект', shortcut: 'Ctrl+W', disabled: !inEditor, action: () => void c()?.close() },
        { label: 'Выход', shortcut: 'Ctrl+Q', action: () => void quit() }
      ]
    },
    {
      label: 'Правка',
      items: [
        { label: 'Отменить', shortcut: 'Ctrl+Z', disabled: !ed?.canUndo, action: () => c()?.undo() },
        { label: 'Повторить', shortcut: 'Ctrl+Shift+Z', disabled: !ed?.canRedo, action: () => c()?.redo() },
        'sep',
        { label: 'Разрезать', shortcut: 'S', disabled: !ed?.hasItems, action: () => c()?.split() },
        { label: 'Стоп-кадр', shortcut: 'Shift+S', disabled: !ed?.hasItems, action: () => c()?.freeze() },
        { label: 'Текст', disabled: !inEditor, action: () => c()?.addText() },
        { label: 'Копировать', shortcut: 'Ctrl+C', disabled: !ed?.hasSel, action: () => c()?.copy() },
        { label: 'Вырезать', shortcut: 'Ctrl+X', disabled: !ed?.hasSel, action: () => c()?.cut() },
        { label: 'Вставить', shortcut: 'Ctrl+V', disabled: !ed?.canPaste, action: () => c()?.paste() },
        { label: 'Дублировать', shortcut: 'Ctrl+D', disabled: !ed?.hasSel, action: () => c()?.duplicate() },
        'sep',
        { label: 'Удалить', shortcut: 'Delete', disabled: !ed?.hasSel, action: () => c()?.del() },
        { label: 'Удалить и закрыть дыру', shortcut: 'Shift+Delete', disabled: !ed?.hasSel, action: () => c()?.delRipple() },
        { label: 'Соединить куски', shortcut: 'Ctrl+J', disabled: !ed?.hasSel, action: () => c()?.join() },
        'sep',
        { label: 'Поставить метку', shortcut: 'M', disabled: !inEditor, action: () => c()?.addMarker() },
        'sep',
        { label: 'Выделить всё', shortcut: 'Ctrl+A', disabled: !ed?.hasItems, action: () => c()?.selectAll() },
        { label: 'Снять выделение', shortcut: 'Esc', disabled: !ed?.hasSel, action: () => c()?.deselect() }
      ]
    },
    {
      label: 'Вид',
      items: [
        { label: 'Приблизить', shortcut: 'Ctrl+=', disabled: !inEditor, action: () => c()?.zoomIn() },
        { label: 'Отдалить', shortcut: 'Ctrl+−', disabled: !inEditor, action: () => c()?.zoomOut() },
        { label: 'Весь таймлайн', shortcut: 'Shift+Z', disabled: !inEditor, action: () => c()?.fit() },
        'sep',
        { label: 'В начало', shortcut: 'Home', disabled: !inEditor, action: () => c()?.home() },
        { label: 'В конец', shortcut: 'End', disabled: !inEditor, action: () => c()?.end() }
      ]
    },
    {
      label: 'Настройки',
      items: [
        { label: 'Распознавание речи…', action: settings('asr') },
        { label: 'ИИ для «Нарезки»…', action: settings('ai') },
        'sep',
        { label: 'Экспорт…', action: settings('export') },
        { label: 'Скачивание…', action: settings('download') },
        { label: 'Новый проект…', action: settings('project') },
        'sep',
        { label: 'Кэш…', action: settings('cache') },
        { label: 'Обновления…', action: settings('updates') }
      ]
    },
    {
      label: 'Справка',
      items: [
        { label: 'Горячие клавиши', action: () => setDialog({ kind: 'hotkeys' }) },
        { label: 'О программе', action: () => setDialog({ kind: 'about' }) }
      ]
    }
  ]

  return (
    <div className="app-shell">
      <header
        className="app-top"
        onDoubleClick={(e) => {
          // двойной щелчок по пустому месту строки — развернуть/вернуть (как у системной рамки)
          if (e.target === e.currentTarget) void window.api.winToggleMax()
        }}
      >
        <button
          className="app-logo"
          disabled={!inEditor}
          onClick={() => void c()?.close()}
          title={inEditor ? 'К списку проектов (Ctrl+W)' : undefined}
          aria-label="К списку проектов"
        >
          <BrandMark size={16} />
        </button>
        <MenuBar menus={menus} />
        <span className="app-title">{inEditor ? ed.name : 'Бобина'}</span>
        <span className="spacer" />
        {inEditor && ed.status && <span className={`app-status${ed.statusErr ? ' warn' : ' dim'}`}>{ed.status}</span>}
        {inEditor && ed.cancellable && (
          <button className="btn icon small ghost" onClick={() => c()?.cancelWork()} title="Отменить: проект останется как был" aria-label="Отменить">
            ×
          </button>
        )}
        {inEditor && (
          <button className="btn primary" onClick={() => c()?.exportVideo()} disabled={!ed.canExport} title="Экспорт видео (Ctrl+E)">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
              <path d="M12 15V3M7 8l5-5 5 5M5 14v6h14v-6" />
            </svg>
            Экспорт
          </button>
        )}
        <div className="win-ctrls">
          <button className="win-btn" onClick={() => void window.api.winMinimize()} title="Свернуть" aria-label="Свернуть">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M6 12h12" />
            </svg>
          </button>
          <button className="win-btn" onClick={() => void window.api.winToggleMax()} title={maxed ? 'Вернуть размер' : 'Развернуть'} aria-label={maxed ? 'Вернуть размер' : 'Развернуть'}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
              {maxed ? <path d="M8.5 8.5V6h9.5v9.5h-2.5M6 8.5h9.5V18H6z" /> : <path d="M6.5 6.5h11v11h-11z" />}
            </svg>
          </button>
          <button
            className="win-btn close"
            onClick={() => void (async () => {
              if (cmds.current && projectId) await cmds.current.save()
              void window.api.winClose()
            })()}
            title="Закрыть"
            aria-label="Закрыть"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M7 7l10 10M17 7L7 17" />
            </svg>
          </button>
        </div>
      </header>

      {projectId ? (
        <Editor key={projectId} projectId={projectId} onClose={closeEditor} onError={onError} commands={cmds}
          onState={setEd}
          blocked={dialog !== null}
          onOpenSettings={(section) => setDialog({ kind: 'settings', section })}
        />
      ) : (
        <StartScreen key={listTick} onOpen={(id) => setProjectId(id)} onError={onError} />
      )}

      {dialog?.kind === 'settings' && <SettingsDialog section={dialog.section} progress={progress} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'hotkeys' && <HotkeysDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'about' && <AboutDialog onClose={() => setDialog(null)} />}

      {(error || update) && (
        <div className="toast-row">
          {error && (
            <div className="toast err" role="alert" onClick={() => setError(null)}>
              {error}
            </div>
          )}
          {update?.state === 'ready' && (
            <button className="toast" onClick={() => void window.api.installUpdate()} title="Перезапустит приложение и поставит новую версию">
              Обновить до {update.version}
            </button>
          )}
          {update?.state === 'downloading' && (
            <div className="toast dim">
              Найдена версия {update.version} · скачиваю{update.percent ? ` ${update.percent}%` : '…'}
            </div>
          )}
          {update?.state === 'error' && (
            <div className="toast err" role="alert" onClick={() => setUpdate(null)} title="Закрыть">
              Не удалось обновиться до {update.version}: {update.message}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
