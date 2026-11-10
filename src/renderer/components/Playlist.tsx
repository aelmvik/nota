import { useEffect, useRef, useState } from 'react'
import { STAGE_LABELS } from '../../shared/processing'
import { MODE_LABELS, type Song } from '../../shared/types'
import { effectiveMode } from '../../shared/project'
import { playSong } from '../audio/sync'
import { importViaDialog } from '../actions'
import { attempt, player, readPref, toast, useStore, writePref } from '../state/store'
import { Button, Icon, InlineEdit, Menu, Slider, formatTime, type MenuItem } from './ui'
import { formatDuration } from '../../shared/practice'
import { canExportTrack, EXPORT_TRACKS } from '../../shared/exporting'
import { openExport } from './ExportDialog'
import { useWaveform, Waveform } from './Waveform'
import { revealLabel } from '../platform'

/**
 * Separation status, shown only when there's something to say: progress,
 * waiting, problems. A ready song shows nothing (its mode buttons say it),
 * or a small warning icon when separation left a note (e.g. very little bass).
 */
export function StatusChip({ song }: { song: Song }) {
  if (song.source.missing && song.separation.status !== 'ready')
    return (
      <span className="chip chip-danger" title={`Not found at ${song.source.path}`}>
        <Icon name="alert" size={12} /> File missing
      </span>
    )
  const sep = song.separation
  switch (sep.status) {
    case 'ready':
      return sep.warning ? (
        <span className="status-note" title={sep.warning} aria-label={sep.warning}>
          <Icon name="alert" size={14} />
        </span>
      ) : null
    case 'processing':
      return (
        <span className="chip chip-busy" title={`${STAGE_LABELS[sep.stage ?? ''] ?? 'Separating'} with ${sep.model}`}>
          <span className="spinner" /> {Math.round(sep.progress * 100)}%
        </span>
      )
    case 'queued':
      return <span className="chip chip-muted">Waiting</span>
    case 'pending':
      return <span className="chip chip-muted">Preparing</span>
    case 'failed':
      return (
        <span className="chip chip-danger" title={sep.error}>
          <Icon name="alert" size={12} /> Failed
        </span>
      )
    case 'cancelled':
      return <span className="chip chip-muted">Cancelled</span>
    case 'unavailable':
      return (
        <span className="chip chip-muted" title={sep.error}>
          No separation
        </span>
      )
  }
}

