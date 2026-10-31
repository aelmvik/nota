// Turns raw tracker output (beats + downbeats) into a stable beat grid.
//
// Raw beats wobble by a few milliseconds, miss beats in breakdowns and
// occasionally add a spurious one. A click that follows them literally
// sounds like it drifts. Here we:
//   1. drop beats that are far too close together,
//   2. fill short gaps (a stop, a missed beat) with evenly spaced beats; a
//      long stretch without beats (talk, silence, a free intro) gets none,
//   3. split the song into sections where the tempo really changes and fit
//      each with a constant tempo, or a steadily changing one (a ritardando),
//      so the click is perfectly even within a section and switches at once
//      where the band does (a smoothing window instead would drift ahead of
//      or behind the beats for several beats around every change),
//   4. extend the grid to the start and end of the song, unless the music
//      starts late or ends early (talk, applause, silence),
//   5. infer the meter from the downbeats, and where each bar starts: where
//      the downbeats clearly and consistently say so (a short bar, a beat the
//      tracker gained or lost, a medley's 3/4 section), the bar lines move from
//      there on; where the tracker is unsure (downbeats every half bar), they
//      keep counting.

import { positionOf, type GridLike } from './music'

export interface BeatGrid {
  beats: number[]
  /** The song's meter (most bars) */
  beatsPerBar: number
  /** Index into `beats` of the first downbeat (bar line) */
  downbeatIndex: number
  /** Position of each beat in its bar (0 = downbeat): only when bars change length or phase mid-song */
  inBar?: number[]
  bpm: number
  /** True when the whole song fits one constant tempo */
  steady: boolean
}

/** A stretch without beats up to this long is filled (or the grid extended over it)… */
const FILL_SECONDS = 4
/** …or up to this many beats (two bars of 4/4); longer ones are left without a grid */
const FILL_BEATS = 8
/** The tracker's beat jitter, seconds: the least assumed (a song's own is measured) */
const JITTER = 0.012
/** Price of a new section, in squared jitters: tempo changes smaller than the jitter aren't worth one */
const SECTION_COST = 45
/** Extra price for a section whose tempo changes steadily rather than staying constant */
const CURVE_COST = 12
/** Shortest section, and the longest one with a changing tempo (longer changes take several), in beats */
const MIN_SECTION = 4
const MAX_CURVE = 64
// Bar lines (in the same made-up units): what each disagreement with the tracker costs
/** A tracker downbeat on a beat that doesn't start a bar */
const MISSED_DOWNBEAT = 1
/** A bar line where the tracker heard no downbeat */
const EXTRA_DOWNBEAT = 1
/** A bar cut short or stretched: a 2/4 bar, a pickup, a beat gained or lost */
const PHASE_JUMP = 4
/** Bars changing to another length for a while (a medley's 3/4 section) */
const METER_CHANGE = 6
/** Every bar spent in another meter, so the bars go back to the song's own where the downbeats stop backing it */
const OTHER_METER_BAR = 0.75
/** Downbeats that must confirm a shift of the bar lines (a beat lost or gained)… */
const CONFIRM_SHIFT = 3
/** …or a shift by half a bar, the tracker's most common mistake */
const CONFIRM_HALF_SHIFT = 6
/** Bars around a half-bar shift in which half-bar downbeats mean the tracker was unsure which half is the 1… */
const UNSURE_BARS = 4
/** …unless this many downbeats confirmed the new bars before the tracker wavered */
const CLEAR_BEFORE_UNSURE = 2

function median(xs: number[]): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

interface Section {
  degree: 1 | 2
  fitted: number[]
}

/** Determinant of a 3×3 matrix given row by row. */
function det3(m: number[]): number {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
}

/**
 * Least squares fit of a line (degree 1) or parabola (degree 2) through
 * `ys` over x = 0, 1, 2…, from the sums of x^k and x^k·y (k ≤ 2). Returns
 * the coefficients (a + b·x + c·x²) and the squared misfit.
 */
