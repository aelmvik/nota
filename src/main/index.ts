import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { CutMap } from '../shared/cuts'
import { findSong } from '../shared/project'
import type { EffectChain, PluginInfo, SongPatch } from '../shared/types'
import type { DeviceRequest, TrackKind, TransportCommand, TransportLoad } from '../shared/api'
import type { EngineTrackSource } from '../shared/types'
import { AssetCache } from './assetCache'
import { AudioSession } from './audioSession'
import { EngineHost, resolveEngineBinary } from './engineHost'
import { bulkDataDir, computerName, exe, trashName, venvPython } from './platform'
import { TakeService } from './takes'
import { UpdateChecker } from './updates'
import { downloadAsset, installUpdate, updateTarget } from './updateInstaller'
import type { TakeState } from '../shared/takes'
import type { UpdateProgress } from '../shared/updates'
import { exportAudio, getTools, IMPORTABLE, setBundledToolsDir } from './media'
import { DEFAULT_VST3_DIRS, PluginScanner } from './pluginScanner'
import { generatedDir, isInside, PROJECT_EXTENSION, safeFileName, SettingsStore, songsDir } from './projectStore'
import { ProjectService } from './projectService'
import { DemucsProvider } from './separation/demucs'
import { AnalysisService } from './analysisService'
import { PythonEnv } from './pythonEnv'
import { TransportService } from './transport'
import { exportSetlistPdf } from './setlist'
import { TranscriptionService } from './transcription'
import { renderWithChanges } from './exportRender'
import { normalizePreferences, SEPARATION_MODELS, type Preferences, type StorageInfo } from '../shared/types'

// Lets a second copy (e.g. a test build) run with separate settings and cache.
if (process.env.NOTA_USER_DATA) app.setPath('userData', process.env.NOTA_USER_DATA)
// Windows starts a new copy for every launch; only the first keeps the window
// and the audio device (macOS does this itself). Keyed on userData, so a copy
// with its own NOTA_USER_DATA still runs beside it.
if (process.platform !== 'darwin' && !app.requestSingleInstanceLock()) app.exit(0)

const appRoot = app.getAppPath()
const defaultProjectsDir = () => join(app.getPath('documents'), 'Nøta Projects')
const userData = app.getPath('userData')
const bulkData = bulkDataDir(userData)
// Model weights the workers download (Demucs from Hugging Face, beat_this via
// PyTorch) live with the app's data, not in ~/.cache.
process.env.HF_HOME ??= join(bulkData, 'models', 'huggingface')
process.env.TORCH_HOME ??= join(bulkData, 'models', 'torch')

const settings = new SettingsStore(join(userData, 'settings.json'))
// NOTA_UPDATE_FROM pretends to be an older version, to try updating from a development build.
const updates = new UpdateChecker(process.env.NOTA_UPDATE_FROM || app.getVersion(), settings, updateTarget())
updates.on('change', (update) => send('app:update', update))
// Generated audio lives in the open project's package; the root is set when one opens.
const cache = new AssetCache()
// Python scripts ship as plain files next to the app (they can't run from inside the asar).
const scriptsDir = app.isPackaged ? join(process.resourcesPath, 'separation') : join(appRoot, 'separation')
// ffmpeg, ffprobe and uv, bundled in the app (scripts/build-tools.mjs)
const toolsDir = app.isPackaged ? join(process.resourcesPath, 'tools') : join(appRoot, 'native', 'build', 'tools')
setBundledToolsDir(toolsDir)
// Windows: the C++ runtime PyTorch needs ships with the tools; the Python workers
// (which inherit this environment) load it from there.
if (process.platform === 'win32' && existsSync(join(toolsDir, 'vcruntime'))) process.env.NOTA_VCRUNTIME ??= join(toolsDir, 'vcruntime')
const uv =existsSync(join(toolsDir, exe('uv'))) ? join(toolsDir, exe('uv')) : null
const pythonEnv = new PythonEnv(scriptsDir, join(bulkData, 'python-env'), uv, app.isPackaged ? [] : [venvPython(join(appRoot, 'separation', '.venv'))])
const provider = new DemucsProvider({ env: pythonEnv, model: process.env.NOTA_SEPARATION_MODEL || 'htdemucs', ffmpegPath: getTools().ffmpeg })
const engine = new EngineHost(resolveEngineBinary(appRoot, process.resourcesPath))
// Plugin windows' title bars follow the app's light or dark theme, in its background colour.
const sendTheme = () => void engine.call('setWindowTheme', { dark: nativeTheme.shouldUseDarkColors, caption: windowBackground() }).catch(() => {})
engine.on('ready', sendTheme)
nativeTheme.on('updated', sendTheme)
const scanner = new PluginScanner(join(userData, 'plugins.json'))