function SongRow({ song, index, selected, onDragStart, onDropAt }: {
  song: Song
  index: number
  selected: boolean
  onDragStart: (id: string) => void
  onDropAt: (index: number) => void
}) {
  const playing = useStore((s) => s.player.playing && s.player.songId === song.id)
  const wave = useWaveform(song.source.missing && !song.playbackProxy ? null : song.id, 'original', song.source.hash)
  const [dropSide, setDropSide] = useState<'above' | 'below' | null>(null)
  const [renaming, setRenaming] = useState<'title' | 'artist' | null>(null)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const sep = song.separation
  const mode = effectiveMode(song)
  const api = window.nota.songs

  const menu: (MenuItem | 'separator')[] = [
    ...(sep.status === 'failed' || sep.status === 'cancelled' || sep.status === 'unavailable'
      ? [{ label: 'Retry separation', icon: 'refresh' as const, onSelect: () => void attempt(() => api.retry(song.id)) }]
      : []),
    ...(sep.status === 'queued' || sep.status === 'processing'
      ? [{ label: 'Cancel separation', icon: 'x' as const, onSelect: () => void attempt(() => api.cancel(song.id)) }]
      : []),
    ...(sep.status === 'ready'
      ? [{ label: 'Separate again', icon: 'refresh' as const, onSelect: () => void attempt(() => api.retry(song.id)) }]
      : []),
    { label: song.source.missing ? 'Relink file…' : 'Replace file…', icon: 'link', onSelect: () => void relink(song.id) },
    { label: 'Rename…', icon: 'edit', onSelect: () => setRenaming('title') },
    { label: song.artist ? 'Edit artist…' : 'Add artist…', icon: 'edit', onSelect: () => setRenaming('artist') },
    { label: revealLabel, icon: 'folder', disabled: song.source.missing, onSelect: () => void attempt(() => api.reveal(song.id)) },
    'separator',
    { label: 'Export…', icon: 'download', disabled: !EXPORT_TRACKS.some((t) => canExportTrack(song, t.value)), onSelect: () => openExport(song.id) },
    'separator',
    { label: 'Remove from playlist', icon: 'trash', danger: true, onSelect: () => void attempt(() => api.remove(song.id)) }
  ]

  return (
    <div
      className={`song${selected ? ' is-selected' : ''}${dropSide ? ` drop-${dropSide}` : ''}`}
      onClick={() => !selected && void attempt(() => api.select(song.id))}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('input, textarea')) return
        e.preventDefault()
        setMenuAt({ x: e.clientX, y: e.clientY })
        if (!selected) void attempt(() => api.select(song.id))
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('application/x-nota-song')) return
        e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        setDropSide(e.clientY < r.top + r.height / 2 ? 'above' : 'below')
      }}
      onDragLeave={() => setDropSide(null)}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('application/x-nota-song')) return
        e.preventDefault()
        e.stopPropagation()
        onDropAt(dropSide === 'below' ? index + 1 : index)
        setDropSide(null)
      }}
    >
      <span
        className="song-grip"
        draggable
        title="Drag to reorder"
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-nota-song', song.id)
          e.dataTransfer.effectAllowed = 'move'
          const row = (e.currentTarget as HTMLElement).closest('.song')
          if (row) e.dataTransfer.setDragImage(row, 20, 20)
          onDragStart(song.id)
        }}
      >
        <Icon name="grip" size={14} />
      </span>
      <span className="song-index">{index + 1}</span>
      <button
        type="button"
        className={`song-play${playing ? ' is-playing' : ''}`}
        title={playing ? 'Pause (Space)' : 'Play'}
        onClick={(e) => {
          e.stopPropagation()
          playSong(song.id)
        }}
      >
        <Icon name={playing ? 'pause' : 'play'} size={14} />
      </button>
      <div className="song-meta">
        <div className="song-title">
          <InlineEdit
            trigger={selected ? 'click' : 'dblclick'}
            value={song.title}
            placeholder="Title"
            editing={renaming === 'title'}
            onEditingChange={(on) => setRenaming(on ? 'title' : null)}
            onCommit={(title) => title && title !== song.title && void attempt(() => api.update(song.id, { title }))}
          />
        </div>
        <div className="song-sub">
          {(song.artist || renaming === 'artist') && (
            <InlineEdit
              className="song-artist"
              trigger={selected ? 'click' : 'dblclick'}
              value={song.artist ?? ''}
              placeholder="Artist"
              editing={renaming === 'artist'}
              onEditingChange={(on) => setRenaming(on ? 'artist' : null)}
              onCommit={(artist) => artist !== (song.artist ?? '') && void attempt(() => api.update(song.id, { artist: artist || null }))}
            />
          )}
          <span className="song-duration">{formatTime(song.durationSec)}</span>
          {song.speed !== 1 && <span className="song-tag">{Math.round(song.speed * 100)}%</span>}
          {(song.pitch.semitones !== 0 || song.pitch.cents !== 0) && <span className="song-tag" title="Key changed">{formatPitch(song.pitch)}</span>}
          {song.loop?.enabled && <span className="song-tag">Loop</span>}
          {song.cuts.length > 0 && (
            <span className="song-tag" title="Parts cut out: playback skips them">
              {song.cuts.length} {song.cuts.length === 1 ? 'cut' : 'cuts'}
            </span>
          )}
        </div>
      </div>
      <div className="song-wave">
        <Waveform
          compact
          dim={!selected}
          wave={wave}
          duration={song.durationSec}
          getPosition={selected ? () => player.currentTime : null}
          loop={song.loop}
          cuts={song.cuts}
          onSeek={(t) => {
            if (selected) player.seek(t)
            else void attempt(() => api.update(song.id, { position: t })).then(() => api.select(song.id))
          }}
        />
      </div>
      {/* Which mode the song plays in; it's chosen in the deck (or with 1, 2, 3). */}
      <span className="song-mode">{mode ? MODE_LABELS[mode] : ''}</span>
      <div className="song-status">
        <StatusChip song={song} />
        {song.source.missing && (
          <Button size="sm" variant="ghost" onClick={(e) => (e.stopPropagation(), void relink(song.id))}>
            Relink
          </Button>
        )}
        {(sep.status === 'failed' || sep.status === 'cancelled') && !song.source.missing && (
          <Button size="sm" variant="ghost" icon="refresh" title="Retry separation" onClick={(e) => (e.stopPropagation(), void attempt(() => api.retry(song.id)))} />
        )}
      </div>
      <div className="song-volume" title={`This song's volume: ${volumeDb(song.volume)}`} onClick={(e) => e.stopPropagation()}>
        <Icon name="speaker" size={14} />
        <Slider value={song.volume} min={0} max={1.5} title={`This song's volume: ${volumeDb(song.volume)}`} onChange={(v) => void api.update(song.id, { volume: v })} />
        <span className="song-volume-db">{volumeDb(song.volume)}</span>
      </div>
      <div onClick={(e) => e.stopPropagation()}>
        <Menu trigger={() => <Button size="sm" variant="ghost" icon="more" title="Song options (or right-click the song)" />} items={menu} at={menuAt} />
      </div>
    </div>
  )
}

