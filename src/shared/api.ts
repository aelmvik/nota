import type { BeatGrid } from './beats'
import type { TakeState } from './takes'
import type { UpdateCheck, UpdateInfo } from './updates'
import type {
  EngineDeviceState,
  EngineMeters,
  EngineTrackSource,
  TransportState,
  EngineSnapshot,
  ImportResult,
  PluginCatalog,
  EffectChain,
  PluginInfo,
  ProjectSnapshot,
  ScanProgress,
  MetronomeSettings,
  Preferences,
  StorageInfo,
  SeparationProviderStatus,
  SetupProgress,
  SongPatch,
  NotesState
} from './types'

/** Interleaved [min, max, colour] bytes per millisecond (see main/media.ts). */
export interface WaveformData {
  perSecond: number
  durationSec: number
  data: Uint8Array
}

/** A song's audio files: the original recording and its two separated tracks. */
export type TrackKind = 'original' | 'bass' | 'backing'

export interface DeviceRequest {
  /** Driver type, e.g. 'Windows Audio' or 'ASIO' (one of the engine's availableDeviceTypes) */
  deviceType?: string
  inputDevice?: string
  outputDevice?: string
  inputChannels?: number[]
  sampleRate?: number
  bufferSize?: number
}

/** Song playback in the native engine; slots are original, bass, play along. */
export interface TransportLoad {
  songId: string
  tracks: (EngineTrackSource | null)[]
  position: number
  mode: number
}

export type TransportCommand =
  | { cmd: 'play'; countInBeats?: number; countInPeriod?: number; beatsPerBar?: number }
  | { cmd: 'pause' }
  | { cmd: 'stop' }
  | { cmd: 'seek'; position: number }
  | { cmd: 'mode'; mode: number }
  | { cmd: 'loop'; start: number; end: number; enabled: boolean }
  | { cmd: 'speed'; speed: number }
  | { cmd: 'pitch'; ratio: number }
  | { cmd: 'volume'; song?: number; master?: number }
  | { cmd: 'returnToStart'; enabled: boolean }
  | { cmd: 'metronome'; enabled: boolean; volume: number }
  | { cmd: 'beats'; times: number[]; accents: boolean[] }
  | { cmd: 'lightweight'; enabled: boolean }
  | { cmd: 'cuts'; regions: { start: number; end: number }[] }
  | { cmd: 'unload' }

export interface TransportLoadResult {
  durationSec: number
  tracks: { slot: number; ok: boolean; error?: string; durationSec?: number }[]
}

