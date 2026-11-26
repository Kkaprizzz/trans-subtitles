/**
 * Трекинг лица: чистая математика без ffmpeg и нейросети (их запускает воркер в main). Детектор YuNet даёт рамки лиц несколько
 * раз в секунду; здесь они привязываются к выбранному человеку (по близости от кадра к кадру), пропадания закрываются
 * («держим позицию, потом плавно к центру»), движение сглаживается с мёртвой зоной, и остаётся прореженный трек.
 *
 * Трек лица — {t: секунды ИСХОДНИКА, x: центр лица в долях ширины картинки 0..1}. Время исходника: обрезка, резка и скорость
 * куска его не ломают. Между точками плавно (ease), как у ключей. Из трека строятся ключи X для вертикального проекта и сдвиг
 * кропа клипа «Нарезки».
 */
import { ease } from './anim.ts'

/** Рамка лица в долях картинки (0..1), x, y — левый верхний угол. */
export interface FaceBox {
  x: number
  y: number
  w: number
  h: number
  score: number
  /** активность рта на этом кадре (движение губ, условные единицы) — для выбора говорящего; нет — не считали */
  act?: number
}

export interface FacePoint {
  /** секунды исходника */
  t: number
  /** центр лица, доля ширины картинки 0..1 */
  x: number
}

export type FaceTrack = FacePoint[]

/** Что нашёл детектор на кадре в момент t (секунды исходника). */
export interface FaceSample {
  t: number
  boxes: FaceBox[]
}

/** Результат поиска по отрезку: лица на кадрах и моменты жёстких склеек (секунды исходника). */
export interface FaceScan {
  samples: FaceSample[]
  cuts: number[]
  /** где в звуке есть речь, интервалы в секундах исходника; нет — не считали (речь считается всегда) */
  speech?: Array<[number, number]>
}

/** Сколько раз в секунду ищем лицо. */
export const FACE_FPS = 4
/** Размер входа YuNet (квадрат). */
export const FACE_INPUT = 640
export const MAX_FACE_POINTS = 4000

const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x))
const r4 = (x: number): number => Math.round(x * 10000) / 10000
const r3 = (x: number): number => Math.round(x * 1000) / 1000

export const boxCx = (b: FaceBox): number => b.x + b.w / 2
export const boxCy = (b: FaceBox): number => b.y + b.h / 2

export function iou(a: FaceBox, b: FaceBox): number {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}

/** Убирает дубли одного лица (детектор даёт много якорей): по убыванию уверенности, перекрытие больше порога — выбрасывается. */
export function nms(boxes: FaceBox[], thr = 0.3): FaceBox[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score)
  const out: FaceBox[] = []
  for (const b of sorted) if (out.every((o) => iou(o, b) < thr)) out.push(b)
  return out
}

/** Как картинка легла в квадрат модели: масштаб по длинной стороне и чёрные поля. */
export interface Letterbox {
  S: number
  px: number
  py: number
  nw: number
  nh: number
}

export function letterbox(srcW: number, srcH: number, S = FACE_INPUT): Letterbox {
  const k = Math.min(S / srcW, S / srcH)
  const nw = Math.round(srcW * k)
  const nh = Math.round(srcH * k)
  return { S, px: Math.floor((S - nw) / 2), py: Math.floor((S - nh) / 2), nw, nh }
}

/**
 * Разбор выхода YuNet (2023mar, вход 640×640): для шагов 8, 16, 32 — cls, obj, bbox по якорям. Уверенность = √(cls·obj),
 * рамка: центр = (клетка + смещение)·шаг, размер = exp(лог-размер)·шаг. Возвращает рамки в долях КАРТИНКИ (поля убраны), после NMS.
 */
