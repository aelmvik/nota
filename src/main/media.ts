import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { exe, replaceFile } from './platform'

// ffmpeg/ffprobe helpers: metadata, hashing, waveform peaks and transcoding.
// All of this runs off the audio path in child processes.

// The app bundles its own audio-only ffmpeg and ffprobe (scripts/build-tools.mjs).
// A system install is only a fallback for development builds without them.
const SEARCH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
let bundledDir: string | null = null

/** Where the bundled tools are; call before the first getTools(). */
export function setBundledToolsDir(dir: string) {
  bundledDir = dir
  tools = null
}

function findTool(name: 'ffmpeg' | 'ffprobe'): string | null {
  const env = process.env[name === 'ffmpeg' ? 'NOTA_FFMPEG' : 'NOTA_FFPROBE']
  if (env && existsSync(env)) return env
  const file = exe(name)
  for (const dir of [bundledDir, ...(process.platform === 'win32' ? [] : SEARCH_DIRS)]) if (dir && existsSync(join(dir, file))) return join(dir, file)
  try {
    const which = process.platform === 'win32' ? 'where' : '/usr/bin/which'
    return execFileSync(which, [name], { encoding: 'utf8' }).trim().split(/\r?\n/)[0] || null
  } catch {
    return null
  }
}

let tools: { ffmpeg: string | null; ffprobe: string | null } | null = null
export function getTools() {
  tools ??= { ffmpeg: findTool('ffmpeg'), ffprobe: findTool('ffprobe') }
  return tools
}

function requireTool(name: 'ffmpeg' | 'ffprobe'): string {
  const path = getTools()[name]
  if (!path) throw new Error(`${name} is missing from Nøta. Reinstall the app.`)
  return path
}

/** Extensions the audio engine reads directly; anything else plays from a FLAC copy. */
export const DIRECTLY_PLAYABLE = new Set(['.mp3', '.wav', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.mp4', '.webm'])
export const IMPORTABLE = new Set([...DIRECTLY_PLAYABLE, '.aif', '.aiff', '.aifc', '.wma', '.alac', '.caf'])

export interface ProbeResult {
  durationSec: number
  title: string
  artist: string | null
  format: string
  codec: string | null
  sampleRate: number | null
  channels: number | null
  sizeBytes: number
}

function run(cmd: string, args: string[], signal?: AbortSignal): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], signal })
    const out: Buffer[] = []
    let err = ''
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err })
      else reject(new Error(err.trim().split('\n').pop() || `${basename(cmd)} exited with code ${code}`))
    })
  })
}

export async function probe(path: string): Promise<ProbeResult> {
  const { stdout } = await run(requireTool('ffprobe'), [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-select_streams', 'a:0', path
  ])
  const info = JSON.parse(stdout.toString())
  const stream = info.streams?.[0]
  if (!stream) throw new Error('The file contains no audio stream')
  const duration = Number(info.format?.duration ?? stream.duration)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Could not determine the duration')

  const tags: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...(info.format?.tags ?? {}), ...(stream.tags ?? {}) }))
    tags[k.toLowerCase()] = String(v)

  const fallbackTitle = basename(path, extname(path))
  return {
    durationSec: duration,
    title: tags.title?.trim() || fallbackTitle,
    artist: tags.artist?.trim() || tags.album_artist?.trim() || null,
    format: extname(path).slice(1).toLowerCase(),
    codec: stream.codec_name ?? null,
    sampleRate: stream.sample_rate ? Number(stream.sample_rate) : null,
    channels: stream.channels ?? null,
    sizeBytes: (await stat(path)).size
  }
}

export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

export function needsProxy(path: string): boolean {
  return !DIRECTLY_PLAYABLE.has(extname(path).toLowerCase())
}

/**
 * Formats that decode to exactly the samples the separated tracks were made
 * from. An MP3 or M4A original decoded by another decoder can land a few to
 * tens of milliseconds off (start padding), audible as a jump when switching
 * modes, so those play from a FLAC copy decoded by FFmpeg, like the stems.
 */
const SEEKS_EXACTLY = new Set(['.flac', '.wav'])

export function wantsProxy(path: string): boolean {
  return !SEEKS_EXACTLY.has(extname(path).toLowerCase())
}

/**
 * FLAC at 16 bits with triangular dither: CD quality, and about half the size
 * of 24-bit for audio that never had more detail (separated tracks, decoded
 * MP3/AAC). Matches separation/separate.py.
 */
const FLAC_16 = ['-af', 'aresample=osf=s16:dither_method=triangular', '-c:a', 'flac', '-sample_fmt', 's16']
const LOSSLESS_CODECS = /^(pcm_|flac$|alac$|wavpack$|ape$|tta$|wmalossless$)/

/** A FLAC playback copy: 16-bit from lossy sources, full depth from lossless ones. */
export async function transcodeToFlac(input: string, output: string): Promise<void> {
  const partial = `${output}.partial.flac`
  const lossless = LOSSLESS_CODECS.test((await probe(input).catch(() => null))?.codec ?? '')
  await run(requireTool('ffmpeg'), ['-v', 'error', '-nostdin', '-y', '-i', input, '-vn', ...(lossless ? ['-c:a', 'flac'] : FLAC_16), partial])
  await replaceFile(partial, output)
}

