import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { CUSTOM_EXT } from '../shared/fonts'
import type { ModelId, ProgressEvent, RenderRequest, Word } from '../shared/types'
import { transcribe } from './asr'
import { allowedFonts, allowFontFile } from './fontFiles'
import { probeMedia } from './media'
import { downloadModel, listModels } from './models'
import { loadProject, saveProject } from './projects'
import { installUpdate, setupUpdater } from './updater'
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
    backgroundColor: '#D9D6CF',
    title: 'Trans Subtitles',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.setMenuBarVisibility(false)
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
    const info = await probeMedia(r.filePaths[0])
    allowedMedia.add(info.path)
    return info
  })

  ipcMain.handle('media:dev-initial', async () => {
    const file = process.env['TS_OPEN']
    if (!file) return null
    const info = await probeMedia(file)
    allowedMedia.add(info.path)
    return info
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

  ipcMain.handle('project:load', (_e, mediaPath: string) => {
    if (!allowedMedia.has(mediaPath)) return null
    return loadProject(mediaPath)
  })
  ipcMain.handle('project:save', (_e, mediaPath: string, words: Word[]) => {
    if (!allowedMedia.has(mediaPath)) throw new Error('Файл не был выбран через диалог')
    return saveProject(mediaPath, words)
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
  ipcMain.handle('asr:transcribe', (_e, mediaPath: string, id: unknown) => {
    assertModelId(id)
    if (!allowedMedia.has(mediaPath)) throw new Error('Файл не был выбран через диалог')
    return transcribe(mediaPath, id, send)
  })
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
  win?.webContents.once('did-finish-load', () => setupUpdater((e) => win?.webContents.send('update', e)))
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', disposeRenderWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
