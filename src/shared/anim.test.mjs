import assert from 'node:assert/strict'
import { animAt, animExpr, animSet, cleanKeys, clampKeys, evalKeys, hasKeys, isAnimated, joinEffects, keysJoinGap, mergeKeys, moveKey, noKeys, setKey, shiftKeys, sliceEffects, splitKeys, ease } from './anim.ts'
import { DEFAULT_FRAME } from './frame.ts'
import { newEffect, cleanEffects } from './effects.ts'
import { insertShape, patchShape, toggleFlip, canHaveEffects, hasFrameCrop } from './mix.ts'
import { newShape, cleanShape, SHAPE_KINDS, shapeLabel } from './shape.ts'
import { flipFilters, isStillFrame } from './frame.ts'
import { addKeyAt, addEffect, canJoin, deleteKeyAt, disableKeys, enableKeys, frameValueAt, joinItems, moveKeyTo, patchEffect, resetFrame, setKeyEase, setPropAt, setSpeed, insertText, patchFrame } from './mix.ts'
import { cropProject } from './cut.ts'
import { addMedia, insertMedia, itemDur, newProject, sanitizeProject, splitItem, trimItem } from './project.ts'

const near = (a, b, msg, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} != ${b}`)
const V = (path, duration, extra = {}) => ({ path, name: path, duration, hasVideo: true, hasAudio: true, width: 1280, height: 720, fps: 25, needsPreview: false, ...extra })
const fx = (type, values = {}, extra = {}) => ({ ...newEffect(type), values: { ...newEffect(type).values, ...values }, ...extra })
const src = (o = {}) => ({ frame: { ...DEFAULT_FRAME }, keys: noKeys(), effects: [], ...o })

// --- ключи: линия, плавность, края
{
  const ks = [{ t: 1, v: 0, ease: false }, { t: 3, v: 100, ease: false }, { t: 5, v: 100, ease: true }, { t: 7, v: 0, ease: false }]
  near(evalKeys(ks, 50, 0), 0, 'до первого держится первый')
  near(evalKeys(ks, 50, 2), 50, 'линейно')
  near(evalKeys(ks, 50, 4), 100, 'плато')
  near(evalKeys(ks, 50, 6), 50, 'плавно: середина совпадает с линейной')
  near(evalKeys(ks, 50, 5.5), 100 - 100 * ease(0.25), 'плавный отрезок идёт по ease')
  assert.ok(evalKeys(ks, 50, 5.5) > 100 - 25, 'в начале плавного отрезка движение медленнее линейного')
  near(evalKeys(ks, 50, 99), 0, 'после последнего держится последний')
  near(evalKeys([], 42, 3), 42, 'без ключей — значение из «Кадра»')
  assert.deepEqual(cleanKeys({ x: [{ t: 2, v: 999, ease: true }, { t: 1, v: -999 }, { t: 'a', v: 1 }, { t: 1.0004, v: 5 }], scale: 'x' }).x, [{ t: 1, v: -100, ease: false }, { t: 2, v: 100, ease: true }], 'мусор выброшен, значения зажаты, дубли по времени склеены')
  assert.deepEqual(cleanKeys(null), noKeys())
}

// --- готовые анимации: значения
{
  const len = 10
  const a = (effects, t, extra = {}) => animAt(src({ effects, ...extra }), len, t)
  near(a([fx('fadeIn', { dur: 2 })], 0).opacity, 0, 'появление: в начале прозрачно')
  near(a([fx('fadeIn', { dur: 2 })], 1).opacity, 0.5, 'появление: середина')
  near(a([fx('fadeIn', { dur: 2 })], 5).opacity, 1, 'появление: потом полностью видно')
  near(a([fx('fadeOut', { dur: 2 })], 9).opacity, 0.5, 'исчезновение: середина')
  near(a([fx('fadeOut', { dur: 2 })], 10).opacity, 0, 'исчезновение: в конце прозрачно')
  near(a([fx('fadeIn', { dur: 2 }, { on: false })], 0).opacity, 1, 'выключенная анимация не действует')
  near(a([fx('zoom', { dir: 0, dur: 2, amount: 20 })], 0).scale, 1, 'приближение: старт 100%')
  near(a([fx('zoom', { dir: 0, dur: 2, amount: 20 })], 1).scale, 1.1, 'приближение: середина')
  near(a([fx('zoom', { dir: 0, dur: 2, amount: 20 })], 8).scale, 1.2, 'приближение держится на 120%')
  near(a([fx('zoom', { dir: 1, dur: 2, amount: 20 })], 0).scale, 1.2, 'отдаление: старт 120%')
  near(a([fx('zoom', { dir: 1, dur: 2, amount: 20 })], 5).scale, 1, 'отдаление: потом 100%')
  near(a([fx('pop', { dur: 0.4, amount: 15 })], 0.2).scale, 1.15, 'поп: пик в середине')
  near(a([fx('pop', { dur: 0.4, amount: 15 })], 0).scale, 1, 'поп: старт 100%')
  near(a([fx('pop', { dur: 0.4, amount: 15 })], 1).scale, 1, 'поп: потом 100%')
  near(a([fx('slideIn', { side: 0, dur: 1 })], 0).x, -100, 'выезд слева: старт за левым краем')
  near(a([fx('slideIn', { side: 1, dur: 1 })], 0).x, 100, 'выезд справа')
  near(a([fx('slideIn', { side: 2, dur: 1 })], 0).y, -100, 'выезд сверху')
  near(a([fx('slideIn', { side: 3, dur: 1 })], 0).y, 100, 'выезд снизу')
  near(a([fx('slideIn', { side: 0, dur: 1 })], 1).x, 0, 'выезд закончился')
  near(a([fx('slideOut', { side: 1, dur: 1 })], 10).x, 100, 'уход вправо: в конце за краем')
  near(a([fx('slideOut', { side: 1, dur: 1 })], 9).x, 0, 'уход: до начала окна на месте')
  near(a([fx('slideOut', { side: 0, dur: 1 })], 9.5).x, -50, 'уход влево: середина')
  // анимации поверх ключей и «Кадра»: масштаб умножается, сдвиг складывается, прозрачность умножается
  const fr = { ...DEFAULT_FRAME, scale: 200, x: 10, opacity: 50 }
  const r = animAt(src({ frame: fr, effects: [fx('zoom', { dir: 0, dur: 1, amount: 50 }), fx('slideIn', { side: 0, dur: 1 }), fx('fadeIn', { dur: 1 })] }), len, 0.5)
  near(r.scale, 2 * 1.25, 'масштаб: база × зум')
  near(r.x, 10 - 50, 'сдвиг: база + выезд')
  near(r.opacity, 0.5 * 0.5, 'прозрачность: база × появление')
  const k = noKeys()
  k.scale = [{ t: 0, v: 100, ease: false }, { t: 10, v: 300, ease: false }]
  near(animAt(src({ keys: k, effects: [fx('zoom', { dir: 0, dur: 1, amount: 100 })] }), len, 5).scale, 2 * 2, 'ключи × зум')
  assert.equal(isAnimated(src()), false)
  assert.equal(isAnimated(src({ effects: [fx('blur')] })), false, 'блюр — не анимация')
  assert.equal(isAnimated(src({ effects: [fx('pop')] })), true)
  assert.equal(isAnimated(src({ keys: k })), true)
  assert.equal(hasKeys(k), true)
  assert.ok(animAt(src({ frame: { ...DEFAULT_FRAME, scale: 400 }, effects: [fx('zoom', { amount: 100, dur: 0.2 })] }), len, 3).scale <= 6, 'предел масштаба')
  assert.deepEqual(Object.keys(animSet([fx('fadeIn'), fx('zoom'), fx('blur')])).sort(), ['fadeIn', 'zoom'])
}

// --- выражения ffmpeg совпадают с animAt (одна математика для превью и экспорта)
{
  const IF = (c, a, b) => (c ? a : b)
  const ev = (expr, t) => new Function('t', 'T', 'IF', 'lt', 'clip', 'sin', 'PI', `return ${expr.replace(/\bif\(/g, 'IF(')}`)(t, t, IF, (a, b) => (a < b ? 1 : 0), (x, a, b) => Math.min(b, Math.max(a, x)), Math.sin, Math.PI)
  const val = (e, t) => (e.e === undefined ? e.c : ev(e.e, t))
  const keys = noKeys()
  keys.x = [{ t: 0.5, v: -30, ease: true }, { t: 2, v: 40, ease: false }, { t: 6, v: 10, ease: true }]
  keys.scale = [{ t: 1, v: 80, ease: true }, { t: 4, v: 250, ease: false }]
  keys.opacity = [{ t: 0, v: 100, ease: false }, { t: 3, v: 20, ease: true }, { t: 7, v: 90, ease: false }]
  const frame = { ...DEFAULT_FRAME, scale: 120, x: 5, y: -8, opacity: 90 }
  const sets = [
    [],
    [fx('fadeIn', { dur: 1.3 }), fx('fadeOut', { dur: 2 })],
    [fx('zoom', { dir: 0, dur: 2.5, amount: 35 }), fx('pop', { dur: 0.6, amount: 20 })],
    [fx('zoom', { dir: 1, dur: 3, amount: 50 }), fx('slideIn', { side: 2, dur: 1.5 }), fx('slideOut', { side: 1, dur: 2 })],
    [fx('slideIn', { side: 0, dur: 1 }, { skip: 0.4 }), fx('fadeOut', { dur: 3 }, { skipEnd: 1.2 }), fx('zoom', { dur: 4, amount: 25 }, { skip: 1 }), fx('pop', { dur: 1 }, { skip: 0.3 })]
  ]
  let n = 0
  for (const withKeys of [false, true]) {
    for (const effects of sets) {
      const s = src({ frame, keys: withKeys ? keys : noKeys(), effects })
      const len = 8
      const start = 12.5
      const ex = animExpr(s, len, start, 't')
      const exT = animExpr(s, len, start, 'T')
      for (let rel = 0; rel <= len; rel += 0.137) {
        const want = animAt(s, len, rel)
        near(val(ex.x, start + rel), want.x, `x rel=${rel}`, 2e-3)
        near(val(ex.y, start + rel), want.y, `y rel=${rel}`, 2e-3)
        near(val(ex.scale, start + rel), want.scale, `scale rel=${rel}`, 2e-3)
        near(val(ex.opacity, start + rel), want.opacity, `opacity rel=${rel}`, 2e-3)
        near(val(exT.opacity, start + rel), want.opacity, `opacity(T) rel=${rel}`, 2e-3)
        n++
      }
    }
  }
  assert.ok(n > 500)
  // статичное — числа, без выражений
  const st = animExpr(src(), 5, 0, 't')
  assert.deepEqual([st.x.c, st.y.c, st.scale.c, st.opacity.c], [0, 0, 1, 1])
  assert.ok(animExpr(src({ effects: [fx('fadeIn')] }), 5, 0, 't').opacity.e)
  assert.equal(animExpr(src({ effects: [fx('fadeIn')] }), 5, 0, 't').x.e, undefined)
}

// --- операции над ключами
{
  let r = setKey([], 'x', 1, 10, 5)
  r = setKey(r.keys, 'x', 3, 30, 5)
  assert.deepEqual(r.keys.map((k) => k.t), [1, 3])
  r = setKey(r.keys, 'x', 3.01, 35, 5)
  assert.equal(r.keys.length, 2, 'рядом — обновление, а не новый ключ')
  assert.equal(r.keys[1].v, 35)
  assert.equal(setKey(r.keys, 'x', 99, 0, 5).keys.at(-1).t, 5, 'время зажато длиной куска')
  assert.equal(setKey([], 'opacity', 1, 500, 5).keys[0].v, 100, 'значение зажато пределом свойства')
  const mv = moveKey(r.keys, 'x', 0, 50, 10, 5)
  assert.ok(mv[0].t < r.keys[1].t, 'ключ не перескакивает соседа')
  assert.deepEqual(clampKeys([{ t: 1, v: 0, ease: false }, { t: 9, v: 100, ease: false }], 5), [{ t: 1, v: 0, ease: false }, { t: 5, v: 50, ease: false }], 'за краем: ключ на краю со значением линии')
  const keep = [{ t: 1, v: 0, ease: false }]
  assert.equal(clampKeys(keep, 5), keep)
  // подрезка слева
  const base = [{ t: 0, v: 0, ease: false }, { t: 4, v: 40, ease: false }, { t: 8, v: 0, ease: false }]
  const sh = shiftKeys(base, 2)
  assert.deepEqual(sh.map((k) => [k.t, k.v]), [[0, 20], [2, 40], [6, 0]], 'линия остаётся на месте, на новом начале ключ')
  assert.deepEqual(shiftKeys(base, -1).map((k) => k.t), [1, 5, 9], 'край вытянули влево — ключи едут вправо')
  // резка и склейка
  const k = noKeys()
  k.x = base
  const { left, right } = splitKeys(k, 2)
  near(evalKeys(left.x, 0, 2), 20, 'резка: слева стык')
  near(evalKeys(right.x, 0, 0), 20, 'резка: справа стык')
  near(evalKeys(right.x, 0, 2), 40, 'резка: справа дальше по линии')
  const m = mergeKeys({ keys: left, frame: DEFAULT_FRAME, len: 2 }, { keys: right, frame: DEFAULT_FRAME, len: 6 })
  assert.deepEqual(m.x.map((q) => [q.t, q.v]), base.map((q) => [q.t, q.v]), 'разрезал и склеил — ключи как были')
  assert.deepEqual(m.y, [], 'без ключей остаётся без ключей')
  // свойство с ключами у одной половины: у другой запекается
  const onlyLeft = noKeys()
  onlyLeft.x = [{ t: 0, v: 0, ease: false }, { t: 2, v: 5, ease: false }]
  const fr5 = { ...DEFAULT_FRAME, x: 5 }
  assert.equal(keysJoinGap({ keys: onlyLeft, frame: DEFAULT_FRAME, len: 2 }, { keys: noKeys(), frame: fr5, len: 3 }), null, 'значения на стыке совпали')
  assert.equal(keysJoinGap({ keys: onlyLeft, frame: DEFAULT_FRAME, len: 2 }, { keys: noKeys(), frame: DEFAULT_FRAME, len: 3 }), 'x', 'не совпали — нельзя')
  const bm = mergeKeys({ keys: onlyLeft, frame: DEFAULT_FRAME, len: 2 }, { keys: noKeys(), frame: fr5, len: 3 })
  near(evalKeys(bm.x, 0, 4), 5, 'запечённая правая половина держит значение')
}

// --- резка/склейка эффектов-анимаций
{
  const e = [fx('fadeIn', { dur: 1 }), fx('fadeOut', { dur: 1 }), fx('zoom', { dir: 0, dur: 1, amount: 20 }), fx('zoom', { dir: 1, dur: 1, amount: 20 }), fx('blur')]
  // у zoom два раза один тип — берём по отдельности
  const one = [fx('fadeIn', { dur: 1 }), fx('fadeOut', { dur: 1 }), fx('zoom', { dir: 0, dur: 1, amount: 20 }), fx('blur')]
  const l = sliceEffects(one, 10, 0, 4)
  const r = sliceEffects(one, 10, 4, 10)
  assert.deepEqual(l.map((x) => x.type), ['fadeIn', 'zoom', 'blur'], 'слева: конец уже не нужен')
  assert.deepEqual(r.map((x) => x.type), ['fadeOut', 'zoom', 'blur'], 'справа: начало закончилось, но зум держится')
  assert.equal(r.find((x) => x.type === 'zoom').skip, 4)
  assert.equal(sliceEffects([fx('zoom', { dir: 1, dur: 1 })], 10, 4, 10).length, 0, 'отдаление закончилось — не нужно')
  const mid = sliceEffects([fx('fadeIn', { dur: 2 })], 10, 1, 10)
  assert.equal(mid[0].skip, 1, 'резка внутри появления: правая половина продолжает его')
  const slice2 = sliceEffects(sliceEffects([fx('fadeOut', { dur: 5 })], 10, 0, 8), 8, 0, 6)
  assert.equal(slice2[0].skipEnd, 4, 'вторая резка копит остаток')
  // склейка
  const j = joinEffects(l, 4, r, 6)
  assert.ok(j && j.map((x) => x.type).sort().join() === 'blur,fadeIn,fadeOut,zoom', 'половины одного куска склеиваются')
  assert.equal(j.find((x) => x.type === 'fadeIn').skip, undefined)
  assert.equal(j.find((x) => x.type === 'zoom').skip, undefined)
  assert.equal(joinEffects([], 4, [fx('fadeIn')], 6), null, 'своё появление на правой половине — не склеить')
  assert.equal(joinEffects([fx('fadeIn')], 4, [], 6) !== null, true, 'появление левой уже закончилось к стыку')
  assert.equal(joinEffects([fx('fadeIn', { dur: 9 })], 4, [], 6), null, 'но не закончилось — нельзя')
  assert.equal(joinEffects([fx('blur')], 4, [], 6), null, 'разные фильтры')
  assert.equal(e.length, 5)
  assert.deepEqual(cleanEffects([{ type: 'fadeIn', values: { dur: 99 }, skip: 2.5, skipEnd: -1 }, { type: 'blur', skip: 3 }])[0].skip, 2.5)
  assert.equal(cleanEffects([{ type: 'fadeIn', values: { dur: 99 } }])[0].values.dur, 10, 'длительность зажата')
  assert.equal(cleanEffects([{ type: 'blur', skip: 3 }])[0].skip, undefined, 'skip только у анимаций')
}

// --- проект: резка, подрезка, склейка, сохранение
{
  let p = newProject('A')
  p = addMedia(p, V('/a.mp4', 20)).p
  const id0 = p.media[0].id
  const ins = insertMedia(p, id0, 0)
  p = ins.p
  const id = ins.id
  p = addEffect(p, [id], 'fadeIn').p
  p = addEffect(p, [id], 'fadeOut').p
  p = addEffect(p, [id], 'blur').p
  assert.equal(p.items[0].effects.length, 3)
  // ромбик и правки
  p = enableKeys(p, id, 'scale', 4)
  assert.deepEqual(p.items[0].keys.scale.map((k) => [k.t, k.v]), [[4, 100]], 'ромбик: ключ с текущим значением')
  p = setPropAt(p, id, 'scale', 10, 150)
  assert.deepEqual(p.items[0].keys.scale.map((k) => [k.t, k.v]), [[4, 100], [10, 150]], 'правка при ключах ставит ключ')
  near(frameValueAt(p.items[0], 'scale', 7), 125, 'поле показывает значение линии')
  p = setPropAt(p, id, 'x', 7, 20)
  assert.equal(p.items[0].frame.x, 20, 'без ромбика правка меняет «Кадр»')
  assert.equal(p.items[0].keys.x.length, 0)
  p = addKeyAt(p, id, 'opacity', 5)
  p = patchFrame(p, id, { opacity: 80 })
  assert.equal(p.items[0].frame.opacity, 80)
  // подрезка слева сдвигает ключи
  const before = frameValueAt(p.items[0], 'scale', 8)
  const t1 = trimItem(p, id, 'start', 2)
  assert.equal(t1.items[0].start, 2)
  near(frameValueAt(t1.items[0], 'scale', 8), before, 'после подрезки слева линия на том же месте таймлайна')
  // резка: ключ на разрезе у обеих половин, анимации по краям
  const sp = splitItem(p, id, 6)
  const l = sp.p.items.find((i) => i.id === id)
  const r = sp.p.items.find((i) => i.id === sp.id)
  near(l.keys.scale.at(-1).t, 6, 'слева ключ на разрезе')
  near(r.keys.scale[0].t, 0, 'справа ключ на начале')
  near(l.keys.scale.at(-1).v, r.keys.scale[0].v, 'значения на стыке одинаковы')
  assert.deepEqual(l.effects.map((e) => e.type), ['fadeIn', 'blur'])
  assert.deepEqual(r.effects.map((e) => e.type), ['fadeOut', 'blur'])
  assert.equal(canJoin(sp.p, id, 'right'), true, 'разрезал и склеил — можно')
  const jn = joinItems(sp.p, id, sp.id)
  assert.ok(!jn.error, jn.error)
  const back = jn.p.items.find((i) => i.id === id)
  assert.deepEqual(back.keys.scale.map((k) => [k.t, k.v]), p.items[0].keys.scale.map((k) => [k.t, k.v]), 'ключи после склейки как до резки')
  assert.deepEqual(back.effects.map((e) => e.type).sort(), ['blur', 'fadeIn', 'fadeOut'])
  // разные ключи — не склеить
  const bad = setPropAt(sp.p, sp.id, 'scale', 6, 300)
  assert.equal(canJoin(bad, id, 'right'), false)
  assert.match(joinItems(bad, id, sp.id).error, /ключев/)
  // у правой своя анимация — не склеить
  const own = addEffect(sp.p, [sp.id], 'zoom').p
  assert.equal(canJoin(own, id, 'right'), false)
  // выключить ромбик: значение остаётся
  const off = disableKeys(p, id, 'scale', 10)
  assert.equal(off.items[0].keys.scale.length, 0)
  assert.equal(off.items[0].frame.scale, 150)
  // удаление ключей, плавность, перенос
  let d = deleteKeyAt(p, id, 'scale', 0)
  assert.equal(d.items[0].keys.scale.length, 1)
  d = deleteKeyAt(d, id, 'scale', 0)
  assert.equal(d.items[0].keys.scale.length, 0)
  assert.equal(d.items[0].frame.scale, 150, 'последний ключ удалён — свойство держит его значение')
  const ea = setKeyEase(p, id, 'scale', 0, true)
  assert.equal(ea.items[0].keys.scale[0].ease, true)
  const mk = moveKeyTo(p, id, 'scale', 1, 12)
  assert.equal(mk.items[0].keys.scale[1].t, 12)
  // сброс кадра чистит ключи
  const rs = resetFrame(p, id)
  assert.equal(hasKeys(rs.items[0].keys), false)
  // скорость: длина меняется, ключи за краем прижимаются
  const sp2 = setSpeed(p, [id], 4).p
  assert.equal(itemDur(sp2.items[0]), 5)
  assert.ok(sp2.items[0].keys.scale.every((k) => k.t <= 5 + 1e-6), 'ключи не вылезают за кусок')
  // сохранение и чтение
  const saved = JSON.parse(JSON.stringify(p))
  const rt = sanitizeProject(saved)
  assert.equal(rt.version, 12)
  assert.deepEqual(rt.items[0].keys, p.items[0].keys)
  assert.deepEqual(rt.items[0].effects.map((e) => e.type), ['fadeIn', 'fadeOut', 'blur'])
  // старый файл v10: без ключей и прозрачности
  const old = JSON.parse(JSON.stringify(p))
  old.version = 10
  delete old.items[0].keys
  delete old.items[0].frame.opacity
  const mig = sanitizeProject(old)
  assert.deepEqual(mig.items[0].keys, noKeys())
  assert.equal(mig.items[0].frame.opacity, 100)
  // рамка клипа: ключи сдвигаются, анимации «уже прошли» / «ещё не начались»
  const cp = cropProject(p, 5, 12)
  const ci = cp.items[0]
  assert.equal(ci.start, 0)
  near(frameValueAt(ci, 'scale', 5), frameValueAt(p.items[0], 'scale', 10), 'значение на той же секунде исходника после сдвига')
  assert.ok(!ci.effects.some((e) => e.type === 'fadeIn'), 'появление в начале кадра рамки уже закончилось')
  assert.ok(ci.effects.some((e) => e.type === 'blur'))
  assert.equal(ci.effects.find((e) => e.type === 'fadeOut'), undefined, 'исчезновение в конце куска не попало в рамку (она закончилась раньше)')
}

// --- надпись: анимации и «Кадр» без кропа, блюра нет
{
  let p = newProject('T')
  p = addMedia(p, V('/a.mp4', 20)).p
  p = insertMedia(p, p.media[0].id, 0).p
  const t = insertText(p, 2, 'title', 4)
  p = t.p
  assert.equal(addEffect(p, [t.id], 'blur').added, 0)
  assert.equal(addEffect(p, [t.id], 'slideIn').added, 1)
  p = addEffect(p, [t.id], 'slideIn').p
  p = patchFrame(p, t.id, { cl: 30, scale: 150 })
  const it = p.items.find((i) => i.id === t.id)
  assert.equal(it.frame.cl, 0, 'кропа у надписи нет')
  assert.equal(it.frame.scale, 150)
  p = enableKeys(p, t.id, 'y', 3)
  assert.equal(p.items.find((i) => i.id === t.id).keys.y.length, 1)
  p = patchEffect(p, t.id, it.effects[0].id, { key: 'side', value: 3 })
  assert.equal(p.items.find((i) => i.id === t.id).effects[0].values.side, 3)
  const rt = sanitizeProject(JSON.parse(JSON.stringify(p)))
  const ri = rt.items.find((i) => i.kind === 'text')
  assert.deepEqual(ri.effects.map((e) => e.type), ['slideIn'])
  assert.equal(ri.frame.scale, 150)
  assert.equal(ri.keys.y.length, 1)
  // из файла блюр на надписи выбрасывается
  const raw = JSON.parse(JSON.stringify(p))
  raw.items.find((i) => i.kind === 'text').effects.push({ id: 'z', type: 'blur', on: true, values: { strength: 50 } })
  assert.deepEqual(sanitizeProject(raw).items.find((i) => i.kind === 'text').effects.map((e) => e.type), ['slideIn'])
  const sp = splitItem(p, t.id, 4)
  const l = sp.p.items.find((i) => i.id === t.id)
  const r = sp.p.items.find((i) => i.id === sp.id)
  assert.deepEqual(l.effects.map((e) => e.type), ['slideIn'])
  assert.deepEqual(r.effects.map((e) => e.type), [], 'выезд на правой половине уже ничего не делает')
  assert.equal(r.keys.y.length >= 1, true)
}

// --- граф экспорта: статичный кусок идёт по старому пути, анимированный — выражениями и маской
{
  const { buildExport } = await import('./exportGraph.ts')
  let p = newProject('G')
  p = addMedia(p, V('/a.mp4', 10)).p
  p = { ...p, canvas: { w: 1280, h: 720 } }
  const ins = insertMedia(p, p.media[0].id, 0)
  p = ins.p
  const graph = (pr, textLayers = []) => {
    const a = buildExport(pr, { W: 1280, H: 720, fps: 30, format: 'h264', quality: 'small', subLayers: [], textLayers }, '/o.mp4').args
    return a[a.indexOf('-filter_complex') + 1]
  }
  const still = graph(p)
  assert.ok(!/eval=frame|alphamerge|geq/.test(still), 'без анимации старый граф')
  // только прозрачность 50%: маска без движения
  const half = graph(patchFrame(p, ins.id, { opacity: 50 }))
  assert.match(half, /alphamerge/)
  assert.match(half, /geq=lum='255\*\(0\.5\)'/)
  assert.ok(!/eval=frame/.test(half), 'масштаб не меняется — scale по кадрам не нужен')
  // появление: прозрачность по T, масштаб статичный
  const fade = graph(addEffect(p, [ins.id], 'fadeIn').p)
  assert.match(fade, /geq=lum='255\*\(clip\(/)
  assert.ok(!/eval=frame/.test(fade))
  // зум и ключи положения: scale eval=frame и overlay по выражению от t
  let z = addEffect(p, [ins.id], 'zoom').p
  z = enableKeys(z, ins.id, 'x', 1)
  z = setPropAt(z, ins.id, 'x', 3, 30)
  const zg = graph(z)
  assert.match(zg, /scale=w='max\(2,2\*trunc\(iw\*\(clip\(/)
  assert.match(zg, /:eval=frame\[v0\]/)
  assert.match(zg, /overlay=x='W\/2\+W\*\(\(if\(lt\(\(t-0\)/)
  assert.ok(!/alphamerge/.test(zg), 'прозрачность 100% и без fade — маска не нужна')
  // надпись: масштаб вокруг центра блока
  let q = p
  const tx = insertText(q, 1, 'title', 3)
  q = addEffect(tx.p, [tx.id], 'pop').p
  const ti = q.items.find((i) => i.id === tx.id)
  const tg = graph(q, [{ itemId: tx.id, trackId: ti.trackId, path: '/p.png', start: ti.start, end: ti.start + itemDur(ti) }])
  assert.match(tg, /\[1:v\]format=rgba/)
  assert.match(tg, /overlay=x='W\*0\.5000\*\(1-/)
  // надпись без анимации и без «Кадра» — как раньше, на весь кадр
  const plain = graph(tx.p, [{ itemId: tx.id, trackId: ti.trackId, path: '/p.png', start: ti.start, end: ti.start + itemDur(ti) }])
  assert.match(plain, /overlay=x=0:y=0:format=auto/)
}

// --- фигуры и зеркало (v12)
{
  const { buildExport } = await import('./exportGraph.ts')
  let p = newProject('S')
  p = addMedia(p, V('/a.mp4', 10)).p
  p = { ...p, canvas: { w: 1280, h: 720 } }
  const vid = insertMedia(p, p.media[0].id, 0)
  p = vid.p
  // вставка: на верхнюю свободную дорожку, 3 с, круг круглый
  const s1 = insertShape(p, 2, 'circle', 3, 1280 / 720)
  p = s1.p
  const it = p.items.find((i) => i.id === s1.id)
  assert.equal(it.kind, 'shape')
  assert.equal(it.mediaId, '')
  assert.equal(itemDur(it), 3)
  assert.equal(it.shape.kind, 'circle')
  assert.ok(Math.abs((it.shape.h / 100) * 720 - (it.shape.w / 100) * 1280) < 8, 'круг: ширина и высота в пикселях близки')
  assert.equal(newShape('frame').strokeOn, true)
  assert.deepEqual(SHAPE_KINDS.map((k) => k.id), ['rect', 'round', 'circle', 'line', 'arrow', 'frame'])
  assert.equal(shapeLabel(newShape('arrow')), 'Стрелка')
  // правка: пределы, вид не меняется
  p = patchShape(p, s1.id, { w: 999, rot: 400, h: -5, kind: 'rect' })
  const sh = p.items.find((i) => i.id === s1.id).shape
  assert.equal(sh.kind, 'circle')
  assert.ok(sh.w <= 200 && sh.rot === 180 && sh.h >= 0.5)
  // кусок-слой: эффекты только анимации, кадр без кропа, кропа нет в диалоге
  assert.equal(canHaveEffects(p, p.items.find((i) => i.id === s1.id), 'blur'), false)
  assert.equal(canHaveEffects(p, p.items.find((i) => i.id === s1.id), 'fadeIn'), true)
  assert.equal(hasFrameCrop(p, p.items.find((i) => i.id === s1.id)), false)
  // резка и файл
  const sp = splitItem(p, s1.id, 3.5)
  assert.equal(sp.p.items.filter((i) => i.kind === 'shape').length, 2)
  const saved = JSON.parse(JSON.stringify(p))
  const rt = sanitizeProject(saved)
  assert.equal(rt.version, 12)
  assert.equal(rt.items.find((i) => i.kind === 'shape').shape.kind, 'circle')
  const bad = JSON.parse(JSON.stringify(p))
  bad.items.find((i) => i.kind === 'shape').shape = { kind: 'zzz', w: 'x', fill: 'red' }
  const fixed = sanitizeProject(bad).items.find((i) => i.kind === 'shape').shape
  assert.equal(fixed.kind, 'rect')
  assert.match(fixed.fill, /^#[0-9a-f]{6}$/)
  assert.equal(cleanShape(null).kind, 'rect')
  // зеркало: переключатель, у всех выбранных сразу; звук и субтитры не затрагиваются
  const f1 = toggleFlip(p, [vid.id, s1.id], 'h')
  assert.equal(f1.changed, 2)
  assert.equal(f1.p.items.find((i) => i.id === vid.id).frame.flipH, 1)
  assert.equal(f1.p.items.find((i) => i.id === s1.id).frame.flipH, 1)
  const f2 = toggleFlip(f1.p, [vid.id, s1.id], 'h')
  assert.equal(f2.p.items.find((i) => i.id === vid.id).frame.flipH, 0, 'у всех включено — выключает')
  const mixed = toggleFlip(toggleFlip(p, [vid.id], 'v').p, [vid.id, s1.id], 'v')
  assert.equal(mixed.p.items.find((i) => i.id === s1.id).frame.flipV, 1, 'у части включено — включает у всех')
  assert.equal(toggleFlip(p, ['nope'], 'h').changed, 0)
  // v11 без зеркала и фигур читается
  const old = JSON.parse(JSON.stringify(p))
  old.version = 11
  for (const i of old.items) {
    delete i.frame.flipH
    delete i.frame.flipV
    delete i.shape
  }
  old.items = old.items.filter((i) => i.kind !== 'shape')
  const mig = sanitizeProject(old)
  assert.equal(mig.items[0].frame.flipH, 0)
  assert.equal(mig.items[0].shape, null)
  assert.deepEqual(flipFilters({ ...mig.items[0].frame, flipH: 1, flipV: 1 }), ['hflip', 'vflip'])
  assert.equal(isStillFrame({ ...mig.items[0].frame, flipH: 1 }), true, 'зеркало — не движение')
  // экспорт: зеркало видео — сразу после эффектов, до кропа; без зеркала граф прежний
  const graph = (pr, layers = []) => {
    const a = buildExport(pr, { W: 1280, H: 720, fps: 30, format: 'h264', quality: 'small', subLayers: [], textLayers: layers }, '/o.mp4').args
    return a[a.indexOf('-filter_complex') + 1]
  }
  assert.ok(!/hflip|vflip/.test(graph(mig)))
  let m = patchFrame(mig, vid.id, { cl: 20 })
  m = toggleFlip(m, [vid.id], 'h').p
  assert.match(graph(m), /hflip,crop=iw\*0\.8/)
  m = toggleFlip(m, [vid.id], 'v').p
  assert.match(graph(m), /hflip,vflip,crop/)
  // слой-фигура: зеркало нарисовано в PNG, в графе нет hflip и нет лишнего scale/overlay-выражений
  const lay = p.items.find((i) => i.id === s1.id)
  const fl = toggleFlip(p, [s1.id], 'h').p
  const flGraph = graph(fl, [{ itemId: s1.id, trackId: lay.trackId, path: '/s.png', start: lay.start, end: lay.start + itemDur(lay) }])
  assert.ok(!/hflip/.test(flGraph))
  assert.match(flGraph, /overlay=x=0:y=0:format=auto/)
  // кроп клипа сохраняет зеркало и фигуру
  const cp = cropProject(fl, 1, 6)
  assert.equal(cp.items.find((i) => i.kind === 'shape').frame.flipH, 1)
}

console.log('anim.ts: все проверки прошли')
