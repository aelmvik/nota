// Domain model shared by the main process, preload and renderer.

export type PlaybackMode = 'original' | 'bass' | 'playalong'
export const PLAYBACK_MODES: readonly PlaybackMode[] = ['original', 'bass', 'playalong']

export const MODE_LABELS: Record<PlaybackMode, string> = {
  original: 'Original',
  bass: 'Bass Solo',
  playalong: 'Play Along'
}

export type StemKind = 'bass' | 'backing'

/** Lifecycle of the bass/backing separation for one song. */
export type SeparationStatus =
  | 'pending' // not yet scheduled (e.g. just imported or reopened)
  | 'queued'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'unavailable' // no separation provider is installed

export interface SeparationState {
  status: SeparationStatus
  /** 0..1, only meaningful while processing */
  progress: number
  stage?: string
  error?: string
  warning?: string
  model?: string
}

/** A generated, validated audio file in the asset cache. */
export interface StemAsset {
  kind: StemKind
  /** Path relative to the asset cache root, e.g. "<hash>/htdemucs/bass.flac" */
  cachePath: string
  durationSec: number
  rmsDb: number
  model: string
  createdAt: string
}

export interface TimeRegion {
  start: number
  end: number
}

export interface LoopRegion {
  start: number
  end: number
  enabled: boolean
}

export type AnalysisStatus = 'pending' | 'running' | 'ready' | 'failed' | 'unavailable'

/** Detected musical facts about the original recording. Beat times live in the asset cache. */
export interface SongAnalysis {
  status: AnalysisStatus
  bpm?: number
  key?: string
  keyConfidence?: number
  /** Offset of the recording from A440 in cents (+ = sharp) */
  tuningCents?: number
  beatCount?: number
  /** Detected meter and bar phase (see shared/beats.ts) */
  beatsPerBar?: number
  downbeatIndex?: number
  /** Constant tempo throughout */
  steady?: boolean
  tracker?: string
  /** Analysis format; older results are redone */
  version?: number
  error?: string
}

/** Transpose and fine-tune, applied in real time. */
export interface PitchSettings {
  semitones: number
  cents: number
}

/** A manual beat grid (from tap tempo or typing a BPM); overrides detected beats. */
export interface TempoGrid {
  bpm: number
  /** Song time (s) of one beat; the grid extends both ways from here */
  offset: number
}

/** Gradually raises the speed while a loop repeats. */
export interface SpeedTrainer {
  enabled: boolean
  /** Speed added per step, e.g. 0.02 = +2% */
  step: number
  /** Loop repetitions per step */
  everyLoops: number
  /** Stop increasing here */
  target: number
}

export interface MetronomeSettings {
  enabled: boolean
  /** Linear volume 0..1 */
  volume: number
  /** Bars counted in before playback starts (0 = off) */
  countInBars: number
  /** Click the first beat of each bar louder */
  accent: boolean
}

export interface SongSource {
  path: string
  /** sha256 of the file contents: the stable key for cached assets */
  hash: string
  sizeBytes: number
  format: string
  codec: string | null
  sampleRate: number | null
  channels: number | null
  missing: boolean
}

export interface Song {
  id: string
  title: string
  artist: string | null
  durationSec: number
  source: SongSource
  /** Cache-relative path of a playable transcode when the source codec can't be played directly */
  playbackProxy: string | null
  mode: PlaybackMode
  /** Linear song volume, 0..1.5 */
  volume: number
  /** Playback rate, pitch preserved */
  speed: number
  loop: LoopRegion | null
  /** Practice cuts: parts playback skips and the views leave out (song time, sorted) */
  cuts: TimeRegion[]
  pitch: PitchSettings
  tempo: TempoGrid | null
  /** Meter override; null = use the detected meter */
  beatsPerBar: number | null
  /** Shifts the detected bar lines by this many beats */
  downbeat: number
  /** 0.5 = half time (every other beat), 2 = double time; applies to detected beats */
  gridScale: 0.5 | 1 | 2
  /** Keep the bars evenly counted instead of following detected changes (short bars, shifted downbeats) */
  evenBars: boolean
  trainer: SpeedTrainer | null
  analysis: SongAnalysis
  /** Last playback position in seconds */
  position: number
  separation: SeparationState
  stems: Partial<Record<StemKind, StemAsset>>
  addedAt: string
  /** Seconds this song has been practised (played) */
  practiceSec: number
  /** The bass notes as you corrected them in the Notes view (song time, original key); null = the transcription */
  editedNotes: BassNote[] | null
}

