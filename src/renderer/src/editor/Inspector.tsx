/** Инспектор: свойства выделенного куска или, если ничего не выделено, — проекта. */
import { memo, useState } from 'react'
import { deleteClip, patchClip, placement } from '../../../shared/cut'
import { hasKeys, KEY_PROPS, type KeyProp } from '../../../shared/anim'
import { EFFECTS } from '../../../shared/effects'
import { FONTS, fontById } from '../../../shared/fonts'
import { FRAME_LIMITS, isDefaultFrame, type FrameKey } from '../../../shared/frame'
import { MAX_PLATE_TEXT, PLATE_LIMITS, type Plate } from '../../../shared/plate'
import { canHaveEffects, clampSpeed, disableKeys, enableKeys, frameValueAt, hasFrameCrop, patchEffect, patchFrame, patchPlate, removeEffect, resetFrame, setFreezeLength, setPropAt, setSpeed, SPEED_PRESETS } from '../../../shared/mix'
import { itemDur, itemEnd, mediaOf, projectDuration, subsOf, trackName, trackOf, trimItem, unlinkSubs, type Clip, type Item, type Project } from '../../../shared/project'
import { MARKER_PALETTE } from './Tracks'
import { fmtTime } from '../format'

interface Props {
  project: Project
  selected: string[]
  /** время курсора, если у выделенного куска есть ключи (поля идут за курсором); иначе −1 */
  time: number
  /** время курсора прямо сейчас (для ромбиков и правок) */
  getTime(): number
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

/** Эффекты куска: у каждого заголовок (глаз «вкл/выкл», удалить) и параметры — ползунки или выбор из вариантов. */
function EffectsBlock(p: { project: Project; item: Item; onCommit(next: Project, key?: string): void }): React.JSX.Element {
  const text = p.item.kind === 'text'
  return (
    <div className="insp-col">
      <span>{text ? 'Анимации' : 'Эффекты'}</span>
      {p.item.effects.length === 0 && <span className="dim fx-none">Пока нет: вкладка «Эффекты» слева в панели медиа</span>}
      {p.item.effects.map((e) => (
        <div key={e.id} className={`fx-box${e.on ? '' : ' off'}`}>
          <div className="fx-head">
            <button className="fx-eye" aria-pressed={!e.on} title={e.on ? 'Выключить эффект' : 'Включить эффект'} onClick={() => p.onCommit(patchEffect(p.project, p.item.id, e.id, { on: !e.on }))}>
              {e.on ? '●' : '○'}
            </button>
            <span className="fx-title">{EFFECTS[e.type].title}</span>
            <button className="fx-del" title="Убрать эффект" aria-label="Убрать эффект" onClick={() => p.onCommit(removeEffect(p.project, p.item.id, e.id))}>
              ×
            </button>
          </div>
          {EFFECTS[e.type].params.map((pr) => {
            const val = e.values[pr.key] ?? pr.default
            if (pr.options) {
              return (
                <div key={pr.key} className="fx-param fx-choice">
                  <span>{pr.title}</span>
                  <div className="seg" role="radiogroup" aria-label={`${EFFECTS[e.type].title}: ${pr.title}`}>
                    {pr.options.map((o, i) => (
                      <button key={o} role="radio" aria-checked={val === i} className={val === i ? 'on' : ''} onClick={() => p.onCommit(patchEffect(p.project, p.item.id, e.id, { key: pr.key, value: i }))}>
                        {o}
                      </button>
                    ))}
                  </div>
                </div>
              )
            }
            return (
              <label key={pr.key} className="fx-param">
                <span>{pr.title}</span>
                <input
                  type="range"
                  min={pr.min}
                  max={pr.max}
                  step={pr.step ?? 1}
                  value={val}
                  onChange={(ev) => p.onCommit(patchEffect(p.project, p.item.id, e.id, { key: pr.key, value: Number(ev.target.value) }), `fx-${e.id}-${pr.key}`)}
                  aria-label={`${EFFECTS[e.type].title}: ${pr.title}`}
                />
                <span className="mono fx-val">
                  {val}
                  {pr.unit ? ` ${pr.unit}` : ''}
                </span>
              </label>
            )
          })}
        </div>
      ))}
    </div>
  )
}

const FRAME_ROWS: Array<{ key: FrameKey; title: string; textTitle?: string }> = [
  { key: 'scale', title: 'Масштаб, %' },
  { key: 'x', title: 'Положение X, %', textTitle: 'Сдвиг X, %' },
  { key: 'y', title: 'Положение Y, %', textTitle: 'Сдвиг Y, %' },
  { key: 'opacity', title: 'Прозрачность, %' },
  { key: 'cl', title: 'Кроп слева, %' },
  { key: 'cr', title: 'Кроп справа, %' },
  { key: 'ct', title: 'Кроп сверху, %' },
  { key: 'cb', title: 'Кроп снизу, %' }
]

/** Ромбик у поля: включён — свойство меняется по времени (правки ставят ключи), выключен — одно значение на весь кусок. */
function KeyDiamond(p: { on: boolean; title: string; onClick(): void }): React.JSX.Element {
  return (
    <button className={`kf-btn${p.on ? ' on' : ''}`} aria-pressed={p.on} title={p.title} aria-label={p.title} onClick={p.onClick}>
      <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
        <path d="M7 1.4 12.6 7 7 12.6 1.4 7Z" fill={p.on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

/** Один числовой ввод кадра: правка применяется по Enter/уходу из поля, ползунок — сразу. key — ромбик ключевых кадров (если свойство анимируется). */
function FrameField(p: { value: number; k: FrameKey; title: string; keyed?: { on: boolean; title: string; onToggle(): void }; onChange(k: FrameKey, v: number, live: boolean): void }): React.JSX.Element {
  const val = p.value
  const [text, setText] = useState(String(val))
  const [seen, setSeen] = useState(val)
  if (seen !== val) {
    setSeen(val)
    setText(String(val))
  }
  const [lo, hi] = FRAME_LIMITS[p.k]
  return (
    <label className={`frame-field${p.keyed ? ' has-kf' : ''}`}>
      <span>{p.title}</span>
      <input type="range" min={lo} max={hi} step={1} value={Math.round(val)} onChange={(e) => p.onChange(p.k, Number(e.target.value), true)} aria-label={p.title} />
      <input
        type="text"
        inputMode="decimal"
        className="mono"
        value={text}
        aria-label={`${p.title}, число`}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const v = Number(text.replace(',', '.'))
          if (!Number.isFinite(v)) setText(String(val))
          else if (v !== val) p.onChange(p.k, v, false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          e.stopPropagation()
        }}
      />
      {p.keyed && <KeyDiamond on={p.keyed.on} title={p.keyed.title} onClick={p.keyed.onToggle} />}
    </label>
  )
}

const CROP_KEYS: FrameKey[] = ['cl', 'cr', 'ct', 'cb']
const isKeyProp = (k: FrameKey): k is KeyProp => (KEY_PROPS as string[]).includes(k)

/**
 * Кадр куска: масштаб, положение, прозрачность (у каждого ромбик ключевых кадров) и кроп; «Сбросить». Мышью — рамка в превью.
 * У надписи кропа нет, а X/Y — сдвиг от её положения.
 */
function FrameBlock(p: { project: Project; item: Item; time: number; getTime(): number; onCommit(next: Project, key?: string): void }): React.JSX.Element {
  const f = p.item.frame
  const text = p.item.kind === 'text'
  const id = p.item.id
  const toggle = (k: KeyProp): void => {
    const n = p.item.keys[k].length
    if (n === 0) p.onCommit(enableKeys(p.project, id, k, p.getTime()))
    else if (n === 1 || window.confirm('Убрать все ключевые кадры этого свойства? Останется значение в текущей точке.')) p.onCommit(disableKeys(p.project, id, k, p.getTime()))
  }
  return (
    <div className="insp-col">
      <span>Кадр</span>
      <div className="frame-grid">
        {FRAME_ROWS.filter((r) => !(text && CROP_KEYS.includes(r.key))).map((r) => {
          const k = r.key
          const keyed = isKeyProp(k) && p.item.keys[k].length > 0
          const value = isKeyProp(k) && keyed ? frameValueAt(p.item, k, p.time) : f[k]
          const title = text && r.textTitle ? r.textTitle : r.title
          return (
            <FrameField
              key={k}
              value={Math.round(value * 100) / 100}
              k={k}
              title={title}
              keyed={isKeyProp(k) ? { on: keyed, title: keyed ? 'Убрать ключевые кадры' : 'Анимировать: ключевые кадры', onToggle: () => toggle(k) } : undefined}
              onChange={(kk, v, live) =>
                p.onCommit(isKeyProp(kk) ? setPropAt(p.project, id, kk, p.getTime(), v) : patchFrame(p.project, id, { [kk]: v }, kk), live ? `fr-${id}-${kk}` : undefined)
              }
            />
          )
        })}
      </div>
      <div className="insp-link">
        <button className="btn small" disabled={isDefaultFrame(f) && !hasKeys(p.item.keys)} onClick={() => p.onCommit(resetFrame(p.project, id))}>
          Сбросить
        </button>
      </div>
    </div>
  )
}

/** Числовое поле с ползунком: правка по Enter/уходу из поля, ползунок — сразу. */
function NumField(p: { title: string; value: number; lo: number; hi: number; step?: number; onChange(v: number, live: boolean): void }): React.JSX.Element {
  const [text, setText] = useState(String(p.value))
  const [seen, setSeen] = useState(p.value)
  if (seen !== p.value) {
    setSeen(p.value)
    setText(String(p.value))
  }
  return (
    <label className="frame-field">
      <span>{p.title}</span>
      <input type="range" min={p.lo} max={p.hi} step={p.step ?? 1} value={p.value} onChange={(e) => p.onChange(Number(e.target.value), true)} aria-label={p.title} />
      <input
        type="text"
        inputMode="decimal"
        className="mono"
        value={text}
        aria-label={`${p.title}, число`}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const v = Number(text.replace(',', '.'))
          if (!Number.isFinite(v)) setText(String(p.value))
          else if (v !== p.value) p.onChange(v, false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          e.stopPropagation()
        }}
      />
    </label>
  )
}

/** Панель надписи: текст, шрифт, размер, цвет, выравнивание, обводка, тень, положение и ширина, длительность. */
function TextPanel(p: { project: Project; item: Item; time: number; getTime(): number; onCommit(next: Project, key?: string): void; onMessage(msg: string): void }): React.JSX.Element | null {
  const pl = p.item.plate
  const [lenText, setLenText] = useState(String(Math.round(itemDur(p.item) * 100) / 100))
  const [lenSeen, setLenSeen] = useState(itemDur(p.item))
  if (!pl) return null
  if (lenSeen !== itemDur(p.item)) {
    setLenSeen(itemDur(p.item))
    setLenText(String(Math.round(itemDur(p.item) * 100) / 100))
  }
  const id = p.item.id
  const patch = (x: Partial<Plate>, key?: string): void => p.onCommit(patchPlate(p.project, id, x), key)
  const font = fontById(pl.font)
  return (
    <aside className="inspector">
      <div className="pane-head">
        <span>Надпись</span>
      </div>
      <div className="insp-body">
        <label className="insp-col">
          <span>Текст</span>
          <textarea rows={3} value={pl.text} maxLength={MAX_PLATE_TEXT} onChange={(e) => patch({ text: e.target.value }, `pt-${id}`)} onKeyDown={(e) => e.stopPropagation()} />
        </label>
        <div className="insp-col">
          <span>Длительность, с</span>
          <div className="speed-row">
            <input
              type="text"
              inputMode="decimal"
              className="mono"
              value={lenText}
              aria-label="Длительность надписи, секунды"
              onChange={(e) => setLenText(e.target.value)}
              onBlur={() => {
                const v = Number(lenText.replace(',', '.'))
                if (!Number.isFinite(v) || v <= 0) setLenText(String(Math.round(itemDur(p.item) * 100) / 100))
                else p.onCommit(trimItem(p.project, id, 'end', p.item.start + v))
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                e.stopPropagation()
              }}
            />
          </div>
        </div>
        <label className="insp-row">
          <span>Шрифт</span>
          <select
            value={pl.font}
            onChange={(e) => {
              const f = fontById(e.target.value)
              patch({ font: f.id, weight: f.weights.includes(pl.weight) ? pl.weight : (f.weights.find((w) => w >= pl.weight) ?? f.weights[f.weights.length - 1]) })
            }}
          >
            {FONTS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="insp-row">
          <span>Начертание</span>
          <select value={pl.weight} onChange={(e) => patch({ weight: Number(e.target.value) })}>
            {font.weights.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
        <NumField title="Размер, %" value={pl.size} lo={PLATE_LIMITS.size[0]} hi={PLATE_LIMITS.size[1]} step={0.5} onChange={(v, live) => patch({ size: v }, live ? `ps-${id}` : undefined)} />
        <label className="insp-row">
          <span>Цвет</span>
          <input type="color" value={pl.color} onChange={(e) => patch({ color: e.target.value }, `pc-${id}`)} />
        </label>
        <div className="insp-col">
          <span>Выравнивание</span>
          <div className="seg" role="radiogroup" aria-label="Выравнивание текста">
            {(['left', 'center', 'right'] as const).map((a) => (
              <button key={a} role="radio" aria-checked={pl.align === a} className={pl.align === a ? 'on' : ''} onClick={() => patch({ align: a })}>
                {a === 'left' ? 'Слева' : a === 'center' ? 'По центру' : 'Справа'}
              </button>
            ))}
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={pl.strokeOn} onChange={(e) => patch({ strokeOn: e.target.checked })} />
          <span>Обводка</span>
        </label>
        {pl.strokeOn && (
          <>
            <label className="insp-row">
              <span>Цвет обводки</span>
              <input type="color" value={pl.strokeColor} onChange={(e) => patch({ strokeColor: e.target.value }, `psc-${id}`)} />
            </label>
            <NumField title="Толщина, %" value={pl.stroke} lo={PLATE_LIMITS.stroke[0]} hi={PLATE_LIMITS.stroke[1]} onChange={(v, live) => patch({ stroke: v }, live ? `pst-${id}` : undefined)} />
          </>
        )}
        <label className="check">
          <input type="checkbox" checked={pl.shadowOn} onChange={(e) => patch({ shadowOn: e.target.checked })} />
          <span>Тень</span>
        </label>
        {pl.shadowOn && (
          <label className="insp-row">
            <span>Цвет тени</span>
            <input type="color" value={pl.shadowColor} onChange={(e) => patch({ shadowColor: e.target.value }, `pshc-${id}`)} />
          </label>
        )}
        <NumField title="Положение X, %" value={pl.x} lo={PLATE_LIMITS.x[0]} hi={PLATE_LIMITS.x[1]} onChange={(v, live) => patch({ x: v }, live ? `px-${id}` : undefined)} />
        <NumField title="Положение Y, %" value={pl.y} lo={PLATE_LIMITS.y[0]} hi={PLATE_LIMITS.y[1]} onChange={(v, live) => patch({ y: v }, live ? `py-${id}` : undefined)} />
        <NumField title="Ширина, %" value={pl.width} lo={PLATE_LIMITS.width[0]} hi={PLATE_LIMITS.width[1]} onChange={(v, live) => patch({ width: v }, live ? `pw-${id}` : undefined)} />
        <FrameBlock project={p.project} item={p.item} time={p.time} getTime={p.getTime} onCommit={p.onCommit} />
        <EffectsBlock project={p.project} item={p.item} onCommit={p.onCommit} />
      </div>
    </aside>
  )
}

function Inspector(p: Props): React.JSX.Element {
  const pr = p.project
  if (p.clip) return <ClipPanel key={p.clip.id} project={pr} clip={p.clip} onCommit={p.onCommit} onSeek={p.onSeek} onFocus={p.onFocusClip} onGone={p.onClipGone} />
  const one = p.selected.length === 1 ? pr.items.find((i) => i.id === p.selected[0]) : undefined
  const m = one ? mediaOf(pr, one.mediaId) : undefined
  if (one && one.kind === 'text') return <TextPanel key={one.id} project={pr} item={one} time={p.time} getTime={p.getTime} onCommit={p.onCommit} onMessage={p.onMessage} />

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
          {hasFrameCrop(pr, one) && <FrameBlock project={pr} item={one} time={p.time} getTime={p.getTime} onCommit={p.onCommit} />}
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