export function decodeYunet(out: Record<string, ArrayLike<number>>, lb: Letterbox, minScore = 0.6): FaceBox[] {
  const found: FaceBox[] = []
  for (const stride of [8, 16, 32]) {
    const cols = lb.S / stride
    const cls = out[`cls_${stride}`]
    const obj = out[`obj_${stride}`]
    const bb = out[`bbox_${stride}`]
    if (!cls || !obj || !bb) continue
    for (let i = 0; i < cols * cols; i++) {
      const score = Math.sqrt(clamp(cls[i], 0, 1) * clamp(obj[i], 0, 1))
      if (score < minScore) continue
      const r = Math.floor(i / cols)
      const c = i % cols
      const cx = (c + bb[i * 4]) * stride
      const cy = (r + bb[i * 4 + 1]) * stride
      const w = Math.exp(bb[i * 4 + 2]) * stride
      const h = Math.exp(bb[i * 4 + 3]) * stride
      const x = (cx - w / 2 - lb.px) / lb.nw
      const y = (cy - h / 2 - lb.py) / lb.nh
      found.push({ x: clamp(x, -0.2, 1.2), y: clamp(y, -0.2, 1.2), w: w / lb.nw, h: h / lb.nh, score })
    }
  }
  return nms(found).map((b) => ({ x: r4(b.x), y: r4(b.y), w: r4(b.w), h: r4(b.h), score: r3(b.score) }))
}

// --- трекинг ---

export interface TrackOpts {
  /** кадр сдвигается, только если лицо ушло дальше этой доли ширины от положения кадра */
  move: number
  /** … и держится там не меньше столько кадров детектора (при 4 к/с: 3 = 0,75 с) */
  moveHold: number
  /** склейка, после которой положение отличается меньше этой доли, не считается склейкой (ложное срабатывание) */
  cutGuard: number
  /** чтобы сменить говорящего, активность другого должна быть больше во столько раз … */
  switchGain: number
  /** … и держаться так столько кадров детектора (10 = 2,5 с): короткие ответы «да», «ага», «конечно» кадр не переключают */
  switchHold: number
  /** после смены говорящего столько кадров (12 = 3 с) обратно не переключаем */
  switchDwell: number
  /** пока нет лица так долго (с), берём другого человека в кадре */
  lostSwitch: number
}

export const DEFAULT_TRACK: TrackOpts = { move: 0.06, moveHold: 3, cutGuard: 0.05, switchGain: 1.5, switchHold: 10, switchDwell: 12, lostSwitch: 1.5 }

export type TrackMode = 'speaker' | 'seed'

export interface TrackRequest {
  /** speaker — кадр на говорящем (по губам и речи); seed — на лице, по которому щёлкнул пользователь */
  mode: TrackMode
  /** выбранная рамка и момент (обязательна для seed; для speaker — необязательная подсказка, с кого начать) */
  seed?: { t: number; box: FaceBox }
}

interface Person {
  boxes: Array<FaceBox | null>
  lastBox: FaceBox
  lastT: number
}

/** Насколько рамка b похожа на прежнюю положение prev (по перекрытию и близости); null — не тот же человек. */
function matchScore(b: FaceBox, prev: FaceBox, lostSec: number): number | null {
  // чем дольше лица не было, тем шире поиск, но не дальше трети ширины: соседний человек в кадре — не тот же самый
  const maxDist = Math.min(0.3, 0.12 + 0.06 * lostSec)
  const dist = Math.max(Math.abs(boxCx(b) - boxCx(prev)), Math.abs(boxCy(b) - boxCy(prev)) * 0.56)
  const ov = iou(b, prev)
  if (dist > maxDist && ov < 0.05) return null
  return ov * 2 + (1 - Math.min(1, dist / maxDist)) + b.score * 0.1
}

/** Лица внутри одного плана (кадры a..b) связываются в людей: каждый бокс — к самому похожему человеку по прошлой позиции. */
function linkPersons(samples: FaceSample[], a: number, b: number): Person[] {
  const persons: Person[] = []
  const len = b - a + 1
  for (let j = a; j <= b; j++) {
    const used = new Set<Person>()
    for (const box of [...samples[j].boxes].sort((x, y) => y.score - x.score)) {
      let best: Person | null = null
      let bestS = -1
      for (const p of persons) {
        if (used.has(p)) continue
        const sc = matchScore(box, p.lastBox, samples[j].t - p.lastT)
        if (sc !== null && sc > bestS) {
          bestS = sc
          best = p
        }
      }
      if (!best) {
        best = { boxes: new Array(len).fill(null), lastBox: box, lastT: samples[j].t }
        persons.push(best)
      }
      best.boxes[j - a] = box
      best.lastBox = box
      best.lastT = samples[j].t
      used.add(best)
    }
  }
  // случайные находки (одна-две рамки на весь план — ложное срабатывание детектора) не людей: отсеиваем, если есть нормальные
  const seen = (p: Person): number => p.boxes.reduce((n, x) => n + (x ? 1 : 0), 0)
  const solid = persons.filter((p) => seen(p) >= 3)
  return solid.length ? solid : persons
}