export interface EffectSlot {
  slotId: string
  pluginId: string
  name: string
  manufacturer: string
  format: string
  descriptionXml: string
  bypassed: boolean
  /** Base64 plugin state from getStateInformation() */
  state: string | null
  /** The bass chain (default) or the output chain, which processes everything you hear */
  chain?: EffectChain
}

export type EffectChain = 'input' | 'output'

export interface AudioConfig {
  /** Driver type (Windows: 'Windows Audio' or 'ASIO'); null for the platform's default */
  deviceType: string | null
  inputDevice: string | null
  outputDevice: string | null
  inputChannels: number[]
  sampleRate: number | null
  bufferSize: number | null
  inputTrimDb: number
  monitorLevelDb: number
  /** Song playback gain (software, linear): 1 = 0 dB, up to 2 ≈ +6 dB */
  playbackVolume: number
}

export interface Project {
  format: 'nota-project'
  version: 1
  id: string
  name: string
  createdAt: string
  updatedAt: string
  songs: Song[]
  selectedSongId: string | null
  audio: AudioConfig
  effects: EffectSlot[]
  /** Whether your bass goes through the output chain (otherwise it joins after it) */
  outputIncludesBass: boolean
  metronome: MetronomeSettings
  /** Seconds of practice in this project: a song playing, or bass played with Monitor on */
  practiceSec: number
}

export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error'

export interface ProjectSnapshot {
  project: Project | null
  filePath: string | null
  saveStatus: SaveStatus
  saveError: string | null
  lastSavedAt: string | null
  recent: RecentProject[]
  /** Practice time across all projects, in seconds */
  practice: PracticeTotals
}

/** A transcribed bass note (Notes view). pitch is a MIDI note number at sounding pitch. */
export interface BassNote {
  start: number
  end: number
  pitch: number
  velocity: number
}

export type NotesState =
  | { status: 'ready'; notes: BassNote[] }
  | { status: 'running'; progress: number }
  | { status: 'failed'; error: string }
  | { status: 'unavailable'; error: string }

export interface PracticeTotals {
  today: number
  /** Since Monday */
  week: number
  total: number
}

export interface RecentProject {
  path: string
  name: string
  openedAt: string
}

export interface SongPatch {
  mode?: PlaybackMode
  pitch?: PitchSettings
  tempo?: TempoGrid | null
  beatsPerBar?: number | null
  downbeat?: number
  gridScale?: 0.5 | 1 | 2
  evenBars?: boolean
  trainer?: SpeedTrainer | null
  volume?: number
  speed?: number
  loop?: LoopRegion | null
  cuts?: TimeRegion[]
  position?: number
  title?: string
  artist?: string | null
  /** Edited bass notes; null goes back to the transcription */
  notes?: BassNote[] | null
}

export interface ImportResult {
  added: string[]
  skipped: { path: string; reason: string }[]
}

export interface SeparationProviderStatus {
  available: boolean
  name: string
  model: string
  device?: string
  reason?: string
  /** ffmpeg found (bundled in the app) */
  ffmpeg?: boolean
  /** The bundled uv is there to install the audio environment */
  canInstall?: boolean
}

export interface SetupProgress {
  running: boolean
  line: string | null
  error: string | null
  done: boolean
}

// ---- Native engine -------------------------------------------------------

