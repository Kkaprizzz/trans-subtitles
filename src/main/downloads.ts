/**
 * Очередь скачивания по ссылке: до двух загрузок одновременно, автоповтор сетевых сбоев, отмена с удалением недокачанного.
 * Готовый файл открывается как обычное медиа (probe), и окно кладёт его в библиотеку проекта, из которого запустили.
 * Очередь живёт, пока работает приложение: после перезапуска не восстанавливается (недокачанное удаляется при выходе).
 */
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { applyProgress, cleanError, isPermanent, meterValue, newMeter, parseLine, uniqueName, type DlMeter, type DlRequest, type DlTask } from '../shared/download'
import type { DlDone, MediaInfo } from '../shared/types'
import { killTree, spawnDownload } from './ytdlp'

const MAX_PARALLEL = 2
const MAX_AUTO_RETRIES = 2
const RETRY_DELAY = 5000

interface Job extends DlTask {
  folder: string
  baseName: string
  formatId: string
  estimate: number | null
  meter: DlMeter
  attempts: number
  retryAt: number | null
  filePath: string | null
  /** пользователь отменил: процесс убит, задачу нужно убрать */
  cancelled: boolean
  proc?: ChildProcess
  timer?: NodeJS.Timeout
}

interface Deps {
  /** папка скачанного (создаётся при первой задаче) */
  folder(): Promise<string>
  /** открыть готовый файл как медиа (в списке разрешённых, с probe) */
  openFile(path: string): Promise<MediaInfo>
}

export class Downloads extends EventEmitter {
  private jobs: Job[] = []

  constructor(private deps: Deps) {
    super()
  }

  list(): DlTask[] {
    return this.jobs.map((j) => ({
      id: j.id,
      projectKey: j.projectKey,
      url: j.url,
      title: j.title,
      kind: j.kind,
      label: j.label,
      status: j.status,
      stage: j.meter.stage,
      value: meterValue(j.meter, j.estimate),
      speed: j.meter.speed,
      eta: j.meter.eta,
      error: j.error
    }))
  }

  private lastEmit = 0
  private changed(force = true): void {
    const now = Date.now()
    if (!force && now - this.lastEmit < 250) return
    this.lastEmit = now
    this.emit('changed', this.list())
  }

  private active(): number {
    return this.jobs.filter((j) => j.status === 'active').length
  }

  async add(req: DlRequest): Promise<string> {
    // то же самое уже качается или ждёт — вторую копию не заводим
    const dup = this.jobs.find((j) => j.url === req.url && j.label === req.label && j.kind === req.kind)
    if (dup) return dup.id
    const folder = await this.deps.folder()
    await mkdir(folder, { recursive: true })
    const ext = req.kind === 'audio' ? 'mp3' : 'mp4'
    const baseName = uniqueName(req.title, req.label, (n) => existsSync(join(folder, `${n}.${ext}`)) || this.jobs.some((j) => j.folder === folder && j.baseName === n))
    const job: Job = {
      id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      projectKey: req.projectKey,
      url: req.url,
      title: req.title,
      kind: req.kind,
      label: req.label,
      status: 'queued',
      stage: null,
      value: 0,
      speed: null,
      eta: null,
      error: null,
      folder,
      baseName,
      formatId: req.formatId,
      estimate: req.filesize,
      meter: newMeter(),
      attempts: 0,
      retryAt: null,
      filePath: null,
      cancelled: false
    }
    this.jobs.push(job)
    this.changed()
    this.schedule()
    return job.id
  }

  private schedule(): void {
    for (const job of this.jobs) {
      if (this.active() >= MAX_PARALLEL) break
      if (job.status === 'queued' && !(job.retryAt && job.retryAt > Date.now())) void this.run(job)
    }
  }

