import { effectiveMode, isModeAvailable } from '../../shared/project'
import { STAGE_LABELS } from '../../shared/processing'
import { MODE_LABELS, PLAYBACK_MODES, type PlaybackMode, type Song } from '../../shared/types'
import { attempt } from '../state/store'

const MODE_HINTS: Record<PlaybackMode, string> = {
  original: 'The full original recording',
  bass: 'Only the isolated bass — listen and learn the part',
  playalong: 'The song without its bass — you play the bass part'
}

export function unavailableReason(song: Song, mode: PlaybackMode): string | null {
  if (isModeAvailable(song, mode)) return null
  if (mode === 'original') return 'The original file is missing — relink it'
  const sep = song.separation
  switch (sep.status) {
    case 'processing':
      return `${STAGE_LABELS[sep.stage ?? ''] ?? 'Separating'} … ${Math.round(sep.progress * 100)}%`
    case 'queued':
      return 'Waiting to be separated'
    case 'pending':
      return 'Preparing separation'
    case 'failed':
      return `Separation failed: ${sep.error ?? 'unknown error'}`
    case 'cancelled':
      return 'Separation was cancelled'
    case 'unavailable':
      return sep.error ?? 'Stem separation is not installed'
    default:
      return 'Not available yet'
  }
}

export function ModeSelector({ song }: { song: Song }) {
  const active = effectiveMode(song)
  const busy = song.separation.status === 'processing' || song.separation.status === 'queued'

  return (
    <div className="modes modes-md" role="radiogroup" aria-label="Playback mode">
      {PLAYBACK_MODES.map((mode, i) => {
        const available = isModeAvailable(song, mode)
        const isActive = active === mode
        // The user's choice is remembered even while its stems are still being made.
        const isWanted = song.mode === mode && !available
        const reason = unavailableReason(song, mode)
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={isActive}
            className={`mode${isActive ? ' is-active' : ''}${available ? '' : ' is-unavailable'}${isWanted ? ' is-wanted' : ''}`}
            title={`${MODE_LABELS[mode]} (${i + 1}) — ${reason ?? MODE_HINTS[mode]}`}
            onClick={(e) => {
              e.stopPropagation()
              void attempt(() => window.nota.songs.update(song.id, { mode }))
            }}
          >
            {mode !== 'original' && !available && busy && (
              <span className="mode-progress" style={{ width: `${Math.round(song.separation.progress * 100)}%` }} />
            )}
            <span className="mode-label">{MODE_LABELS[mode]}</span>
          </button>
        )
      })}
    </div>
  )
}