export interface EngineDeviceState {
  deviceType?: string
  /** Driver types this platform offers (only Windows and Linux have more than one) */
  availableDeviceTypes?: string[]
  /** False for ASIO: one driver is both the input and the output */
  separateInputs?: boolean
  /** The driver has its own settings window (ASIO) */
  hasControlPanel?: boolean
  inputDevices?: string[]
  outputDevices?: string[]
  inputDevice?: string
  outputDevice?: string
  inputChannels?: number[]
  running?: boolean
  sampleRate?: number
  bufferSize?: number
  availableSampleRates?: number[]
  availableBufferSizes?: number[]
  inputChannelNames?: string[]
  outputChannelNames?: string[]
  roundTripLatencyMs?: number
  /** Windows: the input and output latencies already count the buffers, so the round trip is their sum */
  latencyIncludesBuffer?: boolean
  /** Latency the interface and its driver report, per direction */
  inputLatencySamples?: number
  outputLatencySamples?: number
  pluginLatencySamples?: number
  xruns?: number
  monitoring?: boolean
  /** Whether the input is open: always for an audio interface, for a microphone only while Monitor or the tuner is on */
  inputOpen?: boolean
  inputBluetooth?: boolean
  outputBluetooth?: boolean
  /** Windows: a microphone feeding speakers (from the devices' kinds, not their names), so Monitor asks first */
  feedbackRisk?: boolean
  inputTrimDb?: number
  outputLevelDb?: number
  error?: string
}

export type EngineStatus = 'not-built' | 'starting' | 'running' | 'crashed' | 'stopped'

export interface EngineSnapshot {
  status: EngineStatus
  message: string | null
  binaryPath: string | null
  formats: string[]
  device: EngineDeviceState | null
  monitoring: boolean
}

export interface EngineMeters {
  inputPeakRaw: number
  inputPeak: number
  outputPeak: number
  /** The monitored bass alone, after its effects and the Monitor level (0 while Monitor is off) */
  monitorPeak?: number
  limiterGainDb: number
  inputClipped: boolean
  outputClipped: boolean
  invalidSamples: boolean
  xruns?: number
  /** Song playback after the Song fader (native playback only) */
  songPeak?: number
  songClipped?: boolean
}

/** One track handed to the engine. `scope` says how main resolves `path`. */
export interface EngineTrackSource {
  scope: 'local' | 'cache'
  path: string
}

/** Song transport in the native engine, reported ~60 times a second while playing. */
export interface TransportState {
  songId: string
  state: 'stopped' | 'starting' | 'countIn' | 'playing'
  playing: boolean
  /** Song seconds heard at wall-clock time `at` (ms since the epoch) */
  position: number
  at: number
  rate: number
  /** Track slot: 0 original, 1 bass, 2 play along */
  mode: number
  buffering: boolean
  /** Last command (by sequence number) this report reflects */
  seq: number
  /** Counters: loop wraps and songs played to the end */
  wraps: number
  ended: number
  durationSec: number
  countInLeft: number
  underruns: number
}

export interface PluginInfo {
  id: string
  name: string
  manufacturer: string
  format: string
  category: string
  version: string
  isInstrument: boolean
  fileOrIdentifier: string
  descriptionXml: string
}

export interface PluginCatalog {
  plugins: PluginInfo[]
  failed: { fileOrIdentifier: string; format: string; reason: string }[]
  directories: string[]
  scannedAt: string | null
}

export interface ScanProgress {
  running: boolean
  done: number
  total: number
  current: string | null
}

// ---- App-wide preferences (Settings window) -------------------------------------

/** Brand colours to choose from (Settings → Appearance → Colour). */
export const ACCENTS = {
  cobalt: { label: 'Cobalt', hex: '#000cb6' },
  vermilion: { label: 'Vermilion', hex: '#e34234' },
  emerald: { label: 'Emerald', hex: '#009473' }
} as const

export type Accent = keyof typeof ACCENTS

