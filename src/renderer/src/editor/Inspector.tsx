/** Инспектор: свойства выделенного куска или, если ничего не выделено, — проекта. */
import { memo, useState } from 'react'
import { deleteClip, patchClip, placement } from '../../../shared/cut'
import { EFFECTS } from '../../../shared/effects'
import { canHaveEffects, clampSpeed, patchEffect, removeEffect, setFreezeLength, setSpeed, SPEED_PRESETS } from '../../../shared/mix'
import { itemDur, itemEnd, mediaOf, projectDuration, subsOf, trackName, trackOf, unlinkSubs, type Clip, type Item, type Project } from '../../../shared/project'
import { MARKER_PALETTE } from './Tracks'
import { fmtTime } from '../format'

interface Props {
  project: Project
  selected: string[]
  onCommit(next: Project, key?: string): void
  onSeek(t: number): void
  /** открыть окошко метки на таймлайне */
  onMarkerPop(id: string | null): void
  /** выбранная рамка клипа (тогда показываем её свойства) */
  /** сообщение пользователю (почему не вышло) */
  onMessage(msg: string): void
  clip: Clip | null
  onFocusClip(id: string): void
  onClipGone(): void
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

const parseTags = (text: string): string[] =>
  [...new Set(text.split(/[\s,]+/).map((x) => x.replace(/^#+/, '').slice(0, 30)).filter(Boolean))].slice(0, 12).map((x) => `#${x}`)

/** Свойства рамки: тексты для публикации, способ кадрирования в 9:16, участие в экспорте. */
function ClipPanel(p: { project: Project; clip: Clip; onCommit(next: Project, key?: string): void; onSeek(t: number): void; onFocus(id: string): void; onGone(): void }): React.JSX.Element {
  const c = p.clip
  const pr = p.project
  const at = placement(pr, c)
  const media = mediaOf(pr, c.mediaId)
  const [tags, setTags] = useState(c.hashtags.join(' '))
  const patch = (x: Parameters<typeof patchClip>[2], key?: string): void => p.onCommit(patchClip(pr, c.id, x), key)
  return (
    <aside className="inspector">
      <div className="pane-head">
        <span>Клип</span>
      </div>
      <div className="insp-body">
        <label className="insp-col">
          <span>Заголовок</span>
          <input type="text" value={c.title} maxLength={120} placeholder="Название ролика" onChange={(e) => patch({ title: e.target.value }, `ct-${c.id}`)} />
        </label>
        <label className="insp-col">
          <span>Описание</span>
          <textarea rows={3} value={c.description} maxLength={1000} onChange={(e) => patch({ description: e.target.value }, `cd-${c.id}`)} />
        </label>
        <label className="insp-col">
          <span>Хэштеги</span>
          <input
            type="text"
            value={tags}
            placeholder="#лес #подкаст"
            onChange={(e) => {
              setTags(e.target.value)
              patch({ hashtags: parseTags(e.target.value) }, `ch-${c.id}`)
            }}
          />
        </label>
        <div className="insp-col">
          <span>Кадр 9:16</span>
          <div className="seg" role="radiogroup" aria-label="Способ кадрирования">
            <button role="radio" aria-checked={c.framing === 'crop'} className={c.framing === 'crop' ? 'on' : ''} onClick={() => patch({ framing: 'crop' })}>
              Кроп
            </button>
            <button role="radio" aria-checked={c.framing === 'fit-blur'} className={c.framing === 'fit-blur' ? 'on' : ''} onClick={() => patch({ framing: 'fit-blur' })}>
              Целиком на блюре
            </button>
          </div>
        </div>
        {c.framing === 'crop' && (
          <label className="insp-row">
            <span>Сдвиг кадра</span>
            <input type="range" min={0} max={1} step={0.01} value={c.offsetX} onChange={(e) => patch({ offsetX: Number(e.target.value) }, `co-${c.id}`)} />
            <span className="mono">{Math.round(c.offsetX * 100)}%</span>
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={c.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          <span>Экспортировать этот клип</span>
        </label>
        {c.note && <p className="hint warn">Подсказка ИИ: {c.note}</p>}
        {c.approx && <p className="hint warn">Границы приблизительные: ИИ не нашёл точные слова. Проверь начало и конец.</p>}
        {c.reason && <p className="hint">Почему выбран: {c.reason}</p>}
        <dl className="insp-grid mono">
          <dt>Длина</dt>
          <dd>{(c.end - c.start).toFixed(1)} с</dd>
          <dt>Из файла</dt>
          <dd>
            {fmtTime(c.start)} – {fmtTime(c.end)}
          </dd>
          <dt>На таймлайне</dt>
          <dd>{at ? `${fmtTime(at.start)} – ${fmtTime(at.end)}` : 'видео убрано'}</dd>
          <dt>Файл</dt>
          <dd title={media?.name}>{media?.name ?? '—'}</dd>
          {c.score !== null && (
            <>
              <dt>Оценка ИИ</dt>
              <dd>{c.score}/10</dd>
            </>
          )}
        </dl>
        <div className="insp-link">
          <button className="btn small" onClick={() => p.onFocus(c.id)} disabled={!at}>
            Открыть в фокусе
          </button>
          <button
            className="btn small"
            onClick={() => {
              p.onCommit(deleteClip(pr, c.id))
              p.onGone()
            }}
          >
            Удалить рамку
          </button>
        </div>
      </div>
    </aside>
  )
}

/** Скорость выделенных кусков видео и звука: число 0.25–4× и пресеты; у нескольких разных кусков — «разное». */
function SpeedRow(p: { project: Project; ids: string[]; onCommit(next: Project, key?: string): void; onMessage(msg: string): void }): React.JSX.Element | null {
  const items = p.project.items.filter((i) => p.ids.includes(i.id) && i.kind === 'media')
  const speeds = [...new Set(items.map((i) => i.speed))]
  const shown = speeds.length === 1 ? String(speeds[0]) : ''
  const [text, setText] = useState(shown)
  // выделение или значение сменились снаружи — поле показывает актуальное
  const sig = `${p.ids.join(',')}|${shown}`
  const [seen, setSeen] = useState(sig)
  if (seen !== sig) {
    setSeen(sig)
    setText(shown)
  }
  if (items.length === 0) return null
  const apply = (v: number): void => {
    const r = setSpeed(p.project, items.map((i) => i.id), v)
    if (r.error) p.onMessage(r.error)
    else p.onCommit(r.p)
    setText(String(clampSpeed(v)))
  }
  return (
    <div className="insp-col">
      <span>Скорость{speeds.length > 1 ? ' · у кусков разная' : ''}</span>
      <div className="speed-row">
        <input
          type="text"
          inputMode="decimal"
          className="mono"
          value={text}
          placeholder="разное"
          aria-label="Скорость, от 0.25 до 4"
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            const v = Number(text.replace(',', '.'))
            if (text.trim() === '' || !Number.isFinite(v)) setText(shown)
            else if (Math.abs(v - Number(shown)) > 1e-9 || speeds.length > 1) apply(v)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            e.stopPropagation()
          }}
        />
        <span className="dim">×</span>
      </div>
      <div className="speed-presets" role="group" aria-label="Скорость, пресеты">
        {SPEED_PRESETS.map((v) => (
          <button key={v} className={speeds.length === 1 && speeds[0] === v ? 'on' : ''} onClick={() => apply(v)}>
            {v}
          </button>
        ))}
      </div>
    </div>
  )
}

const FREEZE_PRESETS = [1, 2, 3, 5, 10]

/** Длительность стоп-кадра: правая часть дорожки сдвигается вместе с ней. */
function FreezeRow(p: { project: Project; item: Item; onCommit(next: Project, key?: string): void; onMessage(msg: string): void }): React.JSX.Element {
  const len = Math.round((p.item.out - p.item.in) * 100) / 100
  const [text, setText] = useState(String(len))
  const [seen, setSeen] = useState(len)
  if (seen !== len) {
    setSeen(len)
    setText(String(len))
  }
  const apply = (v: number): void => {
    const r = setFreezeLength(p.project, p.item.id, v)
    if (r.error) p.onMessage(r.error)
    else p.onCommit(r.p)
  }
  return (
    <div className="insp-col">
      <span>Длительность стоп-кадра, с</span>
      <div className="speed-row">
        <input
          type="text"
          inputMode="decimal"
          className="mono"
          value={text}
          aria-label="Длительность стоп-кадра, секунды"
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            const v = Number(text.replace(',', '.'))
            if (!Number.isFinite(v) || v <= 0) setText(String(len))
            else if (Math.abs(v - len) > 1e-9) apply(v)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            e.stopPropagation()
          }}
        />
      </div>
      <div className="speed-presets" role="group" aria-label="Длительность, пресеты">
        {FREEZE_PRESETS.map((v) => (
          <button key={v} className={len === v ? 'on' : ''} onClick={() => apply(v)}>
            {v}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Эффекты куска: сила ползунком, глаз «вкл/выкл», удалить. */
function EffectsBlock(p: { project: Project; item: Item; onCommit(next: Project, key?: string): void }): React.JSX.Element {
  return (
    <div className="insp-col">
      <span>Эффекты</span>
      {p.item.effects.length === 0 && <span className="dim fx-none">Пока нет: вкладка «Эффекты» слева в панели медиа</span>}
      {p.item.effects.map((e) => (
        <div key={e.id} className={`fx-row${e.on ? '' : ' off'}`}>
          <button className="fx-eye" aria-pressed={!e.on} title={e.on ? 'Выключить эффект' : 'Включить эффект'} onClick={() => p.onCommit(patchEffect(p.project, p.item.id, e.id, { on: !e.on }))}>
            {e.on ? '●' : '○'}
          </button>
          <span className="fx-title">{EFFECTS[e.type].title}</span>
          <input type="range" min={0} max={100} step={1} value={e.strength} onChange={(ev) => p.onCommit(patchEffect(p.project, p.item.id, e.id, { strength: Number(ev.target.value) }), `fx-${e.id}`)} aria-label={`${EFFECTS[e.type].title}: сила`} />
          <span className="mono fx-val">{e.strength}</span>
          <button className="fx-del" title="Убрать эффект" aria-label="Убрать эффект" onClick={() => p.onCommit(removeEffect(p.project, p.item.id, e.id))}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

function Inspector(p: Props): React.JSX.Element {
  const pr = p.project
  if (p.clip) return <ClipPanel key={p.clip.id} project={pr} clip={p.clip} onCommit={p.onCommit} onSeek={p.onSeek} onFocus={p.onFocusClip} onGone={p.onClipGone} />
  const one = p.selected.length === 1 ? pr.items.find((i) => i.id === p.selected[0]) : undefined
  const m = one ? mediaOf(pr, one.mediaId) : undefined

  if (one && m) {
    const track = trackOf(pr, one.trackId)
    return (
      <aside className="inspector">
        <div className="pane-head">
          <span>{one.kind === 'freeze' ? 'Стоп-кадр' : 'Кусок'}</span>
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
            <dt>{one.kind === 'freeze' ? 'Кадр из файла' : 'Из файла'}</dt>
            <dd>{one.kind === 'freeze' ? fmtTime(one.in) : `${fmtTime(one.in)} – ${fmtTime(one.out)}`}</dd>
            <dt>Дорожка</dt>
            <dd>{track ? trackName(pr, track.id) : '—'}</dd>
          </dl>
          <SpeedRow project={pr} ids={[one.id]} onCommit={p.onCommit} onMessage={p.onMessage} />
          {one.kind === 'freeze' && <FreezeRow key={one.id} project={pr} item={one} onCommit={p.onCommit} onMessage={p.onMessage} />}
          {canHaveEffects(pr, one) && <EffectsBlock project={pr} item={one} onCommit={p.onCommit} />}
          {subsOf(pr, one.id).length > 0 && (
            <div className="insp-link">
              <span className="dim">Субтитры едут вместе с этим видео</span>
              <button className="btn small" onClick={() => p.onCommit(subsOf(pr, one.id).reduce((acc, s) => unlinkSubs(acc, s.id), pr))}>
                Разгруппировать
              </button>
            </div>
          )}
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
        {p.selected.length > 1 && <SpeedRow project={pr} ids={p.selected} onCommit={p.onCommit} onMessage={p.onMessage} />}
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
