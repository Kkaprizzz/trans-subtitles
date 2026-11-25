// Управление окном через CDP: rclick x y | eval '<js>' | shot <файл> | click x y [dbl] | drag x1 y1 x2 y2 | wheel x y dy [ctrl] | key <code> [ctrl|shift|ctrlshift] | dropfiles x y <путь>...
const PORT = process.env.CDP_PORT || 9333
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) || list.find((t) => t.type === 'page' && !/render/.test(t.url))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (m) => {
  const j = JSON.parse(m.data)
  if (j.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true })
  if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id) }
})
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
await send('Page.enable')
const [cmd, ...a] = process.argv.slice(2)
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
if (cmd === 'eval') {
  const r = await send('Runtime.evaluate', { expression: a[0], awaitPromise: true, returnByValue: true })
  console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? r.result, null, 1))
} else if (cmd === 'shot') {
  await send('Page.bringToFront')
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(a[0], Buffer.from(r.result.data, 'base64'))
  console.log('ok', a[0])
} else if (cmd === 'click') {
  const [x, y] = a.map(Number)
  await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y)
  if (a[2] === 'dbl') { await mouse('mousePressed', x, y, { clickCount: 2 }); await mouse('mouseReleased', x, y, { clickCount: 2 }) }
  console.log('ok')
} else if (cmd === 'rclick') {
  const [x, y] = a.map(Number)
  await mouse('mouseMoved', x, y)
  await mouse('mousePressed', x, y, { button: 'right' })
  await mouse('mouseReleased', x, y, { button: 'right' })
  console.log('ok')
} else if (cmd === 'drag') {
  const [x1, y1, x2, y2] = a.map(Number)
  await mouse('mouseMoved', x1, y1); await mouse('mousePressed', x1, y1, { buttons: 1 })
  for (let i = 1; i <= 12; i++) { await mouse('mouseMoved', x1 + ((x2 - x1) * i) / 12, y1 + ((y2 - y1) * i) / 12, { buttons: 1 }); await sleep(16) }
  await mouse('mouseReleased', x2, y2)
  console.log('ok')
} else if (cmd === 'wheel') {
  const [x, y, dy] = a.map(Number)
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, modifiers: a[3] === 'ctrl' ? 2 : 0 })
  console.log('ok')
} else if (cmd === 'key') {
  const mods = a[1] === 'ctrl' ? 2 : a[1] === 'shift' ? 8 : a[1] === 'ctrlshift' ? 10 : 0
  const named = { Space: [' ', 32], Delete: ['Delete', 46], Escape: ['Escape', 27], Enter: ['Enter', 13], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39], Home: ['Home', 36], End: ['End', 35] }
  const [key, vk] = named[a[0]] ?? [a[0].replace(/^Key/, '').toLowerCase(), a[0].replace(/^Key/, '').toUpperCase().charCodeAt(0)]
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: a[0], key, modifiers: mods, windowsVirtualKeyCode: vk })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: a[0], key, modifiers: mods, windowsVirtualKeyCode: vk })
  console.log('ok')
} else if (cmd === 'dropfiles') {
  const [x, y, ...files] = a
  const data = { items: [], files, dragOperationsMask: 1 }
  for (const type of ['dragEnter', 'dragOver', 'drop']) await send('Input.dispatchDragEvent', { type, x: Number(x), y: Number(y), data })
  console.log('ok')
}
ws.close()
