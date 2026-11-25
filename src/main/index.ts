import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } from 'electron'
import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { CUSTOM_EXT } from '../shared/fonts'
import { analyzeClips, windowCharsForTpm } from '../shared/clipsAnalyze'
import { slug } from '../shared/cut'
import type { AiSettingsPatch, AnalyzeRequest, ClipsExportRequest, ExportRequest, MediaInfo, ModelId, ProgressEvent, RenderRequest } from '../shared/types'
import { getAiSettings, resolveAi, setAiSettings } from './aiConfig'
import { chat } from './llm'
import { getPeaks } from './peaks'
import { deleteProject, duplicateProject, exportProjectFile, importProjectFile, listProjects, readProject, writeProject } from './projectStore'
import { exportClips, exportTimeline } from './exportTimeline'
import { thumbnail } from './thumbs'
import { newProject, sanitizeProject, type Project } from '../shared/project'
import { readFile as readFileAsync } from 'node:fs/promises'
import { transcribe, transcribeRange } from './asr'
import { allowedFonts, allowFontFile } from './fontFiles'
import { probeMedia } from './media'
import { buildPreview } from './preview'
import { downloadModel, listModels } from './models'
import { checkNow, installUpdate, setupUpdater } from './updater'
import { cacheInfo, clearCache, getAppSettings, setAppSettings } from './appSettings'
import { disposeRenderWindow, renderOverlay, type CancelToken } from './render'

// Схема media:// отдаёт в <video> только те файлы, которые пользователь сам выбрал.
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: 'font', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

/** Отдаёт файл с поддержкой Range: без неё <video> не умеет перематывать. */
async function serveFile(file: string, range: string | null, extra: Record<string, string> = {}): Promise<Response> {
  const { size } = await stat(file)
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
  let start = 0
  let end = size - 1
  let status = 200

  const m = /^bytes=(\d*)-(\d*)$/.exec(range ?? '')
  if (m && (m[1] || m[2])) {
    if (m[1] === '') start = Math.max(0, size - Number(m[2]))
    else {
      start = Number(m[1])
      if (m[2]) end = Math.min(end, Number(m[2]))
    }
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    }
    status = 206
  }

  const body = Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1),
    ...extra
  }
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  return new Response(body, { status, headers })
}

const allowedMedia = new Set<string>()

let win: BrowserWindow | null = null
let renderCancel: CancelToken | null = null

const send = (e: ProgressEvent): void => {
  win?.webContents.send('progress', e)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 840,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0d0d0f',
    // своя верхняя строка с кнопками окна (как в CapCut): системную рамку убираем
    frame: false,
    // показываем после первой отрисовки: сразу с заставкой, без пустого окна
    show: false,
    title: 'Trans Subtitles',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => {
    win?.maximize()
    win?.show()
  })
  const sendState = (): void => win?.webContents.send('win-state', { maximized: !!win?.isMaximized() })
  win.on('maximize', sendState)
  win.on('unmaximize', sendState)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Окно никуда не уходит со своей страницы: иначе перетащенный в окно файл откроется вместо
  // приложения и получит доступ к window.api (preload подключается к любой странице окна).
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault()
  })
  if (process.env['ELECTRON_RENDERER_URL']) void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

/** Открыть файл: прочитать свойства и разрешить отдавать его окну через media://. */
async function openMedia(path: string): Promise<MediaInfo> {
  const info = await probeMedia(path)
  allowedMedia.add(info.path)
  return info
}