function solveFit(n: number, sx: number[], sxy: number[], syy: number, degree: 1 | 2) {
  if (degree === 1) {
    const b = (n * sxy[1] - sx[1] * sxy[0]) / (n * sx[2] - sx[1] * sx[1])
    const a = (sxy[0] - b * sx[1]) / n
    return { a, b, c: 0, sse: Math.max(0, syy - a * sxy[0] - b * sxy[1]) }
  }
  const m = [n, sx[1], sx[2], sx[1], sx[2], sx[3], sx[2], sx[3], sx[4]]
  const d = det3(m)
  const withColumn = (k: number) => m.map((v, i) => (i % 3 === k ? sxy[Math.floor(i / 3)] : v))
  const [a, b, c] = [0, 1, 2].map((k) => det3(withColumn(k)) / d)
  return { a, b, c, sse: Math.max(0, syy - a * sxy[0] - b * sxy[1] - c * sxy[2]) }
}

/** Adds point (x, y) to the running sums of x^k (k ≤ 4) and x^k·y (k ≤ 2). */
function accumulate(sx: number[], sxy: number[], x: number, y: number) {
  const x2 = x * x
  sx[0] += 1
  sx[1] += x
  sx[2] += x2
  sx[3] += x2 * x
  sx[4] += x2 * x2
  sxy[0] += y
  sxy[1] += x * y
  sxy[2] += x2 * y
}

/** The section's beats replaced by its fitted line or parabola. */
function fitSection(ys: number[], degree: 1 | 2): number[] {
  const sx = [0, 0, 0, 0, 0]
  const sxy = [0, 0, 0]
  let syy = 0
  ys.forEach((t, x) => {
    const y = t - ys[0]
    accumulate(sx, sxy, x, y)
    syy += y * y
  })
  const f = solveFit(ys.length, sx, sxy, syy, degree)
  return ys.map((_, x) => ys[0] + f.a + f.b * x + f.c * x * x)
}

/**
 * The best split of the beats into sections (dynamic programming): each
 * section costs its misfit, in squared jitters, plus a fixed price, so the
 * beats are split only where the tempo really changes. A section's fit is
 * kept up to date as it grows, so the whole search is quadratic in beats.
 */
function segment(beats: number[]): Section[] {
  const n = beats.length
  // This song's jitter, from how irregular consecutive beats are (robust
  // spread of the second differences), never below JITTER.
  const wobble = beats.slice(2).map((t, i) => Math.abs(t - 2 * beats[i + 1] + beats[i]))
  const jitter = Math.max(JITTER, (1.4826 * median(wobble)) / Math.sqrt(6))
  const unit = jitter * jitter
  const best = new Float64Array(n + 1).fill(Infinity)
  const from = new Int32Array(n + 1)
  const degreeOf = new Uint8Array(n + 1)
  best[0] = 0
  // Every earlier start has been tried by the time a start is reached, so its cost is final.
  for (let start = 0; start < n; start++) {
    const sx = [0, 0, 0, 0, 0]
    const sxy = [0, 0, 0]
    let syy = 0
    for (let end = start + 1; end <= n; end++) {
      const x = end - 1 - start
      const y = beats[end - 1] - beats[start] // small numbers keep the sums precise
      accumulate(sx, sxy, x, y)
      syy += y * y
      const len = end - start
      if (len < MIN_SECTION) continue
      for (const degree of [1, 2] as const) {
        if (degree === 2 && (len < 8 || len > MAX_CURVE)) continue
        const cost = best[start] + solveFit(len, sx, sxy, syy, degree).sse / unit + SECTION_COST + (degree === 2 ? CURVE_COST : 0)
        if (cost < best[end]) {
          best[end] = cost
          from[end] = start
          degreeOf[end] = degree
        }
      }
    }
  }
  const sections: Section[] = []
  for (let end = n; end > 0; end = from[end]) {
    const degree = degreeOf[end] as 1 | 2
    sections.unshift({ degree, fitted: fitSection(beats.slice(from[end], end), degree) })
  }
  return sections
}

/**
 * Where each beat falls in its bar (0 = downbeat), from the tracker's
 * downbeats (indices into the beats). A Viterbi pass over (meter, position)
 * states: each beat moves one position on for free, and disagreeing with the
 * tracker, jumping to another position or changing meter costs something.
 * So the bar lines follow the downbeats through an odd-length bar or a lost
 * beat after a bar or two, but don't chase a stray downbeat.
 */
