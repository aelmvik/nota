import type { Beat } from '../../shared/music'
import type { EngineTrackSource, LoopRegion, PlaybackMode } from '../../shared/types'

// What the UI needs from song playback. NativePlayer implements it: the song
// plays in the native engine, on the same clock as the bass and the metronome.

export interface PlayerState {
  songId: string | null
  playing: boolean
  mode: PlaybackMode | null
  duration: number
  buffering: boolean
  error: string | null
}

export type Sources = Partial<Record<PlaybackMode, EngineTrackSource>>

export interface LoadOptions {
  mode: PlaybackMode
  position: number
  speed: number
  volume: number
  loop: LoopRegion | null
  duration: number
}

export interface Player {
  subscribe(fn: (s: PlayerState) => void): () => void
  /** Fires each time playback jumps from the loop end back to its start. */
  onLoopWrap(fn: () => void): () => void
  onEnded(fn: () => void): () => void
  getState(): PlayerState
  /** Position in seconds; cheap enough to read every frame. */
  readonly currentTime: number
  readonly isPlaying: boolean
  readonly speedValue: number
  /** Return to the start point on stop and at the end of the song */
  returnToStart: boolean
  /** Seconds between `currentTime` and what you hear (for tap tempo) */
  readonly heardDelay: number
  /** Peak level of song playback after the Song fader, for the Song meter */
  getPlaybackPeak(): number

  load(songId: string, sources: Sources, opts: LoadOptions): Promise<void>
  /** Stems arrived: add or swap tracks without interrupting playback. */
  updateSources(sources: Sources): void
  unload(): void
  setMode(mode: PlaybackMode): Promise<void>
  play(): Promise<void>
  /** Count-in clicks, then play, on one clock. */
  countInAndPlay(count: number, period: number, perBar: number): Promise<void>
  pause(): void
  stop(): void
  seek(time: number): void
  skip(delta: number): void
  setSpeed(speed: number): void
  setVolume(volume: number): void
  setMasterVolume(volume: number): void
  setLoop(loop: LoopRegion | null): void
  /** Practice cuts: regions playback skips */
  setCuts(regions: { start: number; end: number }[]): void
  setPitchRatio(ratio: number): void
  dispose(): void
}

/** The click track that follows the song's beat grid. */
export interface Clicker {
  setVolume(v: number): void
  /** Beat times for the click; `accent` makes each bar's first beat louder */
  setBeats(beats: Beat[], accent: boolean): void
  setEnabled(on: boolean): void
  dispose(): void
}

export const MODE_SLOT: Record<PlaybackMode, number> = { original: 0, bass: 1, playalong: 2 }
export const SLOT_MODE: PlaybackMode[] = ['original', 'bass', 'playalong']
