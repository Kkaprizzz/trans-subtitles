import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chat, normalizeBaseUrl } from './llm.ts'

// --- адрес: ключ только на https (или localhost)
assert.equal(normalizeBaseUrl(' https://api.x.ai/v1/ '), 'https://api.x.ai/v1')
assert.equal(normalizeBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1')
assert.equal(normalizeBaseUrl('https://user:pass@example.com/v1'), 'https://example.com/v1', 'логин и пароль из адреса вырезаются')
assert.throws(() => normalizeBaseUrl('http://evil.example.com/v1'), /https/)
assert.throws(() => normalizeBaseUrl('api.x.ai'), /неверно/)

// --- мок-сервер
const seen = []
let mode = 'ok'
let hits = 0
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    hits++
    const parsed = body ? JSON.parse(body) : {}
    seen.push({ url: req.url, auth: req.headers.authorization, body: parsed })
    const send = (status, obj, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj))
    }
    if (mode === 'ok') return send(200, { choices: [{ message: { content: '{"clips":[]}' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } })
    if (mode === '401') return send(401, { error: 'bad key sk-SECRET' })
    if (mode === 'rate') return hits < 3 ? send(429, 'slow', { 'Retry-After': '0' }) : send(200, { choices: [{ message: { content: 'ok' } }] })
    if (mode === '500') return send(500, 'boom')
    if (mode === 'nojson') return parsed.response_format ? send(400, { error: 'response_format is not supported' }) : send(200, { choices: [{ message: { content: 'без режима json' } }] })
    if (mode === 'empty') return send(200, { choices: [] })
    if (mode === 'hang') return // не отвечаем
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/v1`
const cfg = { baseUrl: base, apiKey: 'sk-SECRET', model: 'm1' }
const msgs = [{ role: 'user', content: 'привет' }]

try {
  // успех: путь, ключ, тело, расход
  const r = await chat(cfg, msgs)
  assert.equal(r.text, '{"clips":[]}')
  assert.deepEqual(r.usage, { prompt: 12, completion: 3 })
  assert.equal(seen[0].url, '/v1/chat/completions')
  assert.equal(seen[0].auth, 'Bearer sk-SECRET')
  assert.equal(seen[0].body.model, 'm1')
  assert.deepEqual(seen[0].body.response_format, { type: 'json_object' })

  // неверный ключ: понятная ошибка, без повторов, без ключа в тексте не гарантируем — но повторов нет
  mode = '401'
  hits = 0
  await assert.rejects(chat(cfg, msgs), /401 \(ключ не принят\)/)
  assert.equal(hits, 1, '401 не повторяем')

  // лимит запросов: повторяем и выигрываем
  mode = 'rate'
  hits = 0
  assert.equal((await chat(cfg, msgs, { retries: 3 })).text, 'ok')
  assert.equal(hits, 3)

  // постоянный 500: ровно retries+1 попыток, потом ошибка
  mode = '500'
  hits = 0
  await assert.rejects(chat(cfg, msgs, { retries: 1 }), /500/)
  assert.equal(hits, 2)

  // провайдер не знает response_format — повторяем без него
  mode = 'nojson'
  hits = 0
  assert.equal((await chat(cfg, msgs)).text, 'без режима json')
  assert.equal(hits, 2)
  assert.equal(seen.at(-1).body.response_format, undefined)

  // ответ без текста — фатально, повторов нет
  mode = 'empty'
  hits = 0
  await assert.rejects(chat(cfg, msgs), /без текста/)
  assert.equal(hits, 1)

  // таймаут
  mode = 'hang'
  await assert.rejects(chat(cfg, msgs, { retries: 0, timeoutMs: 150 }), /не ответил вовремя/)

  // отмена посреди запроса
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 100)
  await assert.rejects(chat(cfg, msgs, { signal: ac.signal, retries: 0 }), /Отменено/)

  // валидация до сети
  mode = 'ok'
  assert.equal((await chat({ ...cfg, apiKey: '' }, msgs)).text, '{"clips":[]}', 'локальному серверу (Ollama) ключ не нужен')
  assert.equal(seen.at(-1).auth, undefined, 'пустой ключ не отправляется заголовком')
  await assert.rejects(chat({ baseUrl: 'https://api.x.ai/v1', apiKey: '', model: 'm' }, msgs), /ключ/)
  await assert.rejects(chat({ ...cfg, model: ' ' }, msgs), /модель/)
  await assert.rejects(chat({ ...cfg, baseUrl: 'http://example.com/v1' }, msgs), /https/)
} finally {
  server.closeAllConnections()
  server.close()
}
console.log('llm.ts: все проверки прошли')
