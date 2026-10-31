import { describe, expect, it } from 'vitest'
import { barBeatAt, regularizeBeats } from '../src/shared/beats'

// Deterministic pseudo-random jitter.
function jitter(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296 - 0.5
  }
}

const steady = (bpm: number, start: number, n: number, jitterMs = 0, seed = 1) => {
  const r = jitter(seed)
  return Array.from({ length: n }, (_, i) => start + (i * 60) / bpm + (r() * 2 * jitterMs) / 1000)
}

describe('regularizeBeats', () => {
  it('straightens a jittery but steady song onto a perfect grid', () => {
    const raw = steady(120, 0.3, 200, 8)
    const g = regularizeBeats(raw, [], 105)!
    expect(g.steady).toBe(true)
    expect(g.bpm).toBeCloseTo(120, 0)
    const iv = g.beats.slice(1).map((t, i) => t - g.beats[i])
    expect(Math.max(...iv) - Math.min(...iv)).toBeLessThan(1e-6) // perfectly even
    expect(Math.abs(g.beats.find((t) => t > 0.2)! - 0.3)).toBeLessThan(0.005) // phase kept
  })

  it('fills a short stop with no detected beats', () => {
    const raw = [...steady(100, 1, 40), ...steady(100, 1 + 46 * 0.6, 40)] // beats 40..45 missing (3.6 s)
    const g = regularizeBeats(raw, [], 52)!
    const inGap = g.beats.filter((t) => t > 1 + 39.5 * 0.6 && t < 1 + 45.5 * 0.6)
    expect(inGap.length).toBe(6)
  })

  it('leaves a long stretch without beats (talk, silence) without a grid', () => {
    const raw = [...steady(100, 1, 40), ...steady(100, 1 + 60 * 0.6, 40)] // beats 40..59 missing (12 s)
    const g = regularizeBeats(raw, [], 50)!
    const inGap = g.beats.filter((t) => t > 1 + 39.5 * 0.6 && t < 1 + 59.5 * 0.6)
    expect(inGap.length).toBe(0)
    // Both stretches keep their beats where they were
    expect(Math.min(...g.beats.map((b) => Math.abs(b - (1 + 39 * 0.6))))).toBeLessThan(0.002)
    expect(Math.min(...g.beats.map((b) => Math.abs(b - (1 + 60 * 0.6))))).toBeLessThan(0.002)
  })

  it('drops spurious extra beats', () => {
    const raw = steady(90, 0.5, 60)
    raw.splice(10, 0, raw[9] + 0.05) // a double trigger
    const g = regularizeBeats(raw, [], 45)!
    const iv = g.beats.slice(1).map((t, i) => t - g.beats[i])
    expect(Math.min(...iv)).toBeGreaterThan(0.6)
  })

  it('follows a tempo change instead of forcing one tempo', () => {
    const a = steady(100, 0, 60)
    const b = steady(120, a[a.length - 1] + 0.5, 60)
    const g = regularizeBeats([...a, ...b], [], 70)!
    expect(g.steady).toBe(false)
    const early = g.beats[20] - g.beats[19]
    const late = g.beats[g.beats.length - 20] - g.beats[g.beats.length - 21]
    expect(early).toBeCloseTo(0.6, 2)
    expect(late).toBeCloseTo(0.5, 2)
  })

  it('stays on the beats right through a sudden tempo change', () => {
    const a = steady(100, 0.4, 48, 6, 2)
    const b = steady(130, 0.4 + 48 * 0.6, 48, 6, 3)
    const truth = [...steady(100, 0.4, 48), ...steady(130, 0.4 + 48 * 0.6, 48)]
    const g = regularizeBeats([...a, ...b], [], 55)!
    // The beats either side of the change, where a smoothing window would be furthest off.
    for (let i = 44; i < 52; i++) {
      const nearest = Math.min(...g.beats.map((t) => Math.abs(t - truth[i])))
      expect(nearest).toBeLessThan(0.012)
    }
  })

  it('follows a gradual slow-down', () => {
    // 120 bpm easing to 90 over 32 beats, then holding
    const truth: number[] = [1]
    for (let i = 1; i < 96; i++) truth.push(truth[i - 1] + 60 / (i < 32 ? 120 : i < 64 ? 120 - (30 * (i - 32)) / 32 : 90))
    const r = jitter(4)
    const g = regularizeBeats(truth.map((t) => t + r() * 0.012), [], truth[95] + 1)!
    const errors = truth.map((t) => Math.min(...g.beats.map((b) => Math.abs(b - t))))
    // Under 25 ms a click doesn't flam against the beat (a smoothing window lags ~70 ms here).
    expect(Math.max(...errors)).toBeLessThan(0.025)
  })

  it('keeps each tempo perfectly even, with jitter, around a change', () => {
    const raw = [...steady(110, 0.2, 64, 8, 5), ...steady(92, 0.2 + 64 * (60 / 110), 64, 8, 6)]
    const g = regularizeBeats(raw, [], 80)!
    const iv = (lo: number, hi: number) => g.beats.slice(lo + 1, hi).map((t, i) => t - g.beats[lo + i])
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs)
    const first = g.beats.findIndex((t) => t >= raw[0] - 0.01)
    expect(spread(iv(first + 2, first + 60))).toBeLessThan(1e-6)
    expect(spread(iv(first + 68, first + 124))).toBeLessThan(1e-6)
  })

  it('extends the grid to the start and end of the song when the music is close to them', () => {
    const g = regularizeBeats(steady(120, 3, 40), [], 25)!
    expect(g.beats[0]).toBeLessThan(0.5)
    expect(g.beats[g.beats.length - 1]).toBeGreaterThan(24.5)
  })

  it('leaves a spoken intro and a long ending without a grid', () => {
    const g = regularizeBeats(steady(120, 20, 40), [], 60)! // music from 20 s to 39.5 s
    expect(g.beats[0]).toBeGreaterThan(19.4) // at most one beat before the music
    expect(g.beats[g.beats.length - 1]).toBeLessThan(40.1)
  })

  it('finds meter and downbeat phase from downbeats', () => {
    const raw = steady(120, 0.25, 64)
    // Bars start on the 3rd tracked beat; waltz-like 3/4 in the second test
    const downs = raw.filter((_, i) => i % 4 === 2)
    const g = regularizeBeats(raw, downs, 33)!
    expect(g.beatsPerBar).toBe(4)
    expect(barBeatAt(raw[2] + 0.01, g)).toMatchObject({ beat: 1 })
    expect(barBeatAt(raw[6] + 0.01, g)).toMatchObject({ beat: 1 })
    expect(barBeatAt(raw[7] + 0.01, g)).toMatchObject({ beat: 2 })

    const w = regularizeBeats(raw, raw.filter((_, i) => i % 3 === 0), 33)!
    expect(w.beatsPerBar).toBe(3)
  })

  it('moves the bar lines after a 2/4 bar', () => {
    // 4/4, then one bar of two beats at beat 40, then 4/4 again
    const raw = steady(120, 0.25, 96)
    const downs = raw.filter((_, i) => (i < 40 ? i % 4 === 0 : i === 40 || (i >= 42 && (i - 42) % 4 === 0)))
    const g = regularizeBeats(raw, downs, 49)!
    expect(g.beatsPerBar).toBe(4)
    const bar = (i: number) => barBeatAt(raw[i] + 0.01, g)!
    expect(bar(36)).toMatchObject({ beat: 1 })
    expect(bar(40)).toMatchObject({ beat: 1 })
    expect(bar(41)).toMatchObject({ beat: 2 })
    expect(bar(42)).toMatchObject({ beat: 1, bar: bar(40).bar + 1 })
    for (let i = 42; i < 96; i += 4) expect(bar(i)).toMatchObject({ beat: 1 })
  })

  it('moves the bar lines after a beat the tracker lost', () => {
    // From beat 50 on, every downbeat comes one beat earlier than the bars before it would say
    const raw = steady(100, 0.4, 100)
    const downs = raw.filter((_, i) => (i < 50 ? i % 4 === 0 : (i - 51) % 4 === 0))
    const g = regularizeBeats(raw, downs, 62)!
    for (let i = 51; i < 100; i += 4) expect(barBeatAt(raw[i] + 0.01, g)).toMatchObject({ beat: 1 })
    for (let i = 0; i < 48; i += 4) expect(barBeatAt(raw[i] + 0.01, g)).toMatchObject({ beat: 1 })
  })

  it('keeps counting through a half-bar flip the tracker makes when unsure', () => {
    // Downbeats on the 1, then a stretch every two beats, then the tracker settles on the 3
    const raw = steady(110, 0.3, 120)
    const downs = raw.filter((_, i) => (i < 40 && i % 4 === 0) || (i >= 40 && i < 52 && i % 2 === 0) || (i >= 52 && i % 4 === 2))
    const g = regularizeBeats(raw, downs, 66)!
    for (let i = 0; i < 120; i += 4) expect(barBeatAt(raw[i] + 0.01, g)).toMatchObject({ beat: 1 })
  })

  it('puts a confirmed shift in as a short bar', () => {
    // 4/4, then the bars move by two beats with clear downbeats: one bar of two, then 4/4
    const raw = steady(120, 0.25, 100)
    const downs = raw.filter((_, i) => (i <= 40 && i % 4 === 0) || (i > 40 && (i - 42) % 4 === 0 && i >= 46))
    const g = regularizeBeats(raw, downs, 51)!
    expect(barBeatAt(raw[40] + 0.01, g)).toMatchObject({ beat: 1 })
    expect(barBeatAt(raw[42] + 0.01, g)).toMatchObject({ beat: 1, bar: barBeatAt(raw[40] + 0.01, g)!.bar + 1 })
    for (let i = 46; i < 100; i += 4) expect(barBeatAt(raw[i] + 0.01, g)).toMatchObject({ beat: 1 })
  })

  it('ignores a single stray downbeat', () => {
    const raw = steady(120, 0.25, 64)
    const downs = raw.filter((_, i) => i % 4 === 0 || i === 30)
    const g = regularizeBeats(raw, downs, 33)!
    expect(g.inBar).toBeUndefined() // the bars stay regular: one stray downbeat isn't a reason to move them
    expect(barBeatAt(raw[32] + 0.01, g)).toMatchObject({ beat: 1 })
  })

  it('keeps 4/4 when the tracker hears a downbeat every two beats for a while', () => {
    const raw = steady(110, 0.3, 96)
    const downs = raw.filter((_, i) => i % 4 === 0 || (i > 40 && i < 70 && i % 2 === 0))
    const g = regularizeBeats(raw, downs, 54)!
    for (let i = 0; i < 96; i += 4) expect(barBeatAt(raw[i] + 0.01, g)).toMatchObject({ beat: 1 })
    expect(barBeatAt(raw[50] + 0.01, g)).toMatchObject({ beat: 3 })
  })

  it('goes back to the song’s bars where downbeats stop backing another meter', () => {
    // 4/4 with downbeats, a short run of 3-beat bars, then a long stretch with no downbeats at all
    const raw = steady(120, 0.25, 120)
    const downs = raw.filter((_, i) => (i < 40 && i % 4 === 0) || i === 40 || i === 43 || i === 46 || i === 49)
    const g = regularizeBeats(raw, downs, 61)!
    const bars = (from: number, to: number) => g.beats.map((_, i) => i).filter((i) => i >= from && i < to && barBeatAt(g.beats[i] + 0.01, g)!.beat === 1)
    const gaps = (xs: number[]) => xs.slice(1).map((x, k) => x - xs[k])
    expect(gaps(bars(70, 120)).every((d) => d === 4)).toBe(true) // regular 4/4 again, not 3/4 to the end
  })

  it('ignores downbeats that fall between the grid’s beats', () => {
    const raw = steady(100, 0.4, 80)
    // Regular downbeats every 4 beats, plus off-beat ones half a beat late from beat 40 on
    const downs = [...raw.filter((_, i) => i % 4 === 0), ...raw.filter((_, i) => i >= 40 && i % 4 === 1).map((t) => t - 0.3)].sort((a, b) => a - b)
    const g = regularizeBeats(raw, downs, 50)!
    for (let i = 0; i < 80; i += 4) expect(barBeatAt(raw[i] + 0.01, g)).toMatchObject({ beat: 1 })
  })

  it('rejects nonsense input', () => {
    expect(regularizeBeats([1, 2], [], 10)).toBeNull()
    expect(regularizeBeats([0, 0.01, 0.02, 0.03, 0.04], [], 10)).toBeNull()
  })
})

