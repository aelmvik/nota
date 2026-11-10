import { EventEmitter } from 'node:events'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { takeFromRecording, type Take, type TakeMarks, type TakeState } from '../shared/takes'
import type { EngineHost } from './engineHost'
import { writeFileAtomic } from './projectStore'
import type { PythonEnv } from './pythonEnv'
import { runTranscriber } from './transcription'

// Takes: the engine records your bass while you play along (clean, before its
// effects), the recording is transcribed with the same decoder as the songs,
// and the notes are mapped onto the song (src/shared/takes.ts). Only the
// latest take per song is kept, as notes; the recording itself is deleted.

/** The longest take: the engine stops writing there, and the take is ended and turned into notes. */
export const MAX_TAKE_SECONDS = 30 * 60

export class TakeService extends EventEmitter {
  private recording: { hash: string; root: string; path: string; limit: NodeJS.Timeout } | null = null

  constructor(
    private readonly engine: EngineHost,
    private readonly env: PythonEnv,
    /** The open project's Generated folder */
    private readonly root: () => string,
    private readonly ffmpeg: string | null,
    /** The tuner's reference pitch (A4), so a bass tuned to it reads as in tune */
    private readonly a4: () => number
  ) {
    super()
  }

  private file(hash: string, root = this.root()) {
    return join(root, hash, 'take.json')
  }

  private state(hash: string, state: TakeState) {
    this.emit('state', { hash, state })
  }

  get recordingHash(): string | null {
    return this.recording?.hash ?? null
  }

  async read(hash: string): Promise<Take | null> {
    try {
      return JSON.parse(await readFile(this.file(hash), 'utf8')) as Take
    } catch {
      return null
    }
  }

  async start(hash: string) {
    if (this.recording) await this.stop()
    const root = this.root()
    const path = join(root, hash, 'take-recording.wav')
    await this.engine.call('startTake', { path, maxSeconds: MAX_TAKE_SECONDS })
    const limit = setTimeout(() => void this.stop(), MAX_TAKE_SECONDS * 1000)
    limit.unref()
    this.recording = { hash, root, path, limit }
    this.state(hash, { status: 'recording' })
  }

  /** Stop recording (if anything is) and turn the take into notes. */
  async stop() {
    const rec = this.recording
    if (!rec) return
    this.recording = null
    clearTimeout(rec.limit)
    this.state(rec.hash, { status: 'transcribing' })
    const marksPath = `${rec.path}.json`
    try {
      await this.engine.call('stopTake', {}, 30_000)
      const marks = JSON.parse(await readFile(marksPath, 'utf8')) as TakeMarks
      const cents = 1200 * Math.log2(this.a4() / 440)
      const notes = await runTranscriber(this.env, rec.path, cents, this.ffmpeg)
      const take = takeFromRecording(marks, notes)
      if (!take.notes.length) throw new Error('No notes were heard in the take. Is the bass coming into the input?')
      await writeFileAtomic(this.file(rec.hash, rec.root), JSON.stringify(take))
      if (rec.root === this.root()) this.state(rec.hash, { status: 'ready', take })
    } catch (err) {
      if (rec.root === this.root()) this.state(rec.hash, { status: 'failed', error: err instanceof Error ? err.message : String(err) })
    } finally {
      await rm(rec.path, { force: true }).catch(() => {})
      await rm(marksPath, { force: true }).catch(() => {})
    }
  }

  /** Stop recording and throw the take away, without turning it into notes (Nøta is quitting). */
  async discard() {
    const rec = this.recording
    if (!rec) return
    this.recording = null
    clearTimeout(rec.limit)
    await this.engine.call('stopTake', {}, 5000).catch(() => {})
    await rm(rec.path, { force: true }).catch(() => {})
    await rm(`${rec.path}.json`, { force: true }).catch(() => {})
  }

  async clear(hash: string) {
    await rm(this.file(hash), { force: true }).catch(() => {})
    this.state(hash, { status: 'none' })
  }
}
