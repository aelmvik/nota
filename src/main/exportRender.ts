import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import { CutMap } from '../shared/cuts'
import type { TimeRegion } from '../shared/types'

// Renders one track with a song's speed, key and cuts applied, offline, through the
// audio engine's own song path (NotaEngine --render), so an export sounds
// exactly like playback. Returns the path of a 32-bit float WAV in a temp
// folder; the caller converts it and calls cleanup().

export interface RenderedTrack {
  path: string
  cleanup: () => Promise<void>
}

export async function renderWithChanges(
  engineBinary: string,
  input: string,
  opts: { durationSec: number; cuts: TimeRegion[]; speed: number; semitones: number; cents: number; sampleRate: number },
  /** How far along the render is, 0..1 */
  onProgress?: (progress: number) => void,
  /** Aborting stops the engine; the promise rejects with an AbortError and the temp folder is removed */
  signal?: AbortSignal
): Promise<RenderedTrack> {
  const dir = await mkdtemp(join(tmpdir(), 'nota-export-'))
  // Windows can hold a just-closed file for a moment (antivirus, the indexer): rm retries.
  const cleanup = () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  try {
    const script = join(dir, 'render.json')
    const out = join(dir, 'render.wav')
    const ratio = Math.pow(2, (opts.semitones + opts.cents / 100) / 12)
    await writeFile(
      script,
      JSON.stringify({
        sampleRate: opts.sampleRate,
        blockSize: 1024,
        progress: true,
        // The stretched song is longer (slower) or shorter (faster) than the original; cut parts are skipped.
        seconds: new CutMap(opts.cuts, opts.durationSec).kept / opts.speed + 0.05,
        commands: [
          { at: 0, cmd: 'song.volume', song: 1, master: 1 },
          { at: 0, cmd: 'song.load', songId: 'export', tracks: [{ path: input }, null, null], position: 0, mode: 0 },
          { at: 0, cmd: 'song.cuts', regions: opts.cuts },
          { at: 0, cmd: 'song.speed', speed: opts.speed },
          { at: 0, cmd: 'song.pitch', ratio },
          { at: 0, cmd: 'song.play' }
        ]
      })
    )
    await new Promise<void>((resolve, reject) => {
      const child = spawn(engineBinary, ['--render', script, out], { stdio: ['ignore', 'pipe', 'pipe'], signal })
      // The engine reports progress as JSON lines ({"type":"progress","progress":0.42}).
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          const msg = JSON.parse(line)
          if (msg?.type === 'progress' && typeof msg.progress === 'number') onProgress?.(msg.progress)
        } catch {
          // not one of ours
        }
      })
      let err = ''
      child.stderr.on('data', (d) => (err += String(d)))
      // Settled when the engine has exited (also when cancelled), so its files are closed before cleanup.
      let failure: Error | null = null
      child.on('error', (e) => {
        failure ??= e
        if (child.pid === undefined) reject(e) // never started: no 'close' follows
      })
      child.on('close', (code) => {
        if (failure) reject(failure)
        else if (code === 0) resolve()
        else reject(new Error(err.trim() || 'The audio engine couldn’t render the export'))
      })
    })
    return { path: out, cleanup }
  } catch (e) {
    await cleanup().catch(() => {}) // the render's own error says more
    throw e
  }
}
