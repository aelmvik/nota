import { useEffect, useState, type ReactNode } from 'react'
import { ACCENTS, type Accent, type Preferences, type StorageInfo } from '../../shared/types'
import { attempt, getState, setState, toast, useStore, writePref } from '../state/store'
import { Button, Icon, Slider, Toggle, type IconName } from './ui'
import { flipKey, isMac, revealLabel } from '../platform'
import { AudioSection } from './AudioSetup'
import { useUpdate } from '../updates'

// App-wide preferences, shown in the right-hand pane in place of the effects
// chain. Per-song settings (speed, key, loops) live on the song; levels live in
// the Mixer. Audio (the interface) comes first: the Mixer and the status bar lead here.

// The right-hand pane shows one of Mixer, Projects, Settings or Shortcuts. The
// top-bar buttons switch between them; clicking the one that's showing, its ×,
// or Esc collapses the pane entirely.

type Pane = 'effects' | NonNullable<ReturnType<typeof getState>['sidePane']>

export function closeSidePane() {
  writePref('effectsOpen', false)
  setState({ sidePane: null, effectsOpen: false })
}

/** Show `pane`, or collapse the pane if it's the one already showing. */
export function toggleSidePane(pane: Pane) {
  const s = getState()
  const showing: Pane | null = s.sidePane ?? (s.effectsOpen ? 'effects' : null)
  if (showing === pane) return closeSidePane()
  if (pane === 'effects') {
    writePref('effectsOpen', true)
    setState({ sidePane: null, effectsOpen: true })
  } else setState({ sidePane: pane })
}

export const toggleSettings = () => toggleSidePane('settings')

/** Esc closes the Settings / Shortcuts pane (unless you're typing in a field). */
export function useEscToClose() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement).closest('input, textarea, [contenteditable]')) closeSidePane()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

const setPref = (patch: Partial<Preferences>) => void attempt(() => window.nota.prefs.set(patch), 'Settings')

