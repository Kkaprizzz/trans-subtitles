/** Панель «Медиа»: файлы проекта с миниатюрами. Тащи на таймлайн или дважды щёлкни — в конец основной дорожки. */
import { memo } from 'react'
import { EFFECT_MIME, EFFECT_TYPES, EFFECTS, type EffectType } from '../../../shared/effects'
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
  tab: 'media' | 'fx'
  onTab(t: 'media' | 'fx'): void
  /** щелчок по карточке эффекта: наложить на выделенные куски */
  onEffect(t: EffectType): void
}

function MediaPanel(p: Props): React.JSX.Element {
  return (
    <aside className="media-panel">
      <div className="pane-head">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={p.tab === 'media'} className={p.tab === 'media' ? 'on' : ''} onClick={() => p.onTab('media')}>
            Медиа
          </button>
          <button role="tab" aria-selected={p.tab === 'fx'} className={p.tab === 'fx' ? 'on' : ''} onClick={() => p.onTab('fx')}>
            Эффекты
          </button>
        </div>
        {p.tab === 'media' && (
          <button className="btn small" onClick={p.onImport} title="Или перетащи файлы в окно">
            + Импорт
          </button>
        )}
      </div>
      {p.tab === 'fx' && (
        <ul className="fx-list">
          {EFFECT_TYPES.map((t) => (
            <li
              key={t}
              className="fx-card"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(EFFECT_MIME, t)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              onClick={() => p.onEffect(t)}
              title="Щёлкни — наложить на выделенные куски, или перетащи на кусок"
            >
              <span className={`fx-swatch ${t}`} />
              <span className="fx-meta">
                <span className="fx-name">{EFFECTS[t].title}</span>
                <span className="dim">{EFFECTS[t].description}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <ul className="media-list" hidden={p.tab !== 'media'}>
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
