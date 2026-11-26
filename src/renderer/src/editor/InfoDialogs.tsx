/** «Справка»: горячие клавиши и «О программе». */
import { useEffect, useState } from 'react'
import type { AppInfo } from '../../../shared/types'

export const HOTKEYS: Array<[string, Array<[string, string]>]> = [
  [
    'Файл',
    [
      ['Ctrl+N', 'Новый проект'],
      ['Ctrl+O', 'Открыть проект (список проектов)'],
      ['Ctrl+S', 'Сохранить'],
      ['Ctrl+Shift+S', 'Сохранить проект в файл'],
      ['Ctrl+I', 'Добавить медиа'],
      ['Ctrl+E', 'Экспорт видео'],
      ['Ctrl+W', 'Закрыть проект'],
      ['Ctrl+Q', 'Выход']
    ]
  ],
  [
    'Правка',
    [
      ['Ctrl+Z', 'Отменить'],
      ['Ctrl+Shift+Z, Ctrl+Y', 'Повторить'],
      ['S', 'Разрезать по курсору (выделенные куски или все под курсором)'],
      ['Ctrl+J', 'Соединить выделенные куски обратно (если стык точный)'],
      ['Delete, Backspace', 'Удалить выделенное (остаётся пустое место)'],
      ['Shift+Delete', 'Удалить и закрыть дыру (следующие куски сдвигаются)'],
      ['M', 'Поставить метку на выбранной дорожке в позиции курсора'],
      ['Ctrl+A', 'Выделить всё'],
      ['Esc', 'Снять выделение'],
      ['Ctrl / Shift + щелчок', 'Добавить кусок к выделению'],
      ['Правый щелчок по дорожке', 'Добавить метку в этом месте'],
      ['Правый щелчок по куску', 'Отделить звук / вернуть, разрезать здесь, соединить с соседом, удалить'],
      ['Линия громкости', 'На звуке куска (при наведении или выделении): тянуть — уровень; правый щелчок — добавить/убрать точку; точки тянутся по уровню и времени, Alt — без привязки'],
      ['Рамка клипа', 'Щелчок — выбрать, тянуть за середину — сдвинуть, за края — менять границы (по словам; Alt — свободно)'],
      ['Двойной щелчок по рамке', 'Фокус на клипе: кадр 9:16, цикл воспроизведения; Esc — выйти'],
      ['Delete (рамка выбрана)', 'Удалить рамку клипа'],
      ['Значки у дорожки', 'Скрыть слой, заглушить звук, заблокировать, убрать пустую дорожку']
    ]
  ],
  [
    'Воспроизведение и вид',
    [
      ['Пробел', 'Играть / пауза'],
      ['← →', 'На кадр назад / вперёд'],
      ['Shift + ← →', 'На секунду назад / вперёд'],
      ['Home / End', 'В начало / в конец'],
      ['Ctrl+= / Ctrl+−', 'Приблизить / отдалить таймлайн'],
      ['Shift+Z', 'Весь таймлайн'],
      ['Колесо', 'Прокрутка таймлайна'],
      ['Ctrl + колесо', 'Масштаб таймлайна вокруг курсора']
    ]
  ],
  [
    'Субтитры',
    [
      ['Кнопка «Субтитры»', 'Распознать выделенное видео (без выделения — видео на самой нижней дорожке) и поставить дорожку слов'],
      ['Щелчок по слову на кадре', 'Окошко правки слова; Enter — сохранить, Esc — отмена'],
      ['Tab / Shift+Tab в окошке', 'Следующее / предыдущее слово'],
      ['Пробел в тексте слова', 'Разделить слово на два (время делится по буквам)'],
      ['Щелчок по дорожке слов', 'Выбрать слово и перейти к нему']
    ]
  ],
  [
    'Мышь на таймлайне',
    [
      ['Перетаскивание куска', 'Перенос; выше всех дорожек — новая дорожка'],
      ['Край куска', 'Обрезать начало или конец'],
      ['Alt при перетаскивании', 'Без привязки к краям и курсору'],
      ['Двойной щелчок в «Медиа»', 'В конец самой нижней видеодорожки']
    ]
  ]
]

export function HotkeysDialog({ onClose }: { onClose(): void }): React.JSX.Element {
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" role="dialog" aria-label="Горячие клавиши">
        <div className="pane-head">
          <span>Горячие клавиши</span>
          <button className="btn icon small" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </div>
        <div className="modal-body keys">
          {HOTKEYS.map(([group, rows]) => (
            <section key={group}>
              <h3 className="set-h">{group}</h3>
              <dl className="keys-grid">
                {rows.map(([k, v]) => (
                  <div key={k} className="keys-row">
                    <dt className="mono">{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

export function AboutDialog({ onClose }: { onClose(): void }): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    void window.api.appInfo().then(setInfo, () => {})
  }, [])
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="О программе">
        <div className="pane-head">
          <span>О программе</span>
          <button className="btn icon small" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="about-name">Trans Subtitles</p>
          <p className="dim">Монтаж, субтитры и нарезка коротких роликов. Распознавание речи — на этом компьютере.</p>
          <p className="mono dim">
            Версия {info?.version ?? '…'}
            {info && !info.packaged ? ' · режим разработки' : ''}
          </p>
          {info && (
            <button className="link" onClick={() => void window.api.openExternal(info.repo)}>
              {info.repo.replace('https://', '')}
            </button>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  )
}