/** The API the preload script exposes to the renderer as `window.nota`. */
export interface NotaApi {
  project: {
    get(): Promise<ProjectSnapshot>
    create(name: string): Promise<void>
    openDialog(): Promise<boolean>
    open(path: string): Promise<void>
    rename(name: string): Promise<void>
    /** Undo / redo the last project edit; resolves to its label, or null if there was none */
    undo(): Promise<string | null>
    redo(): Promise<string | null>
    /** Opens a save dialog; resolves to the PDF path, or null if cancelled */
    exportSetlist(): Promise<string | null>
    /** Asks for confirmation; resolves true if the project was deleted */
    delete(): Promise<boolean>
    /** Close the project (saved) and show the start screen */
    close(): Promise<void>
    revealInFinder(): Promise<void>
    /** Copy songs that live elsewhere into the project folder; resolves to how many were copied */
    collectSongs(): Promise<number>
    /** Report practice time (seconds) since the last report, for the playing song or none */
    addPractice(seconds: number, songId: string | null): Promise<void>
    forgetRecent(path: string): Promise<void>
    updateMetronome(patch: Partial<MetronomeSettings>): Promise<void>
    onChange(cb: (s: ProjectSnapshot) => void): () => void
  }
  songs: {
    importDialog(): Promise<ImportResult | null>
    importPaths(paths: string[]): Promise<ImportResult>
    /** The song's transcribed bass notes, or progress while they're being made (also pushed via onNotesState) */
    notes(id: string): Promise<NotesState>
    onNotesState(cb: (e: { hash: string; state: NotesState }) => void): () => void
    /** Your latest take of the song (also pushed via onTakeState) */
    take(id: string): Promise<TakeState>
    /** Start recording your bass for a take of the song (the input opens if it isn't) */
    recordTake(id: string): Promise<void>
    /** Stop recording; the take is then transcribed and compared */
    stopTake(): Promise<void>
    clearTake(id: string): Promise<void>
    onTakeState(cb: (e: { hash: string; state: TakeState }) => void): () => void
    /** Save one version of the song as WAV, FLAC or MP3 (asks where); resolves to the path, or null if cancelled */
    export(id: string, kind: 'original' | 'bass' | 'backing'): Promise<string | null>
    remove(id: string): Promise<void>
    move(id: string, toIndex: number): Promise<void>
    select(id: string | null): Promise<void>
    update(id: string, patch: SongPatch): Promise<void>
    relink(id: string): Promise<'relinked' | 'different' | 'cancelled'>
    retry(id: string): Promise<void>
    cancel(id: string): Promise<void>
    reveal(id: string): Promise<void>
    waveform(id: string, kind: TrackKind): Promise<WaveformData | null>
    beats(id: string): Promise<BeatGrid | null>
    retryAnalysis(id: string): Promise<void>
    onImportProgress(cb: (done: number, total: number) => void): () => void
  }
  separation: {
    status(): Promise<SeparationProviderStatus>
    install(): Promise<SeparationProviderStatus>
    onSetupProgress(cb: (p: SetupProgress) => void): () => void
    onStatus(cb: (s: SeparationProviderStatus) => void): () => void
  }
  engine: {
    get(): Promise<EngineSnapshot>
    restart(): Promise<void>
    setDevice(req: DeviceRequest): Promise<EngineDeviceState>
    /** Opens the driver's own settings window (ASIO) */
    showControlPanel(): Promise<EngineDeviceState>
    /** Linux: the input's card in PipeWire's Pro Audio profile, selected again from Input 1 */
    useProAudio(): Promise<EngineDeviceState>
    setMonitoring(enabled: boolean): Promise<void>
    setInputTrim(db: number): Promise<void>
    setMonitorLevel(db: number): Promise<void>
    setPlaybackVolume(volume: number): Promise<void>
    onSnapshot(cb: (s: EngineSnapshot) => void): () => void
    onMeters(cb: (m: EngineMeters) => void): () => void
    setTuner(enabled: boolean, mute: boolean): Promise<void>
    /** ~15 readings per second while the tuner is on; hz is 0 when there's no clear pitch */
    onTuner(cb: (t: { hz: number; clarity: number; rmsDb: number }) => void): () => void
  }
  transport: {
    /** Opens the song's tracks in the engine (paused at `position`). */
    load(req: TransportLoad & { seq: number }): Promise<TransportLoadResult>
    /** Swaps tracks of the loaded song as stems arrive. */
    setTracks(tracks: (EngineTrackSource | null)[], seq: number): Promise<TransportLoadResult>
    /** Fire and forget; `seq` comes back in TransportState.seq once applied. */
    send(command: TransportCommand & { seq: number }): void
    onState(cb: (s: TransportState) => void): () => void
    /** The engine stopped (crash or restart) while a song was loaded. */
    onInterrupted(cb: (e: { wasPlaying: boolean; message: string }) => void): () => void
  }
  effects: {
    catalog(): Promise<PluginCatalog>
    scan(): Promise<PluginCatalog>
    scanProgress(): Promise<ScanProgress>
    onScanProgress(cb: (p: ScanProgress) => void): () => void
    addDirectory(): Promise<PluginCatalog | null>
    removeDirectory(dir: string): Promise<PluginCatalog>
    add(plugin: PluginInfo, chain?: EffectChain): Promise<void>
    setOutputIncludesBass(include: boolean): Promise<void>
    remove(slotId: string): Promise<void>
    move(slotId: string, toIndex: number): Promise<void>
    setBypass(slotId: string, bypassed: boolean): Promise<void>
    /** Opens the effect's window, brings it back in front, or closes it if it was in front */
    toggleEditor(slotId: string): Promise<void>
    slotErrors(): Promise<Record<string, string>>
    onSlotErrors(cb: (errors: Record<string, string>) => void): () => void
  }
  prefs: {
    get(): Promise<Preferences>
    set(patch: Partial<Preferences>): Promise<Preferences>
    chooseProjectsDir(): Promise<Preferences>
    onChange(cb: (p: Preferences) => void): () => void
  }
  storage: {
    info(): Promise<StorageInfo>
    cleanUnused(): Promise<{ removed: number; freedBytes: number }>
    reveal(which: 'project' | 'projects'): Promise<void>
  }
  /** Colours for the window buttons drawn over the title bar (Windows, Linux) */
  setTitleBarColors(color: string, symbolColor: string): Promise<void>
  /** Windows: whether the window is restored (has a frame at the top) rather than maximized or full screen */
  onWindowFramed(cb: (framed: boolean) => void): () => void
  app: {
    version(): Promise<string>
    /** A newer release found by the last check, or null */
    update(): Promise<UpdateInfo | null>
    /** Ask GitHub now (Settings → Updates) */
    checkUpdates(): Promise<UpdateCheck>
    /** Open the newer release's page in the browser */
    openUpdate(): Promise<void>
    onUpdate(cb: (update: UpdateInfo | null) => void): () => void
  }
  /** App menu: Settings… (⌘,) */
  onMenuSettings(cb: () => void): () => void
  pathForFile(file: File): string
  /** File > Import Songs… in the app menu */
  onMenuImport(cb: () => void): () => void
  /** Songs dropped on the Dock icon (or opened with Nøta) were added */
  onImportResult(cb: (result: ImportResult) => void): () => void
  /** Edit > Undo / Redo (⌘Z, ⇧⌘Z) */
  onMenuUndo(cb: (direction: 'undo' | 'redo') => void): () => void
  platform: string
}

declare global {
  interface Window {
    nota: NotaApi
  }
}
