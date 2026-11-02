// A stand-in for the preload API (window.nota), so the real renderer runs in
// a web page: the website's interactive demo. Project edits, undo, settings
// and effects work in memory; playback moves the playhead without sound;
// waveforms, beats and notes come from demo/public/data (see export-data.ts).
// Anything that needs the computer (files, recording, the audio engine)
// answers with a friendly "download Nøta" message.

import type { DeviceRequest, NotaApi, TransportCommand, TransportLoad, TransportLoadResult, TrackKind, WaveformData } from '../src/shared/api'
import type { BeatGrid } from '../src/shared/beats'
import * as P from '../src/shared/project'
import {
  normalizePreferences,
  type EffectChain,
  type EngineDeviceState,
  type EngineMeters,
  type EngineSnapshot,
  type MetronomeSettings,
  type PluginInfo,
  type Preferences,
  type Project,
  type ProjectSnapshot,
  type SongPatch,
  type TransportState
} from '../src/shared/types'

const IN_THE_APP = 'Download Nøta to do this with your own songs and your bass'
const notInDemo = () => Promise.reject(new Error(IN_THE_APP))

type Listener = (payload: never) => void

export async function createFakeNota(base: string): Promise<NotaApi> {
  const listeners = new Map<string, Set<Listener>>()
  const on = <T>(channel: string, cb: (payload: T) => void) => {
    const set = listeners.get(channel) ?? new Set<Listener>()
    set.add(cb as Listener)
    listeners.set(channel, set)
    return () => void set.delete(cb as Listener)
  }
  const emit = (channel: string, payload: unknown) => listeners.get(channel)?.forEach((cb) => (cb as (p: unknown) => void)(payload))

  // ---- Project and undo ----
  let project: Project = await (await fetch(`${base}/project.json`)).json()
  const undo: { label: string; project: Project }[] = []
  const redo: typeof undo = []
  const snapshot = (): ProjectSnapshot => ({
    project,
    filePath: `/Demo/${project.name}.nota`,
    saveStatus: 'saved',
    saveError: null,
    lastSavedAt: new Date().toISOString(),
    recent: [],
    practice: { today: 0, week: 0, total: project.practiceSec }
  })
  const changed = () => emit('project', snapshot())
  const mutate = (label: string | null, fn: (p: Project) => Project) => {
    if (label) {
      undo.push({ label, project })
      redo.length = 0
    }
    project = fn(project)
    changed()
    return Promise.resolve()
  }
  const step = (from: typeof undo, to: typeof undo) => {
    const entry = from.pop()
    if (!entry) return Promise.resolve(null)
    to.push({ label: entry.label, project })
    project = entry.project
    changed()
    return Promise.resolve(entry.label)
  }
  const song = (id: string) => {
    const s = P.findSong(project, id)
    if (!s) throw new Error('No such song')
    return s
  }

  // ---- Data files, fetched once ----
  const cache = new Map<string, Promise<unknown>>()
  const load = <T>(file: string, parse: (r: Response) => Promise<T>): Promise<T | null> => {
    if (!cache.has(file)) cache.set(file, fetch(`${base}/${file}`).then((r) => (r.ok ? parse(r) : null)).catch(() => null))
    return cache.get(file) as Promise<T | null>
  }
  const waveform = (hash: string, kind: TrackKind) =>
    load<WaveformData>(`wave-${hash}-${kind}.bin`, async (r) => {
      const buf = new DataView(await r.arrayBuffer())
      return { perSecond: buf.getUint32(4, true), durationSec: buf.getFloat32(8, true), data: new Uint8Array(buf.buffer, 12) }
    })

  // ---- Settings ----
  let prefs: Preferences = normalizePreferences({ songStorage: 'copy', checkForUpdates: false })

  // ---- Playback: the playhead moves, nothing sounds ----
  const transport = {
    songId: '',
    duration: 0,
    position: 0,
    startedAt: 0,
    playing: false,
    rate: 1,
    mode: 0,
    seq: 0,
    wraps: 0,
    ended: 0,
    returnToStart: true,
    loop: null as { start: number; end: number; enabled: boolean } | null,
    cuts: [] as { start: number; end: number }[]
  }
  const report = () => {
    const t = transport
    const state: TransportState = {
      songId: t.songId,
      state: t.playing ? 'playing' : 'stopped',
      playing: t.playing,
      position: t.position,
      at: Date.now(),
      rate: t.rate,
      mode: t.mode,
      buffering: false,
      seq: t.seq,
      wraps: t.wraps,
      ended: t.ended,
      durationSec: t.duration,
      countInLeft: 0,
      underruns: 0
    }
    emit('transport', state)
  }
  let last = performance.now()
  setInterval(() => {
    const now = performance.now()
    const dt = (now - last) / 1000
    last = now
    const t = transport
    if (!t.playing) return
    t.position += dt * t.rate
    const cut = t.cuts.find((c) => t.position >= c.start && t.position < c.end)
    if (cut) t.position = cut.end
    if (t.loop?.enabled && t.position >= t.loop.end) {
      t.position = t.loop.start + (t.position - t.loop.end)
      t.wraps++
    }
    if (t.position >= t.duration) {
      t.position = t.returnToStart ? t.startedAt : t.duration
      t.playing = false
      t.ended++
    }
    report()
    emit('meters', meters())
  }, 1000 / 30)
  const send = (c: TransportCommand & { seq: number }) => {
    const t = transport
    t.seq = c.seq
    switch (c.cmd) {
      case 'play':
        t.startedAt = t.position
        t.playing = true
        break
      case 'pause':
        t.playing = false
        break
      case 'stop':
        t.playing = false
        if (t.returnToStart) t.position = t.startedAt
        break
      case 'seek':
        t.position = Math.max(0, Math.min(t.duration, c.position))
        t.startedAt = t.position
        break
      case 'mode':
        t.mode = c.mode
        break
      case 'loop':
        t.loop = { start: c.start, end: c.end, enabled: c.enabled }
        break
      case 'speed':
        t.rate = c.speed
        break
      case 'returnToStart':
        t.returnToStart = c.enabled
        break
      case 'cuts':
        t.cuts = c.regions
        break
      case 'unload':
        t.playing = false
        break
    }
    report()
  }
  const loadSong = (req: TransportLoad & { seq: number }): Promise<TransportLoadResult> => {
    const s = P.findSong(project, req.songId)
    Object.assign(transport, { songId: req.songId, duration: s?.durationSec ?? 0, position: req.position, startedAt: req.position, playing: false, mode: req.mode, seq: req.seq })
    report()
    return Promise.resolve({ durationSec: transport.duration, tracks: req.tracks.map((tr, slot) => ({ slot, ok: !!tr, durationSec: transport.duration })) })
  }

  // ---- The "audio engine": an interface that's always there ----
  let monitoring = false
  let device: EngineDeviceState = {
    deviceType: 'CoreAudio',
    availableDeviceTypes: ['CoreAudio'],
    separateInputs: true,
    inputDevices: ['Audio Interface'],
    outputDevices: ['Audio Interface', 'Headphones'],
    inputDevice: 'Audio Interface',
    outputDevice: 'Audio Interface',
    inputChannels: [0],
    inputChannelNames: ['Input 1', 'Input 2'],
    outputChannelNames: ['Output 1', 'Output 2'],
    running: true,
    sampleRate: 48000,
    bufferSize: 128,
    availableSampleRates: [44100, 48000, 96000],
    availableBufferSizes: [32, 64, 128, 256, 512, 1024],
    inputLatencySamples: 96,
    outputLatencySamples: 112,
    pluginLatencySamples: 0,
    roundTripLatencyMs: 9.7,
    inputOpen: true,
    monitoring: false,
    inputTrimDb: 0,
    outputLevelDb: -6
  }
  const engineSnapshot = (): EngineSnapshot => ({ status: 'running', message: null, binaryPath: 'demo', formats: ['VST3', 'AudioUnit'], device: { ...device, monitoring }, monitoring })
  const meters = (): EngineMeters => {
    const level = transport.playing ? 0.35 + Math.random() * 0.25 : 0
    const bass = monitoring ? 0.2 + Math.random() * 0.2 : 0
    return { inputPeakRaw: bass, inputPeak: bass, outputPeak: Math.max(level, bass), monitorPeak: bass, songPeak: level, limiterGainDb: 0, inputClipped: false, outputClipped: false, invalidSamples: false }
  }
  const engineChanged = () => emit('engine', engineSnapshot())
  let tunerTimer: ReturnType<typeof setInterval> | null = null

  const plugins: PluginInfo[] = [
    { name: 'Bass Compressor', manufacturer: 'VST3 plug-in' },
    { name: 'Tilt EQ', manufacturer: 'VST3 plug-in' },
    { name: 'Amp Simulator', manufacturer: 'VST3 plug-in' },
    { name: 'Octave Down', manufacturer: 'VST3 plug-in' },
    { name: 'Room Reverb', manufacturer: 'VST3 plug-in' }
  ].map((p, i) => ({ ...p, id: `demo-${i}`, format: 'VST3', category: 'Effect', version: '1.0', isInstrument: false, fileOrIdentifier: `/Library/Audio/Plug-Ins/VST3/${p.name}.vst3`, descriptionXml: '' }))
  const catalog = { plugins, failed: [], directories: ['/Library/Audio/Plug-Ins/VST3'], scannedAt: new Date().toISOString() }

  const api: NotaApi = {
    project: {
      get: () => Promise.resolve(snapshot()),
      create: notInDemo,
      openDialog: notInDemo,
      open: notInDemo,
      rename: (name) => mutate('Rename project', (p) => P.renameProject(p, name)),
      undo: () => step(undo, redo),
      redo: () => step(redo, undo),
      exportSetlist: notInDemo,
      delete: notInDemo,
      close: notInDemo,
      revealInFinder: notInDemo,
      collectSongs: () => Promise.resolve(0),
      addPractice: () => Promise.resolve(),
      forgetRecent: () => Promise.resolve(),
      updateMetronome: (patch: Partial<MetronomeSettings>) => mutate('Metronome', (p) => P.updateMetronome(p, patch)),
      onChange: (cb) => on('project', cb)
    },
    songs: {
      importDialog: notInDemo,
      importPaths: notInDemo,
      notes: async (id) => {
        const notes = await load(`notes-${song(id).source.hash}.json`, (r) => r.json())
        return notes ? { status: 'ready', notes } : { status: 'unavailable', error: 'No notes for this song in the demo' }
      },
      onNotesState: (cb) => on('notes', cb),
      take: () => Promise.resolve({ status: 'none' }),
      recordTake: notInDemo,
      stopTake: () => Promise.resolve(),
      clearTake: () => Promise.resolve(),
      onTakeState: (cb) => on('take', cb),
      export: notInDemo,
      remove: (id) => mutate('Remove song', (p) => P.removeSong(p, id)),
      move: (id, to) => mutate('Move song', (p) => P.moveSong(p, id, to)),
      select: (id) => mutate(null, (p) => P.selectSong(p, id)),
      update: (id, patch: SongPatch) => mutate('Edit song', (p) => P.updateSong(p, id, patch)),
      relink: () => Promise.resolve('cancelled'),
      retry: () => Promise.resolve(),
      cancel: () => Promise.resolve(),
      reveal: notInDemo,
      waveform: (id, kind) => waveform(song(id).source.hash, kind),
      beats: (id) => load<BeatGrid>(`grid-${song(id).source.hash}.json`, (r) => r.json()),
      retryAnalysis: () => Promise.resolve(),
      onImportProgress: () => () => {}
    },
    separation: {
      status: () => Promise.resolve({ available: true, name: 'Demucs', model: 'htdemucs', device: 'mps', ffmpeg: true, canInstall: true }),
      install: notInDemo,
      onSetupProgress: () => () => {},
      onStatus: () => () => {}
    },
    engine: {
      get: () => Promise.resolve(engineSnapshot()),
      restart: () => Promise.resolve(),
      setDevice: (req: DeviceRequest) => {
        device = { ...device, ...req }
        engineChanged()
        return Promise.resolve(engineSnapshot().device!)
      },
      showControlPanel: () => Promise.resolve(engineSnapshot().device!),
      useProAudio: () => Promise.resolve(engineSnapshot().device!),
      setMonitoring: (enabled) => {
        monitoring = enabled
        engineChanged()
        return Promise.resolve()
      },
      setInputTrim: (db) => mutate(null, (p) => P.updateAudio(p, { inputTrimDb: db })),
      setMonitorLevel: (db) => mutate(null, (p) => P.updateAudio(p, { monitorLevelDb: db })),
      setPlaybackVolume: (v) => mutate(null, (p) => P.updateAudio(p, { playbackVolume: v })),
      onSnapshot: (cb) => on('engine', cb),
      onMeters: (cb) => on('meters', cb),
      // The tuner hears an open A string, a little flat and settling.
      setTuner: (enabled) => {
        if (tunerTimer) clearInterval(tunerTimer)
        tunerTimer = null
        if (enabled) {
          let cents = -18
          tunerTimer = setInterval(() => {
            cents += (-3 - cents) * 0.08 + (Math.random() - 0.5) * 1.5
            emit('tuner', { hz: 55 * 2 ** (cents / 1200), clarity: 0.95, rmsDb: -18 })
          }, 66)
        }
        return Promise.resolve()
      },
      onTuner: (cb) => on('tuner', cb)
    },
    transport: {
      load: loadSong,
      setTracks: (tracks, seq) => Promise.resolve({ durationSec: transport.duration, tracks: tracks.map((tr, slot) => ({ slot, ok: !!tr })) }).finally(() => (transport.seq = seq)),
      send,
      onState: (cb) => on('transport', cb),
      onInterrupted: () => () => {}
    },
    effects: {
      catalog: () => Promise.resolve(catalog),
      scan: () => Promise.resolve(catalog),
      scanProgress: () => Promise.resolve({ running: false, done: 0, total: 0, current: null }),
      onScanProgress: () => () => {},
      addDirectory: () => Promise.resolve(null),
      removeDirectory: () => Promise.resolve(catalog),
      add: (plugin: PluginInfo, chain: EffectChain = 'input') =>
        mutate('Add effect', (p) => ({
          ...p,
          effects: [...p.effects, { slotId: P.newId(), pluginId: plugin.id, name: plugin.name, manufacturer: plugin.manufacturer, format: plugin.format, descriptionXml: '', bypassed: false, state: null, chain }]
        })),
      setOutputIncludesBass: (include) => mutate('Bass through output effects', (p) => ({ ...p, outputIncludesBass: include })),
      remove: (slotId) => mutate('Remove effect', (p) => ({ ...p, effects: p.effects.filter((e) => e.slotId !== slotId) })),
      move: (slotId, to) =>
        mutate('Move effect', (p) => {
          const fx = p.effects.filter((e) => e.slotId !== slotId)
          const moved = p.effects.find((e) => e.slotId === slotId)
          if (moved) fx.splice(to, 0, moved)
          return { ...p, effects: fx }
        }),
      setBypass: (slotId, bypassed) => mutate(bypassed ? 'Bypass effect' : 'Turn effect on', (p) => ({ ...p, effects: p.effects.map((e) => (e.slotId === slotId ? { ...e, bypassed } : e)) })),
      toggleEditor: notInDemo,
      slotErrors: () => Promise.resolve({}),
      onSlotErrors: () => () => {}
    },
    prefs: {
      get: () => Promise.resolve(prefs),
      set: (patch) => {
        prefs = normalizePreferences({ ...prefs, ...patch })
        emit('prefs', prefs)
        return Promise.resolve(prefs)
      },
      chooseProjectsDir: () => Promise.resolve(prefs),
      onChange: (cb) => on('prefs', cb)
    },
    storage: {
      info: () =>
        Promise.resolve({
          projectsDir: '~/Documents/Nøta Projects',
          project: { path: snapshot().filePath!, songsBytes: 38_000_000, generatedBytes: 162_000_000, copiedSongs: project.songs.length, outsideSongs: 0 },
          pythonEnv: { installed: true, path: null, device: 'mps' }
        }),
      cleanUnused: () => Promise.resolve({ removed: 0, freedBytes: 0 }),
      reveal: notInDemo
    },
    setTitleBarColors: () => Promise.resolve(),
    onWindowFramed: () => () => {},
    app: {
      version: () => Promise.resolve('1.0.0'),
      update: () => Promise.resolve(null),
      checkUpdates: () => Promise.resolve({ status: 'current' }),
      openUpdate: () => Promise.resolve(),
      onUpdate: () => () => {}
    },
    onMenuSettings: () => () => {},
    pathForFile: () => '',
    onMenuImport: () => () => {},
    onImportResult: () => () => {},
    onMenuUndo: () => () => {},
    platform: 'darwin',
    jackMissing: false
  }
  return api
}
