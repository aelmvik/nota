import type { BassNote } from './types'

// Edited bass notes (the Notes view's edit mode): kept on the song in the
// project, in song time and the original key, like the transcription.

/** The shortest note an edit leaves (seconds) */
export const MIN_NOTE_SEC = 0.02
export const NOTE_PITCH_MIN = 0
export const NOTE_PITCH_MAX = 127
/** A new note's velocity (the transcription's run 0..1) */
export const NEW_NOTE_VELOCITY = 0.8

const round = (t: number) => Math.round(t * 1e4) / 1e4

/** Sorted by start then pitch, inside the song, at least MIN_NOTE_SEC long; one note per start and pitch (the longer). */
export function normalizeNotes(notes: readonly BassNote[], duration: number): BassNote[] {
  const end = duration > 0 ? duration : Infinity
  const byKey = new Map<string, BassNote>()
  for (const n of notes) {
    if (!n || ![n.start, n.end, n.pitch].every(Number.isFinite)) continue
    const start = round(Math.max(0, Math.min(n.start, end - MIN_NOTE_SEC)))
    const note: BassNote = {
      start,
      end: round(Math.min(end, Math.max(start + MIN_NOTE_SEC, n.end))),
      pitch: Math.max(NOTE_PITCH_MIN, Math.min(NOTE_PITCH_MAX, Math.round(n.pitch))),
      velocity: Number.isFinite(n.velocity) ? Math.max(0, Math.min(1, n.velocity)) : NEW_NOTE_VELOCITY
    }
    const key = noteKey(note)
    const had = byKey.get(key)
    if (!had || had.end < note.end) byKey.set(key, note)
  }
  return [...byKey.values()].sort((a, b) => a.start - b.start || a.pitch - b.pitch)
}

/** Identifies a note across edits and saves: its start (to 0.1 ms) and pitch. */
export const noteKey = (n: Pick<BassNote, 'start' | 'pitch'>) => `${round(n.start).toFixed(4)}:${Math.round(n.pitch)}`

/** Copied notes, relative to the earliest one's start. */
export interface NoteClip {
  notes: BassNote[]
}

export function copyNotes(notes: readonly BassNote[]): NoteClip | null {
  if (!notes.length) return null
  const first = Math.min(...notes.map((n) => n.start))
  return { notes: notes.map((n) => ({ ...n, start: n.start - first, end: n.end - first })) }
}

/** The clip's notes placed from `at`. */
export function pasteNotes(clip: NoteClip, at: number): BassNote[] {
  return clip.notes.map((n) => ({ ...n, start: n.start + at, end: n.end + at }))
}