let audio: AudioSession
const projects = new ProjectService({
  cache,
  provider,
  settings,
  projectsDir: defaultProjectsDir(),
  audioDefaults: () => settings.get().audioDefaults,
  analysis: (listener) => new AnalysisService(pythonEnv, () => cache.root, listener, getTools().ffmpeg),
  beforeSave: (p) => audio.captureStates(p),
  // A song already separated in another project is reused, not separated again.
  generatedSources: () =>
    settings
      .get()
      .knownProjects.filter((p) => p !== projects.filePath)
      .map(generatedDir),
  trash: (path) => shell.trashItem(path)
})
audio = new AudioSession(engine, projects, {
  get: () => settings.get().audioDefaults,
  set: (a) => void settings.update({ audioDefaults: a })
})

// Song playback in the engine. Only the open project's files may be played.
const transport = new TransportService(engine, (src: EngineTrackSource) => {
  if (src.scope === 'cache') {
    const path = cache.abs(src.path)
    return cache.contains(path) && existsSync(path) ? path : null
  }
  return projects.project?.songs.some((s) => s.source.path === src.path) && existsSync(src.path) ? src.path : null
})

let win: BrowserWindow | null = null
const send = (channel: string, payload: unknown) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

projects.on('change', (s) => send('project:change', s))
// Bass notes for the Notes view, transcribed on first use (see transcription.ts).
const transcription = new TranscriptionService(pythonEnv, () => cache.root, getTools().ffmpeg)
transcription.on('state', (e) => send('songs:notesState', e))
const takes = new TakeService(engine, pythonEnv, () => cache.root, getTools().ffmpeg, () => settings.get().preferences.tunerA4)
takes.on('state', (e) => send('songs:takeState', e))
projects.on('closed', () => void takes.stop())
projects.on('closed', () => transcription.clear())
engine.on('snapshot', (s) => send('engine:snapshot', s))
engine.on('meters', (m) => send('engine:meters', m))
engine.on('tuner', (t) => send('engine:tuner', t))
transport.on('state', (s) => send('transport:state', s))
transport.on('interrupted', (e) => send('transport:interrupted', e))
audio.on('chain', (e) => send('effects:slotErrors', e))
scanner.on('progress', (p) => send('effects:scanProgress', p))
pythonEnv.on('progress', (p) => send('separation:setupProgress', p))


async function separationStatus() {
  const a = await provider.checkAvailability()
  return {
    available: a.available,
    name: provider.name,
    model: provider.model,
    device: a.device,
    reason: a.reason,
    ffmpeg: !!getTools().ffmpeg,
    canInstall: pythonEnv.canInstall()
  }
}

// Plugin parameters change inside native editor windows, which the project
// never hears about. Capture their state periodically and when an editor closes.
async function capturePluginStates() {
  const p = projects.project
  if (!p || p.effects.length === 0) return
  const next = await audio.captureStates(p)
  const changed = next.effects.some((e, i) => e.state !== p.effects[i]?.state)
  if (changed && projects.project?.id === p.id) projects.mutate((cur) => ({ ...cur, effects: next.effects }))
}
engine.on('editorClosed', () => void capturePluginStates())
setInterval(() => void capturePluginStates(), 20_000).unref()

// ---- Undo -----------------------------------------------------------------------

const SONG_EDIT_LABELS: Record<string, string> = {
  title: 'Rename song',
  artist: 'Artist',
  speed: 'Speed',
  pitch: 'Key',
  loop: 'Loop',
  cuts: 'Cut',
  volume: 'Track volume',
  tempo: 'Tempo',
  beatsPerBar: 'Meter',
  downbeat: 'Bar start',
  gridScale: 'Half/double time',
  evenBars: 'Even bars',
  trainer: 'Speed trainer',
  notes: 'Edit notes'
}
const songEditLabel = (patch: SongPatch) =>
  patch.notes === null ? 'Back to transcription' : (SONG_EDIT_LABELS[Object.keys(patch)[0] ?? ''] ?? 'Edit song')

/** Undo or redo one project edit; effects and levels are re-applied to the engine. */
async function stepHistory(direction: 'undo' | 'redo'): Promise<string | null> {
  // Keep plugin settings made in their windows since the last capture.
  await capturePluginStates()
  const before = projects.project?.effects ?? []
  const entry = projects.step(direction)
  if (!entry) return null
  const touches = (key: string) => entry.ops.some((o) => o.path[0] === key)
  // Only the plugins that changed are touched; the rest keep playing.
  if (touches('effects')) await audio.applyEffects(before, projects.project?.effects ?? [])
  if (touches('audio') || touches('outputIncludesBass')) await audio.sync()
  return entry.label
}