const area =(b: FaceBox): number => b.w * b.h
const median = (v: number[]): number => {
  const s = [...v].sort((x, y) => x - y)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}

/** Говорит ли кто-то в момент t: нет сведений о речи — считаем, что да. */
function speechOn(speech: Array<[number, number]> | undefined, t: number): boolean {
  if (!speech) return true
  return speech.some(([a, b]) => t >= a && t <= b)
}

/** Кто из людей плана — цель в каждом кадре (индекс человека или -1). */
function pickTargets(persons: Person[], samples: FaceSample[], a: number, b: number, mode: TrackMode, firstPick: number, speech: Array<[number, number]> | undefined, o: TrackOpts): number[] {
  const len = b - a + 1
  const out: number[] = new Array(len).fill(-1)
  if (persons.length === 0) return out
  let cur = firstPick
  let lostRun = 0
  let challenger = -1
  let challengeRun = 0
  let sinceSwitch = 999
  const actAt = (pi: number, k: number): number => {
    // активность рта за последнюю секунду (4 кадра): среднее по кадрам, где человек был виден
    let sum = 0
    let n = 0
    for (let q = Math.max(0, k - 3); q <= k; q++) {
      const bx = persons[pi].boxes[q]
      if (bx) {
        sum += bx.act ?? 0
        n++
      }
    }
    return n ? sum / n : 0
  }
  for (let k = 0; k < len; k++) {
    const present = persons.map((p) => !!p.boxes[k])
    sinceSwitch++
    if (persons.length === 1) {
      out[k] = present[0] ? 0 : -1
      continue
    }
    if (mode === 'seed') {
      out[k] = present[cur] ? cur : -1
      continue
    }
    // кадр на говорящем
    if (!present[cur]) {
      lostRun++
      if (lostRun * 0.25 >= o.lostSwitch) {
        const alt = present.map((v, i) => (v ? i : -1)).filter((i) => i >= 0)
        if (alt.length) {
          cur = alt.reduce((x, y) => (area(persons[x].boxes[k] ?? persons[x].lastBox) >= area(persons[y].boxes[k] ?? persons[y].lastBox) ? x : y))
          lostRun = 0
        }
      }
    } else lostRun = 0
    if (samples[a + k] && speechOn(speech, samples[a + k].t)) {
      let best = cur
      let bestAct = actAt(cur, k)
      for (let i = 0; i < persons.length; i++) {
        if (i === cur || !present[i]) continue
        const v = actAt(i, k)
        if (v > bestAct) {
          bestAct = v
          best = i
        }
      }
      if (best !== cur && bestAct > actAt(cur, k) * o.switchGain + 0.5) {
        if (challenger === best) challengeRun++
        else {
          challenger = best
          challengeRun = 1
        }
        if (challengeRun >= o.switchHold && sinceSwitch >= o.switchDwell) {
          cur = best
          challenger = -1
          challengeRun = 0
          sinceSwitch = 0
        }
      } else if (challengeRun > 0) {
        // короткая пауза в речи другого счёт не обнуляет, а лишь убавляет: «да… ну… конечно» — всё равно короткий ответ
        challengeRun--
        if (challengeRun === 0) challenger = -1
      }
    }
    out[k] = present[cur] ? cur : -1
  }
  return out
}

interface PlateauPlan {
  /** точки кадра внутри плана: время исходника и положение */
  pts: FacePoint[]
}

/**
 * Спокойный кадр одного плана: положение лица по кадрам → медиана (убирает дрожь) → площадки. Кадр стоит на площадке и
 * сдвигается к новому положению коротким плавным переходом, только если лицо ушло больше порога и держится там.
 * force[k] — в кадре k сменился человек (говорящий): двигаемся сразу.
 */
