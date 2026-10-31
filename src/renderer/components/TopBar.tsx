import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { importViaDialog } from '../actions'
import type { EngineDeviceState } from '../../shared/types'
import { EMPTY, attempt, setState, useStore } from '../state/store'
import { toggleProjects } from './Projects'
import { toggleSidePane } from './Settings'
import { openAudioSettings } from './AudioSetup'
import { toggleKeys } from './Shortcuts'
import { Button, Icon, InlineEdit, Popover, Wordmark, type IconName } from './ui'
import { shortcut } from '../platform'
import { useUpdate } from '../updates'

function SaveStatus() {
  const snap = useStore((s) => s.snapshot)
  if (!snap?.project) return null
  const label =
    snap.saveStatus === 'saving' ? 'Saving…' : snap.saveStatus === 'unsaved' ? 'Unsaved changes' : snap.saveStatus === 'error' ? 'Save failed' : 'All changes saved'
  return (
    <span
      className={`save-status is-${snap.saveStatus}`}
      title={snap.saveStatus === 'error' ? (snap.saveError ?? '') : `${snap.filePath ?? ''}\nProjects save automatically.`}
    >
      <span className="save-dot" />
      {label}
    </span>
  )
}

function ProjectName() {
  const name = useStore((s) => s.snapshot?.project?.name ?? '')
  return (
    <InlineEdit
      className="project-name"
      value={name}
      title="Click to rename the project"
      onCommit={(v) => v && v !== name && void attempt(() => window.nota.project.rename(v))}
    />
  )
}

function ProcessingSummary() {
  const songs = useStore((s) => s.snapshot?.project?.songs ?? EMPTY)
  const active = songs.find((s) => s.separation.status === 'processing')
  const waiting = songs.filter((s) => s.separation.status === 'queued').length
  if (!active && !waiting) return null
  return (
    <span className="processing-summary" title="Stem separation runs in the background; you can keep practicing.">
      <span className="spinner" />
      {active ? `Separating “${active.title}” ${Math.round(active.separation.progress * 100)}%` : 'Separation queued'}
      {waiting > 0 && <span className="muted"> · {waiting} waiting</span>}
    </span>
  )
}

function SeparationSetup() {
  const status = useStore((s) => s.separation)
  const setup = useStore((s) => s.setup)
  if (!status) return null
  const install = async () => {
    const next = await attempt(() => window.nota.separation.install(), 'Installing separation')
    if (next) setState({ separation: next })
  }
  return (
    <Popover
      align="center"
      trigger={(open, toggle) => (
        <button type="button" className={`processing-summary is-warn setup-chip${open ? ' is-open' : ''}`} onClick={toggle}>
          {setup.running ? <span className="spinner" /> : <Icon name="alert" size={13} />}
          {setup.running ? 'Installing stem separation…' : 'Stem separation not installed'}
        </button>
      )}
    >
      <div className="pop-section setup-pop">
        <h5>Stem separation</h5>
        <p className="pop-note">
          Nøta separates bass with Demucs and detects tempo, key and tuning with librosa. Both run locally on your computer and need a one-time
          download of about 1 GB (Python and PyTorch).
        </p>
        {(!status.ffmpeg || !status.canInstall) && <p className="pop-note is-error">Parts of Nøta are missing. Reinstall the app.</p>}
        {setup.line && <code className="setup-log">{setup.line}</code>}
        {setup.error && <p className="pop-note is-error">{setup.error}</p>}
        <Button variant="primary" disabled={setup.running || !status.canInstall} onClick={() => void install()}>
          {setup.running ? 'Installing…' : setup.error ? 'Try again' : 'Install'}
        </Button>
      </div>
    </Popover>
  )
}

/** Thin title bar (draggable) with the project name centred, like a plugin window title. */
/** Project name (double-click to rename) and save status, in the middle of the bar. */
function TitleCenter() {
  const hasProject = useStore((s) => !!s.snapshot?.project)
  return (
    <div className="titlebar-center">
      {hasProject ? (
        <>
          <ProjectName />
          <SaveStatus />
        </>
      ) : (
        <span className="titlebar-app">Nøta</span>
      )}
    </div>
  )
}

function RailButton({ icon, label, onClick, active, title }: { icon: IconName; label: string; onClick?: () => void; active?: boolean; title?: string }) {
  return (
    <button type="button" className={`rail-btn${active ? ' is-active' : ''}`} title={title ?? label} onClick={onClick}>
      <Icon name={icon} size={20} />
      <span>{label}</span>
    </button>
  )
}

/** Where the round trip's milliseconds go, for the latency readout's hover popup. */
function latencyBreakdown(d: EngineDeviceState) {
  const sr = d.sampleRate ?? 0
  const ms = (samples = 0) => (sr ? `${((1000 * samples) / sr).toFixed(1)} ms` : '—')
  return {
    rows: [
      ['Input (interface and driver)', ms(d.inputLatencySamples)],
      [`Buffer (${d.bufferSize} samples)`, ms(d.bufferSize ?? 0)],
      ['Output (interface and driver)', ms(d.outputLatencySamples)],
      ['Plug-ins', ms(d.pluginLatencySamples)]
    ],
    tips: [
      (d.bufferSize ?? 0) > 128 ? 'A smaller buffer lowers it, if your computer keeps up without crackles.' : null,
      (d.pluginLatencySamples ?? 0) > 0 ? 'Some plug-ins add delay (lookahead, HQ modes); bypass one to see its share.' : null
    ].filter((t): t is string => !!t)
  }
}

/**
 * Round-trip latency in the status bar. Hovering shows the breakdown at once
 * (the system tooltip waits about a second). The popup is rendered on <body>
 * because the status bar clips anything that sticks out of it.
 */