/**
 * Write audio for use in other software: WAV (24-bit), FLAC or MP3 (VBR ~190 kbit/s), by the output's extension.
 * With `durationSec`, `onProgress` hears how far along it is (0..1), from FFmpeg's own progress report.
 */
export async function exportAudio(
  input: string,
  output: string,
  durationSec?: number,
  onProgress?: (progress: number) => void,
  /** Aborting stops FFmpeg; the promise rejects with an AbortError */
  signal?: AbortSignal
): Promise<void> {
  const ext = extname(output).toLowerCase()
  const codec = ext === '.mp3' ? ['-c:a', 'libmp3lame', '-q:a', '2'] : ext === '.flac' ? ['-c:a', 'flac'] : ['-c:a', 'pcm_s24le']
  const args = ['-v', 'error', '-nostdin', '-y', '-i', input, '-vn', '-map_metadata', '-1', ...codec]
  if (!durationSec || !onProgress) {
    await run(requireTool('ffmpeg'), [...args, output], signal)
    return
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(requireTool('ffmpeg'), [...args, '-progress', 'pipe:1', '-stats_period', '0.1', '-nostats', output], { stdio: ['ignore', 'pipe', 'pipe'], signal })
    let err = ''
    let buffered = ''
    child.stdout.on('data', (d: Buffer) => {
      buffered += d.toString()
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        // out_time_us is the position written so far (out_time_ms is the same, misnamed).
        const m = /^out_time_us=(\d+)/.exec(line)
        if (m) onProgress(Math.min(1, Number(m[1]) / 1e6 / durationSec))
      }
    })
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `ffmpeg exited with code ${code}`))))
  })
}

export const WAVE_PER_SECOND = 1000
const WAVE_SAMPLE_RATE = 22050

/**
 * Waveform data for drawing: for every millisecond the min and max sample
 * (int8) and a "brightness" colour index (0 = all bass, 255 = all treble),
 * interleaved as [min, max, colour, …]. Brightness comes from a three-band
 * split (≈200 Hz / ≈2 kHz) averaged over 10 ms, which is what lets kicks and
 * bass read warm and cymbals and vocals read pale.
 */
export interface WaveformData {
  perSecond: number
  durationSec: number
  data: Uint8Array
}

export async function computeWaveform(path: string): Promise<WaveformData> {
  const { stdout } = await run(requireTool('ffmpeg'), [
    '-v', 'error', '-nostdin', '-i', path, '-vn', '-ac', '1', '-ar', String(WAVE_SAMPLE_RATE), '-f', 'f32le', '-'
  ])
  const x = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4))
  const sr = WAVE_SAMPLE_RATE
  const count = Math.ceil((x.length / sr) * WAVE_PER_SECOND)
  const mins = new Float32Array(count).fill(0)
  const maxs = new Float32Array(count).fill(0)

  // Band energies per 10 ms window.
  const win = Math.round(sr / 100)
  const windows = Math.ceil(x.length / win)
  const low = new Float32Array(windows)
  const mid = new Float32Array(windows)
  const high = new Float32Array(windows)
  const a1 = 1 - Math.exp((-2 * Math.PI * 200) / sr)
  const a2 = 1 - Math.exp((-2 * Math.PI * 2000) / sr)
  let lp1 = 0
  let lp2 = 0

  for (let i = 0; i < x.length; i++) {
    const v = x[i]
    const b = Math.floor((i * WAVE_PER_SECOND) / sr)
    if (v < mins[b]) mins[b] = v
    if (v > maxs[b]) maxs[b] = v
    lp1 += a1 * (v - lp1)
    lp2 += a2 * (v - lp2)
    const w = (i / win) | 0
    low[w] += lp1 * lp1
    mid[w] += (lp2 - lp1) * (lp2 - lp1)
    high[w] += (v - lp2) * (v - lp2)
  }

  const colourOfWindow = new Uint8Array(windows)
  for (let w = 0; w < windows; w++) {
    const total = low[w] + mid[w] + high[w]
    // Perceptual weighting: treble energy is small but very audible.
    const bright = total > 1e-9 ? (0.35 * mid[w] + 2.5 * high[w]) / (low[w] + 0.35 * mid[w] + 2.5 * high[w]) : 0.5
    colourOfWindow[w] = Math.round(Math.min(1, Math.max(0, bright)) * 255)
  }

  const data = new Uint8Array(count * 3)
  for (let b = 0; b < count; b++) {
    data[b * 3] = Math.round(Math.max(-1, mins[b]) * 127) & 0xff
    data[b * 3 + 1] = Math.round(Math.min(1, maxs[b]) * 127) & 0xff
    data[b * 3 + 2] = colourOfWindow[Math.min(windows - 1, Math.floor((b / WAVE_PER_SECOND) * 100))]
  }
  return { perSecond: WAVE_PER_SECOND, durationSec: x.length / sr, data }
}
