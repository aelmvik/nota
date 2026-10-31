import { describe, expect, it } from 'vitest'
import * as M from '../src/shared/music'
import * as P from '../src/shared/project'

describe('pitch', () => {
  it('computes frequency ratios for semitones and cents', () => {
    expect(M.pitchRatio({ semitones: 0, cents: 0 })).toBe(1)
    expect(M.pitchRatio({ semitones: 12, cents: 0 })).toBeCloseTo(2)
    expect(M.pitchRatio({ semitones: -12, cents: 0 })).toBeCloseTo(0.5)
    expect(M.pitchRatio({ semitones: 0, cents: 100 })).toBeCloseTo(M.pitchRatio({ semitones: 1, cents: 0 }))
    expect(M.pitchRatio({ semitones: 0, cents: -23 })).toBeCloseTo(Math.pow(2, -23 / 1200))
  })

  it('clamps and rounds', () => {
    expect(M.clampPitch({ semitones: 20, cents: -80 })).toEqual({ semitones: 12, cents: -50 })
    expect(M.clampPitch({ semitones: 1.6, cents: 12.4 })).toEqual({ semitones: 2, cents: 12 })
  })

  it('corrects a detuned recording towards A440', () => {
    expect(M.tuningCorrection(32)).toBe(-32) // song is sharp: bring it down
    expect(M.tuningCorrection(-18.4)).toBe(18)
    expect(M.tuningCorrection(70)).toBe(-50)
  })
})

describe('key names', () => {
  it('transposes with conventional spelling', () => {
    expect(M.transposeKey('E minor', 2)).toBe('F♯ minor')
    expect(M.transposeKey('E♭ major', 2)).toBe('F major')
    expect(M.transposeKey('C major', -2)).toBe('B♭ major')
    expect(M.transposeKey('A minor', 12)).toBe('A minor')
    expect(M.transposeKey('C♯ minor', -1)).toBe('C minor')
    expect(M.transposeKey('not a key', 3)).toBe('not a key')
  })

  it('formats offsets', () => {
    expect(M.formatSemitones(0)).toBe('0 st')
    expect(M.formatSemitones(-3)).toBe('−3 st')
    expect(M.formatCents(15)).toBe('+15¢')
  })
})

