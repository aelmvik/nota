import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFERENCES, normalizePreferences, SEPARATION_MODELS } from '../src/shared/types'
import { readNote, referenceA4 } from '../src/shared/tuner'

describe('preferences', () => {
  it('defaults to the current (FL-style) behaviour', () => {
    expect(normalizePreferences(null)).toEqual(DEFAULT_PREFERENCES)
    expect(DEFAULT_PREFERENCES).toMatchObject({ stopBehavior: 'return', snapToGrid: true, tunerA4: 440 })
  })

  it('rejects unknown values and clamps ranges', () => {
    const p = normalizePreferences({ stopBehavior: 'rewind' as never, tunerA4: 500, projectsDir: '', songStorage: 'x' as never, accent: 'cocoa' as never })
    expect(p).toMatchObject({ stopBehavior: 'return', tunerA4: 450, projectsDir: null, songStorage: 'ask', accent: 'cobalt', openAtLaunch: 'last' })
    expect(normalizePreferences({ openAtLaunch: 'start' }).openAtLaunch).toBe('start')
    expect(normalizePreferences({ accent: 'vermilion' }).accent).toBe('vermilion')
    expect(normalizePreferences({ tunerA4: 431.27 }).tunerA4).toBe(431.3)
  })

  it('keeps valid choices', () => {
    const p = normalizePreferences({ stopBehavior: 'pause', snapToGrid: false, waveformColors: 'mono', separationQuality: 'high' })
    expect(p).toMatchObject({ stopBehavior: 'pause', snapToGrid: false, waveformColors: 'mono', separationQuality: 'high' })
    expect(SEPARATION_MODELS[p.separationQuality]).toBe('htdemucs_ft')
  })

  it('tunes against a custom reference pitch', () => {
    const a4 = referenceA4(0, 432)
    expect(readNote(432 / 8, a4)).toMatchObject({ note: 'A', octave: 1, cents: 0 })
    expect(readNote(55, a4)!.cents).toBeCloseTo(31.8, 0) // standard A1 is sharp against A = 432
  })
})
