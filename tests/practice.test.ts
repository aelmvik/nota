import { describe, expect, it } from 'vitest'
import { dayKey, formatDuration, practiceTotals } from '../src/shared/practice'
import { addPractice, createProject, parseProject, serializeProject } from '../src/shared/project'

describe('practice time', () => {
  it('sums today, this week (from Monday) and all time', () => {
    const now = new Date(2026, 9, 18, 15) // Sunday 18 Oct 2026
    const days = { '2026-10-18': 600, '2026-10-12': 300, '2026-10-11': 1200, '2025-01-01': 60 }
    expect(practiceTotals(days, now)).toEqual({ today: 600, week: 900, total: 2160 })
    expect(dayKey(now)).toBe('2026-10-18')
  })

  it('formats durations for people', () => {
    expect(formatDuration(0)).toBe('0 min')
    expect(formatDuration(20)).toBe('< 1 min')
    expect(formatDuration(45 * 60)).toBe('45 min')
    expect(formatDuration(3 * 3600 + 20 * 60)).toBe('3 h 20 min')
    expect(formatDuration(2 * 3600)).toBe('2 h')
  })

  it('adds time to the project and the playing song, and survives a save', () => {
    let p = createProject('Gig')
    p = { ...p, songs: [{ id: 's1', practiceSec: 0 } as never, { id: 's2', practiceSec: 10 } as never] }
    p = addPractice(addPractice(p, 's2', 30), null, 15)
    expect(p.practiceSec).toBe(45)
    expect(p.songs.map((s) => s.practiceSec)).toEqual([0, 40])
    const old = JSON.parse(serializeProject(createProject('Old')))
    delete old.practiceSec
    expect(parseProject(JSON.stringify(old)).practiceSec).toBe(0)
  })
})
