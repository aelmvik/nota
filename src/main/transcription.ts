import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import readline from 'node:readline'
import type { BassNote, NotesState, Song } from '../shared/types'
import { writeFileAtomic } from './projectStore'
import type { PythonEnv } from './pythonEnv'

// Bass notes for the "Notes" view: separation/transcribe.py turns a song's
// separated bass track into notes, the first time the view is opened. The
// result is stored next to the song's other generated files, keyed by the
// separation model, so re-separating a song transcribes it again.

const VERSION = 'notes-v3'

interface Job {
  hash: string
  root: string
  input: string
  file: string
  tuningCents: number
}

export class TranscriptionService extends EventEmitter {
  private queue: Job[] = []
  private running: Job | null = null
  private progress = new Map<string, number>()

  constructor(
    private readonly env: PythonEnv,
    /** The open project's Generated folder */
    private readonly root: () => string,
    private readonly ffmpeg: string | null
  ) {
    super()
  }

  private file(hash: string, model: string, root = this.root()) {
    return join(root, hash, `${VERSION}-${model}.json`)
  }

  /** The song's notes if they exist; otherwise starts transcribing and reports progress via 'state' events. */
  async get(song: Song, bassPath: string | null): Promise<NotesState> {
    const stem = song.stems.bass
    if (!stem || !bassPath || song.separation.status !== 'ready') return { status: 'unavailable', error: 'The bass hasn’t been separated yet' }
    const file = this.file(song.source.hash, stem.model)
    try {
      const notes = JSON.parse(await readFile(file, 'utf8')) as BassNote[]
      return { status: 'ready', notes }
    } catch {
      // not transcribed yet
    }
    if (!this.env.python()) return { status: 'unavailable', error: 'The audio environment isn’t installed (Settings → Separation)' }
    const hash = song.source.hash
    if (this.running?.hash !== hash && !this.queue.some((j) => j.hash === hash)) {
      this.queue.push({ hash, root: this.root(), input: bassPath, file, tuningCents: song.analysis.status === 'ready' ? (song.analysis.tuningCents ?? 0) : 0 })
      void this.pump()
    }
    return { status: 'running', progress: this.progress.get(hash) ?? 0 }
  }

  /** Forget queued work (project closed). A running job finishes into its own project. */
  clear() {
    this.queue = []
  }

  private state(hash: string, state: NotesState) {
    this.emit('state', { hash, state })
  }

  private async pump() {
    if (this.running) return
    const job = this.queue.shift()
    if (!job) return
    this.running = job
    this.progress.set(job.hash, 0)
    this.state(job.hash, { status: 'running', progress: 0 })
    try {
      let notes: BassNote[]
      try {
        notes = await this.run(job)
      } catch (err) {
        // An environment installed before a new requirement: install it once and retry.
        if (!(err instanceof Error && err.message.startsWith('missing-module'))) throw err
        await this.env.installMissing()
        notes = await this.run(job)
      }
      await writeFileAtomic(job.file, JSON.stringify(notes))
      if (job.root === this.root()) this.state(job.hash, { status: 'ready', notes })
    } catch (err) {
      if (job.root === this.root()) this.state(job.hash, { status: 'failed', error: err instanceof Error ? err.message : String(err) })
    } finally {
      this.progress.delete(job.hash)
      this.running = null
      void this.pump()
    }
  }

  private run(job: Job): Promise<BassNote[]> {
    return runTranscriber(this.env, job.input, job.tuningCents, this.ffmpeg, (progress) => {
      this.progress.set(job.hash, progress)
      if (job.root === this.root()) this.state(job.hash, { status: 'running', progress })
    })
  }
}

/** Run separation/transcribe.py on a bass recording: notes in the file's own time. */
export function runTranscriber(env: PythonEnv, input: string, tuningCents: number, ffmpeg: string | null, onProgress?: (progress: number) => void): Promise<BassNote[]> {
  const python = env.python()
  const script = env.script('transcribe.py')
  if (!python || !existsSync(script)) return Promise.reject(new Error('The audio environment isn’t installed'))
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, '--input', input, '--tuning-cents', String(tuningCents)], {
      env: { ...process.env, PYTHONUNBUFFERED: '1', ...(ffmpeg ? { NOTA_FFMPEG: ffmpeg } : {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let notes: BassNote[] | null = null
    let error: string | null = null
    child.stderr.on('data', () => {})
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const msg = JSON.parse(line)
        if (msg.type === 'progress') onProgress?.(msg.progress)
        else if (msg.type === 'done') notes = msg.notes
        else if (msg.type === 'error') error = msg.message
      } catch {
        // ignore non-protocol output
      }
    })
    child.on('error', reject)
    child.on('close', () => (notes ? resolve(notes) : reject(new Error(error ?? 'Transcription failed'))))
  })
}