function LatencyReadout({ d }: { d: EngineDeviceState }) {
  const [at, setAt] = useState<{ right: number; bottom: number } | null>(null)
  const b = latencyBreakdown(d)
  // The input (and so the round trip) is only open while Monitor or the tuner is on.
  if (d.roundTripLatencyMs === undefined)
    return (
      <span title="Round-trip latency is measured when the input opens: turn on Monitor or the tuner.">
        Latency —
      </span>
    )
  const total = d.roundTripLatencyMs
  return (
    <>
      <span
        className={total > 20 ? 'is-warn' : ''}
        aria-label={`Round-trip latency ${total.toFixed(1)} milliseconds`}
        onMouseEnter={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setAt({ right: Math.max(8, window.innerWidth - r.right - 8), bottom: window.innerHeight - r.top + 6 })
        }}
        onMouseLeave={() => setAt(null)}
      >
        Latency {total.toFixed(1)} ms
      </span>
      {at &&
        createPortal(
          <div className="hover-tip" role="tooltip" style={{ right: at.right, bottom: at.bottom }}>
            <div className="hover-tip-head">
              Round-trip latency <b>{total.toFixed(1)} ms</b>
            </div>
            <div className="hover-tip-sub">From your bass going in to it coming out</div>
            {total > 20 && <div className="hover-tip-note">Yellow: over 20 ms, which most players notice.</div>}
            {b.rows.map(([label, value]) => (
              <div key={label} className="hover-tip-row">
                <span>{label}</span>
                <span>{value}</span>
              </div>
            ))}
            {b.tips.map((t) => (
              <div key={t} className="hover-tip-note">
                {t}
              </div>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}

/**
 * The window's title bar, in the brand colour: the macOS traffic lights sit
 * on its left (the window uses a hidden-inset title bar), then the wordmark
 * and main actions, the project in the middle, Settings and Shortcuts on the
 * right. Empty parts of the bar drag the window.
 */
export function Rail({ onSettings }: { onSettings: () => void }) {
  const effectsOpen = useStore((s) => s.effectsOpen)
  const sidePane = useStore((s) => s.sidePane)

  return (
    <nav className="rail" aria-label="Nøta">
      <Wordmark size={26} className="rail-mark" />
      <div className="rail-group">
        <RailButton icon="plus" label="Import" title={`Import songs (${shortcut('I')})`} onClick={() => void importViaDialog()} />
        <RailButton icon="folder" label="Projects" active={sidePane === 'projects'} title="Projects" onClick={toggleProjects} />
        <RailButton
          icon="sliders"
          label="Mixer"
          active={effectsOpen && !sidePane}
          title="Mixer: input, effects, tuner and output"
          onClick={() => toggleSidePane('effects')}
        />
      </div>
      <div className="spacer" />
      <TitleCenter />
      <div className="spacer" />
      <RailButton icon="gear" label="Settings" active={sidePane === 'settings'} title={`Settings (${shortcut(',')})`} onClick={onSettings} />
      <RailButton icon="keyboard" label="Shortcuts" active={sidePane === 'keys'} title="Keyboard and mouse shortcuts" onClick={toggleKeys} />
    </nav>
  )
}

/**
 * Input and output level as two small bars that fill up (−60 to 0 dBFS), with
 * a short peak hold. Drawn straight from engine meter events, no React renders.
 */
function IoBars() {
  const inBar = useRef<HTMLSpanElement>(null)
  const outBar = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let inHold = 0
    let outHold = 0
    const fill = (el: HTMLSpanElement | null, peak: number) => {
      if (!el) return
      const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity
      el.style.height = `${Math.max(0, Math.min(1, (db + 60) / 60)) * 100}%`
      el.classList.toggle('is-hot', db > -1)
    }
    return window.nota.engine.onMeters((m) => {
      inHold = Math.max(inHold * 0.9, m.inputPeakRaw)
      outHold = Math.max(outHold * 0.9, m.outputPeak)
      fill(inBar.current, inHold)
      fill(outBar.current, outHold)
    })
  }, [])
  return (
    <span className="statusbar-io" title="Levels: what comes in from your interface, and what goes out to your headphones or speakers">
      In
      <span className="io-bar">
        <span ref={inBar} />
      </span>
      <span className="io-label">Out</span>
      <span className="io-bar">
        <span ref={outBar} />
      </span>
    </span>
  )
}

/** Dark status bar: project state on the left, audio device and live i/o levels on the right. */
export function StatusBar() {
  const engine = useStore((s) => s.engine)
  const separation = useStore((s) => s.separation)
  const d = engine?.status === 'running' ? engine.device : null
  const update = useUpdate()

  return (
    <footer className="statusbar">
      <span className="statusbar-brand">Nøta</span>
      <span className="statusbar-sep" />
      <ProcessingSummary />
      {separation && !separation.available && <SeparationSetup />}
      {update && (
        <button type="button" className="statusbar-update" title="Open the download page" onClick={() => void window.nota.app.openUpdate()}>
          Nøta {update.version} is out
        </button>
      )}
      <div className="spacer" />
      {d ? (
        <>
          <button type="button" className="statusbar-audio" title="Audio interface and settings" onClick={openAudioSettings}>
            <span>{d.outputDevice}</span>
            <span className="statusbar-sep" />
            <span>
              {d.bufferSize} @ {d.sampleRate ? (d.sampleRate / 1000).toFixed(d.sampleRate % 1000 ? 1 : 0) : '—'} kHz
            </span>
          </button>
          <span className="statusbar-sep" />
          <LatencyReadout d={d} />
          <span className="statusbar-sep" />
          <IoBars />
        </>
      ) : (
        <span>{engine?.status === 'starting' ? 'Starting audio engine…' : (engine?.message ?? 'Audio engine not running')}</span>
      )}
    </footer>
  )
}