// ---- IPC ------------------------------------------------------------------------

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>) {
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as A)))
}

function requireSong(id: string) {
  const song = projects.project && findSong(projects.project, id)
  if (!song) throw new Error('This song is no longer in the project')
  return song
}

function defaultProjectName() {
  return `Practice ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
}

/** Projects deleted in Finder: stop offering them in Recent or as a source of generated audio. */
async function forgetMissingProjects() {
  for (const p of settings.get().knownProjects) if (!existsSync(p)) await settings.removeProject(p)
  send('project:change', projects.snapshot())
}

// ---- Preferences (Settings window) ------------------------------------------------

function applyPreferences(p: Preferences) {
  // Drives prefers-color-scheme in the window, and native dialogs and menus.
  nativeTheme.themeSource = p.theme
  win?.setBackgroundColor(windowBackground())
  if (!process.env.NOTA_SEPARATION_MODEL) provider.setModel(SEPARATION_MODELS[p.separationQuality])
  projects.setProjectsDir(p.projectsDir ?? defaultProjectsDir())
}

async function setPreferences(patch: Partial<Preferences>): Promise<Preferences> {
  const next = normalizePreferences({ ...settings.get().preferences, ...patch })
  await settings.update({ preferences: next })
  applyPreferences(next)
  send('prefs:change', next)
  return next
}

async function folderBytes(dir: string): Promise<{ bytes: number; folders: number }> {
  const { readdir, stat } = await import('node:fs/promises')
  let bytes = 0
  let folders = 0
  const walk = async (d: string, depth: number) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (depth === 0) folders++
        await walk(p, depth + 1)
      } else bytes += await stat(p).then((st) => st.size, () => 0)
    }
  }
  await walk(dir, 0)
  return { bytes, folders }
}

async function storageInfo(): Promise<StorageInfo> {
  const a = await provider.checkAvailability()
  const pkg = projects.filePath
  const songs = projects.project?.songs ?? []
  return {
    projectsDir: projects.projectsDir,
    project: pkg
      ? {
          path: pkg,
          songsBytes: (await folderBytes(songsDir(pkg))).bytes,
          generatedBytes: (await folderBytes(generatedDir(pkg))).bytes,
          copiedSongs: songs.filter((s) => isInside(pkg, s.source.path)).length,
          outsideSongs: projects.outsideSongs().length
        }
      : null,
    pythonEnv: { installed: a.available, path: pythonEnv.python(), device: a.device, reason: a.reason }
  }
}

async function openProjectDialog(): Promise<boolean> {
  const res = await dialog.showOpenDialog(win!, {
    title: 'Open practice project',
    defaultPath: projects.projectsDir,
    filters: [{ name: 'Nøta project', extensions: [PROJECT_EXTENSION.slice(1)] }],
    // Packages are folders; until macOS knows the app (installed), Finder treats them as plain folders.
    properties: ['openFile', 'openDirectory']
  })
  const path = res.filePaths[0]
  if (res.canceled || !path) return false
  if (!path.endsWith(PROJECT_EXTENSION)) throw new Error('Choose a Nøta project (.nota)')
  await projects.open(path)
  return true
}

/**
 * How newly added songs are stored, per Settings → Storage. "Ask" shows a
 * dialog (copying is the default); null means the import was cancelled.
 */
async function chooseSongStorage(paths: string[]): Promise<{ copy: boolean } | null> {
  const pkg = projects.filePath
  const pref = settings.get().preferences.songStorage
  if (pref !== 'ask') return { copy: pref === 'copy' }
  if (!pkg || paths.every((p) => isInside(pkg, p))) return { copy: false }
  const n = paths.length
  const choice = await dialog.showMessageBox(win!, {
    type: 'question',
    message: `Copy ${n === 1 ? 'this song' : `these ${n} songs`} into the project?`,
    detail:
      'Copied songs travel with the project and can’t go missing if you move or delete the originals. Leaving them where they are saves disk space, but the project then needs them to stay put.',
    checkboxLabel: 'Don’t ask again (change this in Settings → Storage)',
    buttons: ['Copy Into Project', 'Leave Where They Are', 'Cancel'],
    defaultId: 0,
    cancelId: 2
  })
  if (choice.response === 2) return null
  const copy = choice.response === 0
  if (choice.checkboxChecked) await setPreferences({ songStorage: copy ? 'copy' : 'reference' })
  return { copy }
}

async function importInto(paths: string[]) {
  if (!projects.project) await projects.create(defaultProjectName())
  const mode = await chooseSongStorage(paths)
  if (!mode) return null
  return projects.importFiles(paths, (done, total) => send('songs:importProgress', { done, total }), mode)
}

/**
 * Delete the open project after confirmation: the whole project folder,
 * including its copied songs and generated audio, goes to the Trash.
 */
async function deleteProject(): Promise<boolean> {
  const project = projects.project
  const path = projects.filePath
  if (!project || !path) return false
  const choice = await dialog.showMessageBox(win!, {
    type: 'warning',
    message: `Delete “${project.name}”?`,
    detail:
      `The project, with the songs copied into it and everything Nøta made for them, is moved to the ${trashName()}. Songs that live elsewhere on ${computerName()} are not touched.`,
    buttons: ['Delete Project', 'Cancel'],
    defaultId: 1,
    cancelId: 1
  })
  if (choice.response !== 0) return false
  await projects.close()
  await shell.trashItem(path).catch(() => {})
  await settings.removeProject(path)
  send('project:change', projects.snapshot())
  return true
}

/** Close the open project (it's saved) and go back to the start screen, where the next launch begins too. */
async function closeProject() {
  if (!projects.project) return
  await projects.close()
  await settings.update({ lastProjectPath: null })
}

/** Save the open project's setlist as a PDF and open it. Returns the path, or null if cancelled. */
async function exportSetlist(): Promise<string | null> {
  const project = projects.project
  if (!project) throw new Error('Open a project first')
  const res = await dialog.showSaveDialog(win!, {
    title: 'Export setlist',
    defaultPath: join(app.getPath('documents'), `${safeFileName(project.name)} setlist.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (res.canceled || !res.filePath) return null
  await exportSetlistPdf(projects.project ?? project, res.filePath)
  void shell.openPath(res.filePath)
  return res.filePath
}

