import type { TransportCommand } from '../../shared/api'
import type { Beat } from '../../shared/music'
import type { EngineTrackSource, LoopRegion, PlaybackMode, TransportState } from '../../shared/types'
import { MODE_SLOT, SLOT_MODE, type Clicker, type LoadOptions, type Player, type PlayerState, type Sources } from './player'

// Song playback in the native engine. The engine owns the transport; this
// sends it commands and turns its position reports (about 60 a second, each
// dated to when that audio is heard) into a smooth playhead.
//
// Commands carry a sequence number that the engine echoes back once it has
// applied them. Until then, what the UI asked for (a seek, play, stop) is
// shown straight away, so the playhead never jumps back to a stale report.

const now = () => performance.timeOrigin + performance.now()

/** One sequence for every transport command this window sends. */
let lastSeq = 0
const nextSeq = () => ++lastSeq

export class NativePlayer implements Player {
  private api = window.nota.transport
  private state: PlayerState = { songId: null, playing: false, mode: null, duration: 0, buffering: false, error: null }
  private listeners = new Set<(s: PlayerState) => void>()
  private endListeners = new Set<() => void>()
  private wrapListeners = new Set<() => void>()
  private report: TransportState | null = null
  /** What we asked for, shown until a report with seq >= `seq` arrives */
  private local: { seq: number; position: number; since: number; playing: boolean } | null = null
  private speed = 1
  private loop: LoopRegion | null = null
  private cue = 0
  private counters: { wraps: number; ended: number } | null = null
  private tracksKey = ''
  private loadToken = 0
  private peak = 0
  private lastTime = 0
  private returnToStartValue = true
  private countInWaiters: { seq: number; resolve: () => void }[] = []
  private offs: (() => void)[] = []

  constructor() {
    this.offs.push(
      this.api.onState((s) => this.onReport(s)),
      this.api.onInterrupted(() => {
        this.local = null
        this.report = null
        this.resolveCountIns(Infinity)
        if (this.state.songId) this.set({ playing: false, buffering: false, error: 'The audio engine stopped' })
      }),
      window.nota.engine.onMeters((m) => (this.peak = m.songPeak ?? 0))
    )
  }

  private send(command: TransportCommand): number {
    const seq = nextSeq()
    this.api.send({ ...command, seq } as TransportCommand & { seq: number })
    return seq
  }

  private set(patch: Partial<PlayerState>) {
    const next = { ...this.state, ...patch }
    if (Object.entries(patch).every(([k, v]) => this.state[k as keyof PlayerState] === v)) return
    this.state = next
    for (const l of this.listeners) l(this.state)
  }

  private onReport(s: TransportState) {
    if (!this.state.songId || s.songId !== this.state.songId) return
    this.report = s
    if (this.local && s.seq >= this.local.seq) this.local = null
    this.resolveCountIns(s.state === 'countIn' ? s.seq - 1 : s.seq)

    // Loop wraps and song ends, as counted by the engine.
    if (!this.counters) this.counters = { wraps: s.wraps, ended: s.ended }
    if (s.wraps > this.counters.wraps) for (const l of this.wrapListeners) l()
    if (s.ended > this.counters.ended) for (const l of this.endListeners) l()
    this.counters = { wraps: s.wraps, ended: s.ended }

    if (this.local) return
    const playing = s.state === 'playing' || s.state === 'starting'
    this.set({ playing, buffering: s.buffering || s.state === 'starting', mode: SLOT_MODE[s.mode] ?? this.state.mode, error: null })
  }

  private resolveCountIns(upTo: number) {
    const done = this.countInWaiters.filter((w) => w.seq <= upTo)
    this.countInWaiters = this.countInWaiters.filter((w) => w.seq > upTo)
    for (const w of done) w.resolve()
  }

  subscribe(fn: (s: PlayerState) => void) {
    this.listeners.add(fn)
    fn(this.state)
    return () => void this.listeners.delete(fn)
  }

  onLoopWrap(fn: () => void) {
    this.wrapListeners.add(fn)
    return () => void this.wrapListeners.delete(fn)
  }

