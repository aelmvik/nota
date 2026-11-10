import { recoverAfterRestart } from './processing'
import { clampPitch, tempoFromBpm } from './music'
import type { AudioConfig, EffectSlot, MetronomeSettings, PlaybackMode, Project, Song, SongPatch, SpeedTrainer, StemKind } from './types'
import { normalizeCuts } from './cuts'
import { normalizeNotes } from './noteEdit'

// Pure project operations. Every function returns a new Project and never
// mutates its input, which keeps them trivially testable and lets the main
// process treat the project as an immutable snapshot.

export const SPEED_MIN = 0.25
export const SPEED_STEP = 0.01
export const SPEED_MAX = 1.5
export const MIN_LOOP_SEC = 0.1
export const MAX_VOLUME = 1.5

export const DEFAULT_AUDIO: AudioConfig = {
  deviceType: null,
  inputDevice: null,
  outputDevice: null,
  inputChannels: [0],
  sampleRate: null,
  bufferSize: null,
  inputTrimDb: 0,
  monitorLevelDb: -6,
  playbackVolume: 0.9
}

/** Bump when analysis output changes; songs analysed with older versions are redone. */
export const ANALYSIS_FORMAT = 2

export const DEFAULT_METRONOME: MetronomeSettings = { enabled: false, volume: 0.6, countInBars: 0, accent: true }

export class ProjectError extends Error {}

const now = () => new Date().toISOString()

export function newId(): string {
  return globalThis.crypto.randomUUID()
}

export function createProject(name: string): Project {
  const t = now()
  return {
    format: 'nota-project',
    version: 1,
    id: newId(),
    name: name.trim() || 'Untitled practice',
    createdAt: t,
    updatedAt: t,
    songs: [],
    selectedSongId: null,
    audio: { ...DEFAULT_AUDIO },
    effects: [],
    outputIncludesBass: true,
    metronome: { ...DEFAULT_METRONOME },
    practiceSec: 0
  }
}

export type NewSong = Pick<Song, 'title' | 'artist' | 'durationSec' | 'source'> & { playbackProxy?: string | null }

export function makeSong(init: NewSong): Song {
  return {
    id: newId(),
    title: init.title,
    artist: init.artist,
    durationSec: init.durationSec,
    source: init.source,
    playbackProxy: init.playbackProxy ?? null,
    mode: 'original',
    volume: 1,
    speed: 1,
    loop: null,
    cuts: [],
    pitch: { semitones: 0, cents: 0 },
    tempo: null,
    beatsPerBar: null,
    downbeat: 0,
    gridScale: 1,
    evenBars: false,
    trainer: null,
    analysis: { status: 'pending' },
    position: 0,
    separation: { status: 'pending', progress: 0 },
    stems: {},
    addedAt: now(),
    practiceSec: 0,
    editedNotes: null
  }
}

function touch(p: Project, patch: Partial<Project>): Project {
  return { ...p, ...patch, updatedAt: now() }
}

function mapSong(p: Project, id: string, fn: (s: Song) => Song): Project {
  if (!p.songs.some((s) => s.id === id)) throw new ProjectError(`Unknown song ${id}`)
  return touch(p, { songs: p.songs.map((s) => (s.id === id ? fn(s) : s)) })
}

export function findSong(p: Project, id: string): Song | undefined {
  return p.songs.find((s) => s.id === id)
}

export function hasSourceHash(p: Project, hash: string): boolean {
  return p.songs.some((s) => s.source.hash === hash)
}

export function addSongs(p: Project, songs: Song[]): Project {
  const fresh = songs.filter((s) => !hasSourceHash(p, s.source.hash))
  if (fresh.length === 0) return p
  return touch(p, {
    songs: [...p.songs, ...fresh],
    selectedSongId: p.selectedSongId ?? fresh[0].id
  })
}

export function removeSong(p: Project, id: string): Project {
  const index = p.songs.findIndex((s) => s.id === id)
  if (index < 0) throw new ProjectError(`Unknown song ${id}`)
  const songs = p.songs.filter((s) => s.id !== id)
  let selectedSongId = p.selectedSongId
  if (selectedSongId === id) selectedSongId = songs[Math.min(index, songs.length - 1)]?.id ?? null
  return touch(p, { songs, selectedSongId })
}

