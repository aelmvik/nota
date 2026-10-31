import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import readline from 'node:readline'
import {
  SeparationCancelledError,
  type ProviderAvailability,
  type SeparationProvider,
  type SeparationRequest,
  type SeparationResult
} from './provider'
import type { PythonEnv } from '../pythonEnv'

// Runs separation/separate.py (Hybrid Transformer Demucs) in a Python venv.
// The backing track is the sum of the separated drums, vocals and "other"
// stems: a genuine source-separation result, not a phase-cancelled mix.

export interface DemucsOptions {
  env: PythonEnv
  model?: string
  ffmpegPath?: string | null
}

export class DemucsProvider implements SeparationProvider {
  readonly name = 'Demucs'
  /** Changeable from Settings; new separations use it, existing stems keep theirs. */
  model: string
  private availability: Promise<ProviderAvailability> | null = null

  constructor(private readonly opts: DemucsOptions) {
    this.model = opts.model ?? 'htdemucs'
  }

  private get python() {
    return this.opts.env.python() ?? ''
  }

  private get script() {
    return this.opts.env.script('separate.py')
  }

  checkAvailability(): Promise<ProviderAvailability> {
    this.availability ??= this.runCheck()
    return this.availability
  }

  setModel(model: string) {
    this.model = model
  }

  /** Forget the cached check, e.g. after installing the environment. */
  resetAvailability() {
    this.availability = null
  }

  private async runCheck(): Promise<ProviderAvailability> {
    if (!this.python || !existsSync(this.python))
      return { available: false, reason: 'Stem separation is not installed yet.' }
    if (!existsSync(this.script)) return { available: false, reason: `Missing ${this.script}` }

    return new Promise((resolve) => {
      const child = spawn(this.python, [this.script, '--check'], { env: this.env(), stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.on('error', (e) => resolve({ available: false, reason: e.message }))
      child.on('close', () => {
        try {
          const info = JSON.parse(out.trim().split('\n').pop() ?? '{}')
          resolve(info.ok ? { available: true, device: info.device } : { available: false, reason: info.message ?? 'Demucs is not usable' })
        } catch {
          resolve({ available: false, reason: 'The separation environment did not respond' })
        }
      })
    })
  }

  private env() {
    return {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTORCH_ENABLE_MPS_FALLBACK: '1',
      ...(this.opts.ffmpegPath ? { NOTA_FFMPEG: this.opts.ffmpegPath } : {})
    }
  }

  separate(req: SeparationRequest): Promise<SeparationResult> {
    return new Promise((resolve, reject) => {
      if (req.signal.aborted) return reject(new SeparationCancelledError())

      const child = spawn(this.python, [this.script, '--input', req.inputPath, '--out-dir', req.outDir, '--model', this.model], {
        env: this.env(),
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stderr = ''
      let result: SeparationResult | null = null
      let error: string | null = null

      const onAbort = () => child.kill('SIGTERM')
      req.signal.addEventListener('abort', onAbort, { once: true })

      child.stderr.on('data', (d) => {
        stderr = (stderr + d).slice(-4000)
      })

      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (msg.type === 'progress') req.onProgress(Number(msg.progress) || 0, String(msg.stage ?? 'separating'))
        else if (msg.type === 'error') error = String(msg.message)
        else if (msg.type === 'done') {
          const bass = msg.bass as { path: string; rmsDb: number }
          const backing = msg.backing as { path: string; rmsDb: number }
          result = { model: this.model, bass, backing }
        }
      })

      child.on('error', (e) => reject(e))
      child.on('close', (code) => {
        req.signal.removeEventListener('abort', onAbort)
        if (req.signal.aborted) return reject(new SeparationCancelledError())
        if (code === 0 && result) return resolve(result)
        const tail = stderr.trim().split('\n').filter(Boolean).pop()
        reject(new Error(error ?? tail ?? `The separation process exited with code ${code}`))
      })
    })
  }
}
