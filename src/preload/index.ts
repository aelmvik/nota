import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { NotaApi } from '../shared/api'
import { pipewireJackDir } from '../main/platform'
import type { ImportResult } from '../shared/types'
import type { UpdateInfo, UpdateProgress } from '../shared/updates'

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: NotaApi = {
  project: {
    get: () => invoke('project:get'),
    create: (name) => invoke('project:create', name),
    openDialog: () => invoke('project:openDialog'),
    open: (path) => invoke('project:open', path),
    rename: (name) => invoke('project:rename', name),
    undo: () => invoke('project:undo'),
    redo: () => invoke('project:redo'),
    exportSetlist: () => invoke('project:exportSetlist'),
    delete: () => invoke('project:delete'),
    close: () => invoke('project:close'),
    revealInFinder: () => invoke('project:reveal'),
    collectSongs: () => invoke('project:collectSongs'),
    addPractice: (seconds, songId) => invoke('project:addPractice', seconds, songId),
    forgetRecent: (path) => invoke('project:forgetRecent', path),
    updateMetronome: (patch) => invoke('project:updateMetronome', patch),
    onChange: (cb) => subscribe('project:change', cb)
  },
  songs: {
    importDialog: () => invoke('songs:importDialog'),
    importPaths: (paths) => invoke('songs:importPaths', paths),
    export: (id, request) => invoke('songs:export', id, request),
    exportTarget: (folder, name, format) => invoke('songs:exportTarget', folder, name, format),
    exportFolder: (current) => invoke('songs:exportFolder', current),
    notes: (id) => invoke('songs:notes', id),
    onNotesState: (cb) => subscribe('songs:notesState', cb),
    onExportProgress: (cb) => subscribe('songs:exportProgress', cb),
    cancelExport: (exportId) => invoke('songs:cancelExport', exportId),
    take: (id) => invoke('songs:take', id),
    recordTake: (id) => invoke('songs:recordTake', id),
    stopTake: () => invoke('songs:stopTake'),
    clearTake: (id) => invoke('songs:clearTake', id),
    onTakeState: (cb) => subscribe('songs:takeState', cb),
    remove: (id) => invoke('songs:remove', id),
    move: (id, to) => invoke('songs:move', id, to),
    select: (id) => invoke('songs:select', id),
    update: (id, patch) => invoke('songs:update', id, patch),
    relink: (id) => invoke('songs:relink', id),
    retry: (id) => invoke('songs:retry', id),
    cancel: (id) => invoke('songs:cancel', id),
    reveal: (id) => invoke('songs:reveal', id),
    waveform: (id, kind) => invoke('songs:waveform', id, kind),
    beats: (id) => invoke('songs:beats', id),
    retryAnalysis: (id) => invoke('songs:retryAnalysis', id),
    onImportProgress: (cb) => subscribe<{ done: number; total: number }>('songs:importProgress', (p) => cb(p.done, p.total))
  },
  separation: {
    status: () => invoke('separation:status'),
    install: () => invoke('separation:install'),
    onSetupProgress: (cb) => subscribe('separation:setupProgress', cb),
    onStatus: (cb) => subscribe('separation:status', cb)
  },
  engine: {
    get: () => invoke('engine:get'),
    restart: () => invoke('engine:restart'),
    setDevice: (req) => invoke('engine:setDevice', req),
    showControlPanel: () => invoke('engine:showControlPanel'),
    useProAudio: () => invoke('engine:useProAudio'),
    setMonitoring: (enabled) => invoke('engine:setMonitoring', enabled),
    setInputTrim: (db) => invoke('engine:setInputTrim', db),
    setMonitorLevel: (db) => invoke('engine:setMonitorLevel', db),
    setPlaybackVolume: (v) => invoke('engine:setPlaybackVolume', v),
    onSnapshot: (cb) => subscribe('engine:snapshot', cb),
    onMeters: (cb) => subscribe('engine:meters', cb),
    setTuner: (enabled, mute) => invoke('engine:setTuner', enabled, mute),
    onTuner: (cb) => subscribe('engine:tuner', cb)
  },
  transport: {
    load: (req) => invoke('transport:load', req),
    setTracks: (tracks, seq) => invoke('transport:tracks', tracks, seq),
    send: (command) => ipcRenderer.send('transport:command', command),
    onState: (cb) => subscribe('transport:state', cb),
    onInterrupted: (cb) => subscribe('transport:interrupted', cb)
  },
  effects: {
    catalog: () => invoke('effects:catalog'),
    scan: () => invoke('effects:scan'),
    scanProgress: () => invoke('effects:scanProgress'),
    onScanProgress: (cb) => subscribe('effects:scanProgress', cb),
    addDirectory: () => invoke('effects:addDirectory'),
    removeDirectory: (dir) => invoke('effects:removeDirectory', dir),
    add: (plugin, chain) => invoke('effects:add', plugin, chain),
    setOutputIncludesBass: (include) => invoke('effects:setOutputIncludesBass', include),
    remove: (slotId) => invoke('effects:remove', slotId),
    move: (slotId, to) => invoke('effects:move', slotId, to),
    setBypass: (slotId, bypassed) => invoke('effects:setBypass', slotId, bypassed),
    toggleEditor: (slotId) => invoke('effects:toggleEditor', slotId),
    slotErrors: () => invoke('effects:slotErrors'),
    onSlotErrors: (cb) => subscribe('effects:slotErrors', cb)
  },
  prefs: {
    get: () => invoke('prefs:get'),
    set: (patch) => invoke('prefs:set', patch),
    chooseProjectsDir: () => invoke('prefs:chooseProjectsDir'),
    onChange: (cb) => subscribe('prefs:change', cb)
  },
  storage: {
    info: () => invoke('storage:info'),
    cleanUnused: () => invoke('storage:cleanUnused'),
    reveal: (which) => invoke('storage:reveal', which)
  },
  setTitleBarColors: (color, symbolColor) => invoke('window:titleBarColors', color, symbolColor),
  onWindowFramed: (cb) => subscribe('window:framed', cb),
  app: {
    version: () => invoke('app:version'),
    update: () => invoke('app:update'),
    checkUpdates: () => invoke('app:checkUpdates'),
    openUpdate: () => invoke('app:openUpdate'),
    installUpdate: () => invoke('app:installUpdate'),
    onUpdate: (cb) => subscribe<UpdateInfo | null>('app:update', cb),
    onUpdateProgress: (cb) => subscribe<UpdateProgress>('app:updateProgress', cb)
  },
  onMenuSettings: (cb) => subscribe('menu:settings', () => cb()),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onMenuImport: (cb) => subscribe('menu:import', () => cb()),
  onImportResult: (cb) => subscribe<ImportResult>('songs:importResult', cb),
  onMenuUndo: (cb) => {
    const offUndo = subscribe('menu:undo', () => cb('undo'))
    const offRedo = subscribe('menu:redo', () => cb('redo'))
    return () => {
      offUndo()
      offRedo()
    }
  },
  platform: process.platform,
  jackMissing: process.platform === 'linux' && !pipewireJackDir()
}

contextBridge.exposeInMainWorld('nota', api)
