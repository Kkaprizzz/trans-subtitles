/** Левая панель: «Медиа» (файлы проекта), «Баннеры» (общая библиотека), «Эффекты», «Текст», «Фигуры». Щелчок по файлу — просмотр, на таймлайн — только перетаскиванием. */
import { memo, useState } from 'react'
import { ANIM_TYPES, EFFECT_MIME, EFFECTS, FILTER_TYPES, type EffectType } from '../../../shared/effects'
import { PLATE_STYLES } from '../../../shared/plate'
import type { MediaRef } from '../../../shared/project'
import { SHAPE_KINDS, type ShapeKind } from '../../../shared/shape'
import type { BannerEntry } from '../../../shared/types'
import { fmtTime } from '../format'
import { BANNER_MIME, MEDIA_MIME, SHAPE_MIME } from './Tracks'
import type { ViewFile } from './FileView'

export type LeftTab = 'media' | 'banners' | 'fx' | 'text' | 'shapes'

interface Props {
  media: MediaRef[]
  thumbs: Record<string, string>
  missing: Set<string>
  /** id файла -> доля готовности копии для предпросмотра (нет ключа — не нужна или готова) */
  previewing: Record<string, number>
  usedIds: Set<string>
  onImport(): void
  onRemove(id: string): void
  tab: LeftTab
  onTab(t: LeftTab): void
  /** щелчок по файлу: показать его в главном окне просмотра */
  onView(f: ViewFile): void
  viewingPath: string | null
  /** библиотека баннеров */
  banners: BannerEntry[]
  bannerThumbs: Record<string, string>
  onBannerAdd(): void
  onBannerRemove(id: string): void
  onBannerRename(id: string, name: string): void
  /** щелчок по карточке фигуры: поставить на курсор */
  onShape(kind: ShapeKind): void
  /** щелчок по карточке стиля надписи: поставить на курсор */
  onText(styleId: string): void
  /** щелчок по карточке эффекта: наложить на выделенные куски */
  onEffect(t: EffectType): void
}

const TABS: Array<{ id: LeftTab; label: string; d: string }> = [
  { id: 'media', label: 'Медиа', d: 'M3 6h13v12H3zM16 10l5-3v10l-5-3' },
  { id: 'banners', label: 'Баннеры', d: 'M3 7h18v10H3zM7 12h6M7 15h3' },
  { id: 'fx', label: 'Эффекты', d: 'M12 3l1.8 4.7L18.5 9l-4.7 1.8L12 15.5l-1.8-4.7L5.5 9l4.7-1.8zM18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z' },
  { id: 'text', label: 'Текст', d: 'M5 6h14M12 6v13M9 19h6' },
  { id: 'shapes', label: 'Фигуры', d: 'M4 4h9v9H4zM15 11a4.5 4.5 0 100 9 4.5 4.5 0 000-9z' }
]

/** Значок фигуры для карточки. */
function ShapeGlyph({ kind }: { kind: ShapeKind }): React.JSX.Element {
  const c = 'currentColor'
  return (
    <svg viewBox="0 0 46 34" width="46" height="34" aria-hidden="true">
      {kind === 'rect' && <rect x="8" y="7" width="30" height="20" fill={c} />}
      {kind === 'round' && <rect x="8" y="7" width="30" height="20" rx="7" fill={c} />}
      {kind === 'circle' && <ellipse cx="23" cy="17" rx="11" ry="11" fill={c} />}
      {kind === 'line' && <path d="M8 22 38 12" stroke={c} strokeWidth="3" strokeLinecap="round" />}
      {kind === 'arrow' && (
        <>
          <path d="M8 24 32 13" stroke={c} strokeWidth="3" />
          <path d="M28 8l11 4-7 9z" fill={c} />
        </>
      )}
      {kind === 'frame' && <rect x="9" y="8" width="28" height="18" fill="none" stroke={c} strokeWidth="2.5" />}
    </svg>
  )
}

