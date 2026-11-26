/** Инспектор: свойства выделенного куска или, если ничего не выделено, — проекта. */
import { memo, useRef, useState } from 'react'
import { deleteClip, patchClip, placement } from '../../../shared/cut'
import { hasKeys, KEY_PROPS, type KeyProp } from '../../../shared/anim'
import { EFFECTS, type Effect } from '../../../shared/effects'
import { FONTS, fontById } from '../../../shared/fonts'
import { FRAME_LIMITS, isDefaultFrame, type FrameKey } from '../../../shared/frame'
import { MAX_PLATE_TEXT, PLATE_LIMITS, plateLabel, type Plate } from '../../../shared/plate'
import { SHAPE_LIMITS, shapeLabel } from '../../../shared/shape'
import { canHaveEffects, clampSpeed, disableKeys, enableKeys, frameValueAt, hasFrameCrop, patchEffect, patchFrame, patchPlate, patchShape, removeEffect, resetFrame, setFreezeLength, setPropAt, setSpeed, SPEED_PRESETS, toggleFlip } from '../../../shared/mix'
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

/** Короткое значение эффекта для свёрнутой строки: «слева · 0,5 с», «50%». */
function effectSummary(e: Effect): string {
  const info = EFFECTS[e.type]
  const parts: string[] = []
  for (const pr of info.params) {
    const v = e.values[pr.key] ?? pr.default
    if (pr.options) parts.push(pr.options[v]?.toLowerCase() ?? '')
    else if (e.type === 'color' && v === pr.default) continue
    else parts.push(`${String(v).replace('.', ',')}${pr.unit ? (pr.unit === '%' ? '%' : ` ${pr.unit}`) : ''}`)
  }
  return parts.filter(Boolean).join(' · ') || 'по умолчанию'
}

/**
 * Эффекты или анимации куска свёрнутыми строками: глаз «вкл/выкл», название, значение кратко, ×. Щелчок по строке раскрывает
 * настройки; раскрыта одна строка за раз.
 */