async function importDialog() {
  const res = await dialog.showOpenDialog(win!, {
    title: 'Import songs',
    filters: [{ name: 'Audio', extensions: [...IMPORTABLE].map((e) => e.slice(1)) }],
    properties: ['openFile', 'multiSelections']
  })
  if (res.canceled || res.filePaths.length === 0) return null
  return importInto(res.filePaths)
}

function registerIpc() {
  handle('project:get', () => projects.snapshot())
  handle('project:create', (name: string) => projects.create(name || defaultProjectName()))
  handle('project:openDialog', openProjectDialog)
  handle('project:open', async (path: string) => {
    if (!existsSync(path)) {
      await settings.forgetRecent(path)
      throw new Error('That project no longer exists')
    }
    await projects.open(path)
  })
  handle('project:collectSongs', () => projects.collectSongs())
  handle('project:addPractice', (seconds: number, songId: string | null) => projects.addPractice(songId, seconds))
  handle('project:rename', (name: string) => projects.undoable('Rename project', () => projects.rename(name)))
  handle('project:undo', () => stepHistory('undo'))
  handle('project:redo', () => stepHistory('redo'))
  handle('project:exportSetlist', exportSetlist)
  handle('prefs:get', () => settings.get().preferences)
  handle('prefs:set', (patch: Partial<Preferences>) => setPreferences(patch))
  handle('app:version', () => app.getVersion())
  handle('app:update', () => updates.available)
  handle('app:checkUpdates', () => updates.check())
  handle('app:openUpdate', () => {
    const url = updates.available?.url
    if (url?.startsWith('https://github.com/')) void shell.openExternal(url)
  })
  // Download this system's file from the newer release and install it (see updateInstaller.ts).
  // The usual quit saves the project first; on the Mac and with a .deb the app comes back by itself.
  let installing = false
  handle('app:installUpdate', async () => {
    const update = updates.available
    const target = updateTarget()
    if (!update || installing) return
    if (!update.asset || !target) {
      if (update.url.startsWith('https://github.com/')) void shell.openExternal(update.url)
      return
    }
    installing = true
    const progress = (p: UpdateProgress) => send('app:updateProgress', p)
    try {
      progress({ status: 'downloading', progress: 0 })
      const file = await downloadAsset(update.asset, `Nota/${app.getVersion()}`, (p) => progress({ status: 'downloading', progress: p }))
      progress({ status: 'installing' })
      const outcome = await installUpdate(file, target, app.isPackaged, (path) => (app.isPackaged ? void shell.openPath(path) : shell.showItemInFolder(path)))
      if (outcome === 'opened') progress({ status: 'opened' })
      else {
        if (outcome === 'restart') app.relaunch()
        app.quit()
      }
    } catch (err) {
      progress({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
    } finally {
      installing = false
    }
  })
  handle('prefs:chooseProjectsDir', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Choose where new projects are saved',
      defaultPath: projects.projectsDir,
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return settings.get().preferences
    return setPreferences({ projectsDir: res.filePaths[0] })
  })
  handle('storage:info', storageInfo)
  handle('storage:cleanUnused', async () => {
    const before = (await storageInfo()).project?.generatedBytes ?? 0
    const removed = await projects.removeUnusedGenerated()
    const after = (await storageInfo()).project?.generatedBytes ?? 0
    return { removed, freedBytes: Math.max(0, before - after) }
  })
  // Off the Mac the window buttons sit on the brand bar; the renderer knows its colours.
  handle('window:titleBarColors', (color: string, symbolColor: string) => {
    if (process.platform !== 'darwin') win?.setTitleBarOverlay({ color, symbolColor, height: 48 })
  })
  handle('storage:reveal', (which: 'project' | 'projects') => {
    if (which === 'project' && projects.filePath) void shell.openPath(projects.filePath)
    else void shell.openPath(projects.projectsDir)
  })
  handle('project:delete', deleteProject)
  handle('project:close', closeProject)
  handle('project:reveal', () => projects.filePath && shell.showItemInFolder(projects.filePath))
  handle('project:forgetRecent', async (path: string) => {
    await settings.forgetRecent(path)
    send('project:change', projects.snapshot())
  })

  handle('songs:importDialog', importDialog)
  handle('songs:importPaths', (paths: string[]) => importInto(paths))
  handle('songs:remove', async (id: string) => {
    const song = requireSong(id)
    // The same rule removeSong uses to move the song to the Trash.
    const copied = !!projects.filePath && isInside(songsDir(projects.filePath), song.source.path)
    const choice = await dialog.showMessageBox(win!, {
      type: 'warning',
      message: `Remove “${song.title}” from the playlist?`,
      detail: copied
        ? `Its separated tracks, notes and settings are deleted, and the copy of the song in this project is moved to the ${trashName()}.`
        : 'Its separated tracks, notes and settings are deleted. The song file itself is not touched.',
      buttons: ['Remove', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    })
    if (choice.response === 0) await projects.removeSong(id)
  })
  handle('songs:move', (id: string, to: number) => projects.undoable('Move song', () => projects.moveSong(id, to)))
  handle('songs:select', (id: string | null) => projects.selectSong(id))
  handle('songs:update', (id: string, patch: SongPatch) => {
    // Fewer cuts than before is a restore, not a cut.
    const restoring = patch.cuts !== undefined && patch.cuts.length < (projects.project ? requireSong(id).cuts.length : 0)
    return projects.undoable(restoring ? 'Restore cut' : songEditLabel(patch), () => projects.updateSong(id, patch))
  })
  handle('songs:retry', (id: string) => projects.retrySeparation(id))
  handle('songs:cancel', (id: string) => projects.cancelSeparation(id))
  handle('songs:reveal', (id: string) => {
    const song = requireSong(id)
    if (existsSync(song.source.path)) shell.showItemInFolder(song.source.path)
  })
  handle('songs:notes', (id: string) => {
    const song = requireSong(id)
    const stem = song.stems.bass
    return transcription.get(song, stem ? cache.abs(stem.cachePath) : null)
  })
  handle('songs:take', async (id: string): Promise<TakeState> => {
    const song = requireSong(id)
    if (takes.recordingHash === song.source.hash) return { status: 'recording' }
    const take = await takes.read(song.source.hash)
    return take ? { status: 'ready', take } : { status: 'none' }
  })
  handle('songs:recordTake', (id: string) => takes.start(requireSong(id).source.hash))
  handle('songs:stopTake', () => takes.stop())
  handle('songs:clearTake', (id: string) => takes.clear(requireSong(id).source.hash))
  handle('songs:export', async (id: string, kind: 'original' | 'bass' | 'backing') => {
    const song = requireSong(id)
    const input =
      kind === 'original'
        ? song.source.missing && song.playbackProxy
          ? cache.abs(song.playbackProxy)
          : song.source.path
        : song.stems[kind]
          ? cache.abs(song.stems[kind]!.cachePath)
          : null
    if (!input || !existsSync(input)) throw new Error(kind === 'original' ? 'The original file is missing' : 'This track isn’t separated yet')
    const label = kind === 'original' ? 'Original' : kind === 'bass' ? 'Bass' : 'Play Along'

    // With speed or key changes or cuts, ask whether to bake them in.
    const { semitones, cents } = song.pitch
    const cuts = song.cuts
    const changed = song.speed !== 1 || semitones !== 0 || cents !== 0 || cuts.length > 0
    const changes = [
      song.speed !== 1 ? `${Math.round(song.speed * 100)} %` : null,
      semitones ? `${semitones > 0 ? '+' : '−'}${Math.abs(semitones)} st` : null,
      cents ? `${cents > 0 ? '+' : '−'}${Math.abs(cents)} ¢` : null,
      cuts.length ? `${cuts.length} ${cuts.length === 1 ? 'cut' : 'cuts'}` : null
    ]
      .filter(Boolean)
      .join(', ')
    let withChanges = false
    if (changed) {
      const choice = await dialog.showMessageBox(win!, {
        type: 'question',
        message: 'Export with your changes?',
        detail: `This song has ${changes}. Include that in the exported file (cut parts left out), or export it as recorded?`,
        buttons: [`With changes (${changes})`, 'As recorded', 'Cancel'],
        defaultId: 0,
        cancelId: 2
      })
      if (choice.response === 2) return null
      withChanges = choice.response === 0
    }

    const res = await dialog.showSaveDialog(win!, {
      title: `Export ${label.toLowerCase()}`,
      defaultPath: join(app.getPath('music'), `${safeFileName(song.title)} - ${label}${withChanges ? ` (${changes})` : ''}.wav`),
      filters: [
        { name: 'WAV (24-bit)', extensions: ['wav'] },
        { name: 'FLAC', extensions: ['flac'] },
        { name: 'MP3', extensions: ['mp3'] }
      ]
    })
    if (res.canceled || !res.filePath) return null
    // Progress for the window: rendering the changes (most of the time), then writing the file.
    const file = res.filePath
    const report = (progress: number | null) => send('songs:exportProgress', { id, title: `${song.title} (${label})`, progress })
    report(0)
    try {
      if (withChanges) {
        const binary = engine.snapshot().binaryPath
        if (!binary) throw new Error('The audio engine isn’t available, so the changes can’t be rendered')
        const rendered = await renderWithChanges(
          binary,
          input,
          { durationSec: song.durationSec, cuts, speed: song.speed, semitones, cents, sampleRate: song.source.sampleRate ?? 48000 },
          (p) => report(p * 0.8)
        )
        try {
          await exportAudio(rendered.path, file, new CutMap(cuts, song.durationSec).kept / song.speed, (p) => report(0.8 + p * 0.2))
        } finally {
          await rendered.cleanup()
        }
      } else await exportAudio(input, file, song.durationSec, report)
    } finally {
      report(null)
    }
    shell.showItemInFolder(file)
    return res.filePath
  })
  handle('songs:relink', async (id: string) => {
    const song = requireSong(id)
    const res = await dialog.showOpenDialog(win!, {
      title: `Locate "${song.title}"`,
      message: `Previously at ${song.source.path}`,
      filters: [{ name: 'Audio', extensions: [...IMPORTABLE].map((e) => e.slice(1)) }],
      properties: ['openFile']
    })
    if (res.canceled || !res.filePaths[0]) return 'cancelled'
    const outcome = await projects.relink(id, res.filePaths[0])
    if (outcome === 'different') {
      const choice = await dialog.showMessageBox(win!, {
        type: 'question',
        message: 'This is not the same recording',
        detail: 'The file you picked has different audio from the original. Use it anyway? Its bass stem and backing track will be generated again.',
        buttons: ['Use This File', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      })
      if (choice.response !== 0) return 'cancelled'
      return projects.relink(id, res.filePaths[0], true)
    }
    return outcome
  })
  handle('songs:waveform', async (id: string, kind: TrackKind) => {
    const song = requireSong(id)
    if (kind === 'original') {
      const path = song.playbackProxy ? cache.abs(song.playbackProxy) : song.source.path
      if (!existsSync(path)) return null
      return cache.getWaveform(song.source.hash, 'original', path)
    }
    const stem = song.stems[kind]
    if (!stem) return null
    return cache.getWaveform(song.source.hash, `${stem.model}-${kind}`, cache.abs(stem.cachePath))
  })

  handle('separation:status', separationStatus)
  handle('separation:install', async () => {
    await pythonEnv.install()
    provider.resetAvailability()
    const status = await separationStatus()
    send('separation:status', status)
    if (status.available) {
      // Everything that was waiting on the environment can run now.
      const p = projects.project
      if (p) {
        for (const s of p.songs) if (s.separation.status === 'unavailable') projects.retrySeparation(s.id)
        for (const s of p.songs) if (s.analysis.status === 'unavailable') projects.retryAnalysis(s.id)
      }
    }
    return status
  })
  handle('songs:beats', async (id: string) => {
    const song = requireSong(id)
    return projects.analysis ? projects.analysis.grid(song.source.hash) : null
  })
  handle('songs:retryAnalysis', (id: string) => projects.retryAnalysis(id))
  handle('project:updateMetronome', (patch: Record<string, unknown>) => projects.undoable('Metronome', () => projects.updateMetronome(patch)))

  handle('engine:get', () => engine.snapshot())
  handle('engine:restart', () => engine.restart())
  handle('engine:setDevice', (req: DeviceRequest) => audio.setDevice(req))
  handle('engine:showControlPanel', () => audio.showControlPanel())
  handle('engine:useProAudio', () => audio.useProAudio())
  handle('engine:setMonitoring', (enabled: boolean) => audio.setMonitoring(enabled))
  handle('engine:setInputTrim', (db: number) => projects.undoable('Trim', () => audio.setInputTrim(db)))
  handle('engine:setMonitorLevel', (db: number) => projects.undoable('Monitor level', () => audio.setMonitorLevel(db)))
  handle('engine:setPlaybackVolume', (v: number) => projects.undoable('Song volume', () => audio.setPlaybackVolume(v)))
  handle('engine:setTuner', (enabled: boolean, mute: boolean) => audio.setTuner(enabled, mute))

  handle('transport:load', (req: TransportLoad & { seq: number }) => transport.load(req))
  handle('transport:tracks', (tracks: (EngineTrackSource | null)[], seq: number) => transport.setTracks(tracks, seq))
  ipcMain.on('transport:command', (_e, command: TransportCommand & { seq: number }) => transport.send(command))

  const pluginDirs = () => settings.get().pluginDirectories ?? DEFAULT_VST3_DIRS
  handle('effects:catalog', () => scanner.getCatalog())
  handle('effects:scan', async () => {
    const binary = engine.snapshot().binaryPath
    if (!binary) throw new Error('The audio engine is not built, so plugins cannot be scanned')
    return scanner.scan(binary, pluginDirs(), engine.snapshot().formats.length ? engine.snapshot().formats : ['VST3', 'AudioUnit'])
  })
  handle('effects:scanProgress', () => scanner.getProgress())
  handle('effects:addDirectory', async () => {
    const res = await dialog.showOpenDialog(win!, { title: 'Add VST3 folder', properties: ['openDirectory'] })
    if (res.canceled || !res.filePaths[0]) return null
    const dirs = [...new Set([...pluginDirs(), res.filePaths[0]])]
    await settings.update({ pluginDirectories: dirs })
    await scanner.load(dirs)
    return scanner.getCatalog()
  })
  handle('effects:removeDirectory', async (dir: string) => {
    const dirs = pluginDirs().filter((d) => d !== dir)
    await settings.update({ pluginDirectories: dirs })
    await scanner.load(dirs)
    return scanner.getCatalog()
  })
  handle('effects:add', (plugin: PluginInfo, chain?: EffectChain) => projects.undoable('Add effect', () => audio.addEffect(plugin, chain)))
  handle('effects:setOutputIncludesBass', (include: boolean) => projects.undoable('Bass through output effects', () => audio.setOutputIncludesBass(include)))
  handle('effects:remove', (slotId: string) => projects.undoable('Remove effect', () => audio.removeEffect(slotId)))
  handle('effects:move', (slotId: string, to: number) => projects.undoable('Move effect', () => audio.moveEffect(slotId, to)))
  handle('effects:setBypass', (slotId: string, bypassed: boolean) => projects.undoable(bypassed ? 'Bypass effect' : 'Turn effect on', () => audio.setBypass(slotId, bypassed)))
  handle('effects:toggleEditor', (slotId: string) => audio.toggleEditor(slotId))
  handle('effects:slotErrors', () => audio.getSlotErrors())
}

// ---- Window & menu ------------------------------------------------------------------

function buildMenu() {
  const mac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    // The app menu (About, Settings, Quit) is a Mac thing; elsewhere Exit goes under File.
    ...(mac ? [{ role: 'appMenu' } as const] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: () => void projects.create(defaultProjectName()) },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => void openProjectDialog().catch((e) => dialog.showErrorBox('Could not open the project', String(e?.message ?? e))) },
        { type: 'separator' },
        { label: 'Import Songs…', accelerator: 'CmdOrCtrl+I', click: () => send('menu:import', null) },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => void projects.saveNow() },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('menu:settings', null) },
        { label: 'Export Setlist as PDF…', accelerator: 'CmdOrCtrl+P', click: () => void exportSetlist().catch((e) => dialog.showErrorBox('Could not export the setlist', String(e?.message ?? e))) },
        { label: mac ? 'Show Project in Finder' : 'Show Project Folder', click: () => projects.filePath && shell.showItemInFolder(projects.filePath) },
        { type: 'separator' },
        { label: 'Close Project', click: () => void closeProject() },
        { label: 'Delete Project…', click: () => void deleteProject() },
        ...(mac ? [] : [{ type: 'separator' } as const, { role: 'quit' } as const])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        // Undo/redo go to the window: text fields undo typing, everything else undoes project edits.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('menu:undo', null) },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('menu:redo', null) },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Matches --chassis, so a resize or reload never flashes the other theme. */
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#f4f5f4')

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    title: 'Nøta',
    backgroundColor: windowBackground(),
    // The 48 px brand-coloured bar is the title bar: on the Mac with the traffic
    // lights in it, elsewhere with the system's window buttons drawn over its right
    // end (coloured by the renderer through window:titleBarColors).
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 17 } }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: '#000cb6', symbolColor: '#ffffff', height: 48 } }),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  // The menu stays for its shortcuts, but isn't drawn (Alt would otherwise pop it up mid-gesture).
  if (process.platform !== 'darwin') win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => win?.show())
  // The daily update check, a little after start so it never slows it down (built apps only).
  if (app.isPackaged) setTimeout(() => void updates.checkIfDue(), 10_000)
  if (process.platform === 'win32') {
    // Windows 11 draws a 1 px frame at the top of a restored window and moves the
    // window buttons down by it; the brand bar follows (see .rail in styles.css).
    const sendFramed = () => win?.webContents.send('window:framed', !win.isMaximized() && !win.isFullScreen())
    win.on('maximize', sendFramed)
    win.on('unmaximize', sendFramed)
    win.on('enter-full-screen', sendFramed)
    win.on('leave-full-screen', sendFramed)
    win.webContents.on('did-finish-load', sendFramed)
  }
  win.webContents.once('did-finish-load', importDroppedSongs) // songs that opened the app

  // Device labels for output selection; the renderer never captures the mic itself.
  win.webContents.session.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'speaker-selection')
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'speaker-selection'))

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

