import { useEffect, useRef, useState } from 'react'
import type { EngineMeters } from '../../shared/types'
import { attempt, getState, player, setState, useStore, writePref } from '../state/store'
import { Tuner } from './Tuner'
import { Chain } from './EffectsPanel'
import { closeSidePane } from './Settings'
import { Button, Icon, Select, Slider, Toggle, formatDb } from './ui'
import { deviceSummary, inputChannelChoice, openAudioSettings, useSetDevice } from './AudioSetup'
import { deviceLabel } from '../platform'

// ---- Level meter: updated straight from engine meter events, no React renders ----

const meterListeners = new Set<(m: EngineMeters) => void>()
let meterSubscribed = false
function onMeters(fn: (m: EngineMeters) => void) {
  if (!meterSubscribed) {
    meterSubscribed = true
    window.nota.engine.onMeters((m) => meterListeners.forEach((l) => l(m)))
  }
  meterListeners.add(fn)
  return () => void meterListeners.delete(fn)
}

const dbToPct = (g: number) => {
  if (g <= 0) return 0
  const db = 20 * Math.log10(g)
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
}

/**
 * Vertical gray level meter with peak hold and a clip lamp on
 * top. Input and output come from the audio engine; song playback is measured
 * in the window's own audio graph, sampled every frame while playing.
 */
export function Meter({ which, horizontal = false }: { which: 'input' | 'monitor' | 'song'; horizontal?: boolean }) {
  const barRef = useRef<HTMLDivElement>(null)
  const holdRef = useRef<HTMLDivElement>(null)
  const [clipped, setClipped] = useState(false)
  const clipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let level = 0
    // Peak hold marker, in % of the meter: it rests on the highest peak, then
    // falls with gravity until it lands on the level again.
    let hold = 0
    let holdAge = 0
    let fall = 0
    // Engine meter events arrive about every 33 ms; the song meter runs per frame (~16 ms).
    const perFrame = which === 'song'
    const decay = perFrame ? 0.9 : 0.82
    const holdTicks = perFrame ? 60 : 30 // ~1 s resting on the peak
    const gravity = perFrame ? 0.11 : 0.45 // a full-height drop takes ~0.7 s
    const feed = (peak: number, clip: boolean) => {
      level = Math.max(peak, level * decay)
      const levelPct = dbToPct(level)
      const peakPct = dbToPct(peak)
      if (peakPct >= hold) {
        hold = peakPct
        holdAge = 0
        fall = 0
      } else if (holdAge < holdTicks) holdAge++
      else {
        fall += gravity
        hold = Math.max(levelPct, hold - fall)
      }
      if (barRef.current) barRef.current.style[horizontal ? 'width' : 'height'] = `${levelPct}%`
      if (holdRef.current) holdRef.current.style[horizontal ? 'left' : 'bottom'] = `${hold}%`
      if (clip) {
        setClipped(true)
        if (clipTimer.current) clearTimeout(clipTimer.current)
        clipTimer.current = setTimeout(() => setClipped(false), 2500)
      }
    }
    if (which === 'song') {
      let raf = 0
      const tick = () => {
        raf = requestAnimationFrame(tick)
        const peak = player.isPlaying ? player.getPlaybackPeak() : 0
        feed(peak, peak >= 0.999)
      }
      raf = requestAnimationFrame(tick)
      return () => cancelAnimationFrame(raf)
    }
    return onMeters((m) =>
      which === 'input' ? feed(m.inputPeakRaw, m.inputClipped) : feed(m.monitorPeak ?? 0, (m.monitorPeak ?? 0) >= 1)
    )
  }, [which])

  return (
    <div
      className={horizontal ? 'hmeter' : 'vmeter'}
      title={
        which === 'input'
          ? 'Input level at the converter. If the lamp lights, turn down the gain knob on your audio interface.'
          : which === 'song'
            ? 'Song playback level after the Song fader. If the lamp lights, the song is clipping: turn the fader down.'
            : 'Your bass as you hear it: after its effects and the Monitor level'
      }
    >
      {!horizontal && <span className={`clip-lamp${clipped ? ' is-on' : ''}`} aria-label={clipped ? 'Clipping' : undefined} />}
      <div className="vmeter-track">
        <div className="vmeter-bar" ref={barRef} />
        <div className="vmeter-hold" ref={holdRef} />
      </div>
      {horizontal && <span className={`clip-lamp${clipped ? ' is-on' : ''}`} aria-label={clipped ? 'Clipping' : undefined} />}
    </div>
  )
}