/** Seconds moved by ← → and the skip buttons (⇧ with the arrows: 1 second) */
export const SKIP_SECONDS = 5

export interface Preferences {
  /** Brand colour for the rail, value tags and active states */
  accent: Accent
  /** Light or dark look; 'system' follows macOS */
  theme: 'system' | 'light' | 'dark'
  /** Space / stop: jump back to where playback started, or stay where it stopped */
  stopBehavior: 'return' | 'pause'
  /** Playhead and loop edges snap to the beat grid (⌘ inverts) */
  snapToGrid: boolean
  /** Beat and bar lines in the waveform and Notes view */
  showGrid: boolean
  /** Waveform colouring */
  waveformColors: 'frequency' | 'mono'
  /** Tuner reference: frequency of A4 in Hz */
  tunerA4: number
  /** Demucs model: standard = htdemucs, high = htdemucs_ft (≈4× slower) */
  separationQuality: 'standard' | 'high'
  /** Where new projects are created; null = ~/Documents/Nøta Projects */
  projectsDir: string | null
  /** Adding songs: copy them into the project folder, leave them where they are, or ask each time */
  songStorage: 'ask' | 'copy' | 'reference'
  /** What Nøta shows when it starts: the project open last time, or the start screen */
  openAtLaunch: 'last' | 'start'
  /** Ask GitHub once a day whether there's a newer version */
  checkForUpdates: boolean
}

export const DEFAULT_PREFERENCES: Preferences = {
  accent: 'cobalt',
  theme: 'system',
  stopBehavior: 'return',
  snapToGrid: true,
  showGrid: true,
  waveformColors: 'frequency',
  tunerA4: 440,
  separationQuality: 'standard',
  projectsDir: null,
  songStorage: 'ask',
  openAtLaunch: 'last',
  checkForUpdates: true
}

export const SEPARATION_MODELS: Record<Preferences['separationQuality'], string> = {
  standard: 'htdemucs',
  high: 'htdemucs_ft'
}

/** Clamp and fill in a preferences object read from disk or sent by the UI. */
export function normalizePreferences(p: Partial<Preferences> | null | undefined): Preferences {
  const d = DEFAULT_PREFERENCES
  const v = { ...d, ...(p ?? {}) }
  return {
    accent: typeof v.accent === 'string' && v.accent in ACCENTS ? v.accent : 'cobalt',
    theme: v.theme === 'light' || v.theme === 'dark' ? v.theme : 'system',
    stopBehavior: v.stopBehavior === 'pause' ? 'pause' : 'return',
    snapToGrid: typeof v.snapToGrid === 'boolean' ? v.snapToGrid : d.snapToGrid,
    showGrid: typeof v.showGrid === 'boolean' ? v.showGrid : d.showGrid,
    waveformColors: v.waveformColors === 'mono' ? 'mono' : 'frequency',
    tunerA4: Number.isFinite(v.tunerA4) ? Math.round(Math.min(450, Math.max(430, Number(v.tunerA4))) * 10) / 10 : d.tunerA4,
    separationQuality: v.separationQuality === 'high' ? 'high' : 'standard',
    projectsDir: typeof v.projectsDir === 'string' && v.projectsDir ? v.projectsDir : null,
    songStorage: v.songStorage === 'copy' || v.songStorage === 'reference' ? v.songStorage : 'ask',
    openAtLaunch: v.openAtLaunch === 'start' ? 'start' : 'last',
    checkForUpdates: typeof v.checkForUpdates === 'boolean' ? v.checkForUpdates : d.checkForUpdates
  }
}

export interface StorageInfo {
  projectsDir: string
  /** The open project's folder and what's in it */
  project: {
    path: string
    songsBytes: number
    generatedBytes: number
    /** Songs whose file is in the project's Songs folder */
    copiedSongs: number
    /** Songs whose file is somewhere else on disk */
    outsideSongs: number
  } | null
  pythonEnv: { installed: boolean; path: string | null; device?: string; reason?: string }
}