function EffectRows(p: { project: Project; item: Item; anim: boolean; onCommit(next: Project, key?: string): void }): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const list = p.item.effects.filter((e) => !!EFFECTS[e.type].anim === p.anim)
  return (
    <div className="fxr-list">
      {list.length === 0 && <p className="dim fx-none">Пока нет: вкладка «Эффекты» слева в панели медиа</p>}
      {list.map((e) => {
        const info = EFFECTS[e.type]
        const isOpen = open === e.id
        return (
          <div key={e.id} className={`fxr${e.on ? '' : ' off'}${isOpen ? ' open' : ''}`}>
            <div className="fxr-head">
              <button className="fx-eye" aria-pressed={!e.on} title={e.on ? 'Выключить' : 'Включить'} onClick={() => p.onCommit(patchEffect(p.project, p.item.id, e.id, { on: !e.on }))}>
                {e.on ? '●' : '○'}
              </button>
              <button className="fxr-main" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : e.id)}>
                <span className="fx-title">{info.title}</span>
                <span className="fxr-sum mono">{effectSummary(e)}</span>
              </button>
              <button className="fx-del" title="Убрать" aria-label="Убрать" onClick={() => p.onCommit(removeEffect(p.project, p.item.id, e.id))}>
                ×
              </button>
            </div>
            {isOpen && (
              <div className="fxr-body">
                {info.params.map((pr) => {
                  const val = e.values[pr.key] ?? pr.default
                  if (pr.options) {
                    return (
                      <div key={pr.key} className="fx-param fx-choice">
                        <span>{pr.title}</span>
                        <div className="seg" role="radiogroup" aria-label={`${info.title}: ${pr.title}`}>
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
                        aria-label={`${info.title}: ${pr.title}`}
                      />
                      <span className="mono fx-val">
                        {String(val).replace('.', ',')}
                        {pr.unit ? (pr.unit === '%' ? '%' : ` ${pr.unit}`) : ''}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

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

const fmtNum = (v: number): string => String(Math.round(v * 100) / 100).replace('.', ',')

interface KeyedProp {
  on: boolean
  onToggle(): void
}

/**
 * Числовое поле: подпись можно тянуть мышью влево-вправо (Shift — медленнее), число вводится руками (Enter/уход из поля),
 * справа ромбик ключевых кадров, если свойство анимируется. slider — ещё и ползунок (масштаб, прозрачность).
 */
function Field(p: {
  title: string
  value: number
  lo: number
  hi: number
  step?: number
  unit?: string
  keyed?: KeyedProp
  slider?: boolean
  onChange(v: number, live: boolean): void
}): React.JSX.Element {
  const [text, setText] = useState(fmtNum(p.value))
  const [seen, setSeen] = useState(p.value)
  if (seen !== p.value) {
    setSeen(p.value)
    setText(fmtNum(p.value))
  }
  const step = p.step ?? 1
  const drag = useRef<{ x: number; v: number } | null>(null)
  const snap = (v: number): number => Math.min(p.hi, Math.max(p.lo, Math.round(v / step) * step))
  return (
    <div className={`fld${p.slider ? ' wide' : ''}${p.keyed ? '' : ' nokf'}`}>
      <span
        className="fld-label"
        title="Потяни влево-вправо; Shift — медленнее"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, v: p.value }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          const k = ((p.hi - p.lo) / 300) * (e.shiftKey ? 0.2 : 1)
          const v = snap(d.v + (e.clientX - d.x) * k)
          if (v !== p.value) p.onChange(v, true)
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        {p.title}
      </span>
      {p.slider && <input type="range" className="fld-range" min={p.lo} max={p.hi} step={step} value={Math.min(p.hi, Math.max(p.lo, p.value))} onChange={(e) => p.onChange(Number(e.target.value), true)} aria-label={p.title} />}
      <span className="fld-num">
        <input
          type="text"
          inputMode="decimal"
          className="mono"
          value={text}
          aria-label={`${p.title}, число`}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            const v = Number(text.replace(',', '.'))
            if (!Number.isFinite(v)) setText(fmtNum(p.value))
            else if (v !== p.value) p.onChange(v, false)
            else setText(fmtNum(p.value))
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            e.stopPropagation()
          }}
        />
        {p.unit && <i>{p.unit}</i>}
      </span>
      {p.keyed && <KeyDiamond on={p.keyed.on} title={p.keyed.on ? 'Убрать ключевые кадры' : 'Анимировать: ключевые кадры'} onClick={p.keyed.onToggle} />}
    </div>
  )
}

/** Подзаголовок внутри вкладки. */
const Sub = (p: { children: React.ReactNode }): React.JSX.Element => <div className="insp-sub">{p.children}</div>

/** Оболочка инспектора куска: название куска в шапке, вкладки, прокручиваемое тело. */
function Shell(p: { name: string; hint?: string; tabs: Array<{ id: string; label: string; n?: number }>; tab: string; onTab(id: string): void; children: React.ReactNode }): React.JSX.Element {
  return (
    <aside className="inspector">
      <div className="pane-head">
        <span className="insp-name" title={p.hint ?? p.name}>
          {p.name}
        </span>
      </div>
      <div className="insp-tabs" role="tablist">
        {p.tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={p.tab === t.id} className={p.tab === t.id ? 'on' : ''} onClick={() => p.onTab(t.id)}>
            {t.label}
            {t.n ? <i>{t.n}</i> : null}
          </button>
        ))}
      </div>
      <div className="insp-body">{p.children}</div>
    </aside>
  )
}

/** Открытая вкладка запоминается (отдельно для видео и для надписей и фигур); нет такой у куска — первая. */
function useTab(group: string, ids: string[]): [string, (t: string) => void] {
  const key = `insp-tab-${group}`
  const [saved, setSaved] = useState<string>(() => {
    try {
      return localStorage.getItem(key) ?? ''
    } catch {
      return ''
    }
  })
  const tab = ids.includes(saved) ? saved : ids[0]
  return [
    tab,
    (t) => {
      setSaved(t)
      try {
        localStorage.setItem(key, t)
      } catch {
        /* не страшно */
      }
    }
  ]
}

const isKeyProp = (k: FrameKey): k is KeyProp => (KEY_PROPS as string[]).includes(k)

/** Поля «Кадра», общие для всех кусков с картинкой: масштаб, прозрачность, положение или сдвиг (с ромбиками), зеркало, сброс. cropToo — ещё и кроп. */
function FrameTab(p: { project: Project; item: Item; time: number; getTime(): number; shift: boolean; crop: boolean; onCommit(next: Project, key?: string): void }): React.JSX.Element {
  const f = p.item.frame
  const id = p.item.id
  const toggle = (k: KeyProp): void => {
    const n = p.item.keys[k].length
    if (n === 0) p.onCommit(enableKeys(p.project, id, k, p.getTime()))
    else if (n === 1 || window.confirm('Убрать все ключевые кадры этого свойства? Останется значение в текущей точке.')) p.onCommit(disableKeys(p.project, id, k, p.getTime()))
  }
  // одно поле кадра: ключи — значение линии в момент курсора; правка идёт через ключи, если они есть
  const fld = (k: FrameKey, title: string, extra: { slider?: boolean; unit?: string } = {}): React.JSX.Element => {
    const keyed = isKeyProp(k) && p.item.keys[k].length > 0
    const value = isKeyProp(k) && keyed ? frameValueAt(p.item, k, p.time) : f[k]
    const [lo, hi] = FRAME_LIMITS[k]
    return (
      <Field
        title={title}
        value={Math.round(value * 100) / 100}
        lo={lo}
        hi={hi}
        unit={extra.unit ?? '%'}
        slider={extra.slider}
        keyed={isKeyProp(k) ? { on: keyed, onToggle: () => toggle(k) } : undefined}
        onChange={(v, live) => p.onCommit(isKeyProp(k) ? setPropAt(p.project, id, k, p.getTime(), v) : patchFrame(p.project, id, { [k]: v }, k), live ? `fr-${id}-${k}` : undefined)}
      />
    )
  }
  return (
    <>
      {fld('scale', 'Масштаб', { slider: true })}
      {fld('opacity', 'Прозрачность', { slider: true })}
      <Sub>{p.shift ? 'Сдвиг' : 'Положение'}</Sub>
      <div className="fld-pair">
        {fld('x', 'X')}
        {fld('y', 'Y')}
      </div>
      <Sub>Зеркало</Sub>
      <div className="seg flip-seg" role="group" aria-label="Зеркало">
        <button className={f.flipH ? 'on' : ''} aria-pressed={f.flipH === 1} onClick={() => p.onCommit(toggleFlip(p.project, [id], 'h').p)} title="Отзеркалить по горизонтали">
          ⇄ Горизонтально
        </button>
        <button className={f.flipV ? 'on' : ''} aria-pressed={f.flipV === 1} onClick={() => p.onCommit(toggleFlip(p.project, [id], 'v').p)} title="Отзеркалить по вертикали">
          ⇅ Вертикально
        </button>
      </div>
      {p.crop && (
        <>
          <Sub>Кроп</Sub>
          <div className="fld-pair">
            {fld('cl', 'Слева')}
            {fld('cr', 'Справа')}
          </div>
          <div className="fld-pair">
            {fld('ct', 'Сверху')}
            {fld('cb', 'Снизу')}
          </div>
        </>
      )}
      <div className="insp-link">
        <button className="btn small" disabled={isDefaultFrame(f) && !hasKeys(p.item.keys)} onClick={() => p.onCommit(resetFrame(p.project, id))}>
          Сбросить кадр
        </button>
      </div>
    </>
  )
}

/** Длительность надписи или фигуры, секунды: правка двигает правый край. */
function LenRow(p: { project: Project; item: Item; onCommit(next: Project, key?: string): void }): React.JSX.Element {
  const len = Math.round(itemDur(p.item) * 100) / 100
  return (
    <Field
      title="Длительность"
      value={len}
      lo={0.1}
      hi={60}
      step={0.1}
      unit="с"
      onChange={(v) => p.onCommit(trimItem(p.project, p.item.id, 'end', p.item.start + Math.max(0.1, v)))}
    />
  )
}

/** Надпись: вкладки «Текст», «Кадр», «Анимация». */
function TextPanel(p: { project: Project; item: Item; time: number; getTime(): number; onCommit(next: Project, key?: string): void }): React.JSX.Element | null {
  const pl = p.item.plate
  const anims = p.item.effects.filter((e) => EFFECTS[e.type].anim).length
  const [tab, setTab] = useTab('layer', ['content', 'frame', 'anim'])
  if (!pl) return null
  const id = p.item.id
  const patch = (x: Partial<Plate>, key?: string): void => p.onCommit(patchPlate(p.project, id, x), key)
  const font = fontById(pl.font)
  const L = PLATE_LIMITS
  return (
    <Shell name={plateLabel(pl)} tabs={[{ id: 'content', label: 'Текст' }, { id: 'frame', label: 'Кадр' }, { id: 'anim', label: 'Анимация', n: anims }]} tab={tab} onTab={setTab}>
      {tab === 'content' && (
        <>
          <textarea rows={3} value={pl.text} maxLength={MAX_PLATE_TEXT} aria-label="Текст надписи" onChange={(e) => patch({ text: e.target.value }, `pt-${id}`)} onKeyDown={(e) => e.stopPropagation()} />
          <LenRow project={p.project} item={p.item} onCommit={p.onCommit} />
          <div className="fld-pair">
            <select
              aria-label="Шрифт"
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
            <select aria-label="Начертание" value={pl.weight} onChange={(e) => patch({ weight: Number(e.target.value) })}>
              {font.weights.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </div>
          <div className="fld-pair">
            <Field title="Размер" value={pl.size} lo={L.size[0]} hi={L.size[1]} step={0.5} unit="%" onChange={(v, live) => patch({ size: v }, live ? `ps-${id}` : undefined)} />
            <label className="fld color-fld">
              <span className="fld-label">Цвет</span>
              <input type="color" value={pl.color} onChange={(e) => patch({ color: e.target.value }, `pc-${id}`)} />
            </label>
          </div>
          <div className="seg" role="radiogroup" aria-label="Выравнивание текста">
            {(['left', 'center', 'right'] as const).map((a) => (
              <button key={a} role="radio" aria-checked={pl.align === a} className={pl.align === a ? 'on' : ''} onClick={() => patch({ align: a })}>
                {a === 'left' ? 'Слева' : a === 'center' ? 'По центру' : 'Справа'}
              </button>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={pl.strokeOn} onChange={(e) => patch({ strokeOn: e.target.checked })} />
            <span>Обводка</span>
          </label>
          {pl.strokeOn && (
            <div className="fld-pair">
              <label className="fld color-fld">
                <span className="fld-label">Цвет</span>
                <input type="color" value={pl.strokeColor} onChange={(e) => patch({ strokeColor: e.target.value }, `psc-${id}`)} />
              </label>
              <Field title="Толщина" value={pl.stroke} lo={L.stroke[0]} hi={L.stroke[1]} unit="%" onChange={(v, live) => patch({ stroke: v }, live ? `pst-${id}` : undefined)} />
            </div>
          )}
          <label className="check">
            <input type="checkbox" checked={pl.shadowOn} onChange={(e) => patch({ shadowOn: e.target.checked })} />
            <span>Тень</span>
          </label>
          {pl.shadowOn && (
            <label className="fld color-fld">
              <span className="fld-label">Цвет тени</span>
              <input type="color" value={pl.shadowColor} onChange={(e) => patch({ shadowColor: e.target.value }, `pshc-${id}`)} />
            </label>
          )}
        </>
      )}
      {tab === 'frame' && (
        <>
          <Sub>Положение блока</Sub>
          <div className="fld-pair">
            <Field title="X" value={pl.x} lo={L.x[0]} hi={L.x[1]} step={0.5} unit="%" onChange={(v, live) => patch({ x: v }, live ? `px-${id}` : undefined)} />
            <Field title="Y" value={pl.y} lo={L.y[0]} hi={L.y[1]} step={0.5} unit="%" onChange={(v, live) => patch({ y: v }, live ? `py-${id}` : undefined)} />
          </div>
          <Field title="Ширина" value={pl.width} lo={L.width[0]} hi={L.width[1]} unit="%" onChange={(v, live) => patch({ width: v }, live ? `pw-${id}` : undefined)} />
          <FrameTab project={p.project} item={p.item} time={p.time} getTime={p.getTime} shift crop={false} onCommit={p.onCommit} />
        </>
      )}
      {tab === 'anim' && <EffectRows project={p.project} item={p.item} anim onCommit={p.onCommit} />}
    </Shell>
  )
}

/** Фигура: вкладки «Фигура», «Кадр», «Анимация». */
function ShapePanel(p: { project: Project; item: Item; time: number; getTime(): number; onCommit(next: Project, key?: string): void }): React.JSX.Element | null {
  const sh = p.item.shape
  const anims = p.item.effects.filter((e) => EFFECTS[e.type].anim).length
  const [tab, setTab] = useTab('layer', ['content', 'frame', 'anim'])
  if (!sh) return null
  const id = p.item.id
  const patch = (x: Partial<typeof sh>, key?: string): void => p.onCommit(patchShape(p.project, id, x), key)
  const closed = sh.kind === 'rect' || sh.kind === 'round' || sh.kind === 'circle'
  const L = SHAPE_LIMITS
  return (
    <Shell name={shapeLabel(sh)} tabs={[{ id: 'content', label: 'Фигура' }, { id: 'frame', label: 'Кадр' }, { id: 'anim', label: 'Анимация', n: anims }]} tab={tab} onTab={setTab}>
      {tab === 'content' && (
        <>
          <LenRow project={p.project} item={p.item} onCommit={p.onCommit} />
          <label className="fld color-fld wide">
            <span className="fld-label">Цвет</span>
            <input type="color" value={sh.fill} onChange={(e) => patch({ fill: e.target.value }, `sf-${id}`)} />
          </label>
          {closed && (
            <>
              <label className="check">
                <input type="checkbox" checked={sh.strokeOn} onChange={(e) => patch({ strokeOn: e.target.checked })} />
                <span>Обводка</span>
              </label>
              {sh.strokeOn && (
                <div className="fld-pair">
                  <label className="fld color-fld">
                    <span className="fld-label">Цвет</span>
                    <input type="color" value={sh.strokeColor} onChange={(e) => patch({ strokeColor: e.target.value }, `ssc-${id}`)} />
                  </label>
                  <Field title="Толщина" value={sh.stroke} lo={L.stroke[0]} hi={L.stroke[1]} step={0.1} unit="%" onChange={(v, live) => patch({ stroke: v }, live ? `sst-${id}` : undefined)} />
                </div>
              )}
            </>
          )}
          {sh.kind === 'round' && <Field title="Скругление" value={sh.radius} lo={L.radius[0]} hi={L.radius[1]} unit="%" onChange={(v, live) => patch({ radius: v }, live ? `sr-${id}` : undefined)} />}
          {(sh.kind === 'line' || sh.kind === 'arrow') && <Field title="Толщина" value={sh.thick} lo={L.thick[0]} hi={L.thick[1]} step={0.1} unit="%" onChange={(v, live) => patch({ thick: v }, live ? `sth-${id}` : undefined)} />}
          {sh.kind === 'frame' && <Field title="Толщина" value={sh.stroke} lo={0.1} hi={L.stroke[1]} step={0.1} unit="%" onChange={(v, live) => patch({ stroke: v }, live ? `sst-${id}` : undefined)} />}
        </>
      )}
      {tab === 'frame' && (
        <>
          <Sub>Положение и размер</Sub>
          <div className="fld-pair">
            <Field title="X" value={sh.x} lo={0} hi={100} step={0.5} unit="%" onChange={(v, live) => patch({ x: v }, live ? `sx-${id}` : undefined)} />
            <Field title="Y" value={sh.y} lo={0} hi={100} step={0.5} unit="%" onChange={(v, live) => patch({ y: v }, live ? `sy-${id}` : undefined)} />
          </div>
          <div className="fld-pair">
            <Field title="Ширина" value={sh.w} lo={L.w[0]} hi={100} step={0.5} unit="%" onChange={(v, live) => patch({ w: v }, live ? `sw-${id}` : undefined)} />
            <Field title="Высота" value={sh.h} lo={L.h[0]} hi={100} step={0.5} unit="%" onChange={(v, live) => patch({ h: v }, live ? `sh-${id}` : undefined)} />
          </div>
          <Field title="Поворот" value={sh.rot} lo={L.rot[0]} hi={L.rot[1]} unit="°" onChange={(v, live) => patch({ rot: v }, live ? `srot-${id}` : undefined)} />
          <FrameTab project={p.project} item={p.item} time={p.time} getTime={p.getTime} shift crop={false} onCommit={p.onCommit} />
        </>
      )}
      {tab === 'anim' && <EffectRows project={p.project} item={p.item} anim onCommit={p.onCommit} />}
    </Shell>
  )
}

/** Видео, баннер, стоп-кадр: вкладки «Кусок», «Кадр», «Анимация», «Эффекты». */
function ItemPanel(p: { project: Project; item: Item; time: number; getTime(): number; onCommit(next: Project, key?: string): void; onMessage(msg: string): void }): React.JSX.Element | null {
  const pr = p.project
  const one = p.item
  const m = mediaOf(pr, one.mediaId)
  const track = trackOf(pr, one.trackId)
  const picture = canHaveEffects(pr, one)
  const ids = picture ? ['piece', 'frame', 'anim', 'fx'] : ['piece']
  const [tab, setTab] = useTab('media', ids)
  if (!m) return null
  const anims = one.effects.filter((e) => EFFECTS[e.type].anim).length
  const filters = one.effects.length - anims
  const tabs = [{ id: 'piece', label: 'Кусок' }, ...(picture ? [{ id: 'frame', label: 'Кадр' }, { id: 'anim', label: 'Анимация', n: anims }, { id: 'fx', label: 'Эффекты', n: filters }] : [])]
  return (
    <Shell name={m.name} hint={m.path} tabs={tabs} tab={tab} onTab={setTab}>
      {tab === 'piece' && (
        <>
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
          {subsOf(pr, one.id).length > 0 && (
            <div className="insp-link">
              <span className="dim">Субтитры едут вместе с этим видео</span>
              <button className="btn small" onClick={() => p.onCommit(subsOf(pr, one.id).reduce((acc, s) => unlinkSubs(acc, s.id), pr))}>
                Разгруппировать
              </button>
            </div>
          )}
        </>
      )}
      {tab === 'frame' && hasFrameCrop(pr, one) && <FrameTab project={pr} item={one} time={p.time} getTime={p.getTime} shift={false} crop onCommit={p.onCommit} />}
      {tab === 'anim' && <EffectRows project={pr} item={one} anim onCommit={p.onCommit} />}
      {tab === 'fx' && <EffectRows project={pr} item={one} anim={false} onCommit={p.onCommit} />}
    </Shell>
  )
}

function Inspector(p: Props): React.JSX.Element {
  const pr = p.project
  if (p.clip) return <ClipPanel key={p.clip.id} project={pr} clip={p.clip} onCommit={p.onCommit} onSeek={p.onSeek} onFocus={p.onFocusClip} onGone={p.onClipGone} />
  const one = p.selected.length === 1 ? pr.items.find((i) => i.id === p.selected[0]) : undefined
  const m = one ? mediaOf(pr, one.mediaId) : undefined
  if (one && one.kind === 'shape') return <ShapePanel key={one.id} project={pr} item={one} time={p.time} getTime={p.getTime} onCommit={p.onCommit} />
  if (one && one.kind === 'text') return <TextPanel key={one.id} project={pr} item={one} time={p.time} getTime={p.getTime} onCommit={p.onCommit} />

  if (one && m) return <ItemPanel key={one.id} project={pr} item={one} time={p.time} getTime={p.getTime} onCommit={p.onCommit} onMessage={p.onMessage} />

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