// Double-clicking a project in Finder (also how the app may be launched).
let pendingOpen: string | null = null
// Songs dropped on the Dock icon or opened with Nøta go into the open project, like
// files dropped on the window. macOS sends one event per file, so gather them briefly.
let droppedSongs: string[] = []
let droppedTimer: NodeJS.Timeout | null = null
function importDroppedSongs() {
  droppedTimer = null
  if (!win || win.webContents.isLoading() || !droppedSongs.length) return
  const paths = droppedSongs
  droppedSongs = []
  void importInto(paths)
    .then((res) => res && send('songs:importResult', res))
    .catch((err) => dialog.showErrorBox('Could not add the songs', String(err?.message ?? err)))
}

app.on('open-file', (e, path) => {
  e.preventDefault()
  if (IMPORTABLE.has(extname(path).toLowerCase())) {
    droppedSongs.push(path)
    if (droppedTimer) clearTimeout(droppedTimer)
    droppedTimer = setTimeout(importDroppedSongs, 200)
    return
  }
  if (!win) pendingOpen = path
  else void projects.open(path).catch((err) => dialog.showErrorBox('Could not open the project', String(err?.message ?? err)))
})

// Another launch on Windows: bring this window forward instead.
app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

app.whenReady().then(async () => {
  await settings.load()
  applyPreferences(settings.get().preferences)
  await scanner.load(settings.get().pluginDirectories)
  registerIpc()
  buildMenu()
  if (!app.isPackaged && process.platform === 'darwin') {
    const icon = join(appRoot, 'build', 'icon.png')
    if (existsSync(icon)) app.dock?.setIcon(icon)
  }
  engine.start()

  // A project double-clicked to launch Nøta always opens; otherwise the setting decides.
  const last = pendingOpen ?? (settings.get().preferences.openAtLaunch === 'last' ? settings.get().lastProjectPath : null)
  pendingOpen = null
  if (last && existsSync(last)) {
    try {
      await projects.open(last)
    } catch (err) {
      console.error('Could not reopen last project:', err)
    }
  }
  createWindow()
  setTimeout(() => void forgetMissingProjects(), 5000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  e.preventDefault()
  quitting = true
  void (async () => {
    try {
      await capturePluginStates()
      await projects.flush()
    } finally {
      projects.queue.dispose()
      engine.stop()
      app.quit()
    }
  })()
})

app.on('window-all-closed', () => app.quit())