  private async run(job: Job): Promise<void> {
    job.status = 'active'
    job.error = null
    job.retryAt = null
    job.meter = newMeter()
    job.filePath = null
    this.changed()

    let proc: ChildProcess
    try {
      proc = await spawnDownload({ kind: job.kind, formatId: job.formatId, url: job.url, out: join(job.folder, `${job.baseName}.%(ext)s`) })
    } catch (e) {
      this.fail(job, e instanceof Error ? e.message : String(e))
      this.changed()
      this.schedule()
      return
    }
    job.proc = proc
    if (job.cancelled) killTree(proc)

    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    let buffer = ''
    let stderr = ''
    let spawnError = ''
    proc.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const ev = parseLine(line.trim())
        if (!ev) continue
        if (ev.type === 'file') job.filePath = ev.path
        else job.meter = applyProgress(job.meter, ev)
      }
      this.changed(false)
    })
    proc.stderr?.on('data', (chunk: string) => (stderr += chunk))
    proc.on('error', (err) => {
      spawnError = `Не удалось запустить загрузчик: ${err.message}`
    })
    proc.on('close', (code) => {
      job.proc = undefined
      void (async () => {
        if (job.cancelled) {
          this.removePartials(job)
          this.jobs = this.jobs.filter((j) => j !== job)
        } else if (code === 0 && job.filePath) {
          await this.finish(job)
        } else {
          this.fail(job, spawnError || cleanError(stderr) || `Загрузчик завершился с кодом ${code}`)
        }
        this.changed()
        this.schedule()
      })()
    })
  }

  /** Путь из --print мог прийти искажённым: тогда берём тот, под которым назвали файл мы (расширение задаёт формат). */
  private resolveFile(job: Job): string | null {
    if (job.filePath && existsSync(job.filePath)) return job.filePath
    const expected = join(job.folder, `${job.baseName}.${job.kind === 'audio' ? 'mp3' : 'mp4'}`)
    return existsSync(expected) ? expected : job.filePath
  }

  private async finish(job: Job): Promise<void> {
    const file = this.resolveFile(job)
    if (!file || !existsSync(file)) {
      this.fail(job, 'Файл не появился после скачивания', true)
      return
    }
    try {
      const info = await this.deps.openFile(file)
      this.jobs = this.jobs.filter((j) => j !== job)
      this.emit('done', { id: job.id, projectKey: job.projectKey, info } satisfies DlDone)
    } catch (e) {
      this.fail(job, `Файл скачан, но не открывается: ${e instanceof Error ? e.message : String(e)}`, true)
    }
  }

  private fail(job: Job, message: string, permanent = false): void {
    job.meter = { ...job.meter, speed: null, eta: null }
    if (!permanent && !isPermanent(message) && job.attempts < MAX_AUTO_RETRIES) {
      job.attempts += 1
      job.status = 'queued'
      job.error = message
      job.retryAt = Date.now() + RETRY_DELAY
      clearTimeout(job.timer)
      job.timer = setTimeout(() => this.schedule(), RETRY_DELAY + 50)
      return
    }
    job.status = 'error'
    job.error = message
    job.retryAt = null
  }

  /** Отмена и «убрать» упавшую задачу: недокачанное удаляется. */
  cancel(id: string): void {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) return
    clearTimeout(job.timer)
    job.cancelled = true
    if (job.status === 'active') {
      killTree(job.proc)
      return // уберётся в close
    }
    this.removePartials(job)
    this.jobs = this.jobs.filter((j) => j !== job)
    this.changed()
  }

  /** Выход из приложения: всё качающееся прерывается, недокачанное удаляется. */
  shutdown(): void {
    for (const job of this.jobs) {
      clearTimeout(job.timer)
      job.cancelled = true
      killTree(job.proc)
      this.removePartials(job)
    }
  }

  /** Удаляет только недокачанное этой задачи (.part, .ytdl, промежуточные .f<формат>.<расш>); готовый файл с таким именем не трогаем. */
  private removePartials(job: Job): void {
    let names: string[]
    try {
      names = readdirSync(job.folder)
    } catch {
      return
    }
    const prefix = `${job.baseName}.`
    for (const name of names) {
      if (!name.startsWith(prefix)) continue
      const rest = name.slice(prefix.length)
      const partial = rest.endsWith('.part') || rest.endsWith('.ytdl') || rest.includes('.temp.') || rest.startsWith('temp.') || /^f[^.]+\.[^.]+$/.test(rest)
      if (!partial) continue
      try {
        unlinkSync(join(job.folder, name))
      } catch {
        /* файл занят или уже удалён */
      }
    }
  }
}
