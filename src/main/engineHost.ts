import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import readline from 'node:readline'
import type { EngineDeviceState, EngineMeters, EngineSnapshot, EngineStatus } from '../shared/types'
import { engineExecutable } from './platform'

// Spawns and supervises the native audio engine (native/, JUCE). Requests
// and responses are JSON lines; the engine also pushes meters (30 Hz), song
// transport reports (60 Hz while playing) and device events. If the engine
// crashes it is restarted with monitoring off (and the song paused).

export function resolveEngineBinary(appRoot: string, resourcesPath?: string): string | null {
  const candidates = [
    process.env.NOTA_ENGINE_PATH,
    resourcesPath && join(resourcesPath, engineExecutable()),
    join(appRoot, 'native', 'build', 'NotaEngine_artefacts', 'Release', engineExecutable())
  ]
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? null
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

export class EngineHost extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private stopping = false
  private crashTimes: number[] = []
  private state: EngineSnapshot

  constructor(private readonly binaryPath: string | null) {
    super()
    this.state = {
      status: binaryPath ? 'stopped' : 'not-built',
      message: binaryPath ? null : 'The native audio engine has not been built. Run "npm run engine:build".',
      binaryPath,
      formats: [],
      device: null,
      monitoring: false
    }
  }

  snapshot(): EngineSnapshot {
    return this.state
  }

  get running() {
    return this.state.status === 'running'
  }

  private setState(patch: Partial<EngineSnapshot>) {
    this.state = { ...this.state, ...patch }
    this.emit('snapshot', this.state)
  }

  start() {
    if (!this.binaryPath || this.child) return
    this.stopping = false
    this.setState({ status: 'starting', message: null })

    const child = spawn(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    child.stderr.on('data', () => {}) // plugin chatter; deliberately ignored
    // A write just after the engine died fails with EPIPE before 'exit' arrives;
    // unhandled, that would throw in the main process. 'exit' does the recovery.
    child.stdin.on('error', () => {})

    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line))

    child.on('error', (err) => {
      this.setState({ status: 'crashed', message: `Could not start the audio engine: ${err.message}` })
    })
    child.on('exit', (code, signal) => {
      this.child = null
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('The audio engine stopped'))
      }
      this.pending.clear()
      if (this.stopping) {
        this.setState({ status: 'stopped', monitoring: false })
        return
      }
      const now = Date.now()
      this.crashTimes = [...this.crashTimes.filter((t) => now - t < 60_000), now]
      const reason = signal ? `signal ${signal}` : `exit code ${code}`
      if (this.crashTimes.length > 3) {
        this.setState({ status: 'crashed', monitoring: false, message: `The audio engine keeps crashing (${reason}). A plugin in the chain may be at fault.` })
        return
      }
      this.setState({ status: 'crashed', monitoring: false, message: `The audio engine stopped unexpectedly (${reason}). Restarting…` })
      setTimeout(() => this.start(), 800)
    })
  }

  /** Manual restart after repeated crashes. */
  restart() {
    this.crashTimes = []
    if (this.child) {
      this.child.once('exit', () => this.start())
      this.stop()
    } else this.start()
  }

  stop() {
    this.stopping = true
    if (!this.child) return
    try {
      this.child.stdin.write(JSON.stringify({ id: 0, cmd: 'quit' }) + '\n')
      this.child.stdin.end()
    } catch {
      // already gone
    }
    const child = this.child
    setTimeout(() => child.kill('SIGKILL'), 2000).unref()
  }

  call<T = unknown>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    if (!this.child || this.state.status !== 'running')
      return Promise.reject(new Error(this.state.message ?? 'The audio engine is not running'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`The audio engine did not answer "${cmd}" in time`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.child!.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n')
    })
  }

  private onLine(line: string) {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    switch (msg.type) {
      case 'response': {
        const p = this.pending.get(Number(msg.id))
        if (!p) return
        this.pending.delete(Number(msg.id))
        clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new Error(String(msg.error ?? 'Engine error')))
        return
      }
      case 'ready':
        this.setState({
          status: 'running',
          message: null,
          formats: (msg.formats as string[]) ?? [],
          device: msg.device as EngineDeviceState,
          monitoring: false
        })
        this.emit('ready')
        return
      case 'meters':
        this.emit('meters', msg as unknown as EngineMeters)
        return
      case 'transport':
        this.emit('transport', msg)
        return
      case 'deviceChanged':
        this.updateDevice(msg.state as EngineDeviceState)
        return
      case 'deviceError':
        this.setState({ device: { ...(this.state.device ?? {}), error: String(msg.message) } })
        return
      case 'tuner':
        this.emit('tuner', { hz: Number(msg.hz) || 0, clarity: Number(msg.clarity) || 0, rmsDb: Number(msg.rmsDb) })
        return
      case 'editorClosed':
        this.emit('editorClosed', msg.slotId)
        return
    }
  }

  updateDevice(device: EngineDeviceState) {
    this.setState({ device, monitoring: device.monitoring ?? this.state.monitoring })
  }

  setMonitoringFlag(monitoring: boolean) {
    this.setState({ monitoring })
  }

  setStatus(status: EngineStatus, message: string | null) {
    this.setState({ status, message })
  }
}
