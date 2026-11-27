import assert from 'node:assert/strict'
import { buildTrack, cleanFace, decodeYunet, faceAt, followOffset, iou, letterbox, nms, sameFace } from './face.ts'
import { applyFaceTrack, clearFace, joinItems } from './mix.ts'
import { buildExport, faceExpr } from './exportGraph.ts'
import { addMedia, insertMedia, itemDur, newProject, sanitizeProject, splitItem } from './project.ts'

const near = (a, b, msg, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} != ${b}`)
const V = (path, duration, extra = {}) => ({ path, name: path, duration, hasVideo: true, hasAudio: true, width: 1280, height: 720, fps: 25, needsPreview: false, ...extra })
const box = (cx, cy = 0.4, w = 0.05, h = 0.12, score = 0.9) => ({ x: cx - w / 2, y: cy - h / 2, w, h, score })

// --- разбор выхода детектора
{
  const lb = letterbox(1280, 720)
  assert.deepEqual([lb.nw, lb.nh, lb.px, lb.py], [640, 360, 0, 140])
  assert.deepEqual([letterbox(720, 1280).nw, letterbox(720, 1280).px], [360, 140])
  const S = 640
  const mk = (stride, hit, logSize = 0) => {
    const cols = S / stride
    const cls = new Float32Array(cols * cols)
    const obj = new Float32Array(cols * cols)
    const bbox = new Float32Array(cols * cols * 4)
    for (const [r, c] of hit) {
      const i = r * cols + c
      cls[i] = 0.9
      obj[i] = 0.9
      bbox.set([0.5, 0.5, logSize, logSize], i * 4) // центр клетки, размер = шагу·exp(logSize)
    }
    return { cls, obj, bbox }
  }
  const o32 = mk(32, [[10, 10]])
  const o16 = mk(16, [[20, 20]], Math.LN2) // тот же человек: рамка 32 px рядом с большим якорем
  const o16b = mk(16, [[10, 30]]) // другой человек
  const o8 = mk(8, [])
  const merge = (a, b) => { const r = Float32Array.from(a); b.forEach((v, i) => v && (r[i] = v)); return r }
  const out = { cls_8: o8.cls, obj_8: o8.obj, bbox_8: o8.bbox, cls_16: merge(o16.cls, o16b.cls), obj_16: merge(o16.obj, o16b.obj), bbox_16: merge(o16.bbox, o16b.bbox), cls_32: o32.cls, obj_32: o32.obj, bbox_32: o32.bbox }
  const dets = decodeYunet(out, lb)
  assert.equal(dets.length, 2, 'два разных лица, дубли одного слились')
  // якорь шага 32: клетка (10,10), центр (336,336) в пикселях модели, поля сверху 140 → x=(336-16)/640, y=(336-16-140)/360
  const big = dets.find((d) => Math.abs(d.w - 32 / 640) < 1e-3)
  near(big.x, 0.5, 'x', 0.02); near(big.y, 0.5, 'y', 0.03); near(big.score, 0.9, 'уверенность')
  assert.equal(decodeYunet({ ...out }, lb, 0.95).length, 0, 'порог уверенности')
  assert.equal(nms([box(0.5), box(0.505), box(0.8)]).length, 2)
  near(iou(box(0.5), box(0.5)), 1, 'iou сам с собой')
  near(iou(box(0.2), box(0.8)), 0, 'iou далёких')
}

// --- трекинг: спокойный кадр
const frames = (from, to, fn, fps = 4) => {
  const out = []
  for (let t = from; t <= to + 1e-9; t += 1 / fps) out.push({ t: Math.round(t * 1000) / 1000, boxes: fn(t) })
  return out
}
const SEED = (t, b) => ({ mode: 'seed', seed: { t, box: b } })
{
  // двое сидят; идём за левым — кадр стоит, к соседу не прыгает; первый кадр сразу на человеке
  const s = frames(0, 20, () => [box(0.3), box(0.7)])
  const tr = buildTrack(s, SEED(5, box(0.3)))
  assert.ok(tr.length <= 2, `неподвижное лицо — одна площадка (2 точки), а не ${tr.length}`)
  assert.ok(tr.every((p) => Math.abs(p.x - 0.3) < 0.01))
  near(tr[0].t, 0, 'с начала'); near(faceAt(tr, 0), 0.3, 'первый кадр сразу на человеке', 0.01); near(tr.at(-1).t, 20, 'до конца')
  const right = buildTrack(s, SEED(5, box(0.7)))
  assert.ok(right.every((p) => Math.abs(p.x - 0.7) < 0.01), 'за правым')
}
{
  // человек качается ±0.02 и ±0.03 разовые промахи — кадр не двигается вообще
  const s = frames(0, 30, (t) => [box(0.5 + Math.sin(t * 9) * 0.02 + (Math.abs(t - 12) < 0.01 ? 0.15 : 0))])
  const tr = buildTrack(s, SEED(1, box(0.5)))
  assert.ok(tr.length <= 2 && tr.every((p) => Math.abs(p.x - 0.5) < 0.03), `дрожь и разовый промах не двигают кадр: ${JSON.stringify(tr)}`)
}
{
  // лицо ушло с 0.3 на 0.6 в t=8..9 и остаётся: площадка, короткий переход, площадка
  const s = frames(0, 20, (t) => [box(0.3 + 0.3 * Math.min(1, Math.max(0, t - 8)))])
  const tr = buildTrack(s, SEED(2, box(0.3)))
  assert.ok(tr.length >= 4 && tr.length <= 6, `площадка, переход, площадка: ${tr.length} точек`)
  near(faceAt(tr, 5), 0.3, 'до ухода стоит', 0.01); near(faceAt(tr, 7.5), 0.3, 'ещё стоит: лицо пока в пределах порога', 0.05)
  near(faceAt(tr, 12), 0.6, 'после ухода стоит на новом месте', 0.02)
  const pan = tr.filter((p) => p.t > 7 && p.t < 12)
  assert.ok(pan.length === 2 && pan[1].t - pan[0].t <= 2.55 && pan[1].t - pan[0].t >= 1.15, `переход долгий и плавный (1,2–2,5 с): ${pan[1].t - pan[0].t}`)
  // чем дальше сдвиг, тем дольше: малый (0,12 кадра) ≈ 1,5 с, средний (0,3) ≈ 2,1 с
  const smallS = frames(0, 20, (t) => [box(0.3 + 0.12 * Math.min(1, Math.max(0, t - 8)))])
  const small = buildTrack(smallS, SEED(2, box(0.3))).filter((p) => p.t > 7 && p.t < 14)
  const dSmall = small[1].t - small[0].t
  assert.ok(small.length === 2 && dSmall >= 1.2 && dSmall < pan[1].t - pan[0].t, `малый сдвиг короче среднего: ${dSmall} < ${pan[1].t - pan[0].t}`)
}
{
  // лицо пропало с 8 по 14 с: держим последнее положение, к центру НЕ уезжаем
  const s = frames(0, 20, (t) => (t >= 8 && t < 14 ? [] : [box(0.2)]))
  const tr = buildTrack(s, SEED(2, box(0.2)))
  for (const t of [9, 11, 13.5]) near(faceAt(tr, t), 0.2, `держим на ${t} с`, 0.01)
  assert.ok(tr.length <= 2)
}
{
  // seed в середине; без детекций вообще — точка по рамке
  const s = frames(0, 10, () => [box(0.8)])
  const tr = buildTrack(s, SEED(5, box(0.8)))
  near(tr[0].t, 0, 'назад до начала'); near(faceAt(tr, 0), 0.8, 'и там на месте', 0.01)
  assert.deepEqual(buildTrack([], SEED(3, box(0.4))), [{ t: 3, x: 0.4 }])
  assert.deepEqual(buildTrack([], { mode: 'speaker' }), [])
}

// --- склейки монтажа
{
  // 0–10 с: мужчина (0.4); склейка 10.1: девушка в кадре одна (0.55); склейка 20.1: снова мужчина (0.4)
  const s = frames(0, 30, (t) => (t < 10.1 ? [box(0.4)] : t < 20.1 ? [box(0.55)] : [box(0.4)]))
  const cuts = [10.1, 20.1]
  const tr = buildTrack({ samples: s, cuts }, SEED(3, box(0.4)))
  near(faceAt(tr, 9), 0.4, 'до склейки на мужчине', 0.02)
  near(faceAt(tr, 12), 0.55, 'после склейки — на том, кто в кадре', 0.02)
  near(faceAt(tr, 25), 0.4, 'после второй — снова на мужчине', 0.02)
  near(faceAt(tr, 10.0), 0.4, 'за кадр до склейки ещё на старом', 0.02)
  near(faceAt(tr, 10.2), 0.55, 'сразу после — уже на новом', 0.02)
  const i = tr.findIndex((p) => p.t > 10 && p.t < 10.1)
  assert.ok(i >= 0 && tr[i + 1].t - tr[i].t <= 0.1, 'на склейке две точки рядом: мгновенный перескок')
}
{
  // ложная склейка (резкий жест): лицо на том же месте — перескока нет
  const s = frames(0, 20, () => [box(0.45)])
  const tr = buildTrack({ samples: s, cuts: [10.1] }, SEED(3, box(0.45)))
  assert.ok(tr.length <= 2 && tr.every((p) => Math.abs(p.x - 0.45) < 0.01), 'положение не изменилось — склейки нет')
}
{
  // две головы после склейки: ближайшая к прежнему положению; далёкий человек без склейки не подхватывается
  const s = frames(0, 20, (t) => (t < 10.1 ? [box(0.2)] : [box(0.8), box(0.3)]))
  const tr = buildTrack({ samples: s, cuts: [10.1] }, SEED(2, box(0.2)))
  near(faceAt(tr, 15), 0.3, 'из двух — ближайшее к прежнему', 0.02)
  const far = frames(0, 20, (t) => (t < 8 ? [box(0.2)] : t < 12 ? [] : [box(0.75)]))
  assert.ok(faceAt(buildTrack(far, SEED(2, box(0.2))), 18) < 0.3 || faceAt(buildTrack(far, SEED(2, box(0.2))), 18) > 0.7, 'без склейки далёкого нового лица кадр не «ловит» плавно: он либо остаётся, либо уходит один раз')
}

// --- склейка, которую не нашёл ffmpeg: общий план → крупный
{
  // 0–0.6 с общий план (два мелких лица 0.27 и 0.74), дальше крупный план мужчины (0.46, большое лицо); склеек в списке нет
  const s = frames(0, 10, (t) => (t < 0.6 ? [box(0.27, 0.27, 0.05, 0.065, 0.91), box(0.74, 0.28, 0.05, 0.05, 0.89)] : [box(0.46, 0.32, 0.17, 0.19, 0.94)]))
  const tr = buildTrack(s, { mode: 'speaker' })
  near(faceAt(tr, 1), 0.46, 'на 1-й секунде уже на лице крупного плана, без «подлёта»', 0.02)
  near(faceAt(tr, 5), 0.46, 'и держится', 0.02)
  assert.ok(tr.length <= 4, `лишних точек нет: ${JSON.stringify(tr)}`)
}

// --- говорящий
{
  // общий план: слева A (0.25), справа B (0.7). 0–10 с говорит A, 10–20 с говорит B. Речь есть всё время.
  const s = frames(0, 20, (t) => [box(0.25, 0.4, 0.05, 0.12, 0.9), box(0.7, 0.4, 0.05, 0.12, 0.9)].map((b, i) => ({ ...b, act: (i === 0) === (t < 10) ? 8 : 1 })))
  const speech = [[0, 20]]
  const tr = buildTrack({ samples: s, cuts: [], speech }, { mode: 'speaker' })
  near(faceAt(tr, 5), 0.25, 'говорит A — на нём', 0.02)
  near(faceAt(tr, 8), 0.25, 'и до смены', 0.02)
  near(faceAt(tr, 16), 0.7, 'заговорил B — кадр на нём (переход 1,2–2,5 с после паузы на смену)', 0.02)
  const pan = tr.filter((p) => p.t > 9 && p.t < 16)
  assert.ok(pan.length === 2 && pan[0].t >= 10 - 0.3 && pan[1].t <= 15.6, `смена говорящего — один плавный переход: ${JSON.stringify(pan)}`)
}
{
  // односложные ответы B (1–1,5 с «да, конечно») не переключают кадр с A; а долгий ответ (4 с) — переключает
  const ans = (len) => frames(0, 30, (t) => [box(0.25), box(0.7)].map((b, i) => ({ ...b, act: i === 0 ? (t >= 10 && t < 10 + len ? 1 : 8) : t >= 10 && t < 10 + len ? 9 : 1 })))
  const short = buildTrack({ samples: ans(1.5), cuts: [], speech: [[0, 30]] }, { mode: 'speaker' })
  assert.ok(short.every((p) => Math.abs(p.x - 0.25) < 0.02), `ответ в 1,5 с кадр не двигает: ${JSON.stringify(short)}`)
  const brokenAnswer = frames(0, 30, (t) => [box(0.25), box(0.7)].map((b, i) => ({ ...b, act: i === 0 ? 1 : (t >= 10 && t < 14 && Math.abs(((t - 10) % 1.5) - 0.75) > 0.3) || t >= 14 ? 9 : 1 })))
  assert.ok(buildTrack({ samples: brokenAnswer, cuts: [], speech: [[0, 30]] }, { mode: 'speaker' }).every((p) => p.x > 0.2), 'проверка набора')
  const long = buildTrack({ samples: ans(4), cuts: [], speech: [[0, 30]] }, { mode: 'speaker' })
  near(faceAt(long, 16.5), 0.7, 'ответ B дольше 2,5 с — кадр перешёл на него', 0.02)
  near(faceAt(long, 25), 0.25, 'A снова говорит долго — кадр вернулся', 0.02)
  const mid = buildTrack({ samples: ans(8), cuts: [], speech: [[0, 30]] }, { mode: 'speaker' })
  near(faceAt(mid, 16), 0.7, 'долгая речь B (8 с) — кадр на нём', 0.02)
}
{
  // разовая ложная рамка (один кадр, рядом с прежним положением) — не человек: кадр не уезжает к ней и не ждёт её
  const s = frames(0, 20, (t) => [box(0.48, 0.32, 0.17, 0.18), ...(Math.abs(t - 6) < 0.1 ? [{ ...box(0.22, 0.47, 0.1, 0.1, 0.8), act: 12 }] : [])].map((b) => ({ ...b, act: b.act ?? 0.1 })))
  const tr = buildTrack({ samples: s, cuts: [], speech: [[0, 20]] }, { mode: 'speaker' })
  assert.ok(tr.every((p) => Math.abs(p.x - 0.48) < 0.02), `ложная рамка кадр не двигает: ${JSON.stringify(tr)}`)
}
{
  // короткое «ага» B на 0.5 с не переключает кадр
  const s = frames(0, 20, (t) => [box(0.25), box(0.7)].map((b, i) => ({ ...b, act: i === 0 ? (Math.abs(t - 10) < 0.3 ? 1 : 8) : Math.abs(t - 10) < 0.3 ? 9 : 1 })))
  const tr = buildTrack({ samples: s, cuts: [], speech: [[0, 20]] }, { mode: 'speaker' })
  assert.ok(tr.every((p) => Math.abs(p.x - 0.25) < 0.02), 'короткая реплика не двигает кадр')
}
{
  // пауза: речи нет — остаёмся на том, кто говорил последним (B заговорил, потом оба молчат)
  const s = frames(0, 30, (t) => [box(0.25), box(0.7)].map((b, i) => ({ ...b, act: (i === 0) === (t < 10) ? 8 : 1 })))
  const tr = buildTrack({ samples: s, cuts: [], speech: [[0, 20]] }, { mode: 'speaker' })
  near(faceAt(tr, 28), 0.7, 'после конца речи — на последнем говорившем', 0.02)
  // «по щелчку» игнорирует говорящего
  const seeded = buildTrack({ samples: s, cuts: [], speech: [[0, 30]] }, SEED(2, box(0.25)))
  assert.ok(seeded.every((p) => Math.abs(p.x - 0.25) < 0.02), 'режим по щелчку держит выбранного')
  // нет данных об активности (не считали) — остаёмся на крупнейшем и не прыгаем
  const noAct = frames(0, 10, () => [box(0.25, 0.4, 0.06, 0.14), box(0.7, 0.4, 0.04, 0.1)])
  const t2 = buildTrack(noAct, { mode: 'speaker' })
  assert.ok(t2.every((p) => Math.abs(p.x - 0.25) < 0.02), 'без сведений о губах — на крупнейшем лице, без метаний')
}
{
  // говорящий уходит из кадра на 2 с и дольше: берём оставшегося
  const s = frames(0, 20, (t) => (t < 10 ? [box(0.25), box(0.7)] : [box(0.7)]).map((b, i, arr) => ({ ...b, act: arr.length === 2 && i === 0 ? 8 : 1 })))
  const tr = buildTrack({ samples: s, cuts: [], speech: [[0, 20]] }, { mode: 'speaker' })
  near(faceAt(tr, 8), 0.25, 'пока оба — на говорящем', 0.02); near(faceAt(tr, 18), 0.7, 'остался один — на нём', 0.02)
}

// --- faceAt, cleanFace, followOffset
{
  const tr = [{ t: 0, x: 0.2 }, { t: 10, x: 0.8 }]
  near(faceAt(tr, -5), 0.2, 'до начала'); near(faceAt(tr, 99), 0.8, 'после конца'); near(faceAt(tr, 5), 0.5, 'середина плавного отрезка')
  assert.ok(faceAt(tr, 2.5) < 0.2 + 0.6 * 0.25, 'плавно: в начале медленнее линейного')
  assert.equal(faceAt([], 3), 0.5)
  assert.deepEqual(cleanFace([{ t: 2, x: 9 }, { t: 1, x: -1 }, { t: 'a', x: 1 }, null, { t: 1.0002, x: 0.5 }]), [{ t: 1, x: 0 }, { t: 2, x: 1 }])
  assert.equal(cleanFace([]), null); assert.equal(cleanFace('x'), null)
  assert.equal(sameFace(tr, tr.map((p) => ({ ...p }))), true); assert.equal(sameFace(tr, null), false)
  // кроп 9:16 из 16:9: картинка 3413 px, окно 1080: лицо в центре — окно по центру; у края — у края
  near(followOffset(0.5, 3413, 1080), 0.5, 'по центру'); near(followOffset(0.0, 3413, 1080), 0, 'у левого края окно упирается'); near(followOffset(1, 3413, 1080), 1, 'у правого')
  const o = followOffset(0.25, 3413, 1080)
  near(o * (3413 - 1080) + 540, 0.25 * 3413, 'центр окна на лице')
  near(followOffset(0.5, 3413, 1080, 1), 1, 'ручной сдвиг до упора'); near(followOffset(0.5, 1000, 1000), 0.5, 'нет запаса — по центру')
}

// --- на куске: ключи X в вертикальном проекте, трек в 16:9
{
  let p = newProject('F')
  p = addMedia(p, V('/a.mp4', 20)).p
  const ins = insertMedia(p, p.media[0].id, 0)
  p = ins.p
  const id = ins.id
  const track = [{ t: 0, x: 0.5 }, { t: 5, x: 0.25 }, { t: 12, x: 0.75 }, { t: 20, x: 0.75 }]
  // 16:9: картинка во весь кадр — ключей нет
  const wide = applyFaceTrack(p, id, track, { w: 1920, h: 1080 })
  assert.equal(wide.keyed, false)
  assert.deepEqual(wide.p.items[0].face, track)
  assert.equal(wide.p.items[0].keys.x.length, 0)
  assert.equal(wide.p.items[0].frame.scale, 100)
  // 9:16: масштаб «заполнить», ключи X
  const vert = applyFaceTrack(p, id, track, { w: 1080, h: 1920 })
  assert.equal(vert.keyed, true)
  const it = vert.p.items[0]
  near(it.frame.scale, (1920 / (1080 * 9 / 16)) * 100, 'масштаб — заполнить по высоте', 0.5)
  const kx = it.keys.x
  assert.ok(kx.length >= 4 && kx.every((k) => k.v >= -150 && k.v <= 150), 'ключи в пределах поля')
  near(kx.find((k) => k.t === 0).v, 0, 'лицо по центру — без сдвига')
  const picW = 1080 * (it.frame.scale / 100)
  near(kx.find((k) => k.t === 5).v, ((0.25 * picW) / 1080) * 100, 'лицо слева — картинка уезжает вправо', 0.1)
  assert.ok(kx.find((k) => k.t === 12).v < 0, 'лицо справа — влево')
  assert.equal(kx.at(-1).t, 20)
  // зеркало меняет знак
  const flipped = applyFaceTrack({ ...p, items: p.items.map((i) => ({ ...i, frame: { ...i.frame, flipH: 1 } })) }, id, track, { w: 1080, h: 1920 })
  near(flipped.p.items[0].keys.x.find((k) => k.t === 5).v, -kx.find((k) => k.t === 5).v, 'зеркало — обратный сдвиг', 0.1)
  // ключи края картинки не выходят за кадр: максимум сдвига — до края
  const edge = applyFaceTrack(p, id, [{ t: 0, x: 0 }, { t: 20, x: 0 }], { w: 1080, h: 1920 }).p.items[0].keys.x[0].v
  near(edge, ((picW - 1080) / 2 / 1080) * 100, 'у края кадра упирается в край картинки', 0.1)
  assert.equal(clearFace(vert.p, id).items[0].face, null)
  assert.ok(clearFace(vert.p, id).items[0].keys.x.length > 0, 'ключи остаются')

  // резка делит трек (время исходника у обеих половин), склейка возвращает; разный трек — не склеить
  const sp = splitItem(vert.p, id, 8)
  const l = sp.p.items.find((i) => i.id === id)
  const r = sp.p.items.find((i) => i.id === sp.id)
  assert.deepEqual(l.face, track); assert.deepEqual(r.face, track)
  assert.ok(!joinItems(sp.p, id, sp.id).error, 'половины одного куска склеиваются')
  const other = { ...sp.p, items: sp.p.items.map((i) => (i.id === sp.id ? { ...i, face: [{ t: 0, x: 0.1 }] } : i)) }
  assert.match(joinItems(other, id, sp.id).error, /трек лица/)
  // сохранение и чтение
  const rt = sanitizeProject(JSON.parse(JSON.stringify(vert.p)))
  assert.deepEqual(rt.items[0].face, track)
  const old = JSON.parse(JSON.stringify(vert.p)); delete old.items[0].face
  assert.equal(sanitizeProject(old).items[0].face, null)

  // экспорт клипа: кроп едет за лицом; выражение совпадает с faceAt (в том числе при скорости 2×)
  const cp = { ...vert.p, canvas: { w: 1920, h: 1080 } }
  const args = buildExport(cp, { W: 1080, H: 1920, fps: 30, format: 'h264', quality: 'small', subLayers: [], framing: { mediaId: p.media[0].id, mode: 'crop', offsetX: 0.5 } }, '/o.mp4').args
  const g = args[args.indexOf('-filter_complex') + 1]
  assert.match(g, /crop=1080:1920:'clip\(\(/)
  const IF = (c, a, b) => (c ? a : b)
  const ev = (expr, t) => new Function('t', 'IF', 'lt', 'clip', 'pow', `return ${expr.replace(/\bif\(/g, 'IF(')}`)(t, IF, (a, b) => (a < b ? 1 : 0), (x, a, b) => Math.min(b, Math.max(a, x)), Math.pow)
  for (const speed of [1, 2]) {
    const it2 = { ...vert.p.items[0], start: 3, speed, out: 20 }
    const ex = faceExpr(it2)
    for (let tl = 3; tl < 3 + 20 / speed; tl += 0.37) near(ev(ex, tl), faceAt(track, it2.in + (tl - 3) * speed), `выражение совпадает с faceAt (×${speed}) tl=${tl.toFixed(2)}`, 2e-3)
  }
  // без трека — статичный кроп, как раньше
  const plain = buildExport({ ...cp, items: cp.items.map((i) => ({ ...i, face: null })) }, { W: 1080, H: 1920, fps: 30, format: 'h264', quality: 'small', subLayers: [], framing: { mediaId: p.media[0].id, mode: 'crop', offsetX: 0.5 } }, '/o.mp4').args
  assert.match(plain[plain.indexOf('-filter_complex') + 1], /crop=1080:1920:\(iw-ow\)\*0\.5000:\(ih-oh\)\/2/)
  // «целиком на блюре» трек не использует
  const blur = buildExport(cp, { W: 1080, H: 1920, fps: 30, format: 'h264', quality: 'small', subLayers: [], framing: { mediaId: p.media[0].id, mode: 'fit-blur', offsetX: 0.5 } }, '/o.mp4').args
  assert.ok(!/clip\(\(/.test(blur[blur.indexOf('-filter_complex') + 1]))
  assert.equal(itemDur(it) > 0, true)
}

console.log('face.ts: все проверки прошли')
