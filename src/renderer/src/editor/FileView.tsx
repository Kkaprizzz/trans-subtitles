/**
 * Просмотр файла в главном окне предпросмотра: щелчок по файлу в «Медиа» или «Баннеры» показывает его здесь, таймлайн и проект
 * не трогаются. Файл с прозрачностью лежит на шахматке, звук играет. Если окно не показывает формат напрямую, сначала готовится
 * копия для просмотра (та же, что у кусков таймлайна).
 */
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { MediaInfo } from '../../../shared/types'
import Transport from './Transport'

export type ViewFile = Pick<MediaInfo, 'path' | 'name' | 'duration' | 'hasVideo' | 'hasAudio' | 'needsPreview' | 'hasAlpha' | 'width' | 'height' | 'fps'>

export interface FileViewHandle {
  toggle(): void
}

interface Props {
  file: ViewFile
  master: { level: number; volume: number; muted: boolean; setVolume(v: number): void; toggleMute(): void }
  onClose(): void
  handle: React.Ref<FileViewHandle>
}

export default function FileView(p: Props): React.JSX.Element {
  const { file } = p
  const ref = useRef<HTMLVideoElement>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [prep, setPrep] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)

  // готовим копию для просмотра, если окно не покажет файл как есть (или у файла прозрачность)
  useEffect(() => {
    let alive = true
    setSrc(null)
    setError(null)
    setTime(0)
    setPlaying(false)
    if (!file.needsPreview && !file.hasAlpha) {
      setSrc(window.api.mediaUrl(file.path))
      setPrep(null)
      return
    }
    setPrep(0)
    const off = window.api.onPreviewProgress((e) => {
      if (e.mediaPath === file.path) setPrep(e.value)
    })
    window.api.preparePreview(file.path).then(
      (out) => {
        if (!alive) return
        setPrep(null)
        setSrc(window.api.mediaUrl(out))
      },
      (e: unknown) => {
        if (!alive) return
        setPrep(null)
        setError(e instanceof Error ? e.message : String(e))
      }
    )
    return () => {
      alive = false
      off()
    }
  }, [file.path, file.needsPreview, file.hasAlpha])

  const toggle = useCallback((): void => {
    const el = ref.current
    if (!el) return
    if (el.paused || el.ended) {
      if (el.ended) el.currentTime = 0
      void el.play().catch(() => {})
    } else el.pause()
  }, [])
  useImperativeHandle(p.handle, () => ({ toggle }), [toggle])

  // громкость — общая с предпросмотром проекта
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.volume = Math.min(1, Math.max(0, p.master.level))
  }, [p.master.level, src])

  const dur = file.duration > 0 ? file.duration : 0

  return (
    <>
      <div className="pl-stage fv-stage">
        <div className="fv-bar">
          <span className="fv-title" title={file.path}>
            Просмотр: {file.name}
          </span>
          <button className="fv-x" onClick={p.onClose} title="Закрыть просмотр" aria-label="Закрыть просмотр">
            ✕
          </button>
        </div>
        <div className="fv-frame">
          {src && (
            <video
              key={src}
              ref={ref}
              className={`fv-video${file.hasAlpha ? ' checker' : ''}`}
              src={src}
              playsInline
              preload="auto"
              style={{ display: file.hasVideo ? undefined : 'none' }}
              onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onError={() => setError('Не удалось показать этот файл')}
            />
          )}
          {!file.hasVideo && src && <p className="pl-empty">Только звук</p>}
          {prep !== null && <p className="pl-empty">Готовлю просмотр: {Math.round(prep * 100)}%</p>}
          {error && <p className="pl-empty">{error}</p>}
        </div>
      </div>
      <Transport
        time={time}
        duration={dur}
        playing={playing}
        onTogglePlay={toggle}
        onSeek={(t) => {
          if (ref.current) ref.current.currentTime = t
          setTime(t)
        }}
        onScrubStart={() => undefined}
        onScrubEnd={() => undefined}
        level={p.master.level}
        volume={p.master.volume}
        muted={p.master.muted}
        onVolume={p.master.setVolume}
        onToggleMute={p.master.toggleMute}
        info={`${file.width ? `${file.width}×${file.height}` : 'звук'}${file.fps ? ` · ${Math.round(file.fps)} fps` : ''}`}
      />
    </>
  )
}