function registerIpc(): void {
  ipcMain.handle('media:pick', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      title: 'Выбери видео или аудио',
      properties: ['openFile'],
      filters: [
        {
          name: 'Видео и аудио',
          extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac']
        },
        { name: 'Все файлы', extensions: ['*'] }
      ]
    })
    if (r.canceled || !r.filePaths[0]) return null
    return openMedia(r.filePaths[0])
  })

  // Вызывается только из preload по настоящему перетаскиванию (страница сама сюда не достучится).
  ipcMain.handle('media:drop', (_e, path: unknown) => {
    if (typeof path !== 'string' || !path || !existsSync(path)) throw new Error('Перетащенный файл не найден')
    return openMedia(path)
  })

  ipcMain.handle('media:preview', async (_e, mediaPath: string) => {
    if (!allowedMedia.has(mediaPath)) throw new Error('Файл не был открыт в приложении')
    const info = await probeMedia(mediaPath)
    const out = await buildPreview(mediaPath, info.duration, (value) => win?.webContents.send('preview-progress', { mediaPath, value }), !!info.hasAlpha)
    allowedMedia.add(out)
    return out
  })

  ipcMain.handle('media:dev-initial', async () => {
    const file = process.env['TS_OPEN']
    if (!file) return null
    return openMedia(file)
  })

  ipcMain.handle('render:start', async (_e, req: RenderRequest) => {
    if (!win) return null
    if (renderCancel) throw new Error('Рендер уже идёт')
    if (req.style.font === 'custom' && req.style.customFontPath && !allowFontFile(req.style.customFontPath)) {
      throw new Error('Файл своего шрифта не найден или не поддерживается. Выбери шрифт заново на вкладке «Стиль»')
    }
    if (req.withAudio && (!req.sourcePath || !allowedMedia.has(req.sourcePath))) {
      throw new Error('Звук можно брать только из файла, выбранного через диалог')
    }
    const ext = req.format === 'h264-green' ? 'mp4' : 'mov'
    // TS_RENDER_OUT — только для автотестов окна: путь без диалога
    const forced = process.env['TS_RENDER_OUT']
    let chosen = forced ? join(forced, `${req.suggestedName}_subs.${ext}`) : undefined
    if (!chosen) {
      const r = await dialog.showSaveDialog(win, {
        title: 'Сохранить оверлей',
        defaultPath: join(req.suggestedDir ?? app.getPath('videos'), `${req.suggestedName}_subs.${ext}`),
        filters: [{ name: ext === 'mp4' ? 'MP4' : 'QuickTime MOV', extensions: [ext] }]
      })
      if (r.canceled || !r.filePath) return null
      chosen = r.filePath
    }
    const out = extname(chosen).toLowerCase() === `.${ext}` ? chosen : `${chosen}.${ext}`
    renderCancel = { cancelled: false }
    try {
      return await renderOverlay(req, out, send, renderCancel)
    } finally {
      renderCancel = null
    }
  })
  ipcMain.handle('render:cancel', () => {
    if (renderCancel) renderCancel.cancelled = true
  })
  ipcMain.handle('update:install', () => installUpdate())
  ipcMain.handle('app:reveal', (_e, path: string) => shell.showItemInFolder(path))

  // --- проекты монтажки ---
  /** Файлы проекта разрешаем отдавать окну только после проверки ffprobe: это настоящие медиафайлы. */
  const allowProjectMedia = async (p: Project): Promise<string[]> => {
    const missing: string[] = []
    for (const m of p.media) {
      if (allowedMedia.has(m.path)) continue
      try {
        if (!existsSync(m.path)) throw new Error('нет файла')
        const info = await probeMedia(m.path)
        if (!info.hasVideo && !info.hasAudio) throw new Error('не медиа')
        allowedMedia.add(m.path)
      } catch {
        missing.push(m.path)
      }
    }
    return missing
  }

  ipcMain.handle('projects:list', () => listProjects())
  ipcMain.handle('projects:create', async (_e, name: unknown) => {
    const st = await getAppSettings()
    const p = newProject(typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : 'Без названия')
    const [w, h] = st.newCanvas === 'first' ? [0, 0] : st.newCanvas.split('x').map(Number)
    return writeProject({ ...p, canvas: w && h ? { w, h } : null, fps: st.newFps || p.fps })
  })

  // --- настройки приложения, кэш, справка ---
  ipcMain.handle('app:get-settings', () => getAppSettings())
  ipcMain.handle('app:set-settings', (_e, patch: unknown) => setAppSettings(patch && typeof patch === 'object' ? (patch as object) : {}))
  ipcMain.handle('app:pick-folder', async (_e, title: unknown) => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { title: typeof title === 'string' ? title : 'Выбери папку', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  ipcMain.handle('cache:info', () => cacheInfo())
  ipcMain.handle('cache:clear', () => clearCache())
  ipcMain.handle('app:open-data', () => shell.openPath(app.getPath('userData')).then(() => undefined))
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, repo: 'https://github.com/Kkaprizzz/trans-subtitles' }))
  ipcMain.handle('update:check', () => checkNow((e) => win?.webContents.send('update', e)))
  ipcMain.handle('app:external', (_e, url: unknown) => {
    // наружу — только наш репозиторий
    if (typeof url === 'string' && url.startsWith('https://github.com/Kkaprizzz/trans-subtitles')) return shell.openExternal(url)
  })
  ipcMain.handle('app:quit', () => app.quit())
  ipcMain.handle('win:minimize', () => win?.minimize())
  ipcMain.handle('win:toggle-max', () => {
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('win:close', () => win?.close())
  ipcMain.handle('win:is-max', () => !!win?.isMaximized())
  ipcMain.handle('projects:open', async (_e, id: string) => {
    const project = await readProject(id)
    return { project, missing: await allowProjectMedia(project) }
  })
  ipcMain.handle('projects:write', async (_e, p: Project) => {
    // писать можно только проект, файлы которого уже разрешены (открыты через диалог или проверены)
    const clean = sanitizeProject(p)
    if (!clean) throw new Error('Некорректный проект')
    for (const m of clean.media) if (!allowedMedia.has(m.path)) throw new Error(`Файл не был добавлен через приложение: ${m.name}`)
    return writeProject(clean)
  })
  ipcMain.handle('projects:delete', (_e, id: string) => deleteProject(id))
  ipcMain.handle('projects:duplicate', (_e, id: string) => duplicateProject(id))
  ipcMain.handle('projects:export-file', async (_e, id: string) => {
    if (!win) return null
    const p = await readProject(id)
    const r = await dialog.showSaveDialog(win, {
      title: 'Экспорт проекта',
      defaultPath: join(app.getPath('documents'), `${slug(p.name) || 'Проект'}.tsproj`),
      filters: [{ name: 'Проект Trans Subtitles', extensions: ['tsproj'] }]
    })
    if (r.canceled || !r.filePath) return null
    const out = r.filePath.endsWith('.tsproj') ? r.filePath : `${r.filePath}.tsproj`
    await exportProjectFile(id, out)
    return out
  })
  ipcMain.handle('projects:import-file', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      title: 'Импорт проекта',
      properties: ['openFile'],
      filters: [{ name: 'Проект Trans Subtitles', extensions: ['tsproj', 'json'] }]
    })
    if (r.canceled || !r.filePaths[0]) return null
    const raw = JSON.parse(await readFileAsync(r.filePaths[0], 'utf8')) as unknown
    if (!sanitizeProject(raw)) throw new Error('Это не файл проекта Trans Subtitles или он повреждён')
    return importProjectFile(r.filePaths[0])
  })
  ipcMain.handle('media:import', async () => {
    if (!win) return []
    const r = await dialog.showOpenDialog(win, {
      title: 'Добавить видео и звук',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Видео и аудио', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac'] },
        { name: 'Все файлы', extensions: ['*'] }
      ]
    })
    if (r.canceled) return []
    const out: MediaInfo[] = []
    for (const f of r.filePaths) {
      try {
        out.push(await openMedia(f))
      } catch {
        /* нечитаемый файл пропускаем */
      }
    }
    return out
  })
  ipcMain.handle('media:thumb', async (_e, mediaPath: string, duration: number) => {
    if (!allowedMedia.has(mediaPath)) throw new Error('Файл не был выбран через диалог')
    const t = await thumbnail(mediaPath, Number(duration) || 0)
    allowedMedia.add(t)
    return t
  })
  ipcMain.handle('export:timeline', async (_e, p: Project, req: ExportRequest) => {
    if (!win) return null
    if (renderCancel) throw new Error('Экспорт уже идёт')
    const clean = sanitizeProject(p)
    if (!clean) throw new Error('Некорректный проект')
    for (const m of clean.media) if (!allowedMedia.has(m.path)) throw new Error(`Файл не был добавлен через приложение: ${m.name}`)
    const ext =
      req.format === 'prores422' ? 'mov' : req.format === 'overlay' ? (req.overlayFormat === 'h264-green' ? 'mp4' : 'mov') : 'mp4'
    const suffix = req.format === 'overlay' ? '_subs' : ''
    const forced = process.env['TS_RENDER_OUT']
    let out = forced ? join(forced, `${slug(clean.name) || 'Проект'}${suffix}.${ext}`) : ''
    if (!out) {
      const r = await dialog.showSaveDialog(win, {
        title: 'Экспорт видео',
        defaultPath: join((await getAppSettings()).exportDir ?? app.getPath('videos'), `${slug(clean.name) || 'Проект'}${suffix}.${ext}`),
        filters: [{ name: ext === 'mov' ? 'QuickTime MOV' : 'MP4', extensions: [ext] }]
      })
      if (r.canceled || !r.filePath) return null
      out = extname(r.filePath).toLowerCase() === `.${ext}` ? r.filePath : `${r.filePath}.${ext}`
    }
    renderCancel = { cancelled: false }
    try {
      return await exportTimeline(clean, req, out, send, renderCancel)
    } finally {
      renderCancel = null
    }
  })

  // --- «Нарезка» ---
  ipcMain.handle('cut:peaks', (_e, mediaPath: string) => {
    if (!allowedMedia.has(mediaPath)) throw new Error('Файл не был выбран через диалог')
    return getPeaks(mediaPath)
  })
  ipcMain.handle('ai:get', () => getAiSettings())
  ipcMain.handle('ai:set', (_e, patch: AiSettingsPatch) => setAiSettings(patch && typeof patch === 'object' ? patch : {}))
  ipcMain.handle('ai:test', async () => {
    const ai = await resolveAi()
    const started = Date.now()
    const r = await chat(ai.cfg, [{ role: 'user', content: 'Ответь ровно этим JSON: {"ok":true}' }], {
      extra: ai.extra,
      retries: 0,
      timeoutMs: 60_000,
      maxTokens: 2000
    })
    let ok = false
    try {
      ok = (JSON.parse(r.text) as { ok?: unknown }).ok === true
    } catch {
      ok = false
    }
    const sec = ((Date.now() - started) / 1000).toFixed(1)
    if (!ok) throw new Error(`Модель ответила, но не тем, что просили (${sec} с): ${r.text.slice(0, 80)}`)
    return `Работает: ${ai.cfg.model}, ответ за ${sec} с`
  })
  ipcMain.handle('clips:analyze', async (_e, req: AnalyzeRequest) => {
    if (analyzeAbort) throw new Error('Поиск моментов уже идёт')
    if (!Array.isArray(req?.words) || req.words.length === 0) throw new Error('Нет слов: сначала распознай речь')
    const num = (v: unknown, lo: number, hi: number, name: string): number => {
      const n = Number(v)
      if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name}: от ${lo} до ${hi}`)
      return n
    }
    const minDur = num(req.minDur, 5, 600, 'Минимальная длина клипа')
    const maxDur = num(req.maxDur, minDur + 1, 900, 'Максимальная длина клипа')
    const count = Math.round(num(req.count, 1, 50, 'Число клипов'))
    const ai = await resolveAi()
    analyzeAbort = new AbortController()
    const signal = analyzeAbort.signal
    // с лимитом токенов в минуту — окна поменьше; без лимита весь подкаст идёт одним запросом
    const maxTokens = ai.tpm ? 2500 : 32_000
    const windows = ai.tpm
      ? { maxChars: windowCharsForTpm(ai.tpm, maxTokens), overlapChars: 1500 }
      : { maxChars: 400_000, overlapChars: 4000 }
    const started = Date.now()
    send({ stage: 'ai', value: 0.02, label: 'ИИ читает расшифровку…' })
    try {
      const res = await analyzeClips(
        req.words,
        (m) => chat(ai.cfg, m, { signal, maxTokens, extra: ai.extra, retries: 6 }),
        { windows, minDur, maxDur, maxClips: count, mediaDuration: Number(req.mediaDuration) || undefined, coldViewer: true },
        (p) =>
          send({
            stage: 'ai',
            value: p.stage === 'check' ? 1 : p.done / p.total,
            label: p.stage === 'check' ? 'ИИ проверяет, понятны ли клипы без контекста' : `ИИ ищет моменты: часть ${p.done} из ${p.total}`
          }),
        () => signal.aborted
      )
      return { clips: res.clips, warnings: res.warnings, proposed: res.proposed, notes: res.notes, usage: res.usage, seconds: (Date.now() - started) / 1000 }
    } finally {
      analyzeAbort = null
    }
  })
  ipcMain.handle('clips:cancel', () => analyzeAbort?.abort())
  ipcMain.handle('export:clips', async (_e, p: Project, req: ClipsExportRequest) => {
    if (!win) return null
    if (renderCancel) throw new Error('Экспорт уже идёт')
    const clean = sanitizeProject(p)
    if (!clean) throw new Error('Некорректный проект')
    for (const m of clean.media) if (!allowedMedia.has(m.path)) throw new Error(`Файл не был добавлен через приложение: ${m.name}`)
    const ids = Array.isArray(req?.clipIds) ? req.clipIds.filter((x): x is string => typeof x === 'string') : []
    // TS_RENDER_OUT — только для автотестов окна: папка без диалога
    let parent = process.env['TS_RENDER_OUT']
    if (!parent) {
      const r = await dialog.showOpenDialog(win, {
        title: 'Куда положить клипы',
        defaultPath: (await getAppSettings()).exportDir ?? app.getPath('videos'),
        properties: ['openDirectory', 'createDirectory']
      })
      if (r.canceled || !r.filePaths[0]) return null
      parent = r.filePaths[0]
    }
    const dir = freeDir(join(parent, `${slug(clean.name) || 'Проект'} — клипы`))
    renderCancel = { cancelled: false }
    try {
      return await exportClips(clean, { clipIds: ids, quality: req.quality, burnSubtitles: req.burnSubtitles !== false, writeText: req.writeText !== false }, dir, send, renderCancel)
    } finally {
      renderCancel = null
    }
  })
  ipcMain.handle('font:pick', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      title: 'Выбери файл шрифта',
      properties: ['openFile'],
      filters: [{ name: 'Шрифты', extensions: CUSTOM_EXT.map((e) => e.slice(1)) }]
    })
    if (r.canceled || !r.filePaths[0] || !allowFontFile(r.filePaths[0])) return null
    return { path: r.filePaths[0], name: basename(r.filePaths[0]).replace(/\.[^.]+$/, '') }
  })
  ipcMain.handle('font:allow', (_e, path: string) => allowFontFile(path))

  ipcMain.handle('models:list', () => listModels())
  ipcMain.handle('models:download', (_e, id: unknown) => {
    assertModelId(id)
    return downloadModel(id, (value) => send({ stage: 'download', value, label: 'Скачиваю модель' }))
  })
  ipcMain.handle('asr:transcribe-range', async (_e, mediaPath: string, id: unknown, start: unknown, end: unknown, label: unknown) => {
    assertModelId(id)
    if (!allowedMedia.has(mediaPath)) throw new Error('Файл не был выбран через диалог')
    const a = Number(start)
    const b = Number(end)
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b <= a) throw new Error('Неверный отрезок для распознавания')
    return transcribeRange(mediaPath, id, send, { start: a, end: b }, typeof label === 'string' ? label.slice(0, 80) : 'Распознаю речь')
  })
  ipcMain.handle('asr:transcribe', (_e, mediaPath: string, id: unknown) => {
    assertModelId(id)
    if (!allowedMedia.has(mediaPath)) throw new Error('Файл не был выбран через диалог')
    return transcribe(mediaPath, id, send)
  })
}

let analyzeAbort: AbortController | null = null

/** Папка, которой ещё нет: «Имя», «Имя (2)», «Имя (3)»… — чтобы не перезаписать прошлый рендер. */
function freeDir(base: string): string {
  if (!existsSync(base)) return base
  for (let i = 2; ; i++) if (!existsSync(`${base} (${i})`)) return `${base} (${i})`
}

const MODEL_IDS: ModelId[] = ['gigaam-v3', 'whisper-small', 'whisper-turbo']
function assertModelId(id: unknown): asserts id is ModelId {
  if (!MODEL_IDS.includes(id as ModelId)) throw new Error(`Неизвестная модель: ${String(id)}`)
}

void app.whenReady().then(() => {
  // Приложению не нужны камера, микрофон, геопозиция и т.п. — отказываем во всём.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  protocol.handle('media', (req) => {
    const file = decodeURIComponent(new URL(req.url).pathname.slice(1))
    if (!allowedMedia.has(file)) return new Response('forbidden', { status: 403 })
    return serveFile(file, req.headers.get('range'))
  })
  protocol.handle('font', (req) => {
    const file = decodeURIComponent(new URL(req.url).pathname.slice(1))
    if (!allowedFonts.has(file)) return new Response('forbidden', { status: 403 })
    return serveFile(file, null, { 'Access-Control-Allow-Origin': '*' })
  })
  registerIpc()
  if (process.env['TS_SELFTEST']) {
    void import('./selftest').then((m) => m.runSelfTest(process.env['TS_SELFTEST']!))
    return
  }
  createWindow()
  win?.webContents.once('did-finish-load', () => {
    void getAppSettings().then((st) => setupUpdater((e) => win?.webContents.send('update', e), st.autoUpdate))
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', disposeRenderWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
