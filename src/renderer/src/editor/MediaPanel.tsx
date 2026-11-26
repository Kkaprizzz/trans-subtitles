/** Панель «Медиа»: файлы проекта с миниатюрами. Тащи на таймлайн или дважды щёлкни — в конец основной дорожки. */
import { memo } from 'react'
import { ANIM_TYPES, EFFECT_MIME, EFFECTS, FILTER_TYPES, type EffectType } from '../../../shared/effects'
import { PLATE_STYLES } from '../../../shared/plate'
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
  tab: 'media' | 'fx' | 'text'
  onTab(t: 'media' | 'fx' | 'text'): void
  /** щелчок по карточке стиля надписи: поставить на курсор */
  onText(styleId: string): void
  /** щелчок по карточке эффекта: наложить на выделенные куски */
  onEffect(t: EffectType): void
}

const TABS: Array<{ id: 'media' | 'fx' | 'text'; label: string; d: string }> = [
  { id: 'media', label: 'Медиа', d: 'M3 6h13v12H3zM16 10l5-3v10l-5-3' },
  { id: 'fx', label: 'Эффекты', d: 'M12 3l1.8 4.7L18.5 9l-4.7 1.8L12 15.5l-1.8-4.7L5.5 9l4.7-1.8zM18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z' },
  { id: 'text', label: 'Текст', d: 'M5 6h14M12 6v13M9 19h6' }
]

function MediaPanel(p: Props): React.JSX.Element {
  return (
    <aside className="media-panel">
      {/* узкая колонка вкладок слева: только значки, подпись — при наведении */}
      <nav className="side-tabs" role="tablist" aria-orientation="vertical">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={p.tab === t.id} aria-label={t.label} data-label={t.label} className={p.tab === t.id ? 'on' : ''} onClick={() => p.onTab(t.id)}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={t.d} />
            </svg>
          </button>
        ))}
      </nav>
      <div className="media-body">
      <div className="pane-head">
        <span>{TABS.find((t) => t.id === p.tab)?.label}</span>
        {p.tab === 'media' && (
          <button className="btn small" onClick={p.onImport} title="Или перетащи файлы в окно">
            + Импорт
          </button>
        )}
      </div>
      {p.tab === 'text' && (
        <ul className="fx-list">
          {PLATE_STYLES.map((st) => (
            <li key={st.id} className="fx-card" onClick={() => p.onText(st.id)} title="Щёлкни — поставить надпись на курсор">
              <span className="fx-swatch text-sw" style={{ fontWeight: st.plate.weight, WebkitTextStroke: st.plate.strokeOn ? '1px #000' : undefined }}>
                Аа
              </span>
              <span className="fx-meta">
                <span className="fx-name">{st.title}</span>
                <span className="dim">{st.description}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {p.tab === 'fx' && (
        <>
          {[
            { title: 'Фильтры', types: FILTER_TYPES },
            { title: 'Анимации', types: ANIM_TYPES }
          ].map((g) => (
            <div key={g.title}>
              <div className="fx-group">{g.title}</div>
              <ul className="fx-list">
                {g.types.map((t) => (
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
            </div>
          ))}
        </>
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
      </div>
    </aside>
  )
}

export default memo(MediaPanel)
