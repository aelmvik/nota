import { useSyncExternalStore } from 'react'
import type {
  EngineSnapshot,
  PluginCatalog,
  ProjectSnapshot,
  ScanProgress,
  SeparationProviderStatus,
  SetupProgress
} from '../../shared/types'
import { DEFAULT_PREFERENCES, type Preferences } from '../../shared/types'
import type { PlayerState } from '../audio/player'
import { NativeClicker, NativePlayer } from '../audio/NativePlayer'

// Minimal external store: main-process snapshots plus UI-only state.
// The main process owns the project; the renderer never edits it locally.

export interface Toast {
  id: number
  kind: 'info' | 'error' | 'success'
  text: string
}

export interface AppState {
  snapshot: ProjectSnapshot | null
  engine: EngineSnapshot | null
  separation: SeparationProviderStatus | null
  player: PlayerState
  catalog: PluginCatalog | null
  scan: ScanProgress
  slotErrors: Record<string, string>
  importing: { done: number; total: number } | null
  toasts: Toast[]
  effectsOpen: boolean
  countingIn: boolean
  setup: SetupProgress
  /** Clock and ruler: minutes:seconds or bars.beats */
  timeFormat: 'time' | 'bars'
  tunerOn: boolean
  /** Silence the monitored bass while tuning (like a pedal tuner) */
  tunerMute: boolean
  /** Waiting for "turn on anyway" before monitoring a built-in mic through speakers */
  confirmMonitorRisk: boolean
  /** App-wide preferences (Settings window) */
  prefs: Preferences
  /** Projects, Settings or Keys, shown in the right-hand pane in place of the effects chain. */
  sidePane: 'projects' | 'settings' | 'keys' | null
  /** The song the Export window is open for */
  exportSongId: string | null
}

/** Song playback and the metronome, both in the native engine (see usePlaybackSync). */
export const player = new NativePlayer()

export const metronome = new NativeClicker()

// Reachable from DevTools in development builds, for poking at playback.
if (import.meta.env.DEV) Object.assign(window, { __notaPlayer: player, __notaMetronome: metronome })

/** Stable empty value for selectors: returning a fresh [] would re-render forever. */
export const EMPTY: never[] = []

let state: AppState = {
  snapshot: null,
  engine: null,
  separation: null,
  player: player.getState(),
  catalog: null,
  scan: { running: false, done: 0, total: 0, current: null },
  slotErrors: {},
  importing: null,
  toasts: [],
  effectsOpen: readPref('effectsOpen', true),
  countingIn: false,
  setup: { running: false, line: null, error: null, done: false },
  timeFormat: readPref<'time' | 'bars'>('timeFormat', 'time'),
  tunerOn: false,
  tunerMute: readPref('tunerMute', true),
  confirmMonitorRisk: false,
  prefs: DEFAULT_PREFERENCES,
  sidePane: null,
  exportSongId: null
}

const listeners = new Set<() => void>()

export function getState() {
  return state
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  for (const l of listeners) l()
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => selector(state)
  )
}

let toastId = 0
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 4500) {
  const id = ++toastId
  setState((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms)
}

/** Run an IPC call and surface failures as a toast instead of an unhandled rejection. */
export async function attempt<T>(fn: () => Promise<T>, context?: string): Promise<T | undefined> {
  try {
    return await fn()
  } catch (err) {
    const msg = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)
    toast(context ? `${context}: ${msg}` : msg, 'error', 7000)
    return undefined
  }
}

export function readPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`nota.${key}`)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}

export function writePref(key: string, value: unknown) {
  try {
    localStorage.setItem(`nota.${key}`, JSON.stringify(value))
  } catch {
    // storage unavailable; preference just won't persist
  }
}

export async function initStore() {
  const api = window.nota
  api.project.onChange((snapshot) => setState({ snapshot }))
  api.engine.onSnapshot((engine) => setState({ engine }))
  api.effects.onScanProgress((scan) => setState({ scan }))
  api.effects.onSlotErrors((slotErrors) => setState({ slotErrors }))
  api.songs.onImportProgress((done, total) => setState({ importing: done >= total ? null : { done, total } }))
  player.subscribe((p) => setState({ player: p }))
  api.separation.onSetupProgress((setup) => setState({ setup }))
  api.separation.onStatus((separation) => setState({ separation }))
  api.prefs.onChange((prefs) => setState({ prefs }))
  void api.prefs.get().then((prefs) => setState({ prefs }))

  // Apply each initial value as soon as it arrives, and never let it replace
  // a newer value that already came in through a live update. (The separation
  // check starts Python and can take seconds; meanwhile the engine may report
  // that it is running.)
  const initial = <K extends keyof AppState>(key: K, job: Promise<AppState[K]>) =>
    job.then((value) => setState((s) => (s[key] === null ? { [key]: value } : {}) as Partial<AppState>)).catch(() => {})

  await Promise.all([
    initial('snapshot', api.project.get()),
    initial('engine', api.engine.get()),
    initial('catalog', api.effects.catalog())
  ])
  void initial('separation', api.separation.status())
  void api.effects.scanProgress().then((scan) => setState((s) => (s.scan.running ? {} : { scan })))
  void api.effects.slotErrors().then((slotErrors) => setState((s) => (Object.keys(s.slotErrors).length ? {} : { slotErrors })))
}