function barPositions(n: number, downs: number[], meter: number, unsure: number[]): number[] {
  // Another meter is allowed if it isn't half or double the song's: a 4/4 song
  // may have 3/4 bars, but downbeats every two beats in 4/4 are the tracker
  // hearing half bars, not 2/4.
  // It also needs the tracker to show at least three such bars in a row
  // somewhere: a scatter of odd gaps between downbeats is noise, not a section.
  const gaps = downs.slice(1).map((d, k) => d - downs[k])
  const run = (m: number) => gaps.some((_, k) => k + 3 <= gaps.length && gaps.slice(k, k + 3).every((g) => g === m))
  const meters = [meter, 3, 4].filter((m, k, all) => all.indexOf(m) === k && (m === meter || (m % meter !== 0 && meter % m !== 0 && run(m))))
  const states = meters.flatMap((m) => Array.from({ length: m }, (_, p) => ({ m, p })))
  const ahead = states.map(({ m, p }) => states.findIndex((s) => s.m === m && s.p === (p + 1) % m))
  const isDown = new Uint8Array(n)
  for (const i of downs) isDown[i] = 1
  const emit = (i: number, p: number) => (isDown[i] ? (p === 0 ? 0 : MISSED_DOWNBEAT) : p === 0 ? EXTRA_DOWNBEAT : 0)
  const barCost = states.map(({ m, p }) => (p === 0 && m !== meter ? OTHER_METER_BAR : 0))
  let cost = states.map(({ m, p }) => (m === meter ? 0 : METER_CHANGE) + emit(0, p))
  const back: Int8Array[] = []
  for (let i = 1; i < n; i++) {
    const next = new Array<number>(states.length).fill(Infinity)
    const from = new Int8Array(states.length)
    const cheapest = cost.indexOf(Math.min(...cost))
    const offer = (to: number, prev: number, c: number) => {
      if (c < next[to]) {
        next[to] = c
        from[to] = prev
      }
    }
    states.forEach(({ m, p }, s) => {
      offer(ahead[s], s, cost[s]) // the next beat of the bar, or the next bar
      // From a bar's last beat into a bar of another length
      if (p === m - 1) states.forEach((t, k) => t.p === 0 && t.m !== m && offer(k, s, cost[s] + METER_CHANGE))
    })
    // A jump: the bar line comes early or late. Landing on a bar line costs a
    // little less, so a short bar counts 1, 2 rather than 1, 4.
    states.forEach(({ p }, k) => offer(k, cheapest, cost[cheapest] + PHASE_JUMP + (p === 0 ? 0 : 0.25)))
    for (let k = 0; k < states.length; k++) next[k] += emit(i, states[k].p) + barCost[k]
    back.push(from)
    cost = next
  }
  const out = new Array<number>(n)
  const meterOf = new Array<number>(n)
  let s = cost.indexOf(Math.min(...cost))
  for (let i = n - 1; i >= 0; i--) {
    out[i] = states[s].p
    meterOf[i] = states[s].m
    if (i > 0) s = back[i - 1][s]
  }
  return confirmShifts(out, meterOf, downs, meter, unsure)
}

/**
 * The bars may shift within the song's meter only where the downbeats
 * clearly say so. Each shift is checked by its net size (two one-beat shifts
 * close together are one half-bar shift): it needs CONFIRM_SHIFT downbeats on
 * the new bar lines, a half-bar shift CONFIRM_HALF_SHIFT and no sign of the
 * tracker being unsure which half is the 1. Otherwise the bars keep counting.
 * A kept shift starts right after the last downbeat of the old bars, so it
 * reads as one short bar. Stretches in another meter are left as they are.
 */
