import { useEffect, useState } from 'react'
import { effectiveMode } from '../shared/project'
import { SKIP_SECONDS, type PlaybackMode } from '../shared/types'
import { importPaths, importViaDialog, reportImport } from './actions'
import { togglePlayback, usePlaybackSync } from './audio/sync'
import { cutSelection, Deck, markLoop, setLoop } from './components/Deck'
import { setSpeed, shiftKey, toggleMetronome } from './components/PracticeControls'
import { toggleTuner, useTunerSync } from './components/Tuner'
import { MixerPanel, toggleMonitoring } from './components/Mixer'
import { Playlist } from './components/Playlist'
import { Rail, StatusBar } from './components/TopBar'
import { Icon } from './components/ui'
import { Welcome } from './components/Welcome'
import { SettingsPanel, toggleSettings } from './components/Settings'
import { ShortcutsPanel } from './components/Shortcuts'
import { ExportDialog } from './components/ExportDialog'
import { ProjectsPanel } from './components/Projects'
import { usePracticeTracker } from './practiceTracker'
import { useTitleBarColors } from './theme'
import { attempt, getState, player, toast, useStore } from './state/store'

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return
      const s = getState()
      if (s.exportSongId) return // the Export window has the keyboard
      const project = s.snapshot?.project
      const song = project?.songs.find((x) => x.id === project.selectedSongId)
      const update = window.nota.songs.update
      const modes: Record<string, PlaybackMode> = { '1': 'original', '2': 'bass', '3': 'playalong' }

      let handled = true
      switch (e.key) {
        case ' ':
          if (t.closest('button')) (t as HTMLButtonElement).blur()
          togglePlayback()
          break
        case 'ArrowLeft':
          player.skip(e.shiftKey ? -1 : -SKIP_SECONDS)
          break
        case 'ArrowRight':
          player.skip(e.shiftKey ? 1 : SKIP_SECONDS)
          break
        case 'ArrowUp':
        case 'ArrowDown': {
          if (e.shiftKey) {
            if (song) shiftKey(song, e.key === 'ArrowUp' ? 1 : -1)
            break
          }
          if (!project?.songs.length) break
          const i = project.songs.findIndex((x) => x.id === project.selectedSongId)
          const next = project.songs[Math.max(0, Math.min(project.songs.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1)))]
          if (next && next.id !== project.selectedSongId) void attempt(() => window.nota.songs.select(next.id))
          break
        }
        case '1':
        case '2':
        case '3':
          if (song) void attempt(() => update(song.id, { mode: modes[e.key] }))
          break
        case 'l':
        case 'L':
          if (song?.loop) setLoop(song, { ...song.loop, enabled: !song.loop.enabled })
          else if (song) toast('Drag across the waveform, or press I and O, to make a loop')
          break
        case 'Backspace':
        case 'Delete':
          if (song) cutSelection(song)
          break
        case 'i':
        case 'I':
        case '[':
          if (song) markLoop(song, 'start')
          break
        case 'o':
        case 'O':
        case ']':
          if (song) markLoop(song, 'end')
          break
        case '-':
          if (song) setSpeed(song, song.speed - 0.01)
          break
        case '_':
          if (song) setSpeed(song, song.speed - 0.05)
          break
        case '=':
          if (song) setSpeed(song, song.speed + 0.01)
          break
        case '+':
          if (song) setSpeed(song, song.speed + 0.05)
          break
        case 't':
        case 'T':
          if (s.engine?.status === 'running') toggleTuner()
          break
        case 'k':
        case 'K':
          toggleMetronome()
          break
        case '0':
          if (song) setSpeed(song, 1)
          break
        case 'm':
        case 'M':
          toggleMonitoring()
          break
        default:
          handled = false
      }
      if (handled) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    const offMenu = window.nota.onMenuImport(() => void importViaDialog())
    const offDock = window.nota.onImportResult(reportImport)
    const offSettings = window.nota.onMenuSettings(toggleSettings)
    const offUndo = window.nota.onMenuUndo((direction) => {
      // In a text field, undo the typing; everywhere else, the last project edit.
      // (A switch, checkbox or slider that was just clicked keeps focus but has no typing to undo.)
      const el = document.activeElement as HTMLElement | null
      const typing = el instanceof HTMLInputElement ? !['checkbox', 'radio', 'range', 'button', 'submit', 'color', 'file'].includes(el.type) : false
      if (el && (typing || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
        document.execCommand(direction)
        return
      }
      void attempt(async () => {
        const label = await (direction === 'undo' ? window.nota.project.undo() : window.nota.project.redo())
        toast(label ? `${direction === 'undo' ? 'Undo' : 'Redo'}: ${label}` : `Nothing to ${direction}`, 'info', 1600)
      })
    })
    return () => {
      window.removeEventListener('keydown', onKey)
      offMenu()
      offDock()
      offUndo()
      offSettings()
    }
  }, [])
}

