import type { PitchSettings, Song, SpeedTrainer, TempoGrid } from './types'

// Pure music helpers: pitch ratios, key names, beat grids, tap tempo and the
// speed trainer. Shared by the renderer and tests.

export const SEMITONE_RANGE = 12
export const CENTS_RANGE = 50
export const BPM_MIN = 30
export const BPM_MAX = 300

export function clampPitch(p: PitchSettings): PitchSettings {
  const semis = Math.round(Math.max(-SEMITONE_RANGE, Math.min(SEMITONE_RANGE, p.semitones || 0)))
  const cents = Math.round(Math.max(-CENTS_RANGE, Math.min(CENTS_RANGE, p.cents || 0)))
  return { semitones: semis, cents }
}

export function pitchRatio(p: PitchSettings): number {
  return Math.pow(2, (p.semitones + p.cents / 100) / 12)
}

export function isPitchNeutral(p: PitchSettings): boolean {
  return p.semitones === 0 && p.cents === 0
}

/** Cents to apply so a recording that is `tuningCents` off lands on A440. */
export function tuningCorrection(tuningCents: number): number {
  return Math.round(Math.max(-CENTS_RANGE, Math.min(CENTS_RANGE, -tuningCents)))
}

const SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B']
const ALIASES: Record<string, number> = {
  C: 0, 'C♯': 1, 'D♭': 1, D: 2, 'D♯': 3, 'E♭': 3, E: 4, F: 5, 'F♯': 6, 'G♭': 6,
  G: 7, 'G♯': 8, 'A♭': 8, A: 9, 'A♯': 10, 'B♭': 10, B: 11
}
// Keys conventionally written with flats.
const FLAT_MAJOR = new Set([1, 3, 5, 8, 10])
const FLAT_MINOR = new Set([0, 2, 3, 5, 7, 10])