function plateaus(xs: Array<number | null>, times: number[], force: boolean[], start: number, end: number, startX: number | null, o: TrackOpts): PlateauPlan {
  const n = xs.length
  // дыры закрываем: держим прежнее; до первой находки — первую; совсем нет — прежнее положение предыдущего плана или центр
  const firstFound = xs.findIndex((v) => v !== null)
  const fallback = startX ?? 0.5
  const filled: number[] = []
  let last = firstFound >= 0 ? (xs[firstFound] as number) : fallback
  for (let k = 0; k < n; k++) {
    if (xs[k] !== null) last = xs[k] as number
    filled.push(last)
  }
  // медиана по ±2 кадра: дрожь и разовые промахи детектора не двигают кадр
  const med = filled.map((_, k) => median(filled.slice(Math.max(0, k - 2), Math.min(n, k + 3))))
  const first = median(med.slice(0, Math.min(n, 4)))
  const pts: FacePoint[] = []
  let curX = startX !== null && Math.abs(first - startX) < o.cutGuard ? startX : first
  let plateauStart = start
  let devRun = 0
  let devFrom = 0
  for (let k = 0; k < n; k++) {
    const dev = Math.abs(med[k] - curX)
    const forced = force[k] && dev > o.move / 2
    if (dev > o.move || forced) {
      if (devRun === 0) devFrom = k
      devRun++
      // новое положение принимаем, когда человек «успокоился» (последние кадры в узком разбросе) или ушёл надолго
      const tail = med.slice(Math.max(devFrom, k - o.moveHold + 1), k + 1)
      const settled = devRun >= o.moveHold && Math.max(...tail) - Math.min(...tail) < o.move / 2
      if (settled || forced || devRun >= 12) {
        const newX = forced ? median(med.slice(k, Math.min(n, k + 3))) : median(tail)
        const dist = Math.abs(newX - curX)
        const pan = Math.min(1, Math.max(0.5, 0.45 + dist * 1.5))
        const panStart = Math.max(plateauStart, forced ? times[k] : times[devFrom])
        pts.push({ t: plateauStart, x: curX }, { t: panStart, x: curX })
        curX = newX
        plateauStart = Math.min(end, panStart + pan)
        devRun = 0
      }
    } else devRun = 0
  }
  pts.push({ t: plateauStart, x: curX }, { t: Math.max(plateauStart, end), x: curX })
  return { pts }
}

/** Склейка у видео — мгновенная смена: две точки рядом (старое положение и новое), без «плавания» кадра. */
const CUT_JUMP = 0.04

/**
 * Трек кадра по результату поиска лиц. План за планом (между склейками): в плане лица связываются в людей, выбирается цель
 * (говорящий по губам и речи или лицо, выбранное щелчком), и кадр стоит спокойно на ней, сдвигаясь коротко и плавно только когда
 * человек реально ушёл в сторону или заговорил другой. На склейке кадр перескакивает; если положение почти не изменилось —
 * склейки нет. Нет лица — держим последнее положение, к центру не уезжаем.
 */
