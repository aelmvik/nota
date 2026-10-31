import { mkdir } from 'node:fs/promises'
import type { SeparationEvent } from '../shared/processing'
import type { StemAsset, StemKind } from '../shared/types'
import { SeparationCancelledError, type SeparationProvider } from './separation/provider'

// Background separation queue. Jobs are keyed by source hash (the same audio
// is only ever separated once) and run one at a time: separation saturates
// the GPU/CPU, and running several in parallel would only slow each down.
// Nothing here touches the real-time audio path.

export interface SeparationJob {
  hash: string
  inputPath: string
  durationSec: number
  label: string
}

export interface StemCache {
  stemDir(hash: string, model: string): string
  findValidStems(hash: string, model: string, durationSec: number): Promise<{ assets: Record<StemKind, StemAsset>; warning?: string } | null>
  commitStems(
    hash: string,
    model: string,
    durationSec: number,
    reported: { bass: { path: string; rmsDb: number }; backing: { path: string; rmsDb: number } }
  ): Promise<{ assets: Record<StemKind, StemAsset>; warning?: string }>
}

export type QueueListener = (hash: string, event: SeparationEvent, stems?: Record<StemKind, StemAsset>) => void

export class SeparationQueue {
  private queue: SeparationJob[] = []
  /** `quiet`: dropped by clear(), so its end isn't reported (another project may have the same song queued) */
  private running: { job: SeparationJob; controller: AbortController; quiet?: boolean } | null = null
  private disposed = false
  private idleWaiters: (() => void)[] = []

  constructor(
    private readonly provider: SeparationProvider,
    private readonly cache: StemCache,
    private readonly listener: QueueListener
  ) {}

  get model() {
    return this.provider.model
  }

  /** Queued or running; a cancelled job that is still shutting down doesn't count, so the song can be queued again. */
  has(hash: string): boolean {
    return (this.running?.job.hash === hash && !this.running.controller.signal.aborted) || this.queue.some((j) => j.hash === hash)
  }

  pendingCount(): number {
    return this.queue.length + (this.running ? 1 : 0)
  }

  async enqueue(job: SeparationJob): Promise<void> {
    if (this.disposed || this.has(job.hash)) return
    const availability = await this.provider.checkAvailability()
    if (!availability.available) {
      this.listener(job.hash, { type: 'unavailable', reason: availability.reason ?? 'Separation is not available' })
      return
    }
    if (this.has(job.hash)) return
    this.queue.push(job)
    this.listener(job.hash, { type: 'enqueue' })
    void this.pump()
  }

  /** Move a waiting job to the front, e.g. when the user selects that song. */
  prioritize(hash: string) {
    const i = this.queue.findIndex((j) => j.hash === hash)
    if (i > 0) this.queue.unshift(...this.queue.splice(i, 1))
  }

  cancel(hash: string) {
    if (this.running?.job.hash === hash) {
      this.running.controller.abort()
      return
    }
    const before = this.queue.length
    this.queue = this.queue.filter((j) => j.hash !== hash)
    if (this.queue.length !== before) this.listener(hash, { type: 'cancel' })
  }

  /** Stop everything (project closed). No events are emitted for dropped jobs. */
  clear() {
    this.queue = []
    if (this.running) {
      this.running.quiet = true
      this.running.controller.abort()
    }
  }

  dispose() {
    this.disposed = true
    this.clear()
  }

  /** Resolves once the queue has drained (used by tests and shutdown). */
  whenIdle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve()
    return new Promise((r) => this.idleWaiters.push(r))
  }

  private async pump() {
    if (this.running || this.disposed) return
    const job = this.queue.shift()
    if (!job) {
      this.idleWaiters.splice(0).forEach((r) => r())
      return
    }

    const controller = new AbortController()
    const running: { job: SeparationJob; controller: AbortController; quiet?: boolean } = { job, controller }
    this.running = running
    const model = this.provider.model
    const emit = (e: SeparationEvent, stems?: Record<StemKind, StemAsset>) => {
      if (!controller.signal.aborted || e.type === 'cancel') this.listener(job.hash, e, stems)
    }

    emit({ type: 'start', model })
    try {
      const cached = await this.cache.findValidStems(job.hash, model, job.durationSec)
      if (cached) {
        emit({ type: 'succeed', model, warning: cached.warning }, cached.assets)
      } else {
        const outDir = this.cache.stemDir(job.hash, model)
        await mkdir(outDir, { recursive: true })
        const result = await this.provider.separate({
          inputPath: job.inputPath,
          outDir,
          signal: controller.signal,
          onProgress: (progress, stage) => emit({ type: 'progress', progress, stage })
        })
        if (controller.signal.aborted) throw new SeparationCancelledError()
        emit({ type: 'progress', progress: 0.97, stage: 'validating' })
        const committed = await this.cache.commitStems(job.hash, model, job.durationSec, result)
        emit({ type: 'succeed', model, warning: committed.warning }, committed.assets)
      }
    } catch (err) {
      if (controller.signal.aborted || err instanceof SeparationCancelledError) {
        if (!this.disposed && !running.quiet) this.listener(job.hash, { type: 'cancel' })
      } else {
        emit({ type: 'fail', error: err instanceof Error ? err.message : String(err) })
      }
    } finally {
      this.running = null
      void this.pump()
    }
  }
}
