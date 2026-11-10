import { describe, expect, it } from 'vitest'
import * as P from '../src/shared/project'
import type { Song, SongSource } from '../src/shared/types'

const source = (hash: string, path = `/music/${hash}.mp3`): SongSource => ({
  path,
  hash,
  sizeBytes: 1000,
  format: 'mp3',
  codec: 'mp3',
  sampleRate: 44100,
  channels: 2,
  missing: false
})

const song = (hash: string, duration = 200) => P.makeSong({ title: hash, artist: null, durationSec: duration, source: source(hash) })

function withSongs(...hashes: string[]) {
  return P.addSongs(P.createProject('Test'), hashes.map((h) => song(h)))
}

describe('playlist operations', () => {
  it('adds songs, selects the first, and ignores duplicates by content hash', () => {
    let p = withSongs('a', 'b')
    expect(p.songs.map((s) => s.title)).toEqual(['a', 'b'])
    expect(p.selectedSongId).toBe(p.songs[0].id)
    p = P.addSongs(p, [song('a'), song('c')])
    expect(p.songs.map((s) => s.title)).toEqual(['a', 'b', 'c'])
  })

  it('reorders songs and clamps the target index', () => {
    const p = withSongs('a', 'b', 'c', 'd')
    const moved = P.moveSong(p, p.songs[0].id, 2)
    expect(moved.songs.map((s) => s.title)).toEqual(['b', 'c', 'a', 'd'])
    expect(P.moveSong(p, p.songs[3].id, -5).songs.map((s) => s.title)).toEqual(['d', 'a', 'b', 'c'])
    expect(P.moveSong(p, p.songs[1].id, 99).songs.map((s) => s.title)).toEqual(['a', 'c', 'd', 'b'])
  })

  it('removing the selected song selects its neighbour', () => {
    let p = withSongs('a', 'b', 'c')
    p = P.selectSong(p, p.songs[2].id)
    p = P.removeSong(p, p.songs[2].id)
    expect(p.selectedSongId).toBe(p.songs[1].id)
    p = P.removeSong(P.removeSong(p, p.songs[0].id), p.songs[1].id)
    expect(p.selectedSongId).toBeNull()
  })

  it('never mutates its input', () => {
    const p = withSongs('a', 'b')
    const before = JSON.stringify(p)
    P.moveSong(p, p.songs[0].id, 1)
    P.updateSong(p, p.songs[0].id, { speed: 0.5 })
    P.removeSong(p, p.songs[0].id)
    expect(JSON.stringify(p)).toBe(before)
  })

  it('rejects unknown songs and empty names', () => {
    const p = withSongs('a')
    expect(() => P.removeSong(p, 'nope')).toThrow(P.ProjectError)
    expect(() => P.renameProject(p, '   ')).toThrow(P.ProjectError)
  })
})

describe('playback modes', () => {
  const ready = (s: Song): Song => ({
    ...s,
    separation: { status: 'ready', progress: 1, model: 'htdemucs' },
    stems: {
      bass: { kind: 'bass', cachePath: 'h/htdemucs/bass.flac', durationSec: 200, rmsDb: -20, model: 'htdemucs', createdAt: '' },
      backing: { kind: 'backing', cachePath: 'h/htdemucs/backing.flac', durationSec: 200, rmsDb: -15, model: 'htdemucs', createdAt: '' }
    }
  })

  it('only offers Original until stems exist', () => {
    const s = song('a')
    expect(P.availableModes(s)).toEqual(['original'])
    expect(P.availableModes(ready(s))).toEqual(['original', 'bass', 'playalong'])
  })

  it('does not treat stems as usable unless separation is ready', () => {
    const s = { ...ready(song('a')), separation: { status: 'processing' as const, progress: 0.5 } }
    expect(P.isModeAvailable(s, 'bass')).toBe(false)
    expect(P.isModeAvailable(s, 'playalong')).toBe(false)
  })

  it('remembers a requested mode and falls back until it is available', () => {
    let p = withSongs('a')
    const id = p.songs[0].id
    p = P.updateSong(p, id, { mode: 'playalong' })
    expect(p.songs[0].mode).toBe('playalong')
    expect(P.effectiveMode(p.songs[0])).toBe('original')
    expect(P.effectiveMode(ready(p.songs[0]))).toBe('playalong')
  })

  it('keeps bass modes when the source file goes missing, but not Original', () => {
    const s = ready({ ...song('a'), source: { ...source('a'), missing: true } })
    expect(P.availableModes(s)).toEqual(['bass', 'playalong'])
    expect(P.effectiveMode({ ...s, mode: 'original' })).toBe('bass')
  })

  it('Original stays available from a playback proxy when the source is missing', () => {
    const s = { ...song('a'), source: { ...source('a'), missing: true }, playbackProxy: 'a/playback.flac' }
    expect(P.isModeAvailable(s, 'original')).toBe(true)
  })
})