// ---- Monitoring toggle (shared by the Monitor button and the M key) ------------------

function looksLikeFeedbackRisk(input?: string, output?: string) {
  if (!input || !output) return false
  const i = input.toLowerCase()
  const o = output.toLowerCase()
  return (i.includes('microphone') || i.includes('built-in')) && (o.includes('speaker') || o.includes('built-in output'))
}

/** Turn monitoring on/off; asks first when a built-in mic would feed back through speakers. */
export function toggleMonitoring(confirmed = false) {
  const engine = getState().engine
  if (!engine || engine.status !== 'running') return
  const d = engine.device ?? {}
  if (!engine.monitoring && !confirmed && (d.feedbackRisk || looksLikeFeedbackRisk(d.inputDevice, d.outputDevice))) {
    // The question is asked in the Mixer: show it, even when Monitor was pressed in the deck or with M.
    openMixer()
    setState({ confirmMonitorRisk: true })
    return
  }
  setState({ confirmMonitorRisk: false })
  void attempt(() => window.nota.engine.setMonitoring(!engine.monitoring), 'Monitoring')
}

// ---- Levels (shared by the Mixer and the deck's quick levels) ----------------------------

/** Bottom of the song fader: silence. */
export const SONG_DB_MIN = -60

/** Song gain (linear) ↔ the dB the fader shows. */
export const gainToSongDb = (g: number) => (g > 0 ? Math.max(SONG_DB_MIN, 20 * Math.log10(g)) : SONG_DB_MIN)
export const songDbToGain = (db: number) => (db <= SONG_DB_MIN ? 0 : Math.pow(10, db / 20))

/** The project's levels, held locally while dragging so the faders stay smooth. */
export function useLevels() {
  const audio = useStore((s) => s.snapshot?.project?.audio ?? null)
  const [trim, setTrimState] = useState(audio?.inputTrimDb ?? 0)
  const [monitor, setMonitorState] = useState(audio?.monitorLevelDb ?? -6)
  const [volume, setVolumeState] = useState(audio?.playbackVolume ?? 0.9)
  useEffect(() => setTrimState(audio?.inputTrimDb ?? 0), [audio?.inputTrimDb])
  useEffect(() => setMonitorState(audio?.monitorLevelDb ?? -6), [audio?.monitorLevelDb])
  useEffect(() => setVolumeState(audio?.playbackVolume ?? 0.9), [audio?.playbackVolume])
  return {
    trim,
    monitor,
    songDb: Math.round(gainToSongDb(volume) * 2) / 2,
    setTrim: (db: number) => (setTrimState(db), void window.nota.engine.setInputTrim(db)),
    setMonitor: (db: number) => (setMonitorState(db), void window.nota.engine.setMonitorLevel(db)),
    setSongDb: (db: number) => {
      const gain = songDbToGain(db)
      setVolumeState(gain)
      void window.nota.engine.setPlaybackVolume(gain)
    }
  }
}

/** The Monitor on/off button: the accent shows when you hear your bass. */
export function MonitorButton({ compact = false }: { compact?: boolean }) {
  const monitoring = useStore((s) => s.engine?.monitoring ?? false)
  const running = useStore((s) => s.engine?.status === 'running')
  return (
    <button
      type="button"
      className={`monitor-power${monitoring ? ' is-on' : ''}${compact ? ' is-compact' : ''}`}
      aria-pressed={monitoring}
      disabled={!running}
      title={monitoring ? 'Monitoring on: you hear your bass (M)' : 'Turn monitoring on: hear your bass through its effects (M)'}
      onClick={() => toggleMonitoring()}
    >
      <Icon name="power" size={12} />
      <span className="monitor-word">Monitor</span>
    </button>
  )
}