/** A song's volume (linear, 1 = as recorded) in dB. */
function volumeDb(v: number) {
  if (v <= 0) return '−∞ dB'
  const db = Math.round(200 * Math.log10(v)) / 10
  return `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db).toFixed(1)} dB`
}

/** "+2 st", "−1 st +20 ¢", "+15 ¢" */
function formatPitch({ semitones, cents }: Song['pitch']) {
  const signed = (n: number, unit: string) => `${n > 0 ? '+' : '−'}${Math.abs(n)} ${unit}`
  return [semitones && signed(semitones, 'st'), cents && signed(cents, '¢')].filter(Boolean).join(' ')
}

async function relink(id: string) {
  const outcome = await attempt(() => window.nota.songs.relink(id), 'Relink failed')
  if (outcome === 'relinked') toast('File relinked', 'success')
}

export function Playlist() {
  const project = useStore((s) => s.snapshot!.project!)
  const importing = useStore((s) => s.importing)
  const [, setDragging] = useState<string | null>(null)
  const dragId = useState<{ id: string | null }>({ id: null })[0]

  const songs = project.songs
  const ready = songs.filter((s) => s.separation.status === 'ready').length
  const totalSec = songs.reduce((sum, s) => sum + s.durationSec, 0)

  // The first time songs go into an empty project, one line on the keys that matter most (once ever).
  const count = songs.length
  const hadSongs = useRef(count > 0)
  useEffect(() => {
    if (!hadSongs.current && count > 0 && !readPref('tipFirstSongs', false)) {
      writePref('tipFirstSongs', true)
      toast('Tip: once a song is separated, press 2 for Bass Solo, 3 for Play Along, and L to loop the part you’re working on.', 'info', 10000)
    }
    hadSongs.current = count > 0
  }, [count])

  if (songs.length === 0)
    return (
      <div className="playlist-empty">
        <div className="dropzone">
          <Icon name="music" size={28} />
          <h2>Add the songs you want to practice</h2>
          <p>Drop audio files here, or pick them from disk. Each song is split into an isolated bass part and a backing track without bass, in the background.</p>
          <Button variant="primary" icon="import" onClick={() => void importViaDialog()}>
            Import songs…
          </Button>
          <span className="dropzone-formats">MP3, WAV, FLAC, AIFF, M4A, OGG</span>
          {importing && (
            <span className="dropzone-formats">
              Importing {importing.done} of {importing.total}…
            </span>
          )}
        </div>
      </div>
    )

  return (
    <div className="playlist">
      <div className="playlist-head">
        <h2>Playlist</h2>
        <span className="playlist-count">
          {songs.length} {songs.length === 1 ? 'song' : 'songs'} · {formatDuration(totalSec)} · {ready} separated
        </span>
        {importing && (
          <span className="playlist-count">
            <span className="spinner" /> Importing {importing.done} of {importing.total}
          </span>
        )}
        <div className="spacer" />
      </div>
      <div className="playlist-rows">
        {songs.map((song, i) => (
          <SongRow
            key={song.id}
            song={song}
            index={i}
            selected={song.id === project.selectedSongId}
            onDragStart={(id) => {
              dragId.id = id
              setDragging(id)
            }}
            onDropAt={(to) => {
              const id = dragId.id
              dragId.id = null
              setDragging(null)
              if (!id) return
              const from = songs.findIndex((s) => s.id === id)
              const target = to > from ? to - 1 : to
              if (target !== from) void attempt(() => window.nota.songs.move(id, target))
            }}
          />
        ))}
        {/* Files can be dropped anywhere on the window; this says so where there's room. */}
        <div className="playlist-drop">
          <Icon name="music" size={14} />
          <span>Drop more songs here, or</span>
          <Button size="sm" variant="ghost" icon="import" onClick={() => void importViaDialog()}>
            Import…
          </Button>
        </div>
      </div>
    </div>
  )
}