export function moveSong(p: Project, id: string, toIndex: number): Project {
  const from = p.songs.findIndex((s) => s.id === id)
  if (from < 0) throw new ProjectError(`Unknown song ${id}`)
  const target = Math.max(0, Math.min(p.songs.length - 1, Math.round(toIndex)))
  if (target === from) return p
  const songs = [...p.songs]
  const [song] = songs.splice(from, 1)
  songs.splice(target, 0, song)
  return touch(p, { songs })
}

export function selectSong(p: Project, id: string | null): Project {
  if (id !== null && !findSong(p, id)) throw new ProjectError(`Unknown song ${id}`)
  if (p.selectedSongId === id) return p
  return touch(p, { selectedSongId: id })
}

export function renameProject(p: Project, name: string): Project {
  const trimmed = name.trim()
  if (!trimmed) throw new ProjectError('Project name cannot be empty')
  return touch(p, { name: trimmed })
}

// ---- Playback modes ---------------------------------------------------------

/** The asset each mode needs. Original plays the source (or its proxy). */
export const MODE_ASSET: Record<PlaybackMode, StemKind | 'original'> = {
  original: 'original',
  bass: 'bass',
  playalong: 'backing'
}

export function isModeAvailable(song: Song, mode: PlaybackMode): boolean {
  const asset = MODE_ASSET[mode]
  if (asset === 'original') return !song.source.missing || song.playbackProxy !== null
  return song.separation.status === 'ready' && song.stems[asset] !== undefined
}

export function availableModes(song: Song): PlaybackMode[] {
  return (['original', 'bass', 'playalong'] as const).filter((m) => isModeAvailable(song, m))
}

/** The mode playback should actually use: the chosen one if possible, else the first available. */
export function effectiveMode(song: Song): PlaybackMode | null {
  if (isModeAvailable(song, song.mode)) return song.mode
  return availableModes(song)[0] ?? null
}

// ---- Song settings ------------------------------------------------------------

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1
  return Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed)) * 100) / 100
}

export function normalizeLoop(loop: SongPatch['loop'], duration: number): Song['loop'] {
  if (loop == null || !Number.isFinite(loop.start) || !Number.isFinite(loop.end)) return null
  let start = Math.max(0, Math.min(loop.start, loop.end))
  let end = Math.max(loop.start, loop.end)
  if (duration > 0) {
    start = Math.min(start, duration)
    end = Math.min(end, duration)
  }
  if (end - start < MIN_LOOP_SEC) {
    end = Math.min(duration > 0 ? duration : Infinity, start + MIN_LOOP_SEC)
    start = Math.max(0, end - MIN_LOOP_SEC)
  }
  return { start, end, enabled: loop.enabled }
}

