import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import readline from 'node:readline'
import { regularizeBeats, type BeatGrid } from '../shared/beats'
import { ANALYSIS_FORMAT } from '../shared/project'
import type { SongAnalysis } from '../shared/types'
import { writeFileAtomic } from './projectStore'
import type { PythonEnv } from './pythonEnv'

// Tempo, beat grid, key and tuning detection (separation/analyze.py), one
// song at a time, in the background. Results are stored per source hash in the
// project's Generated folder so reopening a project never re-analyses.

export const ANALYSIS_VERSION = `analysis-v${ANALYSIS_FORMAT}`

/** Raw worker output plus the regularised grid (null if no usable beats). */
export interface AnalysisResult {
  beats: number[]
  downbeats: number[]
  tracker: string
  key: string
  keyConfidence: number
  tuningCents: number
  durationSec: number
  grid: BeatGrid | null
}

export type AnalysisListener = (hash: string, analysis: SongAnalysis) => void

export function summarize(r: AnalysisResult): SongAnalysis {
  return {
    status: 'ready',
    version: ANALYSIS_FORMAT,
    bpm: r.grid?.bpm,
    key: r.key,
    keyConfidence: r.keyConfidence,
    tuningCents: r.tuningCents,
    beatCount: r.grid?.beats.length ?? 0,
    beatsPerBar: r.grid?.beatsPerBar,
    downbeatIndex: r.grid?.downbeatIndex,
    steady: r.grid?.steady,
    tracker: r.tracker
  }
}

export class AnalysisService {
  private queue: { hash: string; path: string }[] = []
  private running: string | null = null

  constructor(
    private readonly env: PythonEnv,
    /** The open project's Generated folder */
    private readonly root: () => string,
    private readonly listener: AnalysisListener,
    private readonly ffmpeg: string | null
  ) {}

  private file(hash: string, root = this.root()) {
    return join(root, hash, `${ANALYSIS_VERSION}.json`)
  }

  async read(hash: string): Promise<AnalysisResult | null> {
    try {
      const raw = JSON.parse(await readFile(this.file(hash), 'utf8')) as AnalysisResult
      // The grid is always rebuilt from the raw beats, so improvements to the
      // regulariser apply to songs that were analysed earlier.
      return { ...raw, grid: regularizeBeats(raw.beats, raw.downbeats ?? [], raw.durationSec) }
    } catch {
      return null
    }
  }

  /** The regularised beat grid used by the metronome, waveform grid and bar clock. */
  async grid(hash: string): Promise<BeatGrid | null> {
    return (await this.read(hash))?.grid ?? null
  }

  async enqueue(hash: string, path: string) {
    if (this.running === hash || this.queue.some((j) => j.hash === hash)) return
    const cached = await this.read(hash)
    if (cached) return this.listener(hash, summarize(cached))
    if (!this.env.python()) {
      return this.listener(hash, { status: 'unavailable', error: 'The analysis environment is not installed' })
    }
    this.queue.push({ hash, path })
    void this.pump()
  }

  clear() {
    this.queue = []
  }

  private async pump() {
    if (this.running) return
    const job = this.queue.shift()
    if (!job) return
    this.running = job.hash
    const root = this.root()
    this.listener(job.hash, { status: 'running' })
    try {
      const result = await this.run(job.path)
      // Written to the project the job started in, even if another one opened since.
      const target = this.file(job.hash, root)
      await writeFileAtomic(target, JSON.stringify(result))
      if (root === this.root()) this.listener(job.hash, summarize(result))
    } catch (err) {
      if (root === this.root()) this.listener(job.hash, { status: 'failed', error: err instanceof Error ? err.message : String(err) })
    } finally {
      this.running = null
      void this.pump()
    }
  }

  private async run(path: string): Promise<AnalysisResult> {
    const raw = await this.runWorker(path)
    return { ...raw, grid: regularizeBeats(raw.beats, raw.downbeats ?? [], raw.durationSec) }
  }

  private runWorker(path: string): Promise<Omit<AnalysisResult, 'grid'>> {
    const python = this.env.python()
    const script = this.env.script('analyze.py')
    if (!python || !existsSync(script)) return Promise.reject(new Error('The analysis environment is not installed'))
    return new Promise((resolve, reject) => {
      const child = spawn(python, [script, '--input', path], {
        env: { ...process.env, PYTHONUNBUFFERED: '1', ...(this.ffmpeg ? { NOTA_FFMPEG: this.ffmpeg } : {}) },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let result: Omit<AnalysisResult, 'grid'> | null = null
      let error: string | null = null
      child.stderr.on('data', () => {})
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          const msg = JSON.parse(line)
          if (msg.type === 'done') result = msg
          else if (msg.type === 'error') error = msg.message
        } catch {
          // ignore non-protocol output
        }
      })
      child.on('error', reject)
      child.on('close', () => (result ? resolve(result) : reject(new Error(error ?? 'Analysis failed'))))
    })
  }
}
