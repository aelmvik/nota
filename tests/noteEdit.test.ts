import { describe, expect, it } from 'vitest'
import { copyNotes, MIN_NOTE_SEC, normalizeNotes, noteKey, pasteNotes } from '../src/shared/noteEdit'
import * as P from '../src/shared/project'
import type { BassNote } from '../src/shared/types'

const n = (start: number, end: number, pitch: number, velocity = 0.5): BassNote => ({ start, end, pitch, velocity })

describe('edited notes', () => {
  it('sorts, keeps notes inside the song and at least the shortest length', () => {
    expect(normalizeNotes([n(2, 3, 40), n(1, 1.5, 45), n(1, 1.2, 40)], 10)).toEqual([n(1, 1.2, 40), n(1, 1.5, 45), n(2, 3, 40)])
    expect(normalizeNotes([n(-1, 0.5, 40)], 10)).toEqual([n(0, 0.5, 40)])
    expect(normalizeNotes([n(9.9, 12, 40)], 10)).toEqual([n(9.9, 10, 40)])
    expect(normalizeNotes([n(1, 1, 40)], 10)[0].end).toBeCloseTo(1 + MIN_NOTE_SEC, 6)
  })

  it('rounds pitches into MIDI range and leaves out broken notes', () => {
    expect(normalizeNotes([n(1, 2, 200), n(2, 3, -4), n(3, 4, 40.6), n(NaN, 1, 40)], 10).map((x) => x.pitch)).toEqual([127, 0, 41])
  })

  it('keeps one note per start and pitch, the longer', () => {
    expect(normalizeNotes([n(1, 1.5, 40), n(1, 2, 40), n(1, 1.2, 41)], 10)).toEqual([n(1, 2, 40), n(1, 1.2, 41)])
  })

  it('names a note by its start and pitch, through a save', () => {
    const [saved] = normalizeNotes([n(1.23456789, 2, 40)], 10)
    expect(noteKey(saved)).toBe(noteKey(n(1.23456789, 3, 40)))
    expect(noteKey(saved)).not.toBe(noteKey(n(1.23456789, 2, 41)))
  })

  it('copies notes relative to the first and pastes them anywhere', () => {
    const clip = copyNotes([n(5, 5.5, 40), n(6, 7, 43)])!
    expect(pasteNotes(clip, 10)).toEqual([n(10, 10.5, 40), n(11, 12, 43)])
    expect(copyNotes([])).toBeNull()
  })
})

describe('edited notes on the song', () => {
  const song = P.makeSong({ title: 'A', artist: null, durationSec: 100, source: { path: 'Songs/a.wav', hash: 'h', size: 1, mtimeMs: 1 } as never })
  const project = P.addSongs(P.createProject('Test'), [song])

  it('starts with the transcription, saves edits and goes back', () => {
    expect(song.editedNotes).toBeNull()
    const edited = P.updateSong(project, song.id, { notes: [n(3, 4, 40), n(1, 2, 38)] })
    expect(edited.songs[0].editedNotes).toEqual([n(1, 2, 38), n(3, 4, 40)])
    expect(P.updateSong(edited, song.id, { notes: null }).songs[0].editedNotes).toBeNull()
    // Other edits leave them alone.
    expect(P.updateSong(edited, song.id, { speed: 0.8 }).songs[0].editedNotes).toEqual(edited.songs[0].editedNotes)
  })

  it('keeps them through a save, and older projects open without them', () => {
    const edited = P.updateSong(project, song.id, { notes: [n(1, 2, 38)] })
    expect(P.parseProject(JSON.stringify(edited)).songs[0].editedNotes).toEqual([n(1, 2, 38)])
    const older = JSON.parse(JSON.stringify(project))
    delete older.songs[0].editedNotes
    expect(P.parseProject(JSON.stringify(older)).songs[0].editedNotes).toBeNull()
  })
})
