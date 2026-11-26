/**
 * Что тащат из панели «Медиа» на таймлайн. Браузер не отдаёт содержимое перетаскивания до броска (видны только типы),
 * поэтому карточка при старте кладёт сюда описание, а таймлайн по нему заранее показывает, куда кусок ляжет.
 */
import type { DragEvent } from 'react'

export type DragKind = 'media' | 'banner' | 'shape'
export interface DragPayload {
  kind: DragKind
  /** id файла проекта, баннера в библиотеке или вид фигуры */
  id: string
  /** что написать на превью */
  label: string
}

let current: DragPayload | null = null

// пустая картинка вместо копии строки у курсора: на таймлайне и так виден контур будущего куска
const blank = typeof Image !== 'undefined' ? Object.assign(new Image(), { src: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' }) : null

export function beginDrag(e: DragEvent, mime: string, payload: DragPayload): void {
  e.dataTransfer.setData(mime, payload.id)
  e.dataTransfer.effectAllowed = 'copy'
  if (blank) e.dataTransfer.setDragImage(blank, 0, 0)
  current = payload
}

export const endDrag = (): void => {
  current = null
}

export const currentDrag = (kind: DragKind): DragPayload | null => (current && current.kind === kind ? current : null)