/** A setting: label and help, with the control beside it (`inline`) or underneath. */
function Row({ label, help, inline, children }: { label: string; help?: ReactNode; inline?: boolean; children: ReactNode }) {
  return (
    <div className={`set-row${inline ? ' is-inline' : ''}`}>
      <div className="set-text">
        <div className="set-label">{label}</div>
        {help && <div className="set-help">{help}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

function Choice<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'is-active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

const mb = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`)

function AppearanceSection({ p }: { p: Preferences }) {
  return (
    <>
      <Row label="Colour">
        <div className="swatches" role="radiogroup" aria-label="Colour">
          {(Object.keys(ACCENTS) as Accent[]).map((a) => (
            <button key={a} type="button" role="radio" aria-checked={p.accent === a} className="swatch" onClick={() => setPref({ accent: a })}>
              <i style={{ background: ACCENTS[a].hex }} />
              {ACCENTS[a].label}
            </button>
          ))}
        </div>
      </Row>
      <Row label="Theme" help="System follows your computer's light or dark setting.">
        <Choice
          value={p.theme}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' }
          ]}
          onChange={(theme) => setPref({ theme })}
        />
      </Row>
    </>
  )
}

function PlaybackSection({ p }: { p: Preferences }) {
  return (
    <>
      <Row label="When playback stops" help="Space and the play button. “Back to start” is how FL Studio works: stop, and press Space again to replay the same spot.">
        <Choice
          value={p.stopBehavior}
          options={[
            { value: 'return', label: 'Back to start' },
            { value: 'pause', label: 'Where it stopped' }
          ]}
          onChange={(stopBehavior) => setPref({ stopBehavior })}
        />
      </Row>
    </>
  )
}

function WaveformSection({ p }: { p: Preferences }) {
  return (
    <>
      <Row inline label="Snap to the beat grid" help={p.snapToGrid ? `The playhead and loop edges land on beats. Hold ${flipKey} for a free position.` : `The playhead and loop edges go exactly where you click. Hold ${flipKey} to snap.`}>
        <Toggle checked={p.snapToGrid} label="Snap to the beat grid" onChange={(snapToGrid) => setPref({ snapToGrid })} />
      </Row>
      <Row inline label="Show the beat grid" help={p.showGrid ? 'Beat and bar lines in the waveform and the Notes view.' : 'No beat or bar lines; the click and snapping still use the beats.'}>
        <Toggle checked={p.showGrid} label="Show the beat grid" onChange={(showGrid) => setPref({ showGrid })} />
      </Row>
      <Row label="Colours" help="By frequency: warm where bass and kicks dominate, cool where it's bright. Single colour is calmer.">
        <Choice
          value={p.waveformColors}
          options={[
            { value: 'frequency', label: 'By frequency' },
            { value: 'mono', label: 'Single colour' }
          ]}
          onChange={(waveformColors) => setPref({ waveformColors })}
        />
      </Row>
    </>
  )
}

function TuningSection({ p }: { p: Preferences }) {
  const [a4, setA4] = useState(p.tunerA4)
  useEffect(() => setA4(p.tunerA4), [p.tunerA4])
  return (
    <Row label="Tuner reference" help="The pitch of A that the tuner treats as in tune. Most music uses 440 Hz. “Tune to the song” in the tuner shifts from here.">
      <Slider
        className="set-slider"
        value={a4}
        min={430}
        max={450}
        step={0.1}
        defaultValue={440}
        format={(v) => `${v.toFixed(1)} Hz`}
        onChange={setA4}
        onCommit={(tunerA4) => setPref({ tunerA4 })}
      />
    </Row>
  )
}

function SeparationSection({ p, info, reload }: { p: Preferences; info: StorageInfo | null; reload: () => void }) {
  const setup = useStore((s) => s.setup)
  const reinstall = async () => {
    const next = await attempt(() => window.nota.separation.install(), 'Installing')
    if (next) {
      setState({ separation: next })
      reload()
    }
  }
  return (
    <>
      <Row
        label="Quality"
        help="High quality isolates the bass a little more cleanly but takes about four times as long. It applies to songs separated from now on; use “Separate again” on a song to redo it."
      >
        <Choice
          value={p.separationQuality}
          options={[
            { value: 'standard', label: 'Standard' },
            { value: 'high', label: 'High (slower)' }
          ]}
          onChange={(separationQuality) => setPref({ separationQuality })}
        />
      </Row>
      <Row
        inline
        label="Audio environment"
        help={
          info?.pythonEnv.installed
            ? `Installed${info.pythonEnv.device ? `, running on ${info.pythonEnv.device === 'mps' ? 'the Apple GPU' : info.pythonEnv.device}` : ''}. Separation, tempo, key and tuning detection run here.`
            : (info?.pythonEnv.reason ?? 'Checking…')
        }
      >
        <Button size="sm" disabled={setup.running} onClick={() => void reinstall()}>
          {setup.running ? 'Installing…' : info?.pythonEnv.installed ? 'Reinstall' : 'Install'}
        </Button>
      </Row>
      {setup.line && setup.running && <code className="setup-log">{setup.line}</code>}
    </>
  )
}

function StorageSection({ p, info, reload }: { p: Preferences; info: StorageInfo | null; reload: () => void }) {
  const [busy, setBusy] = useState<'clean' | 'collect' | null>(null)
  const clean = async () => {
    setBusy('clean')
    const r = await attempt(() => window.nota.storage.cleanUnused(), 'Clearing files')
    setBusy(null)
    if (r) toast(r.freedBytes > 0 ? `Cleared ${mb(r.freedBytes)}` : 'Nothing to clear', 'success')
    reload()
  }
  const collect = async () => {
    setBusy('collect')
    const n = await attempt(() => window.nota.project.collectSongs(), 'Copying songs')
    setBusy(null)
    if (n) toast(`Copied ${n} song${n === 1 ? '' : 's'} into the project`, 'success')
    reload()
  }
  const proj = info?.project
  return (
    <>
      <Row
        label="When Nøta opens"
        help={p.openAtLaunch === 'last' ? 'The project you had open last time opens again.' : 'Nøta starts on the start screen, with your recent projects.'}
      >
        <Choice
          value={p.openAtLaunch}
          options={[
            { value: 'last', label: 'Last project' },
            { value: 'start', label: 'Start screen' }
          ]}
          onChange={(openAtLaunch) => setPref({ openAtLaunch })}
        />
      </Row>
      <Row
        label="When adding songs"
        help={
          p.songStorage === 'copy'
            ? 'Songs are copied into the project, so it travels in one piece and nothing goes missing.'
            : p.songStorage === 'reference'
              ? 'Songs stay where they are; the project points to them. Saves space, but moving the files breaks the link.'
              : 'Nøta asks each time whether to copy the songs into the project or leave them where they are.'
        }
      >
        <Choice
          value={p.songStorage}
          options={[
            { value: 'ask', label: 'Ask' },
            { value: 'copy', label: 'Copy' },
            { value: 'reference', label: 'Leave' }
          ]}
          onChange={(songStorage) => setPref({ songStorage })}
        />
      </Row>
      {proj && (
        <Row
          label="This project"
          help={
            <>
              {mb(proj.songsBytes)} of songs · {mb(proj.generatedBytes)} of separated tracks, key changes and waveforms.
              {proj.outsideSongs > 0 && ` ${proj.outsideSongs} song${proj.outsideSongs === 1 ? ' lives' : 's live'} outside the project.`}
            </>
          }
        >
          <div className="set-buttons">
            {proj.outsideSongs > 0 && (
              <Button size="sm" disabled={!!busy} onClick={() => void collect()}>
                {busy === 'collect' ? 'Copying…' : 'Copy songs in'}
              </Button>
            )}
            <Button size="sm" disabled={!!busy} onClick={() => void clean()}>
              {busy === 'clean' ? 'Clearing…' : 'Clear unused files'}
            </Button>
            <Button size="sm" variant="ghost" icon="folder" title={`${revealLabel}: the project folder`} onClick={() => void window.nota.storage.reveal('project')} />
          </div>
        </Row>
      )}
      <Row label="New projects go in" help={<span className="set-path">{info?.projectsDir ?? '…'}</span>}>
        <div className="set-buttons">
          <Button size="sm" onClick={() => void attempt(() => window.nota.prefs.chooseProjectsDir()).then(reload)}>
            Change…
          </Button>
          <Button size="sm" variant="ghost" icon="folder" title={revealLabel} onClick={() => void window.nota.storage.reveal('projects')} />
        </div>
      </Row>
    </>
  )
}

function PluginsSection() {
  const catalog = useStore((s) => s.catalog)
  const scan = useStore((s) => s.scan)
  const rescan = async () => {
    const c = await attempt(() => window.nota.effects.scan(), 'Plugin scan')
    if (c) {
      setState({ catalog: c })
      toast(`Found ${c.plugins.length} effects`, 'success')
    }
  }
  return (
    <>
      <Row label="VST3 folders" help={`Where Nøta looks for VST3 effects.${isMac ? ' Audio Units are found automatically.' : ''}`}>
        <Button size="sm" icon="plus" onClick={() => void attempt(() => window.nota.effects.addDirectory()).then((c) => c && setState({ catalog: c }))}>
          Add folder…
        </Button>
      </Row>
      <div className="set-list">
        {(catalog?.directories ?? []).map((d) => (
          <div key={d} className="set-list-row">
            <span className="set-path" title={d}>
              {d}
            </span>
            <Button
              size="sm"
              variant="ghost"
              icon="x"
              title="Stop looking here"
              onClick={() => void attempt(() => window.nota.effects.removeDirectory(d)).then((c) => c && setState({ catalog: c }))}
            />
          </div>
        ))}
      </div>
      <Row
        inline
        label="Installed effects"
        help={
          scan.running
            ? `Scanning ${scan.done} / ${scan.total}…`
            : catalog?.scannedAt
              ? `${catalog.plugins.length} effects found${catalog.failed.length ? `, ${catalog.failed.length} could not be loaded` : ''}.`
              : 'Not scanned yet.'
        }
      >
        <Button size="sm" icon="refresh" disabled={scan.running} onClick={() => void rescan()}>
          Rescan
        </Button>
      </Row>
    </>
  )
}

/** This version, the daily check for a newer one, and checking now. */
function UpdatesSection({ p }: { p: Preferences }) {
  const update = useUpdate()
  const [version, setVersion] = useState('')
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  useEffect(() => void window.nota.app.version().then(setVersion), [])
  const check = async () => {
    setChecking(true)
    setResult(null)
    const r = await window.nota.app.checkUpdates()
    setChecking(false)
    setResult(r.status === 'current' ? 'You have the latest version.' : r.status === 'failed' ? `Couldn’t check: ${r.error}` : null)
  }
  return (
    <>
      <Row inline label="Check for updates" help="Once a day Nøta asks GitHub whether a newer version is out, and says so in the status bar. Nothing about you or your projects is sent.">
        <Toggle checked={p.checkForUpdates} label="Check for updates" onChange={(checkForUpdates) => setPref({ checkForUpdates })} />
      </Row>
      <Row label={`Nøta ${version}`} help={update ? `Nøta ${update.version} is out.` : (result ?? undefined)}>
        <div className="set-buttons">
          {update ? (
            <Button size="sm" icon="download" onClick={() => void window.nota.app.openUpdate()}>
              Download {update.version}…
            </Button>
          ) : (
            <Button size="sm" icon="refresh" disabled={checking} onClick={() => void check()}>
              {checking ? 'Checking…' : 'Check now'}
            </Button>
          )}
        </div>
      </Row>
    </>
  )
}

function Group({ title, icon, children }: { title: string; icon: IconName; children: ReactNode }) {
  return (
    <section className="set-group">
      <h4>
        <Icon name={icon} size={13} /> {title}
      </h4>
      {children}
    </section>
  )
}

export function SettingsPanel() {
  const p = useStore((s) => s.prefs)
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const reload = () => void window.nota.storage.info().then(setInfo, () => {})

  useEffect(reload, [])
  useEscToClose()

  return (
    <aside className="side side-settings" aria-label="Settings">
      <div className="side-head">
        <h3>
          <Icon name="gear" size={14} /> Settings
        </h3>
        <Button size="sm" variant="ghost" icon="x" title="Close settings (Esc)" onClick={closeSidePane} />
      </div>
      <div className="set-scroll">
        <Group title="Audio" icon="speaker">
          <AudioSection />
        </Group>
        <Group title="Appearance" icon="contrast">
          <AppearanceSection p={p} />
        </Group>
        <Group title="Playback" icon="play">
          <PlaybackSection p={p} />
        </Group>
        <Group title="Waveform" icon="loop">
          <WaveformSection p={p} />
        </Group>
        <Group title="Tuning" icon="tune">
          <TuningSection p={p} />
        </Group>
        <Group title="Separation" icon="bass">
          <SeparationSection p={p} info={info} reload={reload} />
        </Group>
        <Group title="Storage" icon="folder">
          <StorageSection p={p} info={info} reload={reload} />
        </Group>
        <Group title="Plugins" icon="sliders">
          <PluginsSection />
        </Group>
        <Group title="Updates" icon="download">
          <UpdatesSection p={p} />
        </Group>
      </div>
    </aside>
  )
}
