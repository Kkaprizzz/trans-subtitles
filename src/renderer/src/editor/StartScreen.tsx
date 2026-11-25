/** Стартовый экран: новый проект, импорт, список недавних (строками, не плиткой). */
import { useCallback, useEffect, useState } from 'react'
import type { ProjectSummary } from '../../../shared/types'
import { fmtTime } from '../format'

interface Props {
  onOpen(id: string): void
  onError(msg: string | null): void
}

const clean = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export default function StartScreen(p: Props): React.JSX.Element {
  const [list, setList] = useState<ProjectSummary[] | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setList(await window.api.listProjects())
    } catch (e) {
      p.onError(clean(e))
      setList([])
    }
  }, [p])
  useEffect(() => {
    void refresh()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const create = async (): Promise<void> => {
    try {
      const pr = await window.api.createProject(`Проект ${new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`)
      p.onOpen(pr.id)
    } catch (e) {
      p.onError(clean(e))
    }
  }
  const importFile = async (): Promise<void> => {
    try {
      const pr = await window.api.importProjectFile()
      if (pr) p.onOpen(pr.id)
    } catch (e) {
      p.onError(clean(e))
    }
  }
  const act = async (fn: () => Promise<unknown>, done?: string): Promise<void> => {
    try {
      await fn()
      if (done) setNote(done)
      await refresh()
    } catch (e) {
      p.onError(clean(e))
    }
  }

  return (
    <main className="start">
      <header className="start-head">
        <h1>Проекты</h1>
        <span className="spacer" />
        <button className="btn" onClick={() => void importFile()}>
          Импорт проекта
        </button>
        <button className="btn primary" onClick={() => void create()}>
          + Новый проект
        </button>
      </header>
      <section className="start-list">
        <div className="start-row head dim">
          <span>Проект</span>
          <span>Изменён</span>
          <span>Длина</span>
          <span>Файлов</span>
          <span />
        </div>
        {list === null && <p className="empty">Загружаю…</p>}
        {list?.length === 0 && <p className="empty">Проектов пока нет. Создай новый — и перетащи в него видео.</p>}
        {list?.map((pr) => (
          <div key={pr.id} className="start-row" onClick={() => p.onOpen(pr.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && p.onOpen(pr.id)}>
            <span className="start-name">{pr.name}</span>
            <span className="dim mono">{pr.updatedAt ? new Date(pr.updatedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—'}</span>
            <span className="dim mono">{fmtTime(pr.duration).replace(/\.\d+$/, '')}</span>
            <span className="dim mono">{pr.files}</span>
            <span className="start-actions" onClick={(e) => e.stopPropagation()}>
              <button className="link" onClick={() => void act(() => window.api.duplicateProject(pr.id))}>
                Копия
              </button>
              <button className="link" onClick={() => void act(async () => (await window.api.exportProjectFile(pr.id)) ?? undefined, 'Файл проекта сохранён')}>
                В файл
              </button>
              <button
                className="link"
                onClick={() => {
                  if (window.confirm(`Удалить проект «${pr.name}»? Сами видеофайлы останутся на диске`)) void act(() => window.api.deleteProject(pr.id))
                }}
              >
                Удалить
              </button>
            </span>
          </div>
        ))}
        {note && <p className="hint">{note}</p>}
      </section>
    </main>
  )
}
