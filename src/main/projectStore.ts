import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseProject, serializeProject } from '../shared/project'
import { normalizePreferences, type AudioConfig, type Preferences, type Project, type RecentProject } from '../shared/types'
import { findOnDisk, portableRelative, replaceFile } from './platform'

// A project is a folder (a macOS package, so Finder shows it as one file):
//
//   My Set.nota/
//     project.json     the playlist and all settings
//     Songs/           originals copied into the project (optional per song)
//     Generated/       separated tracks, key changes, waveforms, analysis,
//                      one folder per song named by its audio hash
//
// Songs inside the package are stored by relative path, so the project can be
// moved, renamed or copied to another Mac. Songs left elsewhere keep their
// absolute path.

export const PROJECT_EXTENSION = '.nota'
export const PROJECT_FILE = 'project.json'
export const SONGS_DIR = 'Songs'
export const GENERATED_DIR = 'Generated'

export const generatedDir = (pkg: string) => join(pkg, GENERATED_DIR)
export const songsDir = (pkg: string) => join(pkg, SONGS_DIR)

/** True if `path` is inside `dir` (not equal to it). */
export function isInside(dir: string, path: string): boolean {
  const r = relative(resolve(dir), resolve(path))
  return !!r && !r.startsWith('..') && !isAbsolute(r)
}

/** Write a file so readers only ever see the old or the new contents (temp file, then rename). */
export async function writeFileAtomic(path: string, contents: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, contents)
  await replaceFile(tmp, path)
}

/** Write a project package's project.json (songs inside the package by relative path). */
export async function saveProjectFile(pkg: string, project: Project) {
  const songs = project.songs.map((s) => (isInside(pkg, s.source.path) ? { ...s, source: { ...s.source, path: portableRelative(pkg, s.source.path) } } : s))
  await writeFileAtomic(join(pkg, PROJECT_FILE), serializeProject({ ...project, songs }))
}

/** Read a project package. Source paths come back absolute. */
export async function loadProjectFile(path: string): Promise<Project> {
  const file = join(path, PROJECT_FILE)
  if (!existsSync(file)) throw new Error('This folder is not a Nøta project')
  const project = parseProject(await readFile(file, 'utf8'))
  return {
    ...project,
    songs: project.songs.map((s) => ({ ...s, source: { ...s.source, path: findOnDisk(isAbsolute(s.source.path) ? s.source.path : join(path, s.source.path)) } }))
  }
}

export function safeFileName(name: string): string {
  return name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Practice'
}

export function uniqueProjectPath(dir: string, name: string): string {
  const base = safeFileName(name)
  let candidate = join(dir, base + PROJECT_EXTENSION)
  for (let i = 2; existsSync(candidate); i++) candidate = join(dir, `${base} ${i}${PROJECT_EXTENSION}`)
  return candidate
}

/** A free file name in `dir` for `fileName` ("Song.mp3", "Song 2.mp3", …). */
export function uniqueFilePath(dir: string, fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName
  const ext = dot > 0 ? fileName.slice(dot) : ''
  let candidate = join(dir, fileName)
  for (let i = 2; existsSync(candidate); i++) candidate = join(dir, `${stem} ${i}${ext}`)
  return candidate
}

// ---- App settings (recent projects, plugin folders) ------------------------------

export interface AppSettings {
  recent: RecentProject[]
  lastProjectPath: string | null
  pluginDirectories: string[] | null
  /** Last used audio setup, applied to new projects */
  audioDefaults: AudioConfig | null
  /**
   * Every project this app has created or opened. Their Generated folders are
   * reused when a song is added to another project.
   */
  knownProjects: string[]
  /** App-wide preferences from the Settings window */
  preferences: Preferences
  /** Seconds practised per local day ("2026-10-18"), across all projects */
  practiceDays: Record<string, number>
  /** When GitHub was last asked for a newer release (ISO), so it's at most daily */
  lastUpdateCheck: string | null
}

const DEFAULT_SETTINGS: AppSettings = { recent: [], lastProjectPath: null, pluginDirectories: null, audioDefaults: null, knownProjects: [], preferences: normalizePreferences(null), practiceDays: {}, lastUpdateCheck: null }

export class SettingsStore {
  private data: AppSettings = { ...DEFAULT_SETTINGS }

  constructor(private readonly path: string) {}

  async load() {
    try {
      this.data = { ...DEFAULT_SETTINGS, ...JSON.parse(await readFile(this.path, 'utf8')) }
      // Settings from before knownProjects existed: the recent list is what we know.
      if (!this.data.knownProjects.length) this.data.knownProjects = this.data.recent.map((r) => r.path)
      this.data.preferences = normalizePreferences(this.data.preferences)
      if (typeof this.data.practiceDays !== 'object' || !this.data.practiceDays) this.data.practiceDays = {}
    } catch {
      this.data = { ...DEFAULT_SETTINGS }
    }
    return this.data
  }

  get(): AppSettings {
    return this.data
  }

  async update(patch: Partial<AppSettings>) {
    this.data = { ...this.data, ...patch }
    await writeFileAtomic(this.path, JSON.stringify(this.data, null, 2))
  }

  async touchRecent(path: string, name: string) {
    const recent = [{ path, name, openedAt: new Date().toISOString() }, ...this.data.recent.filter((r) => r.path !== path)].slice(0, 12)
    const knownProjects = this.data.knownProjects.includes(path) ? this.data.knownProjects : [...this.data.knownProjects, path]
    await this.update({ recent, lastProjectPath: path, knownProjects })
  }

  /** The project was deleted (or is gone from disk): forget it. */
  async removeProject(path: string) {
    await this.update({
      recent: this.data.recent.filter((r) => r.path !== path),
      lastProjectPath: this.data.lastProjectPath === path ? null : this.data.lastProjectPath,
      knownProjects: this.data.knownProjects.filter((p) => p !== path)
    })
  }

  async addPracticeDay(day: string, seconds: number) {
    const practiceDays = { ...this.data.practiceDays, [day]: (this.data.practiceDays[day] ?? 0) + seconds }
    await this.update({ practiceDays })
  }

  async forgetRecent(path: string) {
    await this.update({
      recent: this.data.recent.filter((r) => r.path !== path),
      lastProjectPath: this.data.lastProjectPath === path ? null : this.data.lastProjectPath
    })
  }
}
