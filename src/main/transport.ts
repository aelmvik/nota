import { EventEmitter } from 'node:events'
import type { TransportCommand, TransportLoad, TransportLoadResult } from '../shared/api'
import type { EngineTrackSource, TransportState } from '../shared/types'
import type { EngineHost } from './engineHost'

// Song playback in the native engine. The renderer sends transport commands
// here; this resolves track paths (only files that belong to the open
// project), forwards everything to the engine and relays its position
// reports back.
//
// It also remembers what the renderer asked for. If the engine crashes, the
// song is loaded again when it comes back, paused where it was, with the same
// speed, key, loop and metronome, and the renderer is told that playback
// stopped.

type Resolver = (source: EngineTrackSource) => string | null

/** Commands whose latest value is the whole state (replayed after a restart). */
const STATEFUL = new Set(['speed', 'pitch', 'returnToStart', 'metronome', 'beats', 'lightweight', 'loop', 'cuts'])

export class TransportService extends EventEmitter {
  private loadRequest: (TransportLoad & { seq: number }) | null = null
  private params = new Map<string, Record<string, unknown>>()
  private last: TransportState | null = null
  private seq = 0
  private wasRunning = false

  constructor(
    private readonly engine: EngineHost,
    private readonly resolve: Resolver
  ) {
    super()
    engine.on('transport', (s: TransportState) => {
      // Remember where the loaded song is (a freshly started engine reports no song).
      if (s.songId && s.songId === this.loadRequest?.songId) this.last = s
      this.emit('state', s)
    })
    engine.on('snapshot', () => {
      const running = this.engine.running
      if (this.wasRunning && !running && this.loadRequest) {
        const message = this.engine.snapshot().message ?? 'The audio engine stopped'
        this.emit('interrupted', { wasPlaying: !!this.last?.playing, message })
      }
      this.wasRunning = running
    })
    engine.on('ready', () => void this.replay())
  }

  private tracksFor(tracks: (EngineTrackSource | null)[]) {
    return [0, 1, 2].map((i) => {
      const t = tracks[i]
      const path = t ? this.resolve(t) : null
      return path ? { path } : null
    })
  }

  async load(req: TransportLoad & { seq: number }): Promise<TransportLoadResult> {
    this.loadRequest = req
    this.seq = Math.max(this.seq, req.seq)
    this.last = null
    // Not running yet (app start) or restarting: the song is loaded when it's ready.
    if (!this.engine.running) return { durationSec: 0, tracks: [] }
    return this.engine.call<TransportLoadResult>(
      'song.load',
      { songId: req.songId, tracks: this.tracksFor(req.tracks), position: req.position, mode: req.mode, seq: req.seq },
      20_000
    )
  }

  async setTracks(tracks: (EngineTrackSource | null)[], seq: number): Promise<TransportLoadResult> {
    this.seq = Math.max(this.seq, seq)
    if (this.loadRequest) this.loadRequest = { ...this.loadRequest, tracks }
    if (!this.engine.running) return { durationSec: 0, tracks: [] }
    return this.engine.call<TransportLoadResult>('song.tracks', { tracks: this.tracksFor(tracks), seq }, 20_000)
  }

  send(command: TransportCommand & { seq: number }) {
    const { cmd, ...args } = command
    this.seq = Math.max(this.seq, command.seq)
    if (cmd === 'unload') {
      this.loadRequest = null
      this.last = null
    } else if (cmd === 'mode' && this.loadRequest) {
      this.loadRequest = { ...this.loadRequest, mode: (args as { mode: number }).mode }
    } else if (cmd === 'volume') {
      this.params.set('volume', { ...(this.params.get('volume') ?? {}), ...args })
    } else if (STATEFUL.has(cmd)) {
      this.params.set(cmd, args)
    }
    if (!this.engine.running) return
    void this.engine.call(`song.${cmd}`, args).catch(() => {})
  }

  /** After an engine (re)start: everything the renderer asked for, paused where it was. */
  private async replay() {
    for (const [cmd, args] of this.params) await this.engine.call(`song.${cmd}`, { ...args, seq: this.seq }).catch(() => {})
    const req = this.loadRequest
    if (!req) return
    const position = this.last && this.last.songId === req.songId ? this.last.position : req.position
    try {
      await this.engine.call(
        'song.load',
        { songId: req.songId, tracks: this.tracksFor(req.tracks), position, mode: req.mode, seq: this.seq },
        20_000
      )
    } catch {
      // the engine went away again; the next ready event retries
    }
  }
}
