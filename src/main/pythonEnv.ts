import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { venvPython } from './platform'

// Locates (or installs) the Python environment that runs Demucs and the
// analysis and transcription workers. A packaged .app can't ship a
// relocatable PyTorch, so the app installs one into Application Support on
// request with the bundled uv: uv downloads a standalone Python (nothing
// needs to be installed on the Mac) and the packages in requirements.txt.
// Development builds also accept separation/.venv.

/** The Python the environment is created with (the version requirements.txt is tested on). */
const PYTHON_VERSION = '3.13'

export interface SetupProgress {
  running: boolean
  line: string | null
  error: string | null
  done: boolean
}

export class PythonEnv extends EventEmitter {
  private progress: SetupProgress = { running: false, line: null, error: null, done: false }

  constructor(
    /** Directory containing separate.py, analyze.py and requirements.txt */
    readonly scriptsDir: string,
    /** Where the app installs its own environment */
    readonly managedEnvDir: string,
    /** The bundled uv binary, or null if it's missing (a development build without `npm run tools:build`) */
    private readonly uv: string | null,
    /** Extra environments to try (e.g. the repo's dev venv) */
    private readonly extraCandidates: string[] = []
  ) {
    super()
  }

  get managedPython() {
    return venvPython(this.managedEnvDir)
  }

  /** The interpreter to use, or null if none is installed. */
  python(): string | null {
    const candidates = [process.env.NOTA_PYTHON, this.managedPython, ...this.extraCandidates]
    return candidates.find((c): c is string => !!c && existsSync(c)) ?? null
  }

  /** Whether the environment can be installed (the bundled uv is there). */
  canInstall(): boolean {
    return !!this.uv
  }

  script(name: 'separate.py' | 'analyze.py' | 'transcribe.py') {
    return join(this.scriptsDir, name)
  }

  private set(p: Partial<SetupProgress>) {
    this.progress = { ...this.progress, ...p }
    this.emit('progress', this.progress)
  }

  /** uv with its downloads kept beside the environment, so removing the app's data removes them too. */
  private uvRun(args: string[], onLine?: (line: string) => void): Promise<void> {
    const uv = this.uv
    if (!uv) return Promise.reject(new Error('The bundled uv is missing'))
    const home = dirname(this.managedEnvDir)
    return new Promise((resolve, reject) => {
      const child = spawn(uv, args, {
        env: {
          ...process.env,
          UV_PYTHON_INSTALL_DIR: join(home, 'python'),
          UV_CACHE_DIR: join(home, 'uv-cache'),
          UV_PYTHON_PREFERENCE: 'only-managed',
          UV_NO_PROGRESS: '1',
          NO_COLOR: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let tail = ''
      const onData = (d: Buffer) => {
        const text = d.toString()
        tail = (tail + text).slice(-2000)
        const line = text.split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean).pop()
        if (line) onLine?.(line.slice(0, 160))
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(tail.trim().split('\n').pop() || 'uv failed'))))
    })
  }

  private installRequirements(python: string, onLine?: (line: string) => void) {
    // Windows: compile the bytecode now. Otherwise the first separation or Notes
    // view compiles it (and Defender scans every new file): measured 38 s at 0 %.
    const compile = process.platform === 'win32' ? ['--compile-bytecode'] : []
    return this.uvRun(['pip', 'install', ...compile, '--python', python, '-r', join(this.scriptsDir, 'requirements.txt')], onLine)
  }

  /** Download cache: the packages are cloned into the environment, so it's only needed during an install. */
  private clearCache() {
    return rm(join(dirname(this.managedEnvDir), 'uv-cache'), { recursive: true, force: true }).catch(() => {})
  }

  /**
   * Install requirements an existing environment is missing (an update can
   * add one, like onnxruntime for the Notes view), without touching the
   * setup progress shown in Settings.
   */
  async installMissing(): Promise<void> {
    const python = this.python()
    if (!python) throw new Error('The audio environment isn’t installed')
    try {
      await this.installRequirements(python)
    } finally {
      await this.clearCache()
    }
  }

  /** Create the managed environment: a standalone Python, then PyTorch, Demucs, librosa and the rest. */
  async install(): Promise<void> {
    if (this.progress.running) throw new Error('Installation is already running')
    this.set({ running: true, error: null, done: false, line: `Downloading Python ${PYTHON_VERSION}…` })
    const log = (line: string) => this.set({ line })
    try {
      await this.uvRun(['venv', '--clear', '--python', PYTHON_VERSION, this.managedEnvDir], log)
      this.set({ line: 'Downloading PyTorch, Demucs and librosa (about 1 GB)…' })
      await this.installRequirements(this.managedPython, log)
      this.set({ running: false, done: true, line: 'Installed' })
    } catch (err) {
      this.set({ running: false, error: err instanceof Error ? err.message : String(err), line: null })
      throw err
    } finally {
      await this.clearCache()
    }
  }
}