describe('practice settings', () => {
  it('clamps speed and rounds it', () => {
    expect(P.clampSpeed(0.1)).toBe(P.SPEED_MIN)
    expect(P.clampSpeed(9)).toBe(P.SPEED_MAX)
    expect(P.clampSpeed(0.7499999)).toBe(0.75)
    expect(P.clampSpeed(NaN)).toBe(1)
  })

  it('normalises loops: ordered, within the song, minimum length', () => {
    expect(P.normalizeLoop({ start: 20, end: 10, enabled: true }, 100)).toEqual({ start: 10, end: 20, enabled: true })
    expect(P.normalizeLoop({ start: 90, end: 150, enabled: true }, 100)).toEqual({ start: 90, end: 100, enabled: true })
    const tiny = P.normalizeLoop({ start: 5, end: 5, enabled: false }, 100)!
    expect(tiny.end - tiny.start).toBeCloseTo(P.MIN_LOOP_SEC)
    expect(P.normalizeLoop(null, 100)).toBeNull()
  })

  it('ignores values that are not numbers', () => {
    let p = withSongs('a')
    const id = p.songs[0].id
    p = P.updateSong(p, id, { volume: 0.5, position: 12 })
    p = P.updateSong(p, id, { volume: NaN, position: NaN, loop: { start: NaN, end: 5, enabled: true } })
    expect(p.songs[0]).toMatchObject({ volume: 0.5, position: 12, loop: null })
    expect(P.normalizeLoop({ start: 1, end: Infinity, enabled: true }, 100)).toBeNull()
  })
  it('clamps volume and position', () => {
    let p = withSongs('a')
    const id = p.songs[0].id
    p = P.updateSong(p, id, { volume: 5, position: 999 })
    expect(p.songs[0].volume).toBe(P.MAX_VOLUME)
    expect(p.songs[0].position).toBe(200)
  })
})

describe('serialization', () => {
  it('round-trips a project', () => {
    let p = withSongs('a', 'b')
    p = P.updateSong(p, p.songs[1].id, { mode: 'bass', speed: 0.8, loop: { start: 1, end: 5, enabled: true } })
    const back = P.parseProject(P.serializeProject(p))
    expect(back.songs.map((s) => [s.title, s.mode, s.speed, s.loop])).toEqual(p.songs.map((s) => [s.title, s.mode, s.speed, s.loop]))
    expect(back.selectedSongId).toBe(p.selectedSongId)
    expect(back.audio).toEqual(p.audio)
  })

  it('reschedules separations that were in flight when the app closed', () => {
    const p = withSongs('a', 'b', 'c')
    p.songs[0].separation = { status: 'processing', progress: 0.4 }
    p.songs[1].separation = { status: 'queued', progress: 0 }
    p.songs[2].separation = { status: 'failed', progress: 0, error: 'boom' }
    const back = P.parseProject(P.serializeProject(p))
    expect(back.songs.map((s) => s.separation.status)).toEqual(['pending', 'pending', 'failed'])
  })

  it('keeps even bars per song and the accent setting', () => {
    let p = withSongs('a')
    const id = p.songs[0].id
    expect(p.songs[0].evenBars).toBe(false)
    expect(p.metronome.accent).toBe(true)
    p = P.updateSong(p, id, { evenBars: true })
    p = P.updateMetronome(p, { accent: false })
    const back = P.parseProject(P.serializeProject(p))
    expect(back.songs[0].evenBars).toBe(true)
    expect(back.metronome.accent).toBe(false)
  })

  it('fills defaults for missing optional fields and rejects broken files', () => {
    const p = withSongs('a')
    const raw = JSON.parse(P.serializeProject(p))
    delete raw.audio
    delete raw.effects
    delete raw.songs[0].loop
    const back = P.parseProject(JSON.stringify(raw))
    expect(back.audio).toEqual(P.DEFAULT_AUDIO)
    expect(back.effects).toEqual([])
    expect(back.songs[0].loop).toBeNull()

    expect(() => P.parseProject('{nope')).toThrow(/not valid JSON/)
    expect(() => P.parseProject('{"format":"other"}')).toThrow(/not a Nøta project/)
    expect(() => P.parseProject(JSON.stringify({ ...raw, version: 7 }))).toThrow(/Unsupported/)
    expect(() => P.parseProject(JSON.stringify({ ...raw, songs: [{ title: 'x' }] }))).toThrow(/damaged/)
  })
  it('repairs a hand-edited song: no id or length, a volume and position out of range', () => {
    const raw = JSON.parse(P.serializeProject(withSongs('a', 'b')))
    delete raw.songs[0].id
    delete raw.songs[0].durationSec
    delete raw.songs[0].title
    Object.assign(raw.songs[1], { volume: 99, position: 5000 })
    const back = P.parseProject(JSON.stringify(raw))
    expect(back.songs[0].id).toEqual(expect.any(String))
    expect(back.songs[0].id).not.toBe(back.songs[1].id)
    expect(back.songs[0]).toMatchObject({ durationSec: 0, title: 'Untitled' })
    expect(back.songs[1]).toMatchObject({ volume: P.MAX_VOLUME, position: 200 })
    expect(back.selectedSongId).toBe(back.songs[0].id) // the selection named the lost id: the first song, under its new one
  })
})

describe('plugin states', () => {
  const slot = (slotId: string, state: string | null, bypassed = false) =>
    ({ slotId, pluginId: slotId, name: slotId, manufacturer: '', format: 'VST3', descriptionXml: '', bypassed, state })

  it('takes captured states without undoing changes made to the effects meanwhile', () => {
    const before = { ...withSongs('a'), effects: [slot('one', 'old'), slot('two', 'old')] }
    // While the engine answered: "one" was bypassed, "two" removed and "three" added.
    const now = { ...before, effects: [slot('one', 'old', true), slot('three', null)] }
    const captured = [slot('one', 'new'), slot('two', 'new')]
    expect(P.withEffectStates(now, captured).effects).toEqual([slot('one', 'new', true), slot('three', null)])
    // A slot the engine gave no state for keeps the one it had.
    expect(P.withEffectStates(before, [slot('one', null)]).effects[0].state).toBe('old')
  })
})
