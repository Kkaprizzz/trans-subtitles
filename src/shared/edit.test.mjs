import assert from 'node:assert/strict'
import * as E from './edit.ts'
const W = () => [
  { id: 0, text: 'кока', start: 1.0, end: 1.4 },
  { id: 1, text: 'кола', start: 1.5, end: 2.0 },
  { id: 2, text: 'вкусно', start: 2.2, end: 2.8 },
]
// текст
let r = E.setText(W(), 1, 'колу'); assert.equal(r.words[1].text, 'колу'); assert.equal(r.words[1].id, 1); assert.equal(r.focus, 1)
assert.equal(E.setText(W(), 1, ' кола '), null)
// пустой текст удаляет
r = E.setText(W(), 1, '   '); assert.equal(r.words.length, 2); assert.equal(r.focus, 1)
// разделение пропорционально буквам: 'абвгд' (5) -> 'аб' 'вгд'
let w = [{ id: 7, text: 'кокакола', start: 0, end: 0.8 }]
r = E.setText(w, 0, 'кока кола'); assert.equal(r.words.length, 2)
assert.deepEqual(r.words.map(x => x.text), ['кока', 'кола'])
assert.equal(r.words[0].start, 0); assert.equal(r.words[0].end, 0.4); assert.equal(r.words[1].start, 0.4); assert.equal(r.words[1].end, 0.8)
assert.equal(r.words[0].id, 7); assert.equal(r.words[1].id, 8)
// три части, уникальные id, цельный интервал без дыр
w = [{ id: 0, text: 'а', start: 0, end: 1 }, { id: 5, text: 'абвгде', start: 1, end: 4 }]
r = E.setText(w, 1, 'аб вг де'); assert.deepEqual(r.words.map(x => x.id), [0, 5, 6, 7])
assert.equal(r.words[1].start, 1); assert.equal(r.words.at(-1).end, 4)
for (let i = 1; i < r.words.length; i++) assert.equal(r.words[i].start, r.words[i - 1].end)
// слияние
r = E.mergeWithNext(W(), 0); assert.equal(r.words.length, 2); assert.equal(r.words[0].text, 'кокакола'); assert.equal(r.words[0].end, 2.0)
assert.equal(E.mergeWithNext(W(), 2), null)
// удаление
r = E.deleteWord(W(), 2); assert.equal(r.words.length, 2); assert.equal(r.focus, 1)
r = E.deleteWord([{ id: 0, text: 'a', start: 0, end: 1 }], 0); assert.equal(r.focus, -1)
// тайминги: ограничения соседями
let t = E.setTiming(W(), 1, { start: 0.2 }, 10); assert.equal(t[1].start, 1.4, 'не заходит на предыдущее')
t = E.setTiming(W(), 1, { end: 9 }, 10); assert.equal(t[1].end, 2.2, 'не заходит на следующее')
t = E.setTiming(W(), 2, { end: 99 }, 10); assert.equal(t[2].end, 10, 'последнее до длительности')
t = E.setTiming(W(), 0, { start: -5 }, 10); assert.equal(t[0].start, 0)
t = E.setTiming(W(), 1, { start: 99 }, 10); assert.equal(t[1].start, 1.96, 'начало не позже конца минус минимум')
assert.equal(E.setTiming(W(), 1, { start: 1.5 }, 10), null, 'без изменений -> null')
t = E.setTiming(W(), 1, { start: 1.52, end: 1.9 }, 10); assert.equal(t[1].start, 1.52); assert.equal(t[1].end, 1.9)
// исходный массив не мутируется
const orig = W(); E.setTiming(orig, 1, { start: 1.6 }, 10); assert.equal(orig[1].start, 1.5)
// пред-существующее перекрытие не ломает
const ov = [{ id: 0, text: 'а', start: 0, end: 1.2 }, { id: 1, text: 'б', start: 1.1, end: 2 }]
t = E.setTiming(ov, 1, { start: 0.5 }, 10); assert.equal(t, null, 'влево не двигаем, раз уже перекрыто')
console.log('edit.ts: все проверки прошли')