  onEnded(fn: () => void) {
    this.endListeners.add(fn)
    return () => void this.endListeners.delete(fn)
  }

  getState() {
    return this.state
  }

  get speedValue() {
    return this.speed
  }

  get isPlaying() {
    return this.state.playing
  }

  /** Reports are already dated to when the audio is heard. */
  get heardDelay() {
    return 0
  }

  get returnToStart() {
    return this.returnToStartValue
  }

  set returnToStart(on: boolean) {
    this.returnToStartValue = on
    this.send({ cmd: 'returnToStart', enabled: on })
  }

  getPlaybackPeak() {
    return this.peak
  }

  get currentTime(): number {
    const max = this.state.duration || this.report?.durationSec || Infinity
    let t: number
    const l = this.local
    if (l) t = l.playing ? l.position + ((now() - l.since) / 1000) * this.speed : l.position
    else if (this.report) {
      const r = this.report
      t = r.state === 'playing' ? r.position + ((now() - r.at) / 1000) * r.rate : r.position
      // Between reports, follow the loop around instead of overshooting its end.
      const loop = this.loop
      if (r.state === 'playing' && loop?.enabled && r.position < loop.end && t >= loop.end) t = loop.start + (t - loop.end)
    } else return this.cue
    t = Math.max(0, Math.min(max, t))
    // Reports carry a little timing jitter; never let the playhead step back by a hair.
    if (this.state.playing && t < this.lastTime && this.lastTime - t < 0.02) t = this.lastTime
    this.lastTime = t
    return t
  }

  private predict(position: number, playing: boolean, seq: number) {
    this.local = { seq, position, since: now(), playing }
    this.lastTime = position
  }

  private tracksFor(sources: Sources): (EngineTrackSource | null)[] {
    return SLOT_MODE.map((m) => {
      const s = sources[m]
      return s ?? null
    })
  }