export function buildTrack(scan: FaceScan | FaceSample[], req: TrackRequest, o: Partial<TrackOpts> = {}): FaceTrack {
  const opt = { ...DEFAULT_TRACK, ...o }
  const samples = (Array.isArray(scan) ? scan : scan.samples).slice().sort((a, b) => a.t - b.t)
  const cuts = (Array.isArray(scan) ? [] : scan.cuts).slice().sort((a, b) => a - b)
  const speech = Array.isArray(scan) ? undefined : scan.speech
  const n = samples.length
  const seed = req.seed
  if (n === 0) return seed ? [{ t: r3(seed.t), x: r4(clamp(boxCx(seed.box), 0, 1)) }] : []

  // планы: границы по склейкам
  const shotStarts: number[] = [0]
  const cutOf: Array<number | null> = [null]
  for (let j = 1; j < n; j++) {
    let c = cuts.find((x) => x > samples[j - 1].t && x <= samples[j].t)
    // склейку не нашёл ffmpeg (например, общий план → крупный): видно по лицам — ни одно не похоже на прежнее или размер скачком;
    // подтверждаем следующим кадром, чтобы разовый сбой детектора склейкой не считался
    if (c === undefined) {
      const prev = samples[j - 1].boxes
      const changed = (cur: FaceBox[], dt: number): boolean => {
        if (!prev.length || !cur.length) return false
        const linked = cur.some((b) => prev.some((q) => matchScore(b, q, dt) !== null))
        const ratio = Math.max(...cur.map(area)) / Math.max(...prev.map(area))
        return !linked || ratio > 2.5 || ratio < 0.4
      }
      const dt = samples[j].t - samples[j - 1].t
      const next = samples[j + 1]
      if (changed(samples[j].boxes, dt) && (!next || !next.boxes.length || changed(next.boxes, next.t - samples[j - 1].t))) c = (samples[j - 1].t + samples[j].t) / 2
    }
    if (c !== undefined) {
      shotStarts.push(j)
      cutOf.push(c)
    }
  }
  const shots = shotStarts.map((a, i) => ({ a, b: (shotStarts[i + 1] ?? n) - 1, cut: cutOf[i] }))
  let seedShot = 0
  shots.forEach((s, i) => {
    if (seed && (s.cut ?? samples[0].t) <= seed.t) seedShot = i
  })

  const results: Array<FacePoint[] | null> = new Array(shots.length).fill(null)
  const lastX: Array<number | null> = new Array(shots.length).fill(null)
  const firstX: Array<number | null> = new Array(shots.length).fill(null)

  const doShot = (si: number, prevPos: number | null): void => {
    const sh = shots[si]
    const persons = linkPersons(samples, sh.a, sh.b)
    const len = sh.b - sh.a + 1
    // кого брать сначала
    let firstPick = 0
    if (persons.length > 1) {
      const posAt = (p: Person): FaceBox => p.boxes.find((b) => b) ?? p.lastBox
      if (seed && si === seedShot) {
        const k0 = Math.min(len - 1, Math.max(0, samples.findIndex((s, j) => j >= sh.a && s.t >= seed.t) - sh.a))
        const dist = (p: Person): number => Math.abs(boxCx(p.boxes[k0] ?? posAt(p)) - boxCx(seed.box))
        firstPick = persons.reduce((best, p, i) => (dist(p) < dist(persons[best]) ? i : best), 0)
      } else if (prevPos !== null) {
        firstPick = persons.reduce((best, p, i) => (Math.abs(boxCx(posAt(p)) - prevPos) < Math.abs(boxCx(posAt(persons[best])) - prevPos) ? i : best), 0)
      } else {
        firstPick = persons.reduce((best, p, i) => (area(posAt(p)) > area(posAt(persons[best])) ? i : best), 0)
      }
      // «говорящий»: в начале плана смотрим на губы за первую секунду; если кто-то заметно активнее — берём его
      if (req.mode === 'speaker' && !(seed && si === seedShot)) {
        const act = (p: Person): number => {
          const v = p.boxes.slice(0, 4).filter((b): b is FaceBox => !!b).map((b) => b.act ?? 0)
          return v.length ? v.reduce((x, y) => x + y, 0) / v.length : 0
        }
        const best = persons.reduce((bi, p, i) => (act(p) > act(persons[bi]) ? i : bi), 0)
        if (act(persons[best]) > 1 && act(persons[best]) > act(persons[firstPick]) * 1.3 + 0.3) firstPick = best
      }
    }
    const targets = pickTargets(persons, samples, sh.a, sh.b, req.mode, firstPick, speech, opt)
    const xs = targets.map((ti, k) => (ti >= 0 ? clamp(boxCx(persons[ti].boxes[k] as FaceBox), 0, 1) : null))
    const force = targets.map((ti, k) => k > 0 && ti >= 0 && targets[k - 1] >= 0 && ti !== targets[k - 1])
    const times = samples.slice(sh.a, sh.b + 1).map((s) => s.t)
    const start = sh.cut ?? times[0]
    const end = shots[si + 1] ? (shots[si + 1].cut as number) - CUT_JUMP : times[times.length - 1]
    const plan = plateaus(xs, times, force, start, Math.max(start, end), prevPos, opt)
    results[si] = plan.pts
    firstX[si] = plan.pts[0].x
    lastX[si] = plan.pts[plan.pts.length - 1].x
  }
  // порядок: от плана с выбранным лицом вперёд, потом назад (для «по щелчку»); для «говорящего» — просто вперёд
  if (req.mode === 'seed' && seed) {
    let prev: number | null = null
    for (let si = seedShot; si < shots.length; si++) {
      doShot(si, prev)
      prev = lastX[si]
    }
    prev = firstX[seedShot]
    for (let si = seedShot - 1; si >= 0; si--) {
      doShot(si, prev)
      prev = firstX[si]
    }
  } else {
    let prev: number | null = seed ? boxCx(seed.box) : null
    for (let si = 0; si < shots.length; si++) {
      doShot(si, prev)
      prev = lastX[si]
    }
  }

  // склеиваем планы по порядку; почти не изменившееся положение на «склейке» — продолжение, не прыжок
  const out: FacePoint[] = []
  for (let si = 0; si < shots.length; si++) {
    const pts = (results[si] as FacePoint[]).map((q) => ({ ...q }))
    if (si > 0 && out.length) {
      const prevX = out[out.length - 1].x
      if (Math.abs(pts[0].x - prevX) < opt.cutGuard) pts[0] = { t: pts[0].t, x: prevX }
    }
    out.push(...pts)
  }
  // подряд идущие точки с одним значением: оставляем первую и последнюю (площадка)
  const tidy: FacePoint[] = []
  for (let i = 0; i < out.length; i++) {
    const q = out[i]
    const same = (o2: FacePoint | undefined): boolean => !!o2 && Math.abs(o2.x - q.x) < 1e-4
    if (i > 0 && i < out.length - 1 && same(out[i - 1]) && same(out[i + 1])) continue
    if (tidy.length && q.t - tidy[tidy.length - 1].t < 0.005 && same(tidy[tidy.length - 1])) continue
    tidy.push(q)
  }
  return tidy.slice(0, MAX_FACE_POINTS).map((q) => ({ t: r3(q.t), x: r4(clamp(q.x, 0, 1)) }))
}

