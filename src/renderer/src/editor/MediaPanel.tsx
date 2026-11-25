/** Панель «Медиа»: файлы проекта с миниатюрами. Тащи на таймлайн или дважды щёлкни — в конец основной дорожки. */
import { memo } from 'react'
import type { MediaRef } from '../../../shared/project'
import { fmtTime } from '../format'
import { MEDIA_MIME } from './Tracks'

interface Props {
  media: MediaRef[]
  thumbs: Record<string, string>
  missing: Set<string>
  /** id файла -> доля готовности копии для предпросмотра (нет ключа — не нужна или готова) */
  previewing: Record<string, number>
  usedIds: Set<string>
  onImport(): void
  onAppend(id: string): void
  onRemove(id: string): void
}

function MediaPanel(p: Props): React.JSX.Element {
  return (
    <aside className="media-panel">
      <div className="pane-head">
        <span>Медиа</span>
        <button className="btn small" onClick={p.onImport} title="Или перетащи файлы в окно">
          + Импорт
        </button>
      </div>
      <ul className="media-list">
        {p.media.length === 0 && <li className="empty">Добавь видео или звук: «+ Импорт» или перетащи файлы в окно</li>}
        {p.media.map((m) => {
          const lost = p.missing.has(m.path)
          const prog = p.previewing[m.id]
          return (
            <li
              key={m.id}
              className={`media-row${lost ? ' lost' : ''}`}
              draggable={!lost}
              onDragStart={(e) => {
                e.dataTransfer.setData(MEDIA_MIME, m.id)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              onDoubleClick={() => !lost && p.onAppend(m.id)}
              title={lost ? `Файл не найден: ${m.path}` : `${m.path}\nДвойной щелчок — в конец основной дорожки`}
            >
              <div className="media-thumb">
                {m.hasVideo && p.thumbs[m.id] ? (
                  <img src={window.api.mediaUrl(p.thumbs[m.id])} alt="" draggable={false} />
                ) : (
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                    {m.hasVideo ? <path d="M3 6h13v12H3zM16 10l5-3v10l-5-3" /> : <path d="M9 18V6l10-2v12M9 18a3 3 0 11-3-3 3 3 0 013 3zM19 16a3 3 0 11-3-3 3 3 0 013 3z" />}
                  </svg>
                )}
                <span className="media-dur mono">{fmtTime(m.duration).replace(/\.\d+$/, '')}</span>
              </div>
              <div className="media-meta">
                <span className="media-name">{m.name}</span>
                <span className="dim mono">
                  {lost
                    ? 'файл не найден'
                    : prog !== undefined
                      ? `копия для просмотра ${Math.round(prog * 100)}%`
                      : m.hasVideo && m.width
                        ? `${m.width}×${m.height}${m.fps ? ` · ${Math.round(m.fps)} fps` : ''}`
                        : 'звук'}
                </span>
              </div>
              {!p.usedIds.has(m.id) && (
                <button className="media-x" onClick={() => p.onRemove(m.id)} title="Убрать из проекта" aria-label="Убрать из проекта">
                  ×
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

export default memo(MediaPanel)