/** A labelled level: horizontal fader with its meter underneath. */
function LevelRow({ label, title, idle, children, meter }: { label: string; title?: string; idle?: boolean; children: React.ReactNode; meter: React.ReactNode }) {
  return (
    <div className={`mix-level${idle ? ' is-idle' : ''}`} title={title}>
      <span className="mix-level-label">{label}</span>
      <div className="mix-level-body">
        {children}
        {meter}
      </div>
    </div>
  )
}

/** A small italic caption above a control. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mix-field">
      <span className="mix-field-label">{label}</span>
      {children}
    </label>
  )
}

function Strip({ title, sub, children, className = '' }: { title: string; sub: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`mix-strip ${className}`}>
      <header className="mix-strip-head">
        <h4>{title}</h4>
        <span>{sub}</span>
      </header>
      {children}
    </section>
  )
}

/** Opens the Mixer pane (from the status bar, the tuner key, …). */
export function openMixer() {
  writePref('effectsOpen', true)
  setState({ sidePane: null, effectsOpen: true })
}

// ---- Mixer pane ---------------------------------------------------------------------------
//
// What you touch while playing, top to bottom like a channel strip:
//   Bass (your live input): input channel, trim, tuner, effects, monitor level
//   Song (playback): volume
//   Output: output effects
// The interface itself (driver, devices, sample rate, buffer) is set up in
// Settings → Audio; the line at the top shows it and leads there.

