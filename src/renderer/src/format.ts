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

/** 64_800_000 -> «62 МБ», 1_500_000_000 -> «1,4 ГБ». */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 Б'
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  const s = v >= 100 || i === 0 ? String(Math.round(v)) : v.toFixed(1).replace('.', ',').replace(/,0$/, '')
  return `${s} ${units[i]}`
}