describe('beat grid', () => {
  const song = { tempo: null, beatsPerBar: null, downbeat: 0, durationSec: 10 }
  const detected = { beats: [0.5, 1, 1.5, 2, 2.5], beatsPerBar: 4, downbeatIndex: 0 }

  it('uses the detected grid and marks downbeats', () => {
    expect(M.beatGrid(M.effectiveGrid(song, detected)).map((b) => b.inBar)).toEqual([0, 1, 2, 3, 0])
  })

  it('applies meter and downbeat overrides', () => {
    expect(M.beatGrid(M.effectiveGrid({ ...song, downbeat: 1 }, detected)).map((b) => b.inBar)).toEqual([3, 0, 1, 2, 3])
    expect(M.beatGrid(M.effectiveGrid({ ...song, beatsPerBar: 3 }, detected)).map((b) => b.inBar)).toEqual([0, 1, 2, 0, 1])
  })

  it('builds a manual grid whose anchor is a downbeat', () => {
    const g = M.effectiveGrid({ ...song, tempo: { bpm: 120, offset: 1.25 } }, detected)!
    expect(g.beats[0]).toBeCloseTo(0.25)
    expect(g.beats.every((b, i) => i === 0 || Math.abs(b - g.beats[i - 1] - 0.5) < 1e-9)).toBe(true)
    const beats = M.beatGrid(g)
    expect(beats.some((b) => Math.abs(b.time - 1.25) < 1e-9 && b.inBar === 0)).toBe(true)
    expect(g.beats.at(-1)!).toBeLessThanOrEqual(10)
  })

  it('halves or doubles the detected grid', () => {
    const g = { beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], beatsPerBar: 4, downbeatIndex: 1 }
    const half = M.effectiveGrid({ ...song, gridScale: 0.5 }, g)!
    expect(half.beats).toEqual([0.5, 1.5, 2.5, 3.5])
    expect(half.beatsPerBar).toBe(2)
    expect(M.beatGrid(half)[0].inBar).toBe(0)
    const dbl = M.effectiveGrid({ ...song, gridScale: 2 }, g)!
    expect(dbl.beats.slice(0, 3)).toEqual([0, 0.25, 0.5])
    expect(M.beatGrid(dbl)[2].inBar).toBe(0)
  })

  describe('with bars that change mid-song', () => {
    // 4/4, a 2/4 bar at beat 4, then 4/4
    const changing = { beats: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], beatsPerBar: 4, downbeatIndex: 0, inBar: [0, 1, 2, 3, 0, 1, 0, 1, 2, 3, 0, 1] }
    const long = { ...song, durationSec: 12 }

    it('accents every bar where it starts', () => {
      expect(M.beatGrid(M.effectiveGrid(long, changing)).map((b) => b.inBar)).toEqual(changing.inBar)
    })

    it('moves every downbeat with the downbeat override', () => {
      expect(M.beatGrid(M.effectiveGrid({ ...long, downbeat: 1 }, changing)).map((b) => b.inBar)).toEqual([3, 0, 1, 2, 3, 0, 1, 0, 1, 2, 3, 0])
    })

    it('lets a meter set by hand win', () => {
      expect(M.beatGrid(M.effectiveGrid({ ...long, beatsPerBar: 3 }, changing)).map((b) => b.inBar)).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2])
    })

    it('halves and doubles bar by bar', () => {
      const half = M.effectiveGrid({ ...long, gridScale: 0.5 }, changing)!
      expect(half.beats).toEqual([0, 2, 4, 6, 8, 10])
      expect(M.beatGrid(half).map((b) => b.inBar)).toEqual([0, 1, 0, 0, 1, 0])
      const dbl = M.effectiveGrid({ ...long, gridScale: 2 }, changing)!
      expect(M.beatGrid(dbl).slice(6, 14).map((b) => b.inBar)).toEqual([6, 7, 0, 1, 2, 3, 0, 1])
    })

    it('counts the bars evenly when the song is set to even bars', () => {
      // Bars start on beats 0 and 4, then (after a short bar) 6, 10 and 14: even bars follow the majority
      const grid = { beats: Array.from({ length: 16 }, (_, i) => i), beatsPerBar: 4, downbeatIndex: 0, inBar: [0, 1, 2, 3, 0, 1, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1] }
      const g = M.effectiveGrid({ ...long, durationSec: 16, evenBars: true }, grid)!
      expect(g.inBar).toBeUndefined()
      expect(M.beatGrid(g).map((b) => b.inBar)).toEqual([2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1])
      // and the bar start can still be nudged by hand
      expect(M.beatGrid(M.effectiveGrid({ ...long, durationSec: 16, evenBars: true, downbeat: 1 }, grid)!)[3].inBar).toBe(0)
    })

    it('numbers the bars by their bar lines', () => {
      expect(M.barNumbers(changing)).toEqual([1, 1, 1, 1, 2, 2, 3, 3, 3, 3, 4, 4])
      expect(M.positionOf(changing, 7)).toEqual({ bar: 3, beat: 2 })
    })
  })

  it('is empty without any tempo information', () => {
    expect(M.effectiveGrid(song, null)).toBeNull()
    expect(M.beatGrid(null)).toEqual([])
  })
})

describe('tap tempo', () => {
  it('needs three taps and ignores taps after a pause', () => {
    expect(M.tapTempo([0, 0.5])).toBeNull()
    expect(M.tapTempo([0, 0.5, 1.0, 1.5])).toBe(120)
    expect(M.tapTempo([0, 0.5, 10, 10.6, 11.2])).toBe(100)
  })

  it('finds the beat phase from taps made during playback', () => {
    // 100 BPM grid with beats at 0.3 + k*0.6, tapped with small jitter
    const taps = [3.31, 3.89, 4.52, 5.1, 5.69]
    expect(M.tapOffset(taps, 100)).toBeCloseTo(0.3, 1)
  })
})

describe('speed', () => {
  it('moves in 1% steps', () => {
    expect(P.clampSpeed(0.75 + 0.01)).toBe(0.76)
    expect(P.SPEED_STEP).toBe(0.01)
  })

  it('trainer raises speed by one step up to the target', () => {
    const t = { enabled: true, step: 0.02, everyLoops: 2, target: 0.8 }
    expect(M.trainerNext(0.7, t)).toBe(0.72)
    expect(M.trainerNext(0.79, t)).toBe(0.8)
    expect(M.trainerNext(0.8, t)).toBe(0.8)
    expect(P.normalizeTrainer({ enabled: true, step: 0.5, everyLoops: 0, target: 3 })).toEqual({ enabled: true, step: 0.1, everyLoops: 1, target: P.SPEED_MAX })
  })
})

