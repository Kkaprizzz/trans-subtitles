import { FONTS, fontById, nearestWeight, WEIGHT_LABELS } from '../../shared/fonts'
import type { CaptionMode, EnterType, SubtitleStyle } from '../../shared/timeline'

interface Props {
  style: SubtitleStyle
  onChange(patch: Partial<SubtitleStyle>): void
  onReset(): void
}

const MODES: Array<{ id: CaptionMode; label: string; hint: string }> = [
  { id: 'word', label: 'Слово', hint: 'Слово за словом: на экране одно слово' },
  { id: 'highlight', label: 'Подсветка', hint: 'Видна фраза, текущее слово подсвечивается и подпрыгивает' },
  { id: 'typewriter', label: 'Машинка', hint: 'Буквы фразы набираются по очереди' }
]

const ENTERS: Array<{ id: EnterType; label: string }> = [
  { id: 'pop', label: 'Подскок' },
  { id: 'fade', label: 'Плавное проявление' },
  { id: 'none', label: 'Без анимации' }
]

function Num(p: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  title?: string
  onChange(v: number): void
}): React.JSX.Element {
  return (
    <label className="row" title={p.title}>
      <span>{p.label}</span>
      <span className="pair">
        <input
          type="number"
          value={Number.isFinite(p.value) ? p.value : 0}
          min={p.min}
          max={p.max}
          step={p.step ?? 1}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (Number.isFinite(v)) p.onChange(Math.min(p.max, Math.max(p.min, v)))
          }}
        />
        {p.unit && <span className="dim unit">{p.unit}</span>}
      </span>
    </label>
  )
}

function Color(p: { label: string; value: string; title?: string; onChange(v: string): void }): React.JSX.Element {
  return (
    <label className="row" title={p.title}>
      <span>{p.label}</span>
      <span className="pair">
        <input type="color" value={p.value} onChange={(e) => p.onChange(e.target.value.toUpperCase())} />
        <span className="mono dim">{p.value}</span>
      </span>
    </label>
  )
}

function Check(p: { label: string; text: string; value: boolean; onChange(v: boolean): void }): React.JSX.Element {
  return (
    <label className="row">
      <span>{p.label}</span>
      <span className="check">
        <input type="checkbox" checked={p.value} onChange={(e) => p.onChange(e.target.checked)} />
        <span>{p.text}</span>
      </span>
    </label>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <fieldset className="group">
      <legend>{title}</legend>
      {children}
    </fieldset>
  )
}

