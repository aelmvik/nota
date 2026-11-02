import { EventEmitter } from 'node:events'
import { constants, existsSync } from 'node:fs'
import { copyFile, cp, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { canTransition, transition, type SeparationEvent } from '../shared/processing'
import { dayKey, practiceTotals } from '../shared/practice'
import * as P from '../shared/project'
import type { ImportResult, Project, ProjectSnapshot, SaveStatus, Song, SongPatch, StemAsset, StemKind } from '../shared/types'
import type { AssetCache } from './assetCache'
import { IMPORTABLE, hashFile, needsProxy, probe, transcodeToFlac, wantsProxy } from './media'
import {
  generatedDir,
  isInside,
  loadProjectFile,
  saveProjectFile,
  songsDir,
  uniqueFilePath,
  uniqueProjectPath,
  type SettingsStore
} from './projectStore'
import { SeparationQueue } from './separationQueue'
import type { AnalysisService } from './analysisService'
import { applyEntry, History, songsIn, type Entry } from './history'
import type { SeparationProvider } from './separation/provider'

// Owns the open project: applies mutations, autosaves, schedules separation
// jobs and feeds their results back into the song list. Free of Electron
// imports so it can be exercised directly in tests.

export interface ProjectServiceOptions {
  cache: AssetCache
  provider: SeparationProvider
  settings: SettingsStore
  projectsDir: string
  autosaveDelayMs?: number
  /** Audio setup for new projects (the last one used on this machine). */
  audioDefaults?: () => Project['audio'] | null
  /** Tempo/key/tuning detection; optional so tests can leave it out. */
  analysis?: (listener: (hash: string, a: Song['analysis']) => void) => AnalysisService
  /** Called before writing, e.g. to pull current plugin states from the engine. */
  beforeSave?: (project: Project) => Promise<Project>
  /**
   * Other projects' Generated folders, searched on import for songs that
   * have already been separated there.
   */
  generatedSources?: () => string[]
  /** Removes a copied song file (the app moves it to the Trash). */
  trash?: (path: string) => Promise<void>
}

/** Copy a file, as an APFS clone (instant, no extra space) when the volume supports it. */
export async function cloneFile(src: string, dest: string) {
  await copyFile(src, dest, constants.COPYFILE_FICLONE)
}

/** Copy a song's generated folder, skipping partial files. */
export async function cloneGeneratedFolder(src: string, dest: string) {
  await cp(src, dest, {
    recursive: true,
    errorOnExist: false,
    force: false,
    mode: constants.COPYFILE_FICLONE,
    filter: (from) => !/\.(tmp|partial\.flac)$/.test(from)
  })
}

export class ProjectService extends EventEmitter {
  project: Project | null = null
  filePath: string | null = null
  private saveStatus: SaveStatus = 'saved'
  private saveError: string | null = null
  private lastSavedAt: string | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private saving: Promise<void> | null = null
  readonly queue: SeparationQueue
  readonly analysis: AnalysisService | null

  constructor(private readonly opts: ProjectServiceOptions) {
    super()
    this.queue = new SeparationQueue(opts.provider, opts.cache, (hash, event, stems) => this.onSeparation(hash, event, stems))
    this.analysis = opts.analysis?.((hash, a) => this.onAnalysis(hash, a)) ?? null
  }

  snapshot(): ProjectSnapshot {
    return {
      project: this.project,
      filePath: this.filePath,
      saveStatus: this.saveStatus,
      saveError: this.saveError,
      lastSavedAt: this.lastSavedAt,
      recent: this.opts.settings.get().recent,
      practice: practiceTotals(this.opts.settings.get().practiceDays)
    }
  }

  private emitChange() {
    this.emit('change', this.snapshot())
  }

  readonly history = new History()

  /** Run a user edit and record what it changed, for undo (⌘Z). */
  async undoable<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
    const before = this.project
    const result = await fn()
    if (before && this.project && before.id === this.project.id) this.history.record(label, before, this.project)
    return result
  }

  /** Undo or redo one edit. Returns the entry, or null if there was nothing to do. */
  step(direction: 'undo' | 'redo'): Entry | null {
    if (!this.project) return null
    const entry = direction === 'undo' ? this.history.takeUndo() : this.history.takeRedo()
    if (!entry) return null
    this.mutate((p) => {
      let next = applyEntry(p, entry, direction)
      // Show the song the edit was on.
      const ids = songsIn(entry).filter((id) => P.findSong(next, id))
      if (ids.length && !ids.includes(next.selectedSongId ?? '')) next = P.selectSong(next, ids[0])
      return next
    })
    this.emit('history', entry)
    return entry
  }

  /** Apply a change. `persist: false` is for transient state like progress. */
  mutate(fn: (p: Project) => Project, persist = true) {
    if (!this.project) throw new P.ProjectError('No project is open')
    const next = fn(this.project)
    if (next === this.project) return
    this.project = next
    if (persist) this.scheduleSave()
    this.emitChange()
  }

  // ---- Lifecycle -----------------------------------------------------------

  async create(name: string): Promise<void> {
    await this.close()
    this.project = P.createProject(name)
    const audio = this.opts.audioDefaults?.()
    if (audio) this.project = { ...this.project, audio: { ...audio } }
    this.filePath = uniqueProjectPath(this.opts.projectsDir, this.project.name)
    await mkdir(generatedDir(this.filePath), { recursive: true })
    this.opts.cache.setRoot(generatedDir(this.filePath))
    await this.saveNow()
    await this.opts.settings.touchRecent(this.filePath, this.project.name)
    this.emitChange()
  }

  async open(path: string): Promise<void> {
    const project = await loadProjectFile(path)
    await this.close()
    this.project = project
    this.filePath = path
    this.opts.cache.setRoot(generatedDir(path))
    await mkdir(generatedDir(path), { recursive: true })
    void this.removeUnusedGenerated()
    void this.ensurePlaybackCopies()
    this.saveStatus = 'saved'
    this.lastSavedAt = project.updatedAt
    await this.opts.settings.touchRecent(path, project.name)
    this.refreshSourceAvailability()
    this.emitChange()
    void this.scheduleSeparations()
    void this.scheduleAnalysis()
  }

  async close(): Promise<void> {
    if (!this.project) return
    this.history.clear()
    this.queue.clear()
    this.analysis?.clear()
    await this.flush()
    this.project = null
    this.filePath = null
    this.emit('closed')
    this.emitChange()
  }

  /** Where new projects are created (Settings → Storage). */
  setProjectsDir(dir: string) {
    this.opts.projectsDir = dir
  }

  get projectsDir() {
    return this.opts.projectsDir
  }

  rename(name: string) {
    this.mutate((p) => P.renameProject(p, name))
    if (this.filePath && this.project) void this.opts.settings.touchRecent(this.filePath, this.project.name)
  }

  // ---- Saving -----------------------------------------------------------------

  private scheduleSave() {
    this.saveStatus = 'unsaved'
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.saveNow(), this.opts.autosaveDelayMs ?? 800)
  }

  /**
   * Saves the project as it is now. A save already running holds an older
   * state, so this waits for it and then saves again: closing or quitting right
   * after an edit then still writes that edit (it used to return the older save's
   * promise, and the project was closed before the newer one ran).
   */
  async saveNow(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    while (this.saving) await this.saving
    this.saving = this.doSave().finally(() => (this.saving = null))
    return this.saving
  }

  private async doSave() {
    if (!this.project || !this.filePath) return
    const path = this.filePath
    this.saveStatus = 'saving'
    this.emitChange()
    try {
      let project = this.project
      if (this.opts.beforeSave) {
        project = await this.opts.beforeSave(project)
        // Keep the effects as they are now (one may have been added or removed
        // while the engine answered); only take the captured plugin states.
        const states = new Map(project.effects.map((e) => [e.slotId, e.state]))
        if (this.project && this.project.id === project.id)
          this.project = { ...this.project, effects: this.project.effects.map((e) => (states.has(e.slotId) ? { ...e, state: states.get(e.slotId) ?? e.state } : e)) }
      }
      await saveProjectFile(path, project)
      this.saveStatus = this.saveTimer ? 'unsaved' : 'saved'
      this.saveError = null
      this.lastSavedAt = new Date().toISOString()
    } catch (err) {
      this.saveStatus = 'error'
      this.saveError = err instanceof Error ? err.message : String(err)
    }
    this.emitChange()
  }

  async flush() {
    if (this.saveTimer || this.saveStatus === 'unsaved') await this.saveNow()
    else if (this.saving) await this.saving
  }

  // ---- Songs --------------------------------------------------------------------

  /**
   * Add songs to the playlist. With `copy`, each file is copied into the
   * project's Songs folder (as an APFS clone where possible) and the project
   * uses that copy; otherwise it points at the file where it is.
   */
  async importFiles(paths: string[], onProgress?: (done: number, total: number) => void, opts: { copy?: boolean } = {}): Promise<ImportResult> {
    if (!this.project || !this.filePath) throw new P.ProjectError('Create or open a project first')
    const pkg = this.filePath
    const result: ImportResult = { added: [], skipped: [] }
    const songs: Song[] = []
    const seen = new Set<string>()

    let done = 0
    for (const original of paths) {
      let path = original
      try {
        if (!IMPORTABLE.has(extname(path).toLowerCase())) throw new Error('Unsupported file type')
        const [info, hash] = await Promise.all([probe(path), hashFile(path)])
        if (seen.has(hash) || (this.project && P.hasSourceHash(this.project, hash))) throw new Error('Already in this playlist')
        seen.add(hash)

        if (opts.copy && !isInside(pkg, path)) {
          await mkdir(songsDir(pkg), { recursive: true })
          const dest = uniqueFilePath(songsDir(pkg), basename(path))
          await cloneFile(path, dest)
          path = dest
        }
        await this.adoptGenerated(hash)

        let playbackProxy: string | null = null
        if (needsProxy(path)) {
          const proxy = join(this.opts.cache.songDir(hash), 'playback.flac')
          await mkdir(this.opts.cache.songDir(hash), { recursive: true })
          if (!existsSync(proxy)) await transcodeToFlac(path, proxy)
          playbackProxy = this.opts.cache.rel(proxy)
        }

        songs.push(
          P.makeSong({
            title: info.title,
            artist: info.artist,
            durationSec: info.durationSec,
            playbackProxy,
            source: {
              path,
              hash,
              sizeBytes: info.sizeBytes,
              format: info.format,
              codec: info.codec,
              sampleRate: info.sampleRate,
              channels: info.channels,
              missing: false
            }
          })
        )
      } catch (err) {
        result.skipped.push({ path: original, reason: err instanceof Error ? err.message : String(err) })
      }
      onProgress?.(++done, paths.length)
    }

    if (songs.length) {
      this.mutate((p) => P.addSongs(p, songs))
      result.added = songs.map((s) => s.id)
      void this.scheduleSeparations()
      void this.scheduleAnalysis()
      void this.ensurePlaybackCopies()
    }
    return result
  }

  /**
   * Remove a song: its generated files are deleted, and a copy of it in the
   * project's Songs folder goes to the Trash. Files elsewhere are not touched.
   */
  async removeSong(id: string) {
    const song = this.project && P.findSong(this.project, id)
    if (!song || !this.filePath) return
    const pkg = this.filePath
    this.mutate((p) => P.removeSong(p, id))
    if (this.project && P.hasSourceHash(this.project, song.source.hash)) return
    this.queue.cancel(song.source.hash)
    await rm(this.opts.cache.songDir(song.source.hash), { recursive: true, force: true }).catch(() => {})
    if (isInside(songsDir(pkg), song.source.path) && existsSync(song.source.path))
      await (this.opts.trash ?? ((p) => rm(p, { force: true })))(song.source.path).catch(() => {})
  }

  /**
   * Bring in a song's generated folder from another project that already
   * has it, so it isn't separated again.
   * Copies are APFS clones: instant and taking no extra space.
   */
  private async adoptGenerated(hash: string) {
    const dest = this.opts.cache.songDir(hash)
    if (existsSync(dest)) return
    for (const root of this.opts.generatedSources?.() ?? []) {
      const src = join(root, hash)
      if (root === this.opts.cache.root || !existsSync(src)) continue
      try {
        await cloneGeneratedFolder(src, dest)
        return
      } catch {
        await rm(dest, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  private copying = false
  /** Songs whose playback copy failed this session: they play from the original, and the rest still get copies. */
  private copyFailed = new Set<string>()

  /**
   * Make a FLAC playback copy of every lossy original (MP3, M4A, …), one at a
   * time in the background, so the original seeks to exactly the same spot as
   * the separated tracks (see wantsProxy). Until it's ready the song plays
   * from the original file as before.
   */
  async ensurePlaybackCopies() {
    if (this.copying) return
    this.copying = true
    try {
      for (;;) {
        const pkg = this.filePath
        const song = this.project?.songs.find((s) => !s.playbackProxy && !this.copyFailed.has(s.source.hash) && wantsProxy(s.source.path) && existsSync(s.source.path))
        if (!pkg || !song) return
        const dir = this.opts.cache.songDir(song.source.hash)
        const out = join(dir, 'playback.flac')
        try {
          await mkdir(dir, { recursive: true })
          if (!existsSync(out)) await transcodeToFlac(song.source.path, out)
        } catch (err) {
          console.error(`Could not make a playback copy of ${song.title}:`, err)
          this.copyFailed.add(song.source.hash)
          continue
        }
        if (this.filePath !== pkg) return // another project opened meanwhile
        const rel = this.opts.cache.rel(out)
        this.mutate((p) => P.updateSongsByHash(p, song.source.hash, (s) => ({ ...s, playbackProxy: rel })))
      }
    } finally {
      this.copying = false
    }
  }

  /** Delete generated folders for songs that are no longer in the open project. */
  async removeUnusedGenerated(): Promise<number> {
    const project = this.project
    const root = this.opts.cache.root
    if (!project || !root) return 0
    let removed = 0
    for (const name of await readdir(root).catch(() => [] as string[])) {
      if (this.project !== project) break // another project opened meanwhile
      if (!/^[0-9a-f]{64}$/.test(name) || P.hasSourceHash(project, name)) continue
      await rm(join(root, name), { recursive: true, force: true }).catch(() => {})
      removed++
    }
    return removed
  }

  /** Songs that live outside the project folder (and still exist). */
  outsideSongs(): Song[] {
    const pkg = this.filePath
    if (!this.project || !pkg) return []
    return this.project.songs.filter((s) => !s.source.missing && !isInside(pkg, s.source.path))
  }

  /** Copy every song that lives elsewhere into the project's Songs folder. Returns how many were copied. */
  async collectSongs(): Promise<number> {
    const pkg = this.filePath
    const songs = this.outsideSongs()
    if (!pkg || songs.length === 0) return 0
    await mkdir(songsDir(pkg), { recursive: true })
    let copied = 0
    for (const song of songs) {
      if (!existsSync(song.source.path)) continue
      const dest = uniqueFilePath(songsDir(pkg), basename(song.source.path))
      await cloneFile(song.source.path, dest)
      if (this.filePath !== pkg) return copied
      this.mutate((p) => P.updateSongsByHash(p, song.source.hash, (s) => ({ ...s, source: { ...s.source, path: dest, missing: false } })))
      copied++
    }
    await this.saveNow()
    return copied
  }

  moveSong(id: string, toIndex: number) {
    this.mutate((p) => P.moveSong(p, id, toIndex))
  }

  selectSong(id: string | null) {
    this.mutate((p) => P.selectSong(p, id))
    const song = id && this.project ? P.findSong(this.project, id) : null
    if (song) this.queue.prioritize(song.source.hash)
  }

  updateSong(id: string, patch: SongPatch) {
    this.mutate((p) => P.updateSong(p, id, patch))
  }

  /** Mark songs whose source file has disappeared. */
  refreshSourceAvailability() {
    if (!this.project) return
    const changed = this.project.songs.some((s) => s.source.missing === existsSync(s.source.path))
    if (!changed) return
    this.mutate(
      (p) => ({ ...p, songs: p.songs.map((s) => ({ ...s, source: { ...s.source, missing: !existsSync(s.source.path) } })) }),
      false
    )
  }

  /**
   * Point a song at a new copy of its file. Returns 'different' (and changes
   * nothing) if the content differs and `acceptDifferent` is false.
   */
  async relink(id: string, newPath: string, acceptDifferent = false): Promise<'relinked' | 'different'> {
    const song = this.project && P.findSong(this.project, id)
    if (!song) throw new P.ProjectError('Unknown song')
    const [info, hash] = await Promise.all([probe(newPath), hashFile(newPath)])
    const same = hash === song.source.hash
    if (!same && !acceptDifferent) return 'different'

    this.mutate((p) =>
      P.updateSongsByHash(p, song.source.hash, (s) =>
        s.id !== id
          ? s
          : {
              ...s,
              durationSec: info.durationSec,
              source: { ...s.source, path: newPath, hash, sizeBytes: info.sizeBytes, format: info.format, codec: info.codec, missing: false },
              ...(same ? {} : { stems: {}, separation: { status: 'pending' as const, progress: 0 }, playbackProxy: null, loop: null, position: 0 })
            }
      )
    )
    void this.scheduleSeparations()
    void this.scheduleAnalysis()
    return 'relinked'
  }

  retrySeparation(id: string) {
    const song = this.project && P.findSong(this.project, id)
    if (!song || song.source.missing) return
    void this.queue.enqueue({ hash: song.source.hash, inputPath: song.source.path, durationSec: song.durationSec, label: song.title })
  }

  cancelSeparation(id: string) {
    const song = this.project && P.findSong(this.project, id)
    if (song) this.queue.cancel(song.source.hash)
  }

  /** Reuse cached stems where valid, queue the rest. Songs are processed in playlist order. */
  async scheduleSeparations() {
    const project = this.project
    if (!project) return
    for (const song of project.songs) {
      if (song.separation.status !== 'pending' && song.separation.status !== 'unavailable') continue
      const cached = await this.opts.cache.findValidStems(song.source.hash, this.queue.model, song.durationSec)
      if (this.project?.id !== project.id) return
      if (cached) {
        this.onSeparation(song.source.hash, { type: 'reset' })
        this.onSeparation(song.source.hash, { type: 'succeed', model: this.queue.model, warning: cached.warning }, cached.assets)
      } else if (song.source.missing) {
        this.onSeparation(song.source.hash, { type: 'fail', error: 'The original file is missing. Relink it to generate stems.' })
      } else {
        await this.queue.enqueue({ hash: song.source.hash, inputPath: song.source.path, durationSec: song.durationSec, label: song.title })
      }
    }
  }

  /** Detect tempo, key and tuning for songs that haven't been analysed. */
  async scheduleAnalysis() {
    const project = this.project
    if (!project || !this.analysis) return
    for (const song of project.songs) {
      if (song.analysis.status !== 'pending' && song.analysis.status !== 'unavailable') continue
      const path = song.playbackProxy ? this.opts.cache.abs(song.playbackProxy) : song.source.path
      if (!existsSync(path)) continue
      await this.analysis.enqueue(song.source.hash, path)
    }
  }

  retryAnalysis(id: string) {
    const song = this.project && P.findSong(this.project, id)
    if (!song) return
    this.onAnalysis(song.source.hash, { status: 'pending' })
    void this.scheduleAnalysis()
  }

  private onAnalysis(hash: string, analysis: Song['analysis']) {
    if (!this.project) return
    this.mutate((p) => P.updateSongsByHash(p, hash, (s) => ({ ...s, analysis })), analysis.status !== 'running')
  }

  /** Practice time reported by the window (song playing, or bass played with Monitor on). */
  async addPractice(songId: string | null, seconds: number) {
    const sec = Math.min(Math.max(0, seconds), 600)
    if (!sec) return
    await this.opts.settings.addPracticeDay(dayKey(), sec)
    if (this.project) this.mutate((p) => P.addPractice(p, songId && P.findSong(p, songId) ? songId : null, sec))
    else this.emitChange()
  }

  updateMetronome(patch: Partial<Project['metronome']>) {
    this.mutate((p) => P.updateMetronome(p, patch))
  }

  private onSeparation(hash: string, event: SeparationEvent, stems?: Record<StemKind, StemAsset>) {
    if (!this.project) return
    const persist = event.type !== 'progress'
    this.mutate(
      (p) =>
        P.updateSongsByHash(p, hash, (s) => {
          if (!canTransition(s.separation, event.type)) return s
          const separation = transition(s.separation, event)
          // Stems only exist alongside a 'ready' status; re-queuing drops them.
          let nextStems = s.stems
          if (event.type === 'succeed') nextStems = stems ?? s.stems
          else if (event.type === 'enqueue' || event.type === 'reset') nextStems = {}
          return { ...s, separation, stems: nextStems }
        }),
      persist
    )
  }
}