function confirmShifts(pos: number[], meterOf: number[], downs: number[], meter: number, unsure: number[]): number[] {
  const n = pos.length
  const at = (i: number, phase: number) => (((i - phase) % meter) + meter) % meter
  // Stretches with one meter and one phase (where its bars start)
  const stretches: { start: number; end: number; m: number; phase: number }[] = []
  for (let i = 0; i < n; i++) {
    const m = meterOf[i]
    const phase = (((i - pos[i]) % m) + m) % m
    const last = stretches[stretches.length - 1]
    if (last && last.m === m && last.phase === phase && last.end === i) last.end = i + 1
    else stretches.push({ start: i, end: i + 1, m, phase })
  }
  const out = [...pos]
  let kept: { start: number; phase: number } | null = null // the bars in the song's meter so far
  for (const st of stretches) {
    if (st.m !== meter) {
      kept = null
      continue
    }
    if (!kept) {
      kept = { start: st.start, phase: st.phase }
      continue
    }
    const shift = (((st.phase - kept.phase) % meter) + meter) % meter
    if (shift === 0) continue
    const half = meter % 2 === 0 && shift === meter / 2
    const confirmingAt = downs.filter((d) => d >= st.start && d < st.end && at(d, st.phase) === 0)
    // A half-bar shift right before the tracker starts doubling its downbeats is
    // the tracker losing the 1: the new bars must show clearly before that.
    const firstUnsure = unsure.find((d) => d >= st.start - UNSURE_BARS * meter)
    const clearFirst = firstUnsure === undefined || firstUnsure > st.start + UNSURE_BARS * meter || confirmingAt.filter((d) => d < firstUnsure).length >= CLEAR_BEFORE_UNSURE
    if ((half && !clearFirst) || confirmingAt.length < (half ? CONFIRM_HALF_SHIFT : CONFIRM_SHIFT)) {
      for (let i = st.start; i < st.end; i++) out[i] = at(i, kept.phase)
      continue
    }
    const lastOld = downs.filter((d) => d >= kept!.start && d < st.start && out[d] === 0).pop()
    let from = st.start
    if (lastOld !== undefined) {
      let first = lastOld + 1
      while (at(first, st.phase) !== 0) first++
      from = Math.min(from, first)
    }
    for (let i = from; i < st.end; i++) out[i] = at(i, st.phase)
    kept = { start: from, phase: st.phase }
  }
  return out
}

