import { useEffect, useRef, useState } from 'react'
import {
  canExportTrack,
  describeChanges,
  EXPORT_FORMATS,
  EXPORT_TRACKS,
  suggestedExportName,
  type ExportFormat,
  type ExportTarget,
  type ExportTrack
} from '../../shared/exporting'
import { effectiveMode } from '../../shared/project'
import type { Song } from '../../shared/types'
import { fileName } from '../../shared/paths'
import { attempt, readPref, setState, toast, useStore, writePref } from '../state/store'
import { Button, Icon } from './ui'

// The Export window: one song, everything chosen in one place (track, the
// song's changes, format, name and folder), then Export. Opened from the
// song's menu; progress and cancelling are in the export toast.

export const openExport = (songId: string) => setState({ exportSongId: songId })
const close = () => setState({ exportSongId: null })

export function ExportDialog() {
  const song = useStore((s) => {
    const p = s.snapshot?.project
    return s.exportSongId ? (p?.songs.find((x) => x.id === s.exportSongId) ?? null) : null
  })
  // The song went away (removed, or the project closed) while the window was open.
  useEffect(() => {
    if (!song) close()
  }, [song])
  return song ? <ExportWindow key={song.id} song={song} /> : null
}

/** The track the song is playing in, if it can be exported; else the first that can. */
function startingTrack(song: Song): ExportTrack {
  const mode = effectiveMode(song)
  const playing: ExportTrack = mode === 'bass' ? 'bass' : mode === 'playalong' ? 'backing' : 'original'
  if (canExportTrack(song, playing)) return playing
  return EXPORT_TRACKS.find((t) => canExportTrack(song, t.value))?.value ?? 'original'
}

function Segments<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; disabled?: boolean; title?: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg export-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? 'is-active' : ''}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function ExportWindow({ song }: { song: Song }) {
  const changes = describeChanges(song)
  const [track, setTrack] = useState<ExportTrack>(() => startingTrack(song))
  const [withChanges, setWithChanges] = useState(() => readPref('exportWithChanges', true))
  const [format, setFormat] = useState<ExportFormat>(() => {
    const f = readPref<string>('exportFormat', 'wav')
    return EXPORT_FORMATS.some((x) => x.value === f) ? (f as ExportFormat) : 'wav'
  })
  const [folder, setFolder] = useState<string | null>(() => readPref<string | null>('exportFolder', null))
  const suggested = suggestedExportName(song, track, withChanges && !!changes)
  // The name follows the choices until it's typed over.
  const [typedName, setTypedName] = useState<string | null>(null)
  const name = typedName ?? suggested
  const [target, setTarget] = useState<ExportTarget | null>(null)
  const exportRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let alive = true
    void window.nota.songs.exportTarget(folder, name, format).then(
      (t) => alive && setTarget(t),
      () => alive && setTarget(null)
    )
    return () => {
      alive = false
    }
  }, [folder, name, format])

  useEffect(() => exportRef.current?.focus(), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const ready = canExportTrack(song, track) && name.trim() !== '' && !!target

  const start = () => {
    if (!ready) return
    writePref('exportFormat', format)
    writePref('exportFolder', target.folder)
    if (changes) writePref('exportWithChanges', withChanges)
    close()
    void attempt(() => window.nota.songs.export(song.id, { track, withChanges: withChanges && !!changes, format, folder: target.folder, name }), 'Export').then(
      (path) => path && toast(`Exported ${fileName(path)}`, 'success')
    )
  }

  const chooseFolder = async () => {
    const picked = await attempt(() => window.nota.songs.exportFolder(target?.folder ?? folder))
    if (picked) setFolder(picked)
  }

  const notSeparated = song.separation.status === 'ready' ? undefined : 'Separate the song first'

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        onSubmit={(e) => {
          e.preventDefault()
          start()
        }}
      >
        <div className="side-head">
          <h3 id="export-title">
            <Icon name="download" size={14} /> Export <span className="modal-sub">{song.title}</span>
          </h3>
          <Button size="sm" variant="ghost" icon="x" title="Close (Esc)" onClick={close} />
        </div>

        <div className="set-group">
          <div className="set-row">
            <div className="set-label">Track</div>
            <Segments
              label="Track"
              value={track}
              onChange={setTrack}
              options={EXPORT_TRACKS.map((t) => ({
                ...t,
                disabled: !canExportTrack(song, t.value),
                title: canExportTrack(song, t.value) ? undefined : t.value === 'original' ? 'The original file is missing' : notSeparated
              }))}
            />
          </div>

          {changes && (
            <div className="set-row">
              <div className="set-text">
                <div className="set-label">Your changes</div>
                <div className="set-help">
                  {withChanges
                    ? `${describeChanges(song, true)}: played as you hear it${song.cuts.length ? ', with the cut parts left out' : ''}.`
                    : 'The track as recorded, without your changes.'}
                </div>
              </div>
              <Segments
                label="Your changes"
                value={withChanges ? 'with' : 'without'}
                onChange={(v) => setWithChanges(v === 'with')}
                options={[
                  { value: 'with', label: 'With changes' },
                  { value: 'without', label: 'As recorded' }
                ]}
              />
            </div>
          )}

          <div className="set-row">
            <div className="set-text">
              <div className="set-label">Format</div>
              <div className="set-help">{EXPORT_FORMATS.find((f) => f.value === format)!.detail}</div>
            </div>
            <Segments label="Format" value={format} onChange={setFormat} options={EXPORT_FORMATS} />
          </div>

          <div className="set-row">
            <label className="set-label" htmlFor="export-name">
              File name
            </label>
            <div className="export-name">
              <input
                id="export-name"
                className="export-input"
                value={name}
                spellCheck={false}
                onChange={(e) => setTypedName(e.target.value)}
              />
              <span className="export-ext">.{format}</span>
              {typedName !== null && typedName !== suggested && (
                <Button size="sm" variant="ghost" icon="reset" title="Back to the suggested name" onClick={() => setTypedName(null)} />
              )}
            </div>
          </div>

          <div className="set-row is-inline">
            <div className="set-text">
              <div className="set-label">Folder</div>
              <div className="set-path">{target?.folder ?? '…'}</div>
            </div>
            <Button size="sm" icon="folder" onClick={() => void chooseFolder()}>
              Choose…
            </Button>
          </div>
        </div>

        <div className="modal-foot">
          <span className="modal-note" role="status">
            {target?.exists && (
              <>
                <Icon name="alert" size={13} /> {fileName(target.path)} is there already; it will be replaced.
              </>
            )}
          </span>
          <Button onClick={close}>Cancel</Button>
          <button ref={exportRef} type="submit" className="btn btn-primary" disabled={!ready}>
            {target?.exists ? 'Replace' : 'Export'}
          </button>
        </div>
      </form>
    </div>
  )
}
