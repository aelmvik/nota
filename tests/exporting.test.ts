import { describe, expect, it } from 'vitest'
import { canExportTrack, describeChanges, safeExportName, suggestedExportName } from '../src/shared/exporting'
import * as P from '../src/shared/project'
import type { Song } from '../src/shared/types'

const song = (over: Partial<Song> = {}): Song => ({
  ...P.makeSong({
    title: 'So What',
    artist: null,
    durationSec: 200,
    source: { path: '/music/so-what.mp3', hash: 'h', sizeBytes: 1, format: 'mp3', codec: 'mp3', sampleRate: 44100, channels: 2, missing: false }
  }),
  ...over
})

const separated = (s: Song): Song => ({
  ...s,
  separation: { status: 'ready', progress: 1, model: 'htdemucs' },
  stems: {
    bass: { kind: 'bass', cachePath: 'h/bass.flac', durationSec: 200, rmsDb: -20, model: 'htdemucs', createdAt: '' },
    backing: { kind: 'backing', cachePath: 'h/backing.flac', durationSec: 200, rmsDb: -15, model: 'htdemucs', createdAt: '' }
  }
})

describe('the Export window', () => {
  it('describes the song’s changes, or nothing when it has none', () => {
    expect(describeChanges(song())).toBe('')
    const changed = song({ speed: 0.8, pitch: { semitones: -2, cents: 15 }, cuts: [{ start: 1, end: 2 }] })
    expect(describeChanges(changed)).toBe('80 %, −2 st, +15 ¢, 1 cut')
    expect(describeChanges(changed, true)).toBe('80 % speed, 2 semitones down, 15 cents up, 1 cut')
    expect(describeChanges(song({ pitch: { semitones: 1, cents: 0 } }), true)).toBe('1 semitone up')
  })

  it('offers bass and play-along only once the song is separated, and the original only while its file is there', () => {
    expect(['original', 'bass', 'backing'].map((t) => canExportTrack(song(), t as never))).toEqual([true, false, false])
    expect(['original', 'bass', 'backing'].map((t) => canExportTrack(separated(song()), t as never))).toEqual([true, true, true])
    const missing = song({ source: { ...song().source, missing: true } })
    expect(canExportTrack(missing, 'original')).toBe(false)
    expect(canExportTrack({ ...missing, playbackProxy: 'h/playback.flac' }, 'original')).toBe(true)
  })

  it('suggests a name with the track and the changes', () => {
    const s = song({ speed: 0.8, pitch: { semitones: 2, cents: 0 } })
    expect(suggestedExportName(s, 'bass', true)).toBe('So What - Bass (80 %, +2 st)')
    expect(suggestedExportName(s, 'backing', false)).toBe('So What - Play Along')
    expect(suggestedExportName(song({ title: 'AC/DC: Live?' }), 'original', false)).toBe('AC-DC- Live- - Original')
  })

  it('makes any typed name safe as a file name', () => {
    expect(safeExportName('  a/b\\c:d  ')).toBe('a-b-c-d')
    expect(safeExportName('trailing dots...')).toBe('trailing dots')
    expect(safeExportName('x'.repeat(300))).toHaveLength(120)
  })
})
