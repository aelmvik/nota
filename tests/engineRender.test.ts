import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveEngineBinary } from '../src/main/engineHost'
import { getTools } from '../src/main/media'

// Song playback in the native engine, checked sample by sample. The engine's
// --render mode runs the real song path (streaming, crossfades, stretcher,
// metronome) from a script instead of an audio device, so nothing here opens
// a microphone or a speaker.

const engine = resolveEngineBinary(join(__dirname, '..'))
const SR = 48000
let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nota-render-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Writes a 32-bit float WAV. */
function writeWav(path: string, channels: Float32Array[], sampleRate: number) {
  const frames = channels[0].length
  const nch = channels.length
  const data = Buffer.alloc(frames * nch * 4)
  for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++) data.writeFloatLE(channels[c][i], (i * nch + c) * 4)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(3, 20) // IEEE float
  header.writeUInt16LE(nch, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * nch * 4, 28)
  header.writeUInt16LE(nch * 4, 32)
  header.writeUInt16LE(32, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([header, data]))
}

/** Reads a float WAV as written by JUCE (finds the fmt and data chunks). */
function readWav(path: string): { sampleRate: number; channels: Float32Array[] } {
  const b = readFileSync(path)
  let off = 12
  let nch = 2
  let sampleRate = 0
  let bits = 32
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      nch = b.readUInt16LE(off + 10)
      sampleRate = b.readUInt32LE(off + 12)
      bits = b.readUInt16LE(off + 22)
    } else if (id === 'data') {
      if (bits !== 32) throw new Error('expected float data')
      const frames = Math.floor(size / (4 * nch))
      const channels = Array.from({ length: nch }, () => new Float32Array(frames))
      for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++) channels[c][i] = b.readFloatLE(off + 8 + (i * nch + c) * 4)
      return { sampleRate, channels }
    }
    off += 8 + size + (size & 1)
  }
  throw new Error('no data chunk')
}

interface Block {
  type: string
  frame: number
  position: number
  state: string
  playing: boolean
  mode: number
  wraps: number
  ended: number
}

function render(name: string, script: Record<string, unknown>) {
  const scriptPath = join(dir, `${name}.json`)
  const out = join(dir, `${name}.wav`)
  writeFileSync(scriptPath, JSON.stringify({ sampleRate: SR, blockSize: 256, log: true, ...script }))
  const stdout = execFileSync(engine!, ['--render', scriptPath, out], { encoding: 'utf8', maxBuffer: 1 << 28 })
  const lines = stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { audio: readWav(out), blocks: lines.filter((l) => l.type === 'block') as Block[], loaded: lines.filter((l) => l.type === 'loaded') }
}

/** A long sawtooth whose value says which frame it is: v(i) = (i mod P) / P * 0.5 - 0.25. */
const PERIOD = 1 << 18
const saw = (i: number) => ((i % PERIOD) / PERIOD) * 0.5 - 0.25
function sawTrack(path: string, seconds: number, offset = 0, sampleRate = SR) {
  const n = Math.round(seconds * sampleRate)
  const l = new Float32Array(n)
  for (let i = 0; i < n; i++) l[i] = saw(i) + offset
  writeWav(path, [l, l], sampleRate)
}

/** Which frame of the sawtooth a sample came from (exact while |value| identifies it). */
const frameOf = (v: number, offset = 0) => Math.round(((v - offset + 0.25) / 0.5) * PERIOD)

/** Speed 0.8, no key change: the engine's output before the key-change accuracy fix (arm64 build). */
const SPEED_ONLY_SHA256 = '86aab3c56f5aa5730c895770428a56d7a63f61a547aad09817c384d6f1bc00c6'

const vol = { cmd: 'song.volume', at: 0, song: 1, master: 1 }
const tracks = (a: string | null, b: string | null = null, c: string | null = null) =>
  [a, b, c].map((p) => (p ? { path: p } : null))

