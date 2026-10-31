import { describe, expect, it } from 'vitest'
import { readNote, referenceA4, smoothHz } from '../src/shared/tuner'

describe('tuner', () => {
  it('names bass open strings', () => {
    expect(readNote(41.203)).toMatchObject({ note: 'E', octave: 1, string: 'E', cents: 0 })
    expect(readNote(30.868)).toMatchObject({ note: 'B', octave: 0, string: 'B' })
    expect(readNote(97.999)).toMatchObject({ note: 'G', octave: 2, string: 'G' })
    expect(readNote(46.249)).toMatchObject({ note: 'F♯', octave: 1, string: null })
  })

  it('reports cents sharp or flat', () => {
    expect(readNote(55 * 2 ** (12 / 1200))!.cents).toBeCloseTo(12, 1)
    expect(readNote(55 * 2 ** (-30 / 1200))).toMatchObject({ note: 'A', cents: -30 })
    expect(readNote(55 * 2 ** (60 / 1200))).toMatchObject({ note: 'A♯' }) // past halfway: next note
  })

  it('tunes against a shifted reference (match a detuned song)', () => {
    const a4 = referenceA4(32) // recording is 32 cents sharp
    expect(a4).toBeCloseTo(448.2, 1)
    expect(readNote(41.203 * 2 ** (32 / 1200), a4)).toMatchObject({ note: 'E', cents: 0 })
    expect(readNote(41.203, a4)!.cents).toBeCloseTo(-32, 0)
  })

  it('ignores silence and smooths with a median', () => {
    expect(readNote(0)).toBeNull()
    expect(smoothHz([41, 41.2, 82.4, 41.1, 0])).toBe(41.2) // one octave glitch ignored
    expect(smoothHz([0, 0, 0, 41, 0])).toBeNull()
  })
})
