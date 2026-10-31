// Practice cuts: parts of a song that playback skips (the engine jumps over
// them) and that the waveform and Notes view leave out, as if the song were
// shorter. Nothing is deleted; cuts can be restored at any time.
//
// Two timelines: song time (the recording) and display time (the song with
// the cuts removed). CutMap converts between them.

import { barNumbers, inBarOf, type GridLike } from './music'

export interface Region {
  start: number
  end: number
}

const MIN_CUT = 0.01

/** Sorted, merged regions inside [0, duration], dropping slivers. */
export function normalizeCuts(cuts: Region[] | null | undefined, duration: number): Region[] {
  const max = duration > 0 ? duration : Infinity
  const sorted = (cuts ?? [])
    .filter((c) => Number.isFinite(c?.start) && Number.isFinite(c?.end))
    .map((c) => ({ start: Math.max(0, Math.min(c.start, c.end)), end: Math.min(max, Math.max(c.start, c.end)) }))
    .filter((c) => c.end - c.start >= MIN_CUT)
    .sort((a, b) => a.start - b.start)
  const out: Region[] = []
  for (const c of sorted) {
    const last = out[out.length - 1]
    if (last && c.start <= last.end) last.end = Math.max(last.end, c.end)
    else out.push({ ...c })
  }
  return out
}

export class CutMap {
  readonly cuts: Region[]
  /** Length of the song with the cuts removed */
  readonly kept: number

  constructor(cuts: Region[] | null | undefined, readonly duration: number) {
    this.cuts = normalizeCuts(cuts, duration)
    this.kept = Math.max(0, duration - this.cuts.reduce((s, c) => s + c.end - c.start, 0))
  }

  get empty() {
    return this.cuts.length === 0
  }

  /** Song time → display time. A time inside a cut lands where the cut was. */
  toDisplay(t: number): number {
    let removed = 0
    for (const c of this.cuts) {
      if (t >= c.end) removed += c.end - c.start
      else if (t > c.start) return c.start - removed
      else break
    }
    return t - removed
  }

  /**
   * Display time → song time. At the point where a cut was, 'after' gives the
   * end of the cut (where playback continues) and 'before' its start (the end
   * of a region that stops there).
   */
  toSong(d: number, edge: 'after' | 'before' = 'after'): number {
    let t = d
    for (const c of this.cuts) {
      if (edge === 'after' ? t >= c.start : t > c.start) t += c.end - c.start
      else break
    }
    return t
  }

  /** Display times where cuts are (for markers). */
  marks(): number[] {
    return this.cuts.map((c) => this.toDisplay(c.start))
  }

  isCut(t: number): boolean {
    return this.cuts.some((c) => t >= c.start && t < c.end)
  }
}

/** A grid in display time: beats inside cuts are left out, and `barOf` keeps the song's bar numbers. */
export function cutGrid(grid: GridLike, map: CutMap): GridLike {
  if (map.empty) return grid
  const bars = barNumbers(grid)
  const beats: number[] = []
  const inBar: number[] = []
  const barOf: (number | null)[] = []
  grid.beats.forEach((t, i) => {
    if (map.isCut(t)) return
    const p = inBarOf(grid, i)
    beats.push(map.toDisplay(t))
    inBar.push(p)
    barOf.push(p === 0 ? bars[i] : null)
  })
  return { ...grid, beats, barOf, ...(grid.inBar ? { inBar } : {}) }
}

/** True if beat `i` of a grid is a bar line. */
export function isBarLine(grid: GridLike, i: number): boolean {
  if (grid.barOf) return grid.barOf[i] !== null
  return inBarOf(grid, i) === 0
}

/** A loop or region in display time; null if it lies entirely inside cuts. */
export function cutRegion<T extends Region>(r: T, map: CutMap): T | null {
  if (map.empty) return r
  const start = map.toDisplay(r.start)
  const end = map.toDisplay(r.end)
  return end - start > MIN_CUT ? { ...r, start, end } : null
}
