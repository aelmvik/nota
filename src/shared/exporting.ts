import type { Song } from './types'

// Exporting one version of a song: what the Export window offers, and the
// names it suggests. Shared by the window (renderer) and the export itself (main).

export type ExportTrack = 'original' | 'bass' | 'backing'
export type ExportFormat = 'wav' | 'flac' | 'mp3'

export const EXPORT_TRACKS: { value: ExportTrack; label: string }[] = [
  { value: 'original', label: 'Original' },
  { value: 'bass', label: 'Bass' },
  { value: 'backing', label: 'Play Along' }
]

export const EXPORT_FORMATS: { value: ExportFormat; label: string; detail: string }[] = [
  { value: 'wav', label: 'WAV', detail: '24-bit, uncompressed' },
  { value: 'flac', label: 'FLAC', detail: 'Lossless, about half the size' },
  { value: 'mp3', label: 'MP3', detail: 'About 190 kbit/s, smallest' }
]

/** Everything the Export window decided; the file is `<folder>/<name>.<format>`. */
export interface ExportRequest {
  track: ExportTrack
  /** Bake the song's speed, key and cuts into the file */
  withChanges: boolean
  format: ExportFormat
  folder: string
  /** Without the extension */
  name: string
}

/** Where an export would go, and whether a file is already there. */
export interface ExportTarget {
  folder: string
  path: string
  exists: boolean
}

export const trackLabel = (track: ExportTrack) => EXPORT_TRACKS.find((t) => t.value === track)!.label

/** Whether the track can be exported: the original needs its file (or playback copy), the others need separating first. */
export function canExportTrack(song: Song, track: ExportTrack): boolean {
  if (track === 'original') return !song.source.missing || !!song.playbackProxy
  return song.separation.status === 'ready' && !!song.stems[track]
}

/**
 * The song's speed, key and cuts, or '' when it has none: short for file names
 * ("80 %, +2 st, 1 cut"), or `spelledOut` for reading ("80 % speed, 2 semitones up, 1 cut").
 */
export function describeChanges(song: Pick<Song, 'speed' | 'pitch' | 'cuts'>, spelledOut = false): string {
  const { semitones, cents } = song.pitch
  const step = (n: number, short: string, one: string, many: string) =>
    spelledOut ? `${Math.abs(n)} ${Math.abs(n) === 1 ? one : many} ${n > 0 ? 'up' : 'down'}` : `${n > 0 ? '+' : '−'}${Math.abs(n)} ${short}`
  return [
    song.speed !== 1 ? `${Math.round(song.speed * 100)} %${spelledOut ? ' speed' : ''}` : null,
    semitones ? step(semitones, 'st', 'semitone', 'semitones') : null,
    cents ? step(cents, '¢', 'cent', 'cents') : null,
    song.cuts.length ? `${song.cuts.length} ${song.cuts.length === 1 ? 'cut' : 'cuts'}` : null
  ]
    .filter(Boolean)
    .join(', ')
}

/** A name every system accepts as a file name. */
export function safeExportName(name: string): string {
  return name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120)
}

/** "Song - Bass (80 %, +2 st)" */
export function suggestedExportName(song: Song, track: ExportTrack, withChanges: boolean): string {
  const changes = withChanges ? describeChanges(song) : ''
  return safeExportName(`${song.title} - ${trackLabel(track)}${changes ? ` (${changes})` : ''}`)
}
