/** 83.456 -> «01:23.46». Сначала округляем до сотых, иначе 59.999 превращалось в «00:60.00». */
export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const cs = Math.round(sec * 100)
  const m = Math.floor(cs / 6000)
  const s = (cs - m * 6000) / 100
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`
}

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return many
  if (b === 1) return one
  if (b >= 2 && b <= 4) return few
  return many
}