export function MixerPanel() {
  const engine = useStore((s) => s.engine)
  const project = useStore((s) => s.snapshot?.project ?? null)
  const confirmRisk = useStore((s) => s.confirmMonitorRisk)
  const levels = useLevels()
  const { setDevice, error: lastErr, clearError } = useSetDevice()
  const [dismissed, setDismissed] = useState<string | null>(null)
  const running = engine?.status === 'running'

  const head = (
    <div className="side-head">
      <h3>
        <Icon name="sliders" size={14} /> Mixer
      </h3>
      <Button size="sm" variant="ghost" icon="x" title="Hide panel" onClick={closeSidePane} />
    </div>
  )

  const songStrip = (
    <Strip title="Song" sub="Playback" className="is-song">
      <LevelRow label="Volume" title="Song playback level in dB (0 dB = as recorded). It doesn't affect your bass." meter={<Meter which="song" horizontal />}>
        <Slider value={levels.songDb} min={SONG_DB_MIN} max={6} step={0.5} defaultValue={0} format={formatDb} onChange={levels.setSongDb} />
      </LevelRow>
    </Strip>
  )

  if (!running) {
    const notBuilt = engine?.status === 'not-built'
    return (
      <aside className="side mixer">
        {head}
        <div className="side-empty">
          <p>{engine?.status === 'starting' ? 'Starting audio engine…' : (engine?.message ?? 'The audio engine is not running.')}</p>
          {notBuilt ? (
            <code className="io-code">npm run engine:build</code>
          ) : (
            engine?.status !== 'starting' && (
              <Button size="sm" icon="refresh" onClick={() => void attempt(() => window.nota.engine.restart())}>
                Restart engine
              </Button>
            )
          )}
        </div>
      </aside>
    )
  }

  const d = engine.device ?? {}
  const monitoring = engine.monitoring
  const effects = project?.effects ?? []
  const bassFx = effects.filter((e) => (e.chain ?? 'input') === 'input')
  const outputFx = effects.filter((e) => e.chain === 'output')
  const includeBass = project?.outputIncludesBass ?? true
  const sr = d.sampleRate ?? 48000
  const latency = d.pluginLatencySamples ?? 0

  // One input for a mono bass, or a pair (1+2, 3+4, …) for a stereo rig.
  const channels = inputChannelChoice(d)
  // Bluetooth: opening the headset's microphone drops it to phone-call quality,
  // and the song plays through the same headset.
  const bluetoothNote = d.inputBluetooth
    ? {
        short: 'Bluetooth mic: call quality while open',
        long: `While Monitor or the tuner is on, using the ${deviceLabel(d.inputDevice ?? '')} microphone switches it to headset mode: low-quality sound and more dropouts, for the song too. Pick another microphone (your interface, or the computer's) to keep full quality.`
      }
    : d.outputBluetooth
      ? {
          short: 'Bluetooth output: too late to monitor',
          long: 'Bluetooth headphones add around 150 ms or more. Fine for playing along with songs, but too late to hear your own bass live. Use wired headphones or your interface for Monitor.'
        }
      : null
  const rawError = d.error || lastErr
  const error = rawError && rawError !== dismissed ? rawError : null

  const summary = deviceSummary(d)

  return (
    <aside className="side mixer">
      {head}

      {(confirmRisk || error) && (
        <div className="mix-alert" role="alert">
          <Icon name="alert" size={14} />
          {confirmRisk ? (
            <div>
              <span>Monitoring a built-in microphone through speakers will feed back. Use headphones.</span>
              <div className="mix-alert-actions">
                <Button size="sm" variant="danger" onClick={() => toggleMonitoring(true)}>
                  Turn on anyway
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setState({ confirmMonitorRisk: false })}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <span>{error}</span>
              <Button size="sm" variant="ghost" icon="x" title="Dismiss" onClick={() => (clearError(), setDismissed(rawError))} />
            </>
          )}
        </div>
      )}

      <button type="button" className="mix-device" title="Interface, driver, sample rate and buffer: Settings → Audio" onClick={openAudioSettings}>
        <Icon name="speaker" size={14} />
        <span className="mix-device-text">
          <span className="mix-device-name">{summary.name}</span>
          {summary.detail && <span className="mix-device-detail">{summary.detail}</span>}
        </span>
        <span className="mix-device-link">
          Setup
          <Icon name="chevRight" size={12} />
        </span>
      </button>

      <div className="mixer-body">
        <Strip title="Bass" sub="Your live input" className="is-bass">
          {channels.options.length > 1 && (
            <div className="mix-fields">
              <Field label="Input">
                <Select
                  title="Which input on your interface the bass is plugged into: one for a mono bass, a pair for a stereo rig"
                  value={channels.value}
                  placeholder="Choose an input"
                  options={channels.options}
                  onChange={(v) => void setDevice({ inputChannels: channels.toChannels(v) })}
                />
              </Field>
            </div>
          )}
          {bluetoothNote && (
            <span className="mix-note" title={bluetoothNote.long}>
              <Icon name="alert" size={11} />
              {bluetoothNote.short}
            </span>
          )}
          <LevelRow
            label="Trim"
            idle={!d.inputOpen}
            title={
              d.inputOpen
                ? 'Input level, and a digital trim inside Nøta. Set the real input gain with the knob on your interface. If the lamp lights, turn that knob down.'
                : 'A microphone opens when you turn on Monitor or the tuner, so the meter is quiet until then.'
            }
            meter={<Meter which="input" horizontal />}
          >
            <Slider value={levels.trim} min={-24} max={24} step={0.5} defaultValue={0} format={formatDb} onChange={levels.setTrim} />
          </LevelRow>

          <Tuner />

          <div className="mix-sub">Effects</div>
          <div className="chain">
            <Chain chain="input" effects={bassFx} />
          </div>

          <div className={`mix-monitor${monitoring ? ' is-on' : ''}`}>
            <MonitorButton />
            <LevelRow label="" title="How loud you hear your bass, after its effects" meter={<Meter which="monitor" horizontal />}>
              <Slider value={levels.monitor} min={-60} max={6} step={0.5} defaultValue={-6} format={formatDb} onChange={levels.setMonitor} />
            </LevelRow>
          </div>
        </Strip>

        {songStrip}

        <Strip title="Output" sub="What you hear" className="is-output">
          <div className="side-option">
            <Toggle
              checked={includeBass}
              label="Bass through the output effects"
              disabled={!project}
              onChange={(v) => void attempt(() => window.nota.effects.setOutputIncludesBass(v))}
            />
            <span>{includeBass ? 'Song and bass go through these' : 'Only the song goes through these'}</span>
          </div>
          <div className="chain">
            <Chain chain="output" effects={outputFx} />
          </div>
        </Strip>
      </div>

      <div className="side-foot">
        <span title="Extra delay the plugins add to your bass">Plugin latency on your bass: {latency ? `${((latency / sr) * 1000).toFixed(1)} ms` : 'none'}</span>
      </div>
    </aside>
  )
}
