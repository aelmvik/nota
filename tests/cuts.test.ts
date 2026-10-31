import { describe, expect, it } from 'vitest'
import { CutMap, cutGrid, cutRegion, isBarLine, normalizeCuts } from '../src/shared/cuts'

describe('practice cuts', () => {
  it('sorts, merges and clamps cuts', () => {
    expect(normalizeCuts([{ start: 50, end: 40 }, { start: 10, end: 20 }, { start: 15, end: 25 }, { start: 95, end: 200 }, { start: 5, end: 5.001 }], 100)).toEqual([
      { start: 10, end: 25 },
      { start: 40, end: 50 },
      { start: 95, end: 100 }
    ])
  })

  it('maps song time to display time and back', () => {
    const m = new CutMap([{ start: 10, end: 20 }, { start: 30, end: 35 }], 60)
    expect(m.kept).toBe(45)
    expect(m.toDisplay(5)).toBe(5)
    expect(m.toDisplay(15)).toBe(10) // inside a cut: where the cut was
    expect(m.toDisplay(25)).toBe(15)
    expect(m.toDisplay(40)).toBe(25)
    expect(m.toSong(5)).toBe(5)
    expect(m.toSong(10)).toBe(20) // at the cut: playback continues after it
    expect(m.toSong(10, 'before')).toBe(10) // a region ending there stops before it
    expect(m.toSong(25)).toBe(40)
    expect(m.marks()).toEqual([10, 20])
  })

  it('leaves beats inside cuts out of the grid but keeps bar numbers', () => {
    const grid = { beats: [0, 1, 2, 3, 4, 5, 6, 7, 8], beatsPerBar: 4, downbeatIndex: 0 }
    const g = cutGrid(grid, new CutMap([{ start: 2.5, end: 4.5 }], 9))
    expect(g.beats).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(g.barOf).toEqual([1, null, null, null, null, null, 3])
    expect(isBarLine(g, 6)).toBe(true)
  })

  it('keeps bars that change length through a cut', () => {
    const grid = { beats: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], beatsPerBar: 4, downbeatIndex: 0, inBar: [0, 1, 2, 3, 0, 1, 0, 1, 2, 3] }
    const g = cutGrid(grid, new CutMap([{ start: 0.5, end: 2.5 }], 10))
    expect(g.inBar).toEqual([0, 3, 0, 1, 0, 1, 2, 3])
    expect(g.barOf).toEqual([1, null, 2, null, 3, null, null, null])
    expect(isBarLine(g, 4)).toBe(true)
    expect(isBarLine(g, 5)).toBe(false)
  })

  it('shortens regions across a cut and drops ones inside it', () => {
    const m = new CutMap([{ start: 10, end: 20 }], 60)
    expect(cutRegion({ start: 8, end: 22 }, m)).toEqual({ start: 8, end: 12 })
    expect(cutRegion({ start: 12, end: 18 }, m)).toBeNull()
  })
})