export function updateSong(p: Project, id: string, patch: SongPatch): Project {
  return mapSong(p, id, (s) => {
    const next: Song = { ...s }
    if (patch.mode !== undefined) {
      // Choosing an unavailable mode is allowed: it is remembered and becomes
      // active once its stems are ready. Playback falls back meanwhile.
      next.mode = patch.mode
    }
    // A value that isn't a number (NaN from a slip in the window's maths) changes nothing.
    if (patch.volume !== undefined && Number.isFinite(patch.volume)) next.volume = Math.min(MAX_VOLUME, Math.max(0, patch.volume))
    if (patch.speed !== undefined) next.speed = clampSpeed(patch.speed)
    if (patch.loop !== undefined) next.loop = normalizeLoop(patch.loop, s.durationSec)
    if (patch.cuts !== undefined) next.cuts = normalizeCuts(patch.cuts, s.durationSec)
    if (patch.position !== undefined && Number.isFinite(patch.position))
      next.position = Math.max(0, Math.min(s.durationSec || Infinity, patch.position))
    if (patch.pitch !== undefined) next.pitch = clampPitch(patch.pitch)
    if (patch.tempo !== undefined) next.tempo = patch.tempo ? tempoFromBpm(patch.tempo.bpm, patch.tempo.offset) : null
    if (patch.beatsPerBar !== undefined)
      next.beatsPerBar = patch.beatsPerBar === null ? null : Math.max(1, Math.min(12, Math.round(patch.beatsPerBar)))
    if (patch.downbeat !== undefined) {
      const per = next.beatsPerBar ?? s.analysis.beatsPerBar ?? 4
      next.downbeat = ((Math.round(patch.downbeat) % per) + per) % per
    }
    if (patch.gridScale !== undefined) next.gridScale = patch.gridScale === 0.5 || patch.gridScale === 2 ? patch.gridScale : 1
    if (patch.evenBars !== undefined) next.evenBars = !!patch.evenBars
    if (patch.trainer !== undefined) next.trainer = patch.trainer ? normalizeTrainer(patch.trainer) : null
    if (patch.title !== undefined && patch.title.trim()) next.title = patch.title.trim()
    if (patch.artist !== undefined) next.artist = patch.artist?.trim() || null
    if (patch.notes !== undefined) next.editedNotes = patch.notes ? normalizeNotes(patch.notes, s.durationSec) : null
    return next
  })
}

export function normalizeTrainer(t: SpeedTrainer): SpeedTrainer {
  return {
    enabled: !!t.enabled,
    step: Math.round(Math.max(0.01, Math.min(0.1, t.step)) * 100) / 100,
    everyLoops: Math.max(1, Math.min(16, Math.round(t.everyLoops))),
    target: clampSpeed(t.target)
  }
}

export function updateMetronome(p: Project, patch: Partial<MetronomeSettings>): Project {
  const m = { ...p.metronome, ...patch }
  m.volume = Math.max(0, Math.min(1, m.volume))
  m.countInBars = Math.max(0, Math.min(2, Math.round(m.countInBars)))
  m.accent = m.accent !== false
  return touch(p, { metronome: m })
}

/** Apply a change to every song that shares a source hash (jobs are keyed by hash). */
export function updateSongsByHash(p: Project, hash: string, fn: (s: Song) => Song): Project {
  if (!hasSourceHash(p, hash)) return p
  return touch(p, { songs: p.songs.map((s) => (s.source.hash === hash ? fn(s) : s)) })
}

export function updateAudio(p: Project, patch: Partial<AudioConfig>): Project {
  return touch(p, { audio: { ...p.audio, ...patch } })
}

// ---- Serialization --------------------------------------------------------------

