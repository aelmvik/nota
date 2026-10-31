import type { PracticeTotals } from './types'

// Practice time: what counts is a song playing, or bass being played with
// Monitor on (the renderer decides, see usePracticeTracker). Totals per day
// are kept app-wide; per song and per project they live in the project.

/** Local calendar day, e.g. "2026-10-18". */
export function dayKey(d = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** Today, this week (from Monday) and all time, from seconds per day. */
export function practiceTotals(days: Record<string, number>, now = new Date()): PracticeTotals {
  const today = dayKey(now)
  const monday = new Date(now)
  monday.setHours(0, 0, 0, 0)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  const weekStart = dayKey(monday)
  let week = 0
  let total = 0
  for (const [day, sec] of Object.entries(days)) {
    total += sec
    if (day >= weekStart && day <= today) week += sec
  }
  return { today: days[today] ?? 0, week, total }
}

/** "< 1 min", "45 min", "3 h 20 min", "120 h". */
export function formatDuration(sec: number): string {
  const min = Math.floor(sec / 60)
  if (min < 1) return sec > 0 ? '< 1 min' : '0 min'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return h >= 100 || m === 0 ? `${h} h` : `${h} h ${m} min`
}