/** Карточка баннера: превью на шахматке, длительность, название (двойной щелчок — переименовать), убрать из списка. */
function BannerRow(p: {
  b: BannerEntry
  thumb?: string
  viewing: boolean
  onView(f: ViewFile): void
  onRemove(id: string): void
  onRename(id: string, name: string): void
}): React.JSX.Element {
  const { b } = p
  const [edit, setEdit] = useState<string | null>(null)
  const commit = (): void => {
    if (edit !== null && edit.trim() && edit.trim() !== b.name) p.onRename(b.id, edit.trim())
    setEdit(null)
  }
  return (
    <li
      className={`media-row banner-row${b.missing ? ' lost' : ''}${p.viewing ? ' viewing' : ''}`}
      draggable={!b.missing}
      onDragStart={(e) => {
        e.dataTransfer.setData(BANNER_MIME, b.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={() => !b.missing && p.onView(b)}
      title={b.missing ? `Файл не найден: ${b.path}` : `${b.path}\nЩелчок — просмотр, перетащи на таймлайн`}
    >
      <div className="media-thumb checker">
        {p.thumb && <img src={window.api.mediaUrl(p.thumb)} alt="" draggable={false} />}
        <span className="media-dur mono">{fmtTime(b.duration).replace(/\.\d+$/, '')}</span>
      </div>
      <div className="media-meta">
        {edit === null ? (
          <span className="media-name" onDoubleClick={() => setEdit(b.name)}>
            {b.name}
          </span>
        ) : (
          <input
            className="media-rename"
            autoFocus
            value={edit}
            onChange={(e) => setEdit(e.target.value)}
            onBlur={commit}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') setEdit(null)
            }}
          />
        )}
        <span className="dim mono">{b.missing ? 'файл не найден' : `${b.width ? `${b.width}×${b.height}` : ''}${b.hasAlpha ? ' · прозрачный' : ''}${b.hasAudio ? ' · звук' : ''}`}</span>
      </div>
      <button
        className="media-x"
        onClick={(e) => {
          e.stopPropagation()
          p.onRemove(b.id)
        }}
        title="Убрать из библиотеки (файл не удаляется)"
        aria-label="Убрать из библиотеки"
      >
        ×
      </button>
    </li>
  )
}

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
        {p.tab === 'banners' && (
          <button className="btn small" onClick={p.onBannerAdd} title="Или перетащи файлы в окно">
            + Добавить
          </button>
        )}
      </div>
      {p.tab === 'shapes' && (
        <ul className="fx-list">
          {SHAPE_KINDS.map((k) => (
            <li
              key={k.id}
              className="fx-card"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(SHAPE_MIME, k.id)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              onClick={() => p.onShape(k.id)}
              title="Щёлкни — поставить на курсор, или перетащи на таймлайн"
            >
              <span className="fx-swatch shape-sw">
                <ShapeGlyph kind={k.id} />
              </span>
              <span className="fx-meta">
                <span className="fx-name">{k.title}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {p.tab === 'banners' && (
        <ul className="media-list">
          {p.banners.length === 0 && <li className="empty">Добавь свои готовые баннеры: «+ Добавить» или перетащи файлы в окно. Они будут доступны в любом проекте</li>}
          {p.banners.map((b) => (
            <BannerRow key={b.id} b={b} thumb={p.bannerThumbs[b.id]} viewing={p.viewingPath === b.path} onView={p.onView} onRemove={p.onBannerRemove} onRename={p.onBannerRename} />
          ))}
        </ul>
      )}
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
              className={`media-row${lost ? ' lost' : ''}${p.viewingPath === m.path ? ' viewing' : ''}`}
              draggable={!lost}
              onDragStart={(e) => {
                e.dataTransfer.setData(MEDIA_MIME, m.id)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              onClick={() => !lost && p.onView(m)}
              title={lost ? `Файл не найден: ${m.path}` : `${m.path}\nЩелчок — просмотр, перетащи на таймлайн`}
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