export function serializeProject(p: Project): string {
  return JSON.stringify(p, null, 2)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Parse and validate a project file. Unknown/missing optional fields get
 * defaults; structurally broken files throw. In-flight separation jobs are
 * reset to "pending" so they are rescheduled.
 */
export function parseProject(json: string): Project {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new ProjectError('The project file is not valid JSON')
  }
  if (!isObject(raw) || raw.format !== 'nota-project') throw new ProjectError('This is not a Nøta project file')
  if (raw.version !== 1) throw new ProjectError(`Unsupported project version ${String(raw.version)}`)
  if (!Array.isArray(raw.songs)) throw new ProjectError('The project file has no song list')

  const songs: Song[] = raw.songs.map((s: unknown, i: number) => {
    if (!isObject(s) || !isObject(s.source) || typeof s.source.path !== 'string' || typeof s.source.hash !== 'string')
      throw new ProjectError(`Song ${i + 1} in the project file is damaged`)
    const stored = s as unknown as Song
    // A song without a usable id or length (a hand-edited file) gets one, so the rest of the app can rely on them.
    const song: Song = { ...stored, durationSec: Number.isFinite(stored.durationSec) && stored.durationSec > 0 ? stored.durationSec : 0 }
    return {
      ...song,
      id: typeof song.id === 'string' && song.id ? song.id : newId(),
      title: typeof song.title === 'string' && song.title.trim() ? song.title : 'Untitled',
      artist: song.artist ?? null,
      playbackProxy: song.playbackProxy ?? null,
      mode: (['original', 'bass', 'playalong'] as const).includes(song.mode) ? song.mode : 'original',
      volume: Number.isFinite(song.volume) ? Math.min(MAX_VOLUME, Math.max(0, song.volume)) : 1,
      speed: clampSpeed(song.speed ?? 1),
      loop: song.loop ? normalizeLoop(song.loop, song.durationSec) : null,
      cuts: normalizeCuts(Array.isArray(song.cuts) ? song.cuts : [], song.durationSec),
      position: Number.isFinite(song.position) ? Math.max(0, Math.min(song.durationSec || Infinity, song.position)) : 0,
      stems: isObject(song.stems) ? song.stems : {},
      pitch: song.pitch ? clampPitch(song.pitch) : { semitones: 0, cents: 0 },
      tempo: song.tempo && song.tempo.bpm > 0 ? tempoFromBpm(song.tempo.bpm, song.tempo.offset ?? 0) : null,
      // Results from the older librosa-only analysis are redone, and the
      // meter defaults move to "detected".
      beatsPerBar: song.analysis?.version === ANALYSIS_FORMAT && typeof song.beatsPerBar === 'number' ? song.beatsPerBar : null,
      downbeat: song.analysis?.version === ANALYSIS_FORMAT && typeof song.downbeat === 'number' ? song.downbeat : 0,
      trainer: song.trainer ? normalizeTrainer(song.trainer) : null,
      gridScale: song.gridScale === 0.5 || song.gridScale === 2 ? song.gridScale : 1,
      evenBars: song.evenBars === true,
      analysis:
        song.analysis?.version === ANALYSIS_FORMAT && (song.analysis.status === 'ready' || song.analysis.status === 'failed')
          ? song.analysis
          : { status: 'pending' },
      separation: recoverAfterRestart(song.separation ?? { status: 'pending', progress: 0 }),
      source: { ...song.source, missing: false },
      practiceSec: typeof song.practiceSec === 'number' && song.practiceSec > 0 ? song.practiceSec : 0,
      editedNotes: Array.isArray(song.editedNotes) ? normalizeNotes(song.editedNotes, song.durationSec) : null
    }
  })

  const p = raw as unknown as Project
  const selectedSongId = songs.some((s) => s.id === p.selectedSongId) ? p.selectedSongId : (songs[0]?.id ?? null)
  return {
    format: 'nota-project',
    version: 1,
    id: typeof p.id === 'string' ? p.id : newId(),
    name: typeof p.name === 'string' && p.name.trim() ? p.name : 'Untitled practice',
    createdAt: p.createdAt ?? now(),
    updatedAt: p.updatedAt ?? now(),
    songs,
    selectedSongId,
    audio: { ...DEFAULT_AUDIO, ...(isObject(p.audio) ? p.audio : {}) },
    effects: Array.isArray(p.effects) ? p.effects : [],
    outputIncludesBass: p.outputIncludesBass !== false,
    metronome: { ...DEFAULT_METRONOME, ...(isObject(p.metronome) ? p.metronome : {}) },
    practiceSec: typeof p.practiceSec === 'number' && p.practiceSec > 0 ? p.practiceSec : 0
  }
}

/** Add practice time to the project and, when a song was playing, to that song. */
export function addPractice(p: Project, songId: string | null, seconds: number): Project {
  if (!(seconds > 0)) return p
  return {
    ...p,
    practiceSec: p.practiceSec + seconds,
    songs: songId ? p.songs.map((s) => (s.id === songId ? { ...s, practiceSec: s.practiceSec + seconds } : s)) : p.songs
  }
}

/** `project` with the plugin states captured in `captured`, slot by slot: its effects stay as they are now. */
export function withEffectStates(project: Project, captured: readonly EffectSlot[]): Project {
  const states = new Map(captured.map((e) => [e.slotId, e.state]))
  return { ...project, effects: project.effects.map((e) => (states.has(e.slotId) ? { ...e, state: states.get(e.slotId) ?? e.state } : e)) }
}