describe.skipIf(!engine)('native song playback (offline render)', () => {
  it('plays a file bit-exact at 100 % and loops on the exact frame', () => {
    const a = join(dir, 'a.wav')
    sawTrack(a, 4)
    const loopStart = 1.0
    const loopEnd = 1.5
    const { audio, blocks } = render('loop', {
      seconds: 2.5,
      commands: [
        vol,
        { at: 0, cmd: 'song.load', songId: 's', tracks: tracks(a), position: 0.5, mode: 0 },
        { at: 0, cmd: 'song.loop', start: loopStart, end: loopEnd, enabled: true },
        { at: 0, cmd: 'song.play' }
      ]
    })
    const out = audio.channels[0]
    // Playback starts on the first block, with a 3 ms fade-in.
    const fadeIn = Math.round(0.003 * SR)
    const start = 0.5 * SR
    for (let j = fadeIn + 1; j < 0.4 * SR; j++) expect(out[j]).toBe(Math.fround(saw(start + j)))
    // First wrap: output frame where the song reaches the loop end.
    const wrapAt = (loopEnd - 0.5) * SR
    const tail = Math.round(0.005 * SR)
    // After the 5 ms crossfade, the loop start plays exactly.
    for (let k = tail; k < 0.3 * SR; k++) expect(out[wrapAt + k]).toBe(Math.fround(saw(loopStart * SR + k)))
    // Inside the crossfade, the new audio comes in exactly at the loop start.
    expect(frameOf(out[wrapAt + tail - 1])).toBeGreaterThan(loopStart * SR)
    // Position reports follow the loop.
    const last = blocks[blocks.length - 1]
    expect(last.wraps).toBeGreaterThanOrEqual(2)
    expect(last.position).toBeGreaterThanOrEqual(loopStart)
    expect(last.position).toBeLessThan(loopEnd)
  })

  it('skips cut regions on the exact frame, with the playhead following', () => {
    const a = join(dir, 'cut.wav')
    sawTrack(a, 6)
    const cutStart = 1.0
    const cutEnd = 2.5
    const { audio, blocks } = render('cuts', {
      seconds: 2.0,
      commands: [
        vol,
        { at: 0, cmd: 'song.load', songId: 's', tracks: tracks(a), position: 0.5, mode: 0 },
        { at: 0, cmd: 'song.cuts', regions: [{ start: cutStart, end: cutEnd }] },
        { at: 0, cmd: 'song.play' }
      ]
    })
    const out = audio.channels[0]
    const jumpAt = (cutStart - 0.5) * SR
    const tail = Math.round(0.005 * SR)
    // Before the cut, bit-exact; after the 5 ms crossfade, the audio after the cut, bit-exact.
    for (let j = Math.round(0.01 * SR); j < jumpAt; j++) expect(out[j]).toBe(Math.fround(saw(0.5 * SR + j)))
    for (let k = tail; k < 0.5 * SR; k++) expect(out[jumpAt + k]).toBe(Math.fround(saw(cutEnd * SR + k)))
    // The playhead skips the cut too, and a cut is not a loop wrap.
    const last = blocks[blocks.length - 1]
    expect(last.position).toBeGreaterThan(cutEnd)
    expect(last.wraps).toBe(0)
  })

  it('exports with changes: cut parts are left out of the rendered file', async () => {
    const { renderWithChanges } = await import('../src/main/exportRender')
    const a = join(dir, 'export.wav')
    sawTrack(a, 5)
    const rendered = await renderWithChanges(engine!, a, { durationSec: 5, cuts: [{ start: 1, end: 3 }], speed: 1, semitones: 0, cents: 0, sampleRate: SR })
    try {
      const out = readWav(rendered.path).channels[0]
      // 5 s minus a 2 s cut, plus the render's short tail.
      expect(out.length / SR).toBeCloseTo(3.05, 1)
      const tail = Math.round(0.005 * SR)
      // Before the cut, as recorded; after it, the audio from 3 s on.
      expect(out[Math.round(0.5 * SR)]).toBe(Math.fround(saw(0.5 * SR)))
      expect(out[SR + tail + 100]).toBe(Math.fround(saw(3 * SR + tail + 100)))
    } finally {
      await rendered.cleanup()
    }
  })

  it('switches modes sample-locked, with a 30 ms crossfade', () => {
    const a = join(dir, 'ma.wav')
    const b = join(dir, 'mb.wav')
    sawTrack(a, 3)
    sawTrack(b, 3, 0.25)
    const { audio } = render('mode', {
      seconds: 1.5,
      commands: [
        vol,
        { at: 0, cmd: 'song.load', songId: 's', tracks: tracks(a, b), position: 0, mode: 0 },
        { at: 0, cmd: 'song.play' },
        { at: 0.5, cmd: 'song.mode', mode: 1 }
      ]
    })
    const out = audio.channels[0]
    const switchAt = Math.ceil((0.5 * SR) / 256) * 256 // applied at the next block boundary
    const fade = Math.round(0.03 * SR)
    // Before: track A exactly. After the fade: track B exactly, same frame.
    for (let j = 1000; j < switchAt; j++) expect(out[j]).toBe(Math.fround(saw(j)))
    for (let j = switchAt + fade + 1; j < 1.4 * SR; j++) expect(out[j]).toBeCloseTo(saw(j) + 0.25, 6)
    // During the fade, both tracks are at the same frame: out - saw(j) is the gain ramp.
    let prev = -1
    for (let j = switchAt; j < switchAt + fade; j++) {
      const g = (out[j] - saw(j)) / 0.25
      expect(g).toBeGreaterThanOrEqual(prev - 1e-4)
      prev = g
    }
  })

  it('seeks to the exact frame', () => {
    const a = join(dir, 'sa.wav')
    sawTrack(a, 6)
    const { audio, blocks } = render('seek', {
      seconds: 1.2,
      commands: [
        vol,
        { at: 0, cmd: 'song.load', songId: 's', tracks: tracks(a), position: 0, mode: 0 },
        { at: 0, cmd: 'song.play' },
        { at: 0.5, cmd: 'song.seek', position: 4.25, seq: 7 }
      ]
    })
    const out = audio.channels[0]
    const seekAt = Math.ceil((0.5 * SR) / 256) * 256
    const fade = Math.round(0.01 * SR)
    for (let k = fade; k < 0.5 * SR; k++) expect(out[seekAt + k]).toBe(Math.fround(saw(4.25 * SR + k)))
    const after = blocks.find((b) => b.frame > seekAt + 512)!
    expect(after.position).toBeGreaterThan(4.25)
    expect(after.position).toBeLessThan(4.27)
  })

  it('resamples a 44.1 kHz file cleanly to the device rate', () => {
    const a = join(dir, 'r441.wav')
    const n = 44100 * 3
    const l = new Float32Array(n)
    for (let i = 0; i < n; i++) l[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 44100)
    writeWav(a, [l, l], 44100)
    const { audio } = render('resample', {
      seconds: 2,
      commands: [vol, { at: 0, cmd: 'song.load', songId: 's', tracks: tracks(a), position: 0, mode: 0 }, { at: 0, cmd: 'song.play' }]
    })
    const out = audio.channels[0]
    // Same sine at 48 kHz, across many 8192-frame chunk boundaries.
    let maxErr = 0
    for (let j = 1000; j < 1.9 * SR; j++) maxErr = Math.max(maxErr, Math.abs(out[j] - 0.5 * Math.sin((2 * Math.PI * 1000 * j) / SR)))
    expect(maxErr).toBeLessThan(2e-3)
  })

  /** Frames where a train of short impulses (or clicks) starts. */
  function onsets(x: Float32Array, threshold = 0.02, gap = 0.1 * SR) {
    const found: number[] = []
    for (let i = 0; i < x.length; i++) {
      if (Math.abs(x[i]) > threshold && (found.length === 0 || i - found[found.length - 1] > gap)) found.push(i)
    }
    return found
  }

  function impulses(path: string, seconds: number, times: number[]) {
    const n = Math.round(seconds * SR)
    const l = new Float32Array(n)
    for (const t of times) {
      const at = Math.round(t * SR)
      // A short windowed burst: survives the stretcher as one onset.
      for (let k = 0; k < 480; k++) l[at + k] = 0.8 * Math.sin((2 * Math.PI * 2000 * k) / SR) * Math.sin((Math.PI * k) / 480)
    }
    writeWav(path, [l, l], SR)
  }

  function frequency(x: Float32Array, from: number, to: number) {
    let crossings = 0
    for (let i = from + 1; i < to; i++) if (x[i - 1] < 0 && x[i] >= 0) crossings++
    return (crossings * SR) / (to - from)
  }

  it('slows down with the pitch kept, and keeps the position on time', () => {
    const a = join(dir, 'slow.wav')
    const n = SR * 4
    const l = new Float32Array(n)
    for (let i = 0; i < n; i++) l[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / SR)
    writeWav(a, [l, l], SR)
    const { audio, blocks } = render('slow', {
      seconds: 3,
      commands: [
        vol,
        { at: 0, cmd: 'song.load', songId: 's', tracks: tracks(a), position: 0, mode: 0 },
        { at: 0, cmd: 'song.speed', speed: 0.5 },
        { at: 0, cmd: 'song.play' }
      ]
    })
    expect(frequency(audio.channels[0], 0.5 * SR, 2.5 * SR)).toBeCloseTo(220, -0.5)
    const at2s = blocks.find((b) => b.frame >= 2 * SR)!
    expect(at2s.position).toBeCloseTo(1.0, 2)
  })

  it('changes key in real time', () => {
    const a = join(dir, 'key.wav')
    const n = SR * 3
    const l = new Float32Array(n)
    for (let i = 0; i < n; i++) l[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / SR)
    writeWav(a, [l, l], SR)
    const { audio } = render('key', {
      seconds: 2,
      commands: [
        vol,
        { at: 0, cmd: 'song.load', songId: 's', tracks: tracks(a), position: 0, mode: 0 },
        { at: 0, cmd: 'song.pitch', ratio: Math.pow(2, 7 / 12) },
        { at: 0, cmd: 'song.play' }
      ]
    })
    expect(frequency(audio.channels[0], 0.3 * SR, 1.8 * SR)).toBeCloseTo(220 * Math.pow(2, 7 / 12), -0.5)
  })

  /** A band-limited sawtooth (harmonics below 8 kHz), as a stand-in for a bass note. */
  function bassSaw(out: Float32Array, from: number, to: number, f0: number) {
    const harmonics = Math.floor(8000 / f0)
    for (let i = from; i < to; i++) {
      const w = (2 * Math.PI * f0 * (i - from)) / SR
      let v = 0
      for (let h = 1; h <= harmonics; h++) v += Math.sin(h * w) / h
      out[i] = 0.25 * v
    }
  }

  /** Strongest frequency within ±3 % of `near`: Blackman-Harris windowed DTFT, refined by golden section. */
  function peakFrequency(x: Float32Array, from: number, to: number, near: number) {
    const n = to - from
    const win = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const t = (2 * Math.PI * i) / (n - 1)
      win[i] = (0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t)) * x[from + i]
    }
    const power = (f: number) => {
      // Rotating phasor instead of a sin/cos per sample.
      const dc = Math.cos((2 * Math.PI * f) / SR)
      const ds = Math.sin((2 * Math.PI * f) / SR)
      let c = 1
      let s = 0
      let re = 0
      let im = 0
      for (let i = 0; i < n; i++) {
        re += win[i] * c
        im -= win[i] * s
        const nc = c * dc - s * ds
        s = s * dc + c * ds
        c = nc
      }
      return re * re + im * im
    }
    const step = near * 0.001
    let best = near
    let bestPower = -1
    for (let f = near * 0.97; f <= near * 1.03; f += step) {
      const p = power(f)
      if (p > bestPower) [best, bestPower] = [f, p]
    }
    let a = best - step
    let b = best + step
    for (let k = 0; k < 30; k++) {
      const m1 = a + (b - a) * 0.382
      const m2 = a + (b - a) * 0.618
      if (power(m1) > power(m2)) b = m2
      else a = m1
    }
    return (a + b) / 2
  }

  it('changes key on pitch for low bass notes (within 1 cent of the fundamental)', () => {
    // E1, A1 and D2, one after another: low notes are where a too-short analysis
    // block, or a biased peak map, used to put key changes 10-90 cents off.
    const notes = [41.2034, 55, 73.4162]
    const seg = Math.round(2.5 * SR)
    const a = join(dir, 'bass.wav')
    const l = new Float32Array(seg * notes.length)
    notes.forEach((f, k) => bassSaw(l, k * seg, (k + 1) * seg, f))
    writeWav(a, [l, l], SR)

    const cases: { semitones: number; speed?: number }[] = [
      ...[1, -1, 2, -2, 3, -3, 5, -5, 7, -7].map((semitones) => ({ semitones })),
      { semitones: 0.5 }, // 50 cents
      { semitones: -0.37 }, // -37 cents
      { semitones: -3, speed: 0.75 } // key change while slowed down
    ]
    for (const { semitones, speed = 1 } of cases) {
      const ratio = Math.pow(2, semitones / 12)
      const { audio } = render(`bass-${semitones}-${speed}`, {
        seconds: (notes.length * 2.5) / speed,
        commands: [
          vol,
          { at: 0, cmd: 'song.load', songId: 's', tracks: tracks(a), position: 0, mode: 0 },
          { at: 0, cmd: 'song.pitch', ratio },
          { at: 0, cmd: 'song.speed', speed },
          { at: 0, cmd: 'song.play' }
        ]
      })
      notes.forEach((f, k) => {
        // The middle 1.5 s of each note, clear of the note changes.
        const from = Math.round(((k * 2.5 + 0.5) / speed) * SR)
        const to = from + Math.round(1.5 * SR)
        const target = f * ratio
        const cents = 1200 * Math.log2(peakFrequency(audio.channels[0], from, to, target) / target)
        expect(Math.abs(cents), `${f} Hz, ${semitones} st, speed ${speed}: ${cents.toFixed(2)} cents`).toBeLessThan(1)
      })
    }
  })

  // The hash is the Mac build's; other compilers and CPUs round the stretcher's floats differently.
  it.skipIf(process.platform !== 'darwin')('leaves speed-only changes untouched by the key-change engine', () => {
    // Slow-down without a key change runs the stock Signalsmith preset, as before
    // the key-change accuracy fix: this hash is that output. Recompute it only for a
    // deliberate change to the slow-down path.
    const a = join(dir, 'speed-only.wav')
    const n = SR * 3
    const l = new Float32Array(n)
    bassSaw(l, 0, n, 55)
    for (let i = 0; i < n; i++) l[i] += 0.2 * Math.sin((2 * Math.PI * 659.26 * i) / SR) * Math.exp(-((i % 12000) / 3000))
    writeWav(a, [l, l], SR)
    const run = (name: string) =>
      render(name, {
        seconds: 2,
        commands: [
          vol,
          { at: 0, cmd: 'song.load', songId: 's', tracks: tracks(a), position: 0.25, mode: 0 },
          { at: 0, cmd: 'song.speed', speed: 0.8 },
          { at: 0, cmd: 'song.play' }
        ]
      }).audio.channels
    const plain = run('speed-only')
    const hash = createHash('sha256')
    for (const ch of plain) hash.update(Buffer.from(ch.buffer, ch.byteOffset, ch.byteLength))
    expect(hash.digest('hex')).toBe(SPEED_ONLY_SHA256)
  })

  it('lines stretched audio up with its reported position', () => {
    const a = join(dir, 'imp.wav')
    const times = [0.5, 1.0, 1.5, 2.0, 2.5]
    impulses(a, 4, times)
    const speed = 0.75
    const { audio } = render('stretch-align', {
      seconds: 3.6,
      commands: [
        vol,
        { at: 0, cmd: 'song.load', songId: 's', tracks: tracks(a), position: 0.25, mode: 0 },
        { at: 0, cmd: 'song.speed', speed },
        { at: 0, cmd: 'song.play' }
      ]
    })
    const found = onsets(audio.channels[0], 0.05)
    const expected = times.map((t) => ((t - 0.25) / speed) * SR)
    expect(found.length).toBe(expected.length)
    // Within 3 ms of where the song position says they are.
    found.forEach((f, i) => expect(Math.abs(f - expected[i])).toBeLessThan(0.003 * SR))
  })

  it('clicks on the beat grid, inside loops and at any speed', () => {
    const silent = join(dir, 'silent.wav')
    writeWav(silent, [new Float32Array(SR * 6), new Float32Array(SR * 6)], SR)
    const beats = Array.from({ length: 12 }, (_, i) => 0.5 * i)
    for (const speed of [1, 0.6]) {
      const { audio } = render(`metro-${speed}`, {
        seconds: 3.5,
        commands: [
          vol,
          { at: 0, cmd: 'song.load', songId: 's', tracks: tracks(silent), position: 0.75, mode: 0 },
          { at: 0, cmd: 'song.beats', times: beats, accents: beats.map((_, i) => i % 4 === 0) },
          { at: 0, cmd: 'song.metronome', enabled: true, volume: 1 },
          { at: 0, cmd: 'song.loop', start: 1.0, end: 2.0, enabled: true },
          { at: 0, cmd: 'song.speed', speed },
          { at: 0, cmd: 'song.play' }
        ]
      })
      // Song time 0.75 → 1.0, 1.5, then the loop: 1.0, 1.5, 1.0, …
      const expected: number[] = []
      let song = 0.75
      let t = 0
      const step = 1 / SR
      while (t < 3.5 - 0.05) {
        for (const b of [1.0, 1.5]) if (song <= b && song + step * speed > b) expected.push(Math.round(t * SR))
        song += step * speed
        if (song >= 2.0) {
          song -= 1.0
          if (Math.abs(song - 1.0) < step * speed) expected.push(Math.round(t * SR) + 1)
        }
        t += step
      }
      const found = onsets(audio.channels[0], 0.01)
      expect(found.length).toBe(expected.length)
      // The click envelope ramps over 24 samples; the onset threshold lands a few in.
      const tolerance = speed === 1 ? 24 : 0.003 * SR
      found.forEach((f, i) => expect(Math.abs(f - expected[i])).toBeLessThan(tolerance))
    }
  })

  it('counts in and starts the song on the next beat', () => {
    const a = join(dir, 'ci.wav')
    sawTrack(a, 3)
    const { audio } = render('countin', {
      seconds: 3,
      commands: [
        vol,
        { at: 0, cmd: 'song.load', songId: 's', tracks: tracks(a), position: 0, mode: 0 },
        { at: 0, cmd: 'song.metronome', enabled: false, volume: 1 },
        { at: 0, cmd: 'song.play', countInBeats: 4, countInPeriod: 0.5, beatsPerBar: 4 }
      ]
    })
    const out = audio.channels[0]
    const clicksAt = onsets(out.subarray(0, 2 * SR), 0.01)
    expect(clicksAt.length).toBe(4)
    clicksAt.forEach((f, i) => expect(Math.abs(f - i * 0.5 * SR)).toBeLessThan(24))
    // The song starts exactly two seconds in, from its start position.
    const start = 2 * SR
    const fadeIn = Math.round(0.003 * SR)
    for (let k = fadeIn + 1; k < 0.5 * SR; k++) expect(out[start + k]).toBe(Math.fround(saw(k)))
  })

  // JUCE's FLAC reader returned silence for reads that didn't continue the
  // previous one, so FLAC tracks went quiet whenever they were resampled
  // (Bluetooth headsets run at 24 kHz) or after seeks. The same audio as WAV
  // and as FLAC must play identically.
  it.skipIf(!getTools().ffmpeg)('plays FLAC exactly like WAV, at any device rate, across seeks and loops', () => {
    const wav = join(dir, 'music.wav')
    const flac = join(dir, 'music.flac')
    const n = 44100 * 40
    const l = new Float32Array(n)
    const r = new Float32Array(n)
    let seed = 1
    for (let i = 0; i < n; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const noise = (seed / 2 ** 32 - 0.5) * 0.1
      l[i] = 0.3 * Math.sin((2 * Math.PI * 110 * i) / 44100) + noise
      r[i] = 0.3 * Math.sin((2 * Math.PI * 165 * i) / 44100) - noise
    }
    writeWav(wav, [l, r], 44100)
    execFileSync(getTools().ffmpeg!, ['-v', 'error', '-y', '-i', wav, '-c:a', 'flac', '-sample_fmt', 's32', flac])
    for (const sampleRate of [24000, 44100, 48000]) {
      const run = (path: string) =>
        render(`flac-${sampleRate}-${path.endsWith('flac')}`, {
          sampleRate,
          seconds: 4,
          commands: [
            vol,
            { at: 0, cmd: 'song.load', songId: 's', tracks: tracks(path), position: 17.3, mode: 0 },
            { at: 0, cmd: 'song.loop', start: 20.11, end: 20.9, enabled: true },
            { at: 0, cmd: 'song.play' },
            { at: 2.5, cmd: 'song.seek', position: 31.77 }
          ]
        }).audio.channels
      const [a, b] = [run(wav), run(flac)]
      let maxDiff = 0
      let level = 0
      for (let c = 0; c < 2; c++)
        for (let i = 0; i < a[c].length; i++) {
          maxDiff = Math.max(maxDiff, Math.abs(a[c][i] - b[c][i]))
          level = Math.max(level, Math.abs(b[c][i]))
        }
      expect(level).toBeGreaterThan(0.2)
      expect(maxDiff).toBeLessThan(1e-5) // 24-bit FLAC vs float WAV
    }
  })
})
