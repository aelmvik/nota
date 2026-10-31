// A SeparationProvider turns one mixed song into an isolated bass stem and a
// backing track without bass. The job queue only talks to this interface,
// so Demucs can be replaced (another local model, a remote service) without
// touching the rest of the app.

export interface SeparationRequest {
  inputPath: string
  outDir: string
  signal: AbortSignal
  onProgress: (progress: number, stage: string) => void
}

export interface SeparationResult {
  model: string
  bass: { path: string; rmsDb: number }
  backing: { path: string; rmsDb: number }
}

export interface ProviderAvailability {
  available: boolean
  device?: string
  reason?: string
}

export interface SeparationProvider {
  readonly name: string
  /** Identifies the model; part of the cache key so changing it regenerates stems. */
  readonly model: string
  checkAvailability(): Promise<ProviderAvailability>
  separate(request: SeparationRequest): Promise<SeparationResult>
}

export class SeparationCancelledError extends Error {
  constructor() {
    super('Separation was cancelled')
  }
}