/** Положение лица (доля ширины картинки) в момент t исходника: между точками плавно, за краями держится крайняя. */
export function faceAt(track: FaceTrack, t: number): number {
  const n = track.length
  if (n === 0) return 0.5
  if (t <= track[0].t) return track[0].x
  if (t >= track[n - 1].t) return track[n - 1].x
  for (let i = 1; i < n; i++) {
    if (t < track[i].t) {
      const a = track[i - 1]
      const b = track[i]
      return a.x + (b.x - a.x) * ease((t - a.t) / Math.max(1e-9, b.t - a.t))
    }
  }
  return track[n - 1].x
}

/** Трек из файла проекта: мусор выброшен, время по возрастанию, положение в 0..1; пустой — null. */
export function cleanFace(raw: unknown): FaceTrack | null {
  if (!Array.isArray(raw)) return null
  const pts: FacePoint[] = []
  for (const p of raw as Array<Record<string, unknown>>) {
    const t = Number(p?.t)
    const x = Number(p?.x)
    if (Number.isFinite(t) && t >= 0 && Number.isFinite(x)) pts.push({ t: r3(t), x: r4(clamp(x, 0, 1)) })
  }
  pts.sort((a, b) => a.t - b.t)
  const out = pts.filter((p, i) => i === 0 || p.t - pts[i - 1].t > 0.001).slice(0, MAX_FACE_POINTS)
  return out.length ? out : null
}

export const sameFace = (a: FaceTrack | null, b: FaceTrack | null): boolean =>
  a === b || (!!a && !!b && a.length === b.length && a.every((p, i) => Math.abs(p.t - b[i].t) < 1e-6 && Math.abs(p.x - b[i].x) < 1e-6))

/**
 * Сдвиг окна кропа 0..1 (как offsetX клипа): окно шириной ow в картинке шириной iw стоит так, чтобы лицо (cx) было в центре;
 * manual — ручной сдвиг клипа (0.5 — без сдвига), он добавляется поверх: ±половина свободного места.
 */
export function followOffset(cx: number, iw: number, ow: number, manual = 0.5): number {
  const slack = iw - ow
  if (slack <= 0) return 0.5
  return clamp((cx * iw - ow / 2 + (manual - 0.5) * slack) / slack, 0, 1)
}
