// перетаскивание строки «Медиа» на таймлайн: node dnd.mjs <индекс строки> <x> <y>
const [idx, x, y] = process.argv.slice(2).map(Number)
const list = await (await fetch('http://127.0.0.1:9333/json')).json()
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pend = new Map()
ws.addEventListener('message', (m) => { const j = JSON.parse(m.data); if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id) } })
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const ev = (await send('Runtime.evaluate', { expression: `(()=>{const r=document.querySelectorAll('.media-row')[${idx}].getBoundingClientRect();return [r.left+40,r.top+20]})()`, returnByValue: true })).result.result.value
await send('Input.setInterceptDrags', { enabled: true })
const intercepted = new Promise((res) => ws.addEventListener('message', (m) => { const j = JSON.parse(m.data); if (j.method === 'Input.dragIntercepted') res(j.params.data) }))
const mouse = (type, mx, my) => send('Input.dispatchMouseEvent', { type, x: mx, y: my, button: 'left', buttons: 1, clickCount: 1 })
await mouse('mousePressed', ev[0], ev[1])
for (let i = 1; i <= 8; i++) await mouse('mouseMoved', ev[0] + i * 6, ev[1] + i * 4)
const data = await Promise.race([intercepted, new Promise((r) => setTimeout(() => r(null), 2000))])
if (!data) { console.log('перетаскивание не началось'); process.exit(1) }
for (const type of ['dragEnter', 'dragOver', 'drop']) await send('Input.dispatchDragEvent', { type, x, y, data })
await mouse('mouseReleased', x, y)
await send('Input.setInterceptDrags', { enabled: false })
console.log('ok')
ws.close()