/** "E minor" transposed by +2 -> "F♯ minor". Returns the input if unparseable. */
export function transposeKey(key: string, semitones: number): string {
  const m = /^([A-G][♯♭#b]?)\s+(major|minor)$/.exec(key.trim())
  if (!m) return key
  const root = ALIASES[m[1].replace('#', '♯').replace(/^([A-G])b$/, '$1♭')]
  if (root === undefined) return key
  const pc = (((root + semitones) % 12) + 12) % 12
  const useFlat = m[2] === 'major' ? FLAT_MAJOR.has(pc) : FLAT_MINOR.has(pc)
  return `${(useFlat ? FLAT : SHARP)[pc]} ${m[2]}`
}

export function formatSemitones(n: number): string {
  if (n === 0) return '0 st'
  return `${n > 0 ? '+' : '−'}${Math.abs(n)} st`
}

export function formatCents(n: number): string {
  if (n === 0) return '0¢'
  return `${n > 0 ? '+' : '−'}${Math.abs(n)}¢`
}

// ---- Beats --------------------------------------------------------------------------

export interface Beat {
  time: number
  /** 0 = downbeat */
  inBar: number
}

export interface GridLike {
  beats: number[]
  /** The song's meter (most bars); bars may differ when `inBar` is set */
  beatsPerBar: number
  /** Index of the first downbeat; with `inBar` absent, every beatsPerBar-th beat from it starts a bar */
  downbeatIndex: number
  /** Position of each beat in its bar (0 = downbeat), set when bars change length or phase mid-song */
  inBar?: number[]
  /** Bar number of each beat that starts a bar, null for other beats (set when cuts leave beats out) */
  barOf?: (number | null)[]
}

/**
 * True if the grid has no beats between beat `i` and the next: a stretch
 * without music (talk, silence) that the regulariser left empty. Such a
 * gap is several times longer than the beats around it.
 */
export function isGridGap(beats: number[], i: number): boolean {
  if (i < 0 || i + 1 >= beats.length) return false
  const span = beats[i + 1] - beats[i]
  const around = [i - 1, i + 1].filter((k) => k >= 0 && k + 1 < beats.length).map((k) => beats[k + 1] - beats[k])
  return around.length > 0 && span > 1.75 * Math.min(...around)
}

/** Position of beat `i` in its bar (0 = downbeat). */
export function inBarOf(grid: GridLike, i: number): number {
  if (grid.inBar && i >= 0 && i < grid.inBar.length) return grid.inBar[i]
  return mod(i - grid.downbeatIndex, grid.beatsPerBar)
}

const barNumberCache = new WeakMap<GridLike, number[]>()

/** Bar number of every beat: 1 for the bar starting at downbeatIndex, counting bar lines (≤ 0 before it). */
export function barNumbers(grid: GridLike): number[] {
  const cached = barNumberCache.get(grid)
  if (cached) return cached
  let out: number[]
  if (!grid.inBar) out = grid.beats.map((_, i) => Math.floor((i - grid.downbeatIndex) / grid.beatsPerBar) + 1)
  else {
    let bar = 0
    out = grid.inBar.map((p) => (p === 0 ? ++bar : bar))
  }
  barNumberCache.set(grid, out)
  return out
}

/** Bar (1-based, ≤ 0 before the first) and beat (1-based) of beat `i`; a cut grid keeps the song's bar numbers. */
export function positionOf(grid: GridLike, i: number): { bar: number; beat: number } {
  if (grid.barOf) {
    let k = i
    while (k >= 0 && grid.barOf[k] == null) k--
    if (k >= 0) return { bar: grid.barOf[k]!, beat: (grid.inBar ? grid.inBar[i] : i - k) + 1 }
    const first = grid.barOf.findIndex((b) => b != null)
    return { bar: first >= 0 ? grid.barOf[first]! - 1 : 0, beat: inBarOf(grid, i) + 1 }
  }
  return { bar: barNumbers(grid)[i], beat: inBarOf(grid, i) + 1 }
}

/** `inBar` with every downbeat moved `shift` beats later; beyond the ends the bars keep `perBar` beats. */
function shiftBars(inBar: number[], shift: number, perBar: number): number[] {
  const n = inBar.length
  return inBar.map((_, i) => {
    const j = i - shift
    if (j < 0) return mod(inBar[0] + j, perBar)
    if (j >= n) return mod(inBar[n - 1] + j - (n - 1), perBar)
    return inBar[j]
  })
}

/**
 * The grid in use: a manual tempo (typed BPM / tap) if set, else the
 * detected, regularised grid, with the user's meter and downbeat overrides.
 */
export function effectiveGrid(
  song: Pick<Song, 'tempo' | 'beatsPerBar' | 'downbeat' | 'durationSec'> & { gridScale?: Song['gridScale']; evenBars?: boolean },
  detected: GridLike | null
): GridLike | null {
  if (detected && !song.tempo && song.gridScale && song.gridScale !== 1) detected = scaleGrid(detected, song.gridScale)
  const perBar = Math.max(1, song.beatsPerBar ?? detected?.beatsPerBar ?? 4)
  if (song.tempo) {
    const period = 60 / song.tempo.bpm
    const first = song.tempo.offset - Math.floor(song.tempo.offset / period) * period
    const beats: number[] = []
    for (let t = first; t <= song.durationSec + 1e-6; t += period) beats.push(t)
    const anchor = Math.round((song.tempo.offset - first) / period)
    return { beats, beatsPerBar: perBar, downbeatIndex: mod(anchor + song.downbeat, perBar) }
  }
  if (!detected || detected.beats.length < 2) return null
  // Even bars: one bar position for the whole song, where most of the detected bars start.
  if (detected.inBar && song.evenBars) detected = evenGrid(detected)
  // Bars that change mid-song follow the detection unless the meter was set by hand.
  if (detected.inBar && song.beatsPerBar == null) {
    const inBar = song.downbeat ? shiftBars(detected.inBar, song.downbeat, perBar) : detected.inBar
    return { beats: detected.beats, beatsPerBar: perBar, downbeatIndex: Math.max(0, inBar.indexOf(0)), inBar }
  }
  return { beats: detected.beats, beatsPerBar: perBar, downbeatIndex: mod(detected.downbeatIndex + song.downbeat, perBar) }
}

/** The grid with evenly counted bars, starting where most of its bars start. */
export function evenGrid(g: GridLike): GridLike {
  const votes = new Array<number>(g.beatsPerBar).fill(0)
  g.beats.forEach((_, i) => {
    if (inBarOf(g, i) === 0) votes[mod(i, g.beatsPerBar)]++
  })
  const { inBar: _drop, ...rest } = g
  return { ...rest, downbeatIndex: votes.indexOf(Math.max(...votes)) }
}

/** Half time keeps every other beat (from a downbeat); double time adds the midpoints. */
export function scaleGrid(g: GridLike, scale: 0.5 | 2): GridLike {
  // Doubling leaves gaps unfilled, which would shift bars counted by index: give them explicit positions.
  if (scale === 2 && !g.inBar && g.beats.some((_, i) => isGridGap(g.beats, i))) g = { ...g, inBar: g.beats.map((_, i) => inBarOf(g, i)) }
  if (g.inBar) {
    const inBar = g.inBar
    if (scale === 0.5) {
      // Every other beat from each bar's downbeat
      const keep = g.beats.map((_, i) => inBar[i] % 2 === 0)
      const halved = inBar.filter((_, i) => keep[i]).map((p) => p / 2)
      return { beats: g.beats.filter((_, i) => keep[i]), beatsPerBar: Math.max(1, Math.round(g.beatsPerBar / 2)), downbeatIndex: Math.max(0, halved.indexOf(0)), inBar: halved }
    }
    const beats: number[] = []
    const doubled: number[] = []
    for (let i = 0; i < g.beats.length; i++) {
      beats.push(g.beats[i])
      doubled.push(inBar[i] * 2)
      if (i + 1 < g.beats.length && !isGridGap(g.beats, i)) {
        beats.push((g.beats[i] + g.beats[i + 1]) / 2)
        doubled.push(inBar[i] * 2 + 1)
      }
    }
    return { beats, beatsPerBar: g.beatsPerBar * 2, downbeatIndex: g.downbeatIndex * 2, inBar: doubled }
  }
  if (scale === 0.5) {
    const phase = g.downbeatIndex % 2
    const beats = g.beats.filter((_, i) => i % 2 === phase)
    return { beats, beatsPerBar: Math.max(1, Math.round(g.beatsPerBar / 2)), downbeatIndex: Math.floor(g.downbeatIndex / 2) }
  }
  const beats: number[] = []
  for (let i = 0; i < g.beats.length; i++) {
    beats.push(g.beats[i])
    if (i + 1 < g.beats.length && !isGridGap(g.beats, i)) beats.push((g.beats[i] + g.beats[i + 1]) / 2)
  }
  return { beats, beatsPerBar: g.beatsPerBar * 2, downbeatIndex: g.downbeatIndex * 2 }
}

function mod(a: number, n: number) {
  return ((a % n) + n) % n
}

/** Beat times with bar positions, for the metronome. */
export function beatGrid(grid: GridLike | null): Beat[] {
  if (!grid) return []
  return grid.beats.map((time, i) => ({ time, inBar: inBarOf(grid, i) }))
}

export function bpmOf(song: Pick<Song, 'tempo' | 'analysis'> & { gridScale?: Song['gridScale'] }): number | null {
  if (song.tempo) return song.tempo.bpm
  return song.analysis.bpm ? song.analysis.bpm * (song.gridScale ?? 1) : null
}

/**
 * Tempo around time `t`, from the beats within about two bars of it (`span`
 * beat intervals), so it follows tempo changes without jittering beat to beat.
 */
export function localBpm(beats: number[], t: number, span = 8): number | null {
  const n = beats.length
  if (n < 2) return null
  let a = 0
  let b = n - 1
  while (a < b) {
    const mid = (a + b + 1) >> 1
    if (beats[mid] <= t) a = mid
    else b = mid - 1
  }
  // No tempo where there's no grid: well before or after it, or inside a gap.
  const edge = (k: number) => beats[k + 1] - beats[k]
  if (t < beats[0] - edge(0) || t > beats[n - 1] + edge(n - 2) || isGridGap(beats, a)) return null
  // The beats around t, within its stretch of music.
  let first = a
  let last = Math.min(a + 1, n - 1)
  while (first > 0 && !isGridGap(beats, first - 1)) first--
  while (last < n - 1 && !isGridGap(beats, last)) last++
  const width = Math.min(span, last - first)
  if (width < 1) return null
  const hi = Math.min(last, Math.max(a - (width >> 1), first) + width)
  const lo = hi - width
  const dur = beats[hi] - beats[lo]
  return dur > 0 ? (60 * width) / dur : null
}

/** BPM from tap times (seconds). Needs at least 3 taps; ignores taps after a long pause. */
export function tapTempo(taps: number[]): number | null {
  if (taps.length < 3) return null
  const recent: number[] = [taps[taps.length - 1]]
  for (let i = taps.length - 2; i >= 0 && recent.length < 9; i--) {
    if (recent[0] - taps[i] > 2.5) break
    recent.unshift(taps[i])
  }
  if (recent.length < 3) return null
  const intervals = recent.slice(1).map((t, i) => t - recent[i]).sort((a, b) => a - b)
  const median = intervals[Math.floor(intervals.length / 2)]
  const bpm = 60 / median
  return bpm >= BPM_MIN && bpm <= BPM_MAX ? Math.round(bpm * 10) / 10 : null
}

/** Grid offset that best fits taps made while the song was playing (song-time positions). */
export function tapOffset(songTimes: number[], bpm: number): number {
  const period = 60 / bpm
  // Circular mean of the tap phases.
  let x = 0
  let y = 0
  for (const t of songTimes) {
    const a = ((t % period) / period) * 2 * Math.PI
    x += Math.cos(a)
    y += Math.sin(a)
  }
  const phase = (Math.atan2(y, x) / (2 * Math.PI) + 1) % 1
  return phase * period
}

// ---- Speed trainer -------------------------------------------------------------------

export const DEFAULT_TRAINER: SpeedTrainer = { enabled: true, step: 0.02, everyLoops: 2, target: 1 }

/** The speed after one trainer step: up by `step`, never past `target`. */
export function trainerNext(speed: number, t: SpeedTrainer): number {
  if (speed >= t.target - 1e-6) return speed
  return Math.round(Math.min(t.target, speed + t.step) * 100) / 100
}

export function tempoFromBpm(bpm: number, offset: number): TempoGrid {
  return { bpm: Math.round(Math.max(BPM_MIN, Math.min(BPM_MAX, bpm)) * 100) / 100, offset: Math.max(0, offset) }
}
