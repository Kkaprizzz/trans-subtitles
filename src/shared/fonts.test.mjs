import assert from 'node:assert/strict'
import { CUSTOM_FAMILY, FONTS, fontById, fontFamilyOf, nearestWeight } from './fonts.ts'

assert.equal(fontById('нет такого').id, FONTS[0].id, 'неизвестный id -> первый шрифт')
assert.equal(fontById('prata').label, 'Prata')
assert.equal(nearestWeight(fontById('prata'), 800), 400)
assert.equal(nearestWeight(fontById('arsenal'), 800), 700)
assert.equal(nearestWeight(fontById('montserrat'), 650), 600)
assert.ok(fontFamilyOf({ font: 'custom', customFontPath: '/x.ttf' }).startsWith(`'${CUSTOM_FAMILY}'`))
assert.ok(fontFamilyOf({ font: 'custom', customFontPath: '/x.ttf' }).includes('Montserrat'), 'есть запасной шрифт')
assert.equal(fontFamilyOf({ font: 'custom', customFontPath: '' }), FONTS[0].family, 'custom без файла -> Montserrat')
assert.equal(fontFamilyOf({ font: 'spectral', customFontPath: '/x.ttf' }), "'Spectral'")
for (const f of FONTS) assert.ok(f.weights.length > 0 && f.weights.every((w) => w % 100 === 0))
console.log('fonts.ts: все проверки прошли')