  async load(songId: string, sources: Sources, opts: LoadOptions) {
    const token = ++this.loadToken
    this.resolveCountIns(Infinity)
    const tracks = this.tracksFor(sources)
    const mode = sources[opts.mode] ? opts.mode : (SLOT_MODE.find((m) => sources[m]) ?? null)
    this.report = null
    this.counters = null
    this.speed = opts.speed
    this.loop = opts.loop
    this.cue = opts.position
    this.tracksKey = JSON.stringify(tracks)
    this.set({ songId, mode, playing: false, buffering: false, error: null, duration: opts.duration })
    this.send({ cmd: 'speed', speed: opts.speed })
    this.send({ cmd: 'volume', song: opts.volume })
    this.sendLoop(opts.loop)
    const seq = nextSeq()
    this.predict(opts.position, false, seq)
    try {
      const result = await this.api.load({ songId, tracks, position: opts.position, mode: MODE_SLOT[mode ?? 'original'], seq })
      if (token !== this.loadToken) return
      const failed = mode && result.tracks.find((t) => t.slot === MODE_SLOT[mode] && !t.ok)
      if (failed) this.set({ error: 'This audio file could not be played' })
    } catch (err) {
      if (token !== this.loadToken) return
      this.set({ error: err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err) })
    }
  }

  updateSources(sources: Sources) {
    if (!this.state.songId) return
    const tracks = this.tracksFor(sources)
    const key = JSON.stringify(tracks)
    if (key !== this.tracksKey) {
      this.tracksKey = key
      void this.api.setTracks(tracks, nextSeq()).catch(() => {})
    }
    if (this.state.mode && !sources[this.state.mode]) {
      const fallback = SLOT_MODE.find((m) => sources[m])
      if (fallback) void this.setMode(fallback)
    }
  }

  unload() {
    ++this.loadToken
    this.resolveCountIns(Infinity)
    this.report = null
    this.local = null
    this.tracksKey = ''
    if (this.state.songId) this.send({ cmd: 'unload' })
    this.set({ songId: null, playing: false, mode: null, duration: 0, buffering: false, error: null })
  }

  async setMode(mode: PlaybackMode) {
    if (mode === this.state.mode) return
    this.set({ mode })
    this.send({ cmd: 'mode', mode: MODE_SLOT[mode] })
  }

  private startPosition() {
    let t = this.currentTime
    const max = this.state.duration
    if (max > 0 && t >= max - 0.02) t = 0
    if (this.loop?.enabled && t >= this.loop.end) t = this.loop.start
    return t
  }

  async play() {
    if (!this.state.songId || this.state.playing) return
    const t = this.startPosition()
    this.cue = t
    const seq = this.send({ cmd: 'play' })
    this.predict(t, true, seq)
    this.set({ playing: true, error: null })
  }

  /** The engine clicks the count-in and starts the song on the next beat, sample-exact. */
  countInAndPlay(count: number, period: number, perBar: number): Promise<void> {
    if (!this.state.songId || this.state.playing) return Promise.resolve()
    const t = this.startPosition()
    this.cue = t
    const seq = this.send({ cmd: 'play', countInBeats: count, countInPeriod: period, beatsPerBar: perBar })
    this.predict(t, false, seq)
    return new Promise((resolve) => {
      this.countInWaiters.push({ seq, resolve })
      // Never leave the UI counting in forever (engine gone, say).
      setTimeout(() => this.resolveCountIns(seq), (count * period + 3) * 1000)
    })
  }

  pause() {
    if (!this.state.songId) return
    const t = this.currentTime
    const seq = this.send({ cmd: 'pause' })
    this.predict(t, false, seq)
    this.set({ playing: false, buffering: false })
  }

  stop() {
    if (!this.state.songId) return
    const t = this.returnToStartValue ? this.cue : this.currentTime
    const seq = this.send({ cmd: 'stop' })
    this.resolveCountIns(Infinity)
    this.predict(t, false, seq)
    this.set({ playing: false, buffering: false })
  }

  toggle() {
    if (this.state.playing) this.stop()
    else void this.play()
  }

  seek(time: number) {
    if (!this.state.songId) return
    const max = this.state.duration
    const to = Math.max(0, Math.min(max > 0 ? max - 0.01 : time, time))
    this.cue = to
    const seq = this.send({ cmd: 'seek', position: to })
    this.predict(to, this.state.playing, seq)
  }

  skip(delta: number) {
    this.seek(this.currentTime + delta)
  }

  setSpeed(speed: number) {
    // Re-anchor the prediction so the playhead doesn't jump when the rate changes.
    if (this.local) this.local = { ...this.local, position: this.currentTime, since: now() }
    this.speed = speed
    this.send({ cmd: 'speed', speed })
  }

  setVolume(volume: number) {
    this.send({ cmd: 'volume', song: volume })
  }

  setMasterVolume(volume: number) {
    this.send({ cmd: 'volume', master: volume })
  }

  private sendLoop(loop: LoopRegion | null) {
    this.send({ cmd: 'loop', start: loop?.start ?? 0, end: loop?.end ?? 0, enabled: !!loop?.enabled })
  }

  setLoop(loop: LoopRegion | null) {
    this.loop = loop
    this.sendLoop(loop)
  }

  setCuts(regions: { start: number; end: number }[]) {
    this.send({ cmd: 'cuts', regions })
  }

  setPitchRatio(ratio: number) {
    this.send({ cmd: 'pitch', ratio })
  }

  dispose() {
    this.unload()
    for (const off of this.offs) off()
  }
}

/** The metronome when the song plays in the engine: the engine clicks on the song's clock. */
export class NativeClicker implements Clicker {
  private enabled = false
  private volume = 0.6

  private send(command: TransportCommand) {
    window.nota.transport.send({ ...command, seq: nextSeq() } as TransportCommand & { seq: number })
  }

  setVolume(v: number) {
    this.volume = v
    this.send({ cmd: 'metronome', enabled: this.enabled, volume: v })
  }

  setEnabled(on: boolean) {
    this.enabled = on
    this.send({ cmd: 'metronome', enabled: on, volume: this.volume })
  }

  setBeats(beats: Beat[], accent: boolean) {
    this.send({ cmd: 'beats', times: beats.map((b) => b.time), accents: beats.map((b) => accent && b.inBar === 0) })
  }

  dispose() {}
}