export default function StylePanel({ style: s, onChange, onReset }: Props): React.JSX.Element {
  const font = fontById(s.font)

  return (
    <div className="style-panel">
      <div className="segmented" role="radiogroup" aria-label="Режим показа">
        {MODES.map((m) => (
          <button
            key={m.id}
            role="radio"
            aria-checked={s.mode === m.id}
            className={s.mode === m.id ? 'on' : ''}
            title={m.hint}
            onClick={() => onChange({ mode: m.id })}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="hint tight">{MODES.find((m) => m.id === s.mode)?.hint}</p>

      {s.mode !== 'word' && (
        <Group title="Фразы">
          <Num label="Слов во фразе" value={s.maxWords} min={1} max={8} onChange={(v) => onChange({ maxWords: Math.round(v) })} />
          <Num
            label="Пауза-разрыв"
            value={s.pauseBreak}
            min={0.1}
            max={3}
            step={0.1}
            unit="с"
            title="Если между словами пауза дольше, фраза обрывается"
            onChange={(v) => onChange({ pauseBreak: v })}
          />
        </Group>
      )}

      <Group title="Шрифт">
        <label className="row">
          <span>Гарнитура</span>
          <select
            value={s.font}
            onChange={(e) => onChange({ font: e.target.value, weight: nearestWeight(fontById(e.target.value), s.weight) })}
          >
            {FONTS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
            {s.customFontPath && (
              <option value="custom">Свой: {s.customFontName || 'файл'}</option>
            )}
          </select>
        </label>
        <div className="row">
          <span />
          <button
            className="btn"
            onClick={async () => {
              const f = await window.api.pickFont()
              if (f) onChange({ font: 'custom', customFontPath: f.path, customFontName: f.name })
            }}
            title="Файл .ttf, .otf, .woff или .woff2. Запоминается путь к файлу"
          >
            Выбрать файл шрифта…
          </button>
        </div>
        <label className="row">
          <span>Начертание</span>
          <select
            value={s.font === 'custom' ? 400 : s.weight}
            onChange={(e) => onChange({ weight: Number(e.target.value) })}
            disabled={s.font === 'custom' || font.weights.length === 1}
            title={s.font === 'custom' ? 'У шрифта из файла начертание одно — то, что в файле' : undefined}
          >
            {font.weights.map((w) => (
              <option key={w} value={w}>
                {WEIGHT_LABELS[w] ?? w}
              </option>
            ))}
          </select>
        </label>
        <Num label="Размер" value={s.size} min={16} max={400} unit="px" title="Пиксели при высоте кадра 1080; на другие размеры пересчитывается" onChange={(v) => onChange({ size: Math.round(v) })} />
        <Check label="Регистр" text="ВСЕ ЗАГЛАВНЫЕ" value={s.uppercase} onChange={(v) => onChange({ uppercase: v })} />
        <Check label="Знаки" text="убрать знаки препинания" value={s.stripPunct} onChange={(v) => onChange({ stripPunct: v })} />
      </Group>

      <Group title="Цвета">
        <Color label="Текст" value={s.color} title="Обычный цвет текста" onChange={(v) => onChange({ color: v })} />
        <Color
          label="Акцент"
          value={s.accent}
          title="Цвет активного слова. В режиме «Слово» — цвет самого слова"
          onChange={(v) => onChange({ accent: v })}
        />
        <Color label="Обводка" value={s.strokeColor} onChange={(v) => onChange({ strokeColor: v })} />
        <Num label="Толщина обводки" value={s.stroke} min={0} max={80} unit="px" onChange={(v) => onChange({ stroke: Math.round(v) })} />
      </Group>

      <Group title="Тень">
        <Check label="Тень" text="включена" value={s.shadowOn} onChange={(v) => onChange({ shadowOn: v })} />
        {s.shadowOn && (
          <>
            <Color label="Цвет" value={s.shadowColor} onChange={(v) => onChange({ shadowColor: v })} />
            <Num label="Сдвиг по X" value={s.shadowX} min={-60} max={60} unit="px" onChange={(v) => onChange({ shadowX: Math.round(v) })} />
            <Num label="Сдвиг по Y" value={s.shadowY} min={-60} max={60} unit="px" onChange={(v) => onChange({ shadowY: Math.round(v) })} />
            <Num label="Размытие" value={s.shadowBlur} min={0} max={80} unit="px" onChange={(v) => onChange({ shadowBlur: Math.round(v) })} />
          </>
        )}
      </Group>

      <Group title="Подложка">
        <Check label="Подложка" text="под фразой" value={s.plateOn} onChange={(v) => onChange({ plateOn: v })} />
        {s.plateOn && (
          <>
            <Color label="Цвет" value={s.plateColor} onChange={(v) => onChange({ plateColor: v })} />
            <Num label="Непрозрачность" value={Math.round(s.plateOpacity * 100)} min={0} max={100} unit="%" onChange={(v) => onChange({ plateOpacity: v / 100 })} />
            <Num label="Отступ" value={s.platePad} min={0} max={120} unit="px" onChange={(v) => onChange({ platePad: Math.round(v) })} />
            <Num label="Скругление" value={s.plateRadius} min={0} max={120} unit="px" onChange={(v) => onChange({ plateRadius: Math.round(v) })} />
          </>
        )}
      </Group>

      <Group title="Положение">
        <Num label="По вертикали" value={s.posY} min={5} max={95} step={0.5} unit="%" title="Центр блока сверху вниз" onChange={(v) => onChange({ posY: v })} />
        <Num label="Ширина блока" value={s.blockWidth} min={30} max={100} unit="%" onChange={(v) => onChange({ blockWidth: Math.round(v) })} />
        <Num
          label="Макс. строк"
          value={s.maxLines}
          min={1}
          max={4}
          title="Если фраза не влезает, шрифт уменьшается"
          onChange={(v) => onChange({ maxLines: Math.round(v) })}
        />
      </Group>

      <Group title="Анимация">
        {s.mode === 'typewriter' ? (
          <p className="hint tight">В режиме «Машинка» фраза не анимируется: буквы просто набираются.</p>
        ) : (
          <>
            <label className="row">
              <span>Появление</span>
              <select value={s.enter} onChange={(e) => onChange({ enter: e.target.value as EnterType })}>
                {ENTERS.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </select>
            </label>
            {s.enter !== 'none' && (
              <Num label="Длительность" value={Math.round(s.enterDur * 1000)} min={40} max={600} step={10} unit="мс" onChange={(v) => onChange({ enterDur: v / 1000 })} />
            )}
            {s.enter === 'pop' && (
              <Num label="Старт. масштаб" value={Math.round(s.enterScale * 100)} min={30} max={100} unit="%" onChange={(v) => onChange({ enterScale: v / 100 })} />
            )}
          </>
        )}
        {s.mode === 'highlight' && (
          <Num label="Подскок слова" value={Math.round(s.pop * 100)} min={100} max={160} unit="%" title="Во сколько раз растёт активное слово" onChange={(v) => onChange({ pop: v / 100 })} />
        )}
        <Num label="Задержка в конце" value={Math.round(s.hold * 1000)} min={0} max={2000} step={50} unit="мс" title="Сколько фраза остаётся после конца речи" onChange={(v) => onChange({ hold: v / 1000 })} />
      </Group>

      <div className="style-actions">
        <button className="btn" onClick={onReset}>
          Сбросить стиль
        </button>
      </div>
    </div>
  )
}