describe('new song settings in projects', () => {
  it('defaults and persists pitch, tempo, trainer and metronome', () => {
    let p = P.addSongs(P.createProject('x'), [
      P.makeSong({ title: 'a', artist: null, durationSec: 100, source: { path: '/a', hash: 'a', sizeBytes: 1, format: 'mp3', codec: null, sampleRate: null, channels: null, missing: false } })
    ])
    const id = p.songs[0].id
    expect(p.songs[0].pitch).toEqual({ semitones: 0, cents: 0 })
    p = P.updateSong(p, id, { pitch: { semitones: -2, cents: 23 }, tempo: { bpm: 92.345, offset: 0.4 }, beatsPerBar: 3, downbeat: 4 })
    p = P.updateMetronome(p, { enabled: true, countInBars: 9 })
    const back = P.parseProject(P.serializeProject(p))
    expect(back.songs[0]).toMatchObject({ pitch: { semitones: -2, cents: 23 }, tempo: { bpm: 92.35, offset: 0.4 } })
    expect(back.metronome).toMatchObject({ enabled: true, countInBars: 2 })
  })

  it('migrates project files written before these settings existed', () => {
    const p = P.addSongs(P.createProject('old'), [
      P.makeSong({ title: 'a', artist: null, durationSec: 100, source: { path: '/a', hash: 'a', sizeBytes: 1, format: 'mp3', codec: null, sampleRate: null, channels: null, missing: false } })
    ])
    const raw = JSON.parse(P.serializeProject(p))
    for (const k of ['pitch', 'tempo', 'beatsPerBar', 'downbeat', 'trainer', 'analysis']) delete raw.songs[0][k]
    delete raw.metronome
    const back = P.parseProject(JSON.stringify(raw))
    expect(back.songs[0]).toMatchObject({ pitch: { semitones: 0, cents: 0 }, tempo: null, beatsPerBar: null, analysis: { status: 'pending' } })
    expect(back.metronome).toEqual(P.DEFAULT_METRONOME)
  })
})

describe('localBpm', () => {
  // 100 BPM for 32 beats, then 120 BPM for 32 beats.
  const beats: number[] = []
  let t = 0
  for (let i = 0; i < 32; i++) beats.push((t += 0.6))
  for (let i = 0; i < 32; i++) beats.push((t += 0.5))

  it('follows the tempo at the playhead', () => {
    expect(M.localBpm(beats, 5)).toBeCloseTo(100, 5)
    expect(M.localBpm(beats, beats[50])).toBeCloseTo(120, 5)
  })
  it('handles the edges and short grids', () => {
    expect(M.localBpm(beats, 0.3)).toBeCloseTo(100, 5) // within a beat of the grid
    expect(M.localBpm(beats, beats.at(-1)! + 0.2)).toBeCloseTo(120, 5)
    expect(M.localBpm(beats, -3)).toBeNull() // no grid this far before or after it
    expect(M.localBpm(beats, 1e6)).toBeNull()
    expect(M.localBpm([1, 1.5], 1.2)).toBeCloseTo(120, 5)
    expect(M.localBpm([1], 1)).toBeNull()
  })

  it('has no tempo inside a gap, and doesn’t average across one', () => {
    const gapped = [...beats.slice(0, 20), ...beats.slice(20).map((b) => b + 15)] // 15 s without beats after beat 19
    expect(M.localBpm(gapped, beats[19] + 5)).toBeNull()
    expect(M.localBpm(gapped, beats[19] - 0.1)).toBeCloseTo(100, 5)
    expect(M.localBpm(gapped, beats[21] + 15)).toBeCloseTo(100, 5)
  })

  it('doubles a grid without filling its gaps', () => {
    const g = { beats: [0, 1, 2, 3, 13, 14, 15], beatsPerBar: 4, downbeatIndex: 0 }
    const dbl = M.scaleGrid(g, 2)
    expect(dbl.beats).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 13, 13.5, 14, 14.5, 15])
    // The bars after the gap stay where they were: beat 13 was the 1 of a bar (index 4 in 4/4)
    expect(M.beatGrid(dbl)[7].inBar).toBe(0)
  })
})

describe('playback copies', async () => {
  const { wantsProxy, needsProxy } = await import('../src/main/media')
  it('makes FLAC copies of lossy originals so they seek like the stems', () => {
    expect(['a.mp3', 'b.m4a', 'c.ogg', 'd.aiff'].every(wantsProxy)).toBe(true)
    expect(['a.flac', 'b.WAV'].some(wantsProxy)).toBe(false)
    expect(needsProxy('a.mp3')).toBe(false) // still playable while the copy is made
  })
})
