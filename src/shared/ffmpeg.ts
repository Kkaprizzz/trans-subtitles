/** Чистые помощники для ffmpeg: нужен ли запасной декодер AV1 и читаемый текст ошибки. Запуск — main/decoder.ts. */

/** Имя запасного декодера AV1 (libaom: медленнее dav1d, но работает без видеокарты). */
export const AV1_FALLBACK = 'libaom-av1'

/**
 * Сборка ffmpeg без libdav1d (gyan essentials под Windows) декодирует AV1 только встроенным декодером, а он без видеокарты
 * кадров не выдаёт («Your platform doesn't support hardware accelerated AV1 decoding»): поток пустой, экспорт падает.
 * Запасной вариант — libaom, если он собран. `decoders` — вывод `ffmpeg -decoders`.
 */
export function needsAv1Fallback(decoders: string): boolean {
  const has = (name: string): boolean => new RegExp(`\\s${name}\\s`).test(decoders)
  return !has('libdav1d') && has(AV1_FALLBACK)
}

// строки-следствия: настоящая причина стоит выше
const SYMPTOM = /^Conversion failed!?$|Nothing was written into output file|^Exiting normally|^Received signal/i

/** Последние информативные строки stderr ffmpeg (по умолчанию две), без служебных приставок «[фильтр @ адрес]» (на Windows адрес без 0x). */
export function ffmpegErrorText(stderr: string, max = 2): string {
  const lines = String(stderr)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const useful = lines.filter((l) => !SYMPTOM.test(l))
  const picked = (useful.length ? useful : lines).slice(-max)
  const text = picked.map((l) => l.replace(/^\[[^\]]*@ (?:0x)?[0-9a-f]+\]\s*/i, '')).join(' · ')
  return text || 'неизвестная ошибка'
}