export function regularizeBeats(raw: number[], downbeats: number[], duration: number): BeatGrid | null {
  let beats = [...raw].filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b)
  if (beats.length < 4) return null
  let period = median(beats.slice(1).map((t, i) => t - beats[i]))
  if (!(period > 0.15 && period < 2.5)) return null

  // 1. Remove beats that come much too soon after the previous one.
  const cleaned = [beats[0]]
  for (const t of beats.slice(1)) if (t - cleaned[cleaned.length - 1] > period * 0.6) cleaned.push(t)
  beats = cleaned

  // 2. Fill short gaps with evenly spaced beats; long ones start a new run of music.
  const fillable = (seconds: number, beatCount: number) => seconds <= FILL_SECONDS || beatCount <= FILL_BEATS
  const runs: number[][] = [[beats[0]]]
  for (let i = 1; i < beats.length; i++) {
    const gap = beats[i] - beats[i - 1]
    const n = Math.round(gap / period)
    const run = runs[runs.length - 1]
    if (n >= 2 && !fillable(gap, n)) runs.push([beats[i]])
    else {
      if (n >= 2) for (let k = 1; k < n; k++) run.push(beats[i - 1] + (gap * k) / n)
      run.push(beats[i])
    }
  }
  const all = runs.flat()
  period = median(all.slice(1).map((t, i) => t - all[i]))

  // 3. Sections of constant or steadily changing tempo, each fitted exactly (never across a gap).
  const fitted = runs.map((run) => (run.length >= MIN_SECTION ? segment(run) : [{ degree: 1 as const, fitted: run }]))
  const steady = runs.length === 1 && fitted[0].length === 1 && fitted[0][0].degree === 1
  const fittedRuns = fitted.map((sections) => sections.flatMap((sec) => sec.fitted))
  beats = fittedRuns.flat()
  if (steady) period = (beats[beats.length - 1] - beats[0]) / (beats.length - 1)

  // 4. Extend to the start and end of the song when the music starts or ends
  // close to them, by at most one beat when it doesn't (a spoken intro gets no clicks).
  const firstRun = fittedRuns[0]
  const lastRun = fittedRuns[fittedRuns.length - 1]
  const firstPeriod = firstRun.length > 1 ? firstRun[1] - firstRun[0] : period
  const lastPeriod = lastRun.length > 1 ? lastRun[lastRun.length - 1] - lastRun[lastRun.length - 2] : period
  const headTo = fillable(beats[0], beats[0] / firstPeriod) ? -1e-6 : beats[0] - firstPeriod - 1e-6
  const tailTo = fillable(duration - beats[beats.length - 1], (duration - beats[beats.length - 1]) / lastPeriod) ? duration + 1e-6 : beats[beats.length - 1] + lastPeriod + 1e-6
  const head: number[] = []
  for (let t = beats[0] - firstPeriod; t >= headTo && t >= -1e-6; t -= firstPeriod) head.unshift(Math.max(0, t))
  const tail: number[] = []
  for (let t = beats[beats.length - 1] + lastPeriod; t <= tailTo && t <= duration + 1e-6; t += lastPeriod) tail.push(t)
  beats = [...head, ...beats, ...tail]

  // 5. Meter and downbeat phase from the tracker's downbeats.
  const nearest = (t: number) => {
    let lo = 0
    let hi = beats.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (beats[mid] < t) lo = mid
      else hi = mid
    }
    return Math.abs(beats[lo] - t) <= Math.abs(beats[hi] - t) ? lo : hi
  }
  // Only downbeats that sit on a beat of the grid count. Where the grid keeps
  // every other of the tracker's beats (a double-time stretch), its downbeats
  // can fall between grid beats, and snapping them to a neighbour is noise.
  const onGrid = (t: number) => {
    const i = nearest(t)
    const step = beats[Math.min(i + 1, beats.length - 1)] - beats[Math.max(i - 1, 0)]
    return Math.abs(beats[i] - t) <= 0.125 * step ? i : -1 // a quarter of a beat (step spans two)
  }
  const valid = downbeats.filter((t) => Number.isFinite(t))
  const dIdx = valid.map(nearest).filter((i, k, a) => k === 0 || i !== a[k - 1]) // for the meter, as the tracker counts it
  const onBeats = valid.map(onGrid).filter((i, k, a) => i >= 0 && (k === 0 || i !== a[k - 1]))
  let beatsPerBar = 4
  if (dIdx.length >= 3) {
    const counts = new Map<number, number>()
    for (let k = 1; k < dIdx.length; k++) {
      const d = dIdx[k] - dIdx[k - 1]
      if (d >= 2 && d <= 7) counts.set(d, (counts.get(d) ?? 0) + 1)
    }
    let best = 0
    for (const [d, c] of counts) if (c > best) [beatsPerBar, best] = [d, c]
  }
  let downbeatIndex = 0
  let inBar: number[] | undefined
  // Three or more downbeats in a row half a bar apart are the tracker unsure
  // which half is the 1: no evidence either way. (One such pair is just a short bar.)
  const half = beatsPerBar % 2 === 0 ? beatsPerBar / 2 : 0
  const onSet = new Set(onBeats)
  const inHalfRun = (i: number) => [-2, -1, 0].some((k) => onSet.has(i + k * half) && onSet.has(i + (k + 1) * half) && onSet.has(i + (k + 2) * half))
  const unsure = half ? onBeats.filter(inHalfRun) : []
  const sure = onBeats.filter((i) => !unsure.includes(i))
  if (sure.length >= 2) {
    const positions = barPositions(beats.length, sure, beatsPerBar, unsure)
    downbeatIndex = Math.max(0, positions.indexOf(0))
    // Kept only when the bars really do change somewhere, so a regular song's grid stays simple.
    if (positions.some((p, i) => p !== (((i - downbeatIndex) % beatsPerBar) + beatsPerBar) % beatsPerBar)) inBar = positions
  } else if (dIdx.length) downbeatIndex = (((onBeats[0] ?? dIdx[0]) % beatsPerBar) + beatsPerBar) % beatsPerBar

  return { beats, beatsPerBar, downbeatIndex, ...(inBar ? { inBar } : {}), bpm: Math.round((60 / period) * 100) / 100, steady }
}

/** Position within the grid: bar (1-based, may be ≤ 0 before the first bar), beat (1-based) and fraction. */
export function barBeatAt(time: number, grid: GridLike): { bar: number; beat: number; frac: number } | null {
  const b = grid.beats
  if (b.length < 2) return null
  // The playhead lands on whole audio samples, a few microseconds off a beat it
  // was put on: a hair before a beat counts as on it, as the waveform shows it.
  const t = time + 0.001
  let lo = 0
  let hi = b.length - 1
  if (t <= b[0]) lo = 0
  else if (t >= b[hi]) lo = hi - 1
  else
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (b[mid] <= t) lo = mid
      else hi = mid
    }
  const span = b[lo + 1] - b[lo]
  const frac = Math.max(0, Math.min(0.999, (t - b[lo]) / span))
  return { ...positionOf(grid, lo), frac }
}