describe('barBeatAt', () => {
  it('counts bars from the first downbeat', () => {
    const grid = { beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4], beatsPerBar: 4, downbeatIndex: 1 }
    expect(barBeatAt(0.6, grid)).toMatchObject({ bar: 1, beat: 1 })
    expect(barBeatAt(2.6, grid)).toMatchObject({ bar: 2, beat: 1 })
    expect(barBeatAt(2.75, grid)!.frac).toBeCloseTo(0.5)
    expect(barBeatAt(0.1, grid)).toMatchObject({ bar: 0, beat: 4 })
  })

  it('counts a playhead a hair before a beat as on it', () => {
    const grid = { beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4], beatsPerBar: 4, downbeatIndex: 0 }
    expect(barBeatAt(2 - 0.000003, grid)).toMatchObject({ bar: 2, beat: 1 })
    expect(barBeatAt(2 - 0.01, grid)).toMatchObject({ bar: 1, beat: 4 })
  })

  it('follows bars of different lengths', () => {
    const grid = { beats: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], beatsPerBar: 4, downbeatIndex: 0, inBar: [0, 1, 2, 3, 0, 1, 0, 1, 2, 3] }
    expect(barBeatAt(5.5, grid)).toMatchObject({ bar: 2, beat: 2 })
    expect(barBeatAt(6.5, grid)).toMatchObject({ bar: 3, beat: 1 })
    expect(barBeatAt(8.5, grid)).toMatchObject({ bar: 3, beat: 3 })
  })
})
