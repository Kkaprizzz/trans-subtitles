/** Управление заставкой из index.html: этапы запуска и уход. */

/** Заставка держится не меньше этого времени, чтобы не мелькать на быстрых ПК. */
const MIN_MS = 1200
/** Страховка: если что-то сломалось при запуске, заставка не должна закрыть окно навсегда. */
const MAX_MS = 15000

export function splashStep(text: string, progress: number): void {
  const status = document.getElementById('splash-status')
  if (status) status.textContent = text
  const bar = document.getElementById('splash-bar')
  if (bar) bar.style.transform = `scaleX(${Math.min(1, Math.max(0, progress))})`
}

export function hideSplash(): void {
  const el = document.getElementById('splash')
  if (!el || el.dataset['hiding']) return
  el.dataset['hiding'] = '1'
  // performance.now() считается от начала загрузки страницы
  const wait = Math.max(0, MIN_MS - performance.now())
  setTimeout(() => {
    splashStep('Готово', 1)
    el.classList.add('done')
    setTimeout(() => el.remove(), 250)
  }, wait)
}

setTimeout(hideSplash, MAX_MS)