/** Accept audio files dropped anywhere on the window. */
function useFileDrop() {
  const [over, setOver] = useState(false)
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setOver(true)
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setOver(false)
    }
    const overFn = (e: DragEvent) => hasFiles(e) && e.preventDefault()
    const drop = async (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setOver(false)
      await importPaths([...(e.dataTransfer?.files ?? [])].map((f) => window.nota.pathForFile(f)).filter(Boolean))
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', overFn)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', overFn)
      window.removeEventListener('drop', drop)
    }
  }, [])
  return over
}

function Toasts() {
  const toasts = useStore((s) => s.toasts)
  // Exports being written, with how far along they are.
  const [exports, setExports] = useState<Record<string, { title: string; progress: number }>>({})
  useEffect(
    () =>
      window.nota.songs.onExportProgress(({ exportId, title, progress }) =>
        setExports(({ [exportId]: _, ...rest }) => (progress === null ? rest : { ...rest, [exportId]: { title, progress } }))
      ),
    []
  )
  return (
    <div className="toasts" aria-live="polite">
      {Object.entries(exports).map(([id, e]) => (
        <div key={`export-${id}`} className="toast toast-progress" role="status">
          <Icon name="download" size={14} />
          <span className="toast-progress-text">
            <span>Exporting {e.title}…</span>
            <span className="toast-progress-bar">
              <span style={{ width: `${Math.round(e.progress * 100)}%` }} />
            </span>
          </span>
          <span className="toast-progress-pct">{Math.round(e.progress * 100)}%</span>
          <button
            type="button"
            className="toast-cancel"
            title="Cancel export"
            aria-label={`Cancel exporting ${e.title}`}
            onClick={() => void window.nota.songs.cancelExport(id).catch(() => {})}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.kind === 'error' && <Icon name="alert" size={14} />}
          {t.kind === 'success' && <Icon name="check" size={14} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}

export function App() {
  const ready = useStore((s) => s.snapshot !== null)
  const hasProject = useStore((s) => !!s.snapshot?.project)
  const effectsOpen = useStore((s) => s.effectsOpen)
  const sidePane = useStore((s) => s.sidePane)
  const selectedMode = useStore((s) => {
    const p = s.snapshot?.project
    const song = p?.songs.find((x) => x.id === p.selectedSongId)
    return song ? effectiveMode(song) : null
  })
  usePlaybackSync()
  useTitleBarColors(useStore((s) => s.prefs.accent))
  useTunerSync()
  useShortcuts()
  usePracticeTracker()
  const dropping = useFileDrop()

  if (!ready) return <div className="boot" />

  return (
    <div className={`app${effectsOpen || sidePane ? ' with-side' : ''}`} data-mode={selectedMode ?? 'none'}>
      <div className="workspace">
        {hasProject ? (
          <>
            <main className="main">
              <Playlist />
            </main>
            <Deck />
          </>
        ) : (
          <main className="main main-welcome">
            <Welcome />
          </main>
        )}
      </div>
      <Rail onSettings={toggleSettings} />
      {sidePane === 'projects' ? <ProjectsPanel /> : sidePane === 'settings' ? <SettingsPanel /> : sidePane === 'keys' ? <ShortcutsPanel /> : effectsOpen && <MixerPanel />}
      <StatusBar />
      <ExportDialog />
      <Toasts />
      {dropping && (
        <div className="drop-overlay">
          <div>
            <Icon name="import" size={28} />
            <span>Drop to add to the playlist</span>
          </div>
        </div>
      )}
    </div>
  )
}
