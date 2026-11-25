/** Инспектор: свойства выделенного куска или, если ничего не выделено, — проекта. */
import { memo } from 'react'
import { itemDur, itemEnd, mediaOf, patchItem, projectDuration, subsOf, trackName, trackOf, unlinkSubs, type Project } from '../../../shared/project'
import { MARKER_PALETTE } from './Tracks'
import { fmtTime } from '../format'

interface Props {
  project: Project
  selected: string[]
  onCommit(next: Project, key?: string): void
  onSeek(t: number): void
  /** открыть окошко метки на таймлайне */
  onMarkerPop(id: string | null): void
}

const CANVASES = [
  { id: '1920x1080', label: '16:9 · 1920×1080' },
  { id: '1080x1920', label: '9:16 · 1080×1920' },
  { id: '1080x1080', label: '1:1 · 1080×1080' },
  { id: '1080x1350', label: '4:5 · 1080×1350' },
  { id: '1280x720', label: '16:9 · 1280×720' },
  { id: '3840x2160', label: '16:9 · 3840×2160' }
]
const FPS = [24, 25, 30, 50, 60]

function Inspector(p: Props): React.JSX.Element {
  const pr = p.project
  const one = p.selected.length === 1 ? pr.items.find((i) => i.id === p.selected[0]) : undefined
  const m = one ? mediaOf(pr, one.mediaId) : undefined

  if (one && m) {
    const track = trackOf(pr, one.trackId)
    return (
      <aside className="inspector">
        <div className="pane-head">
          <span>Кусок</span>
        </div>
        <div className="insp-body">
          <p className="insp-title" title={m.path}>
            {m.name}
          </p>
          <dl className="insp-grid mono">
            <dt>На таймлайне</dt>
            <dd>
              {fmtTime(one.start)} – {fmtTime(itemEnd(one))}
            </dd>
            <dt>Длина</dt>
            <dd>{itemDur(one).toFixed(2)} с</dd>
            <dt>Из файла</dt>
            <dd>
              {fmtTime(one.in)} – {fmtTime(one.out)}
            </dd>
            <dt>Дорожка</dt>
            <dd>{track ? trackName(pr, track.id) : '—'}</dd>
          </dl>
          {m.hasAudio && (
            <label className="insp-row">
              <span>Громкость</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={one.volume}
                onChange={(e) => p.onCommit(patchItem(pr, one.id, { volume: Number(e.target.value) }), `vol-${one.id}`)}
              />
              <span className="mono">{Math.round(one.volume * 100)}%</span>
            </label>
          )}
          {subsOf(pr, one.id).length > 0 && (
            <div className="insp-link">
              <span className="dim">Субтитры едут вместе с этим видео</span>
              <button className="btn small" onClick={() => p.onCommit(subsOf(pr, one.id).reduce((acc, s) => unlinkSubs(acc, s.id), pr))}>
                Разгруппировать
              </button>
            </div>
          )}
          <p className="hint">S — разрезать по курсору, Delete — удалить, края куска тянутся мышью.</p>
        </div>
      </aside>
    )
  }

  const cv = pr.canvas
  const cvId = cv ? `${cv.w}x${cv.h}` : ''
  return (
    <aside className="inspector">
      <div className="pane-head">
        <span>{p.selected.length > 1 ? `Выделено кусков: ${p.selected.length}` : 'Проект'}</span>
      </div>
      <div className="insp-body">
        <label className="insp-row">
          <span>Название</span>
          <input type="text" value={pr.name} onChange={(e) => p.onCommit({ ...pr, name: e.target.value.slice(0, 120) }, 'name')} />
        </label>
        <label className="insp-row">
          <span>Кадр</span>
          <select
            value={cvId}
            onChange={(e) => {
              const [w, h] = e.target.value.split('x').map(Number)
              if (w && h) p.onCommit({ ...pr, canvas: { w, h } })
            }}
          >
            {!cv && <option value="">по первому видео</option>}
            {cv && !CANVASES.some((c) => c.id === cvId) && <option value={cvId}>{`${cv.w}×${cv.h} (как у видео)`}</option>}
            {CANVASES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="insp-row">
          <span>FPS</span>
          <select value={String(pr.fps)} onChange={(e) => p.onCommit({ ...pr, fps: Number(e.target.value) })}>
            {!FPS.includes(pr.fps) && <option value={String(pr.fps)}>{pr.fps}</option>}
            {FPS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <dl className="insp-grid mono">
          <dt>Длина</dt>
          <dd>{fmtTime(projectDuration(pr))}</dd>
          <dt>Файлов</dt>
          <dd>{pr.media.length}</dd>
          <dt>Кусков</dt>
          <dd>{pr.items.length}</dd>
        </dl>
        <div className="insp-markers">
          <span className="set-h">Метки · {pr.markers.length}</span>
          {pr.markers.length === 0 && <p className="hint">Метка ставится клавишей M, правым щелчком по дорожке или кнопкой ⚑ в шапке дорожки.</p>}
          <ul>
            {pr.markers.map((m) => (
              <li
                key={m.id}
                onClick={() => {
                  p.onSeek(m.t)
                  p.onMarkerPop(m.id)
                }}
              >
                <span className="mk-dot" style={{ background: MARKER_PALETTE[m.color] }} />
                <span className="mono dim">{fmtTime(m.t).replace(/\.\d+$/, '')}</span>
                <span className="mk-text">{m.text || 'Без текста'}</span>
                <span className="dim mk-track">{trackName(pr, m.trackId)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </aside>
  )
}

export default memo(Inspector)
