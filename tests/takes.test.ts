import { describe, expect, it } from 'vitest'
import { roundTripFrames, takeFromRecording, type TakeMarks } from '../src/shared/takes'

const SR = 1000 // frames per second, to keep the numbers readable
const BLOCK = 10

/** Marks for playback described as [seconds of take, song position at its start, speed] segments. */
function marks(segments: [number, number, number, boolean?][], latency = 0): TakeMarks {
  const out: TakeMarks['marks'] = []
  let frame = 0
  for (const [seconds, from, speed, playing = true] of segments) {
    for (let f = BLOCK; f <= seconds * SR; f += BLOCK) out.push([frame + f, from + (f / SR) * speed, playing ? 1 : 0])
    frame += seconds * SR
  }
  return { sampleRate: SR, frames: frame, dropped: false, inputLatency: latency, outputLatency: 0, bufferSize: 0, outputChainLatency: 0, marks: out }
}

const note = (start: number, end: number, pitch: number) => ({ start, end, pitch, velocity: 0.8 })

describe('takes', () => {
  it('maps take time to song time at full speed', () => {
    const take = takeFromRecording(marks([[10, 20, 1]]), [note(2, 2.5, 40)])
    expect(take.notes[0].start).toBeCloseTo(22, 2)
    expect(take.notes[0].end).toBeCloseTo(22.5, 2)
  })

  it('follows a slowed-down song', () => {
    const take = takeFromRecording(marks([[10, 0, 0.5]]), [note(4, 6, 40)])
    expect(take.notes[0].start).toBeCloseTo(2, 2) // 4 s of playing at half speed = 2 s of song
    expect(take.notes[0].end).toBeCloseTo(3, 2)
  })

  it('maps both times round a loop to the same place, and drops notes played while stopped', () => {
    // 4 s from 10 s, wrap back to 10 s for 4 s more, then 2 s stopped
    const take = takeFromRecording(marks([[4, 10, 1], [4, 10, 1], [2, 14, 0, false]]), [note(1, 1.5, 40), note(5, 5.5, 40), note(9, 9.5, 40)])
    expect(take.notes.map((n) => Math.round(n.start * 10) / 10)).toEqual([11, 11])
    expect(take.notes[1].end).toBeCloseTo(11.5, 2) // not smeared across the wrap
  })

  it('takes the round trip latency off', () => {
    const m = marks([[10, 0, 1]], 200) // 200 ms between the song going out and the bass coming back
    expect(roundTripFrames(m)).toBe(200)
    expect(takeFromRecording(m, [note(3, 3.5, 40)]).notes[0].start).toBeCloseTo(2.8, 2)
  })

  it('adds the buffers only where the driver latencies leave them out', () => {
    const m = { ...marks([[10, 0, 1]], 0), inputLatency: 469, outputLatency: 331, bufferSize: 256 }
    expect(roundTripFrames(m)).toBe(469 + 331 + 2 * 256)
    // Windows (ASIO; measured with a loopback cable): the round trip is input + output.
    expect(roundTripFrames({ ...m, latencyIncludesBuffer: true })).toBe(469 + 331)
  })

})
