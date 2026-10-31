// Takes: you play along while Nøta records your bass, the recording is
// transcribed into notes, and those are drawn over the song's notes.
//
// The engine records the clean bass and logs the song position at the end of
// every audio block ("marks"), so a moment in the take maps back to the song
// whatever happened meanwhile: speed changes, loop wraps, seeks. Each
// continuous stretch of playback is a "pass" (a new one starts after a pause,
// a loop wrap or a seek), which keeps notes from being smeared across a jump.

import type { BassNote } from './types'

/** What the engine writes next to a take (see AudioEngine::stopTake). */
export interface TakeMarks {
  sampleRate: number
  frames: number
  dropped: boolean
  inputLatency: number
  outputLatency: number
  bufferSize: number
  outputChainLatency: number
  /** [take frames recorded by the end of an audio block, song position then (s), playing 1/0] */
  marks: [number, number, number][]
}

export interface Take {
  recordedAt: string
  /** Your notes, in song time (seconds, as the song's own notes) */
  notes: BassNote[]
  /** The disk fell behind while recording, so the take has a gap */
  dropped: boolean
}

export type TakeState =
  | { status: 'none' }
  | { status: 'recording' }
  | { status: 'transcribing' }
  | { status: 'ready'; take: Take }
  | { status: 'failed'; error: string }

/**
 * Frames between the song being rendered and you being heard playing along
 * with it: the song goes out through the output buffer, the driver and the
 * output effects; your bass comes back through the driver and an input buffer.
 */
export function roundTripFrames(m: TakeMarks): number {
  return m.inputLatency + m.outputLatency + 2 * m.bufferSize + m.outputChainLatency
}

interface Pass {
  /** Index of the first mark of the pass */
  first: number
  last: number
}

/** Continuous stretches of playback: a new one starts after a pause, a loop wrap or a seek. */
function passesOf(m: TakeMarks): Pass[] {
  const passes: Pass[] = []
  const sr = m.sampleRate
  let open: Pass | null = null
  m.marks.forEach(([frame, pos, playing], i) => {
    if (!playing) {
      open = null
      return
    }
    const prev = m.marks[i - 1]
    const continuous =
      open && prev && prev[2] && pos >= prev[1] - 1e-4 && pos - prev[1] <= ((frame - prev[0]) / sr) * 4 + 0.02 // under 4× speed
    if (open && continuous) open.last = i
    else {
      open = { first: i, last: i }
      passes.push(open)
    }
  })
  return passes
}

/** The song position you were hearing when the take reached `frame`, and the pass; null while the song wasn't playing. */
function locate(m: TakeMarks, passes: Pass[], frame: number): { pos: number; pass: number; rate: number } | null {
  const g = frame - roundTripFrames(m)
  const sr = m.sampleRate
  for (let p = 0; p < passes.length; p++) {
    const { first, last } = passes[p]
    const start = m.marks[first][0] - (m.marks[first + 1] ? m.marks[first + 1][0] - m.marks[first][0] : 0)
    if (g < start || g > m.marks[last][0]) continue
    // The first mark at or after g, interpolated from the one before (or extrapolated from the next).
    let i = first
    while (i < last && m.marks[i][0] < g) i++
    const a = i > first ? m.marks[i - 1] : m.marks[i]
    const b = i > first ? m.marks[i] : m.marks[Math.min(i + 1, last)]
    const span = b[0] - a[0]
    const rate = span > 0 ? (b[1] - a[1]) / (span / sr) : 1
    return { pos: a[1] + ((g - a[0]) / sr) * rate, pass: p, rate: rate > 0 ? rate : 1 }
  }
  return null
}

/** Turn notes transcribed from the take (in take seconds) into a Take in song time. */
export function takeFromRecording(m: TakeMarks, notes: BassNote[], recordedAt = new Date().toISOString()): Take {
  const passes = passesOf(m)
  const sr = m.sampleRate
  const out: BassNote[] = []
  for (const n of notes) {
    const s = locate(m, passes, n.start * sr)
    if (!s) continue // played while the song was stopped or counting in
    const e = locate(m, passes, n.end * sr)
    const end = e && e.pass === s.pass && e.pos > s.pos ? e.pos : s.pos + (n.end - n.start) * s.rate
    out.push({ start: s.pos, end, pitch: n.pitch, velocity: n.velocity })
  }
  return { recordedAt, notes: out, dropped: m.dropped }
}
