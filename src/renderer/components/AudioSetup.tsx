import { useState, type ReactNode } from 'react'
import type { DeviceRequest } from '../../shared/api'
import type { EngineDeviceState } from '../../shared/types'
import { attempt, setState, useStore } from '../state/store'
import { Button, Icon, Select } from './ui'

// The audio interface and how it runs: driver, devices, sample rate and buffer.
// Set up once, so it lives in Settings (like the Audio preferences of Logic or
// Live); the Mixer keeps what you touch while playing.

/** Driver types offered, by the engine's names. Others (DirectSound, WASAPI's low-latency shared mode) are left out. */
const DRIVER_LABELS: Record<string, string> = {
  'Windows Audio': 'Windows Audio',
  'Windows Audio (Exclusive Mode)': 'Windows Audio, exclusive',
  ASIO: 'ASIO',
  ALSA: 'ALSA',
  JACK: 'JACK'
}

const DRIVER_HELP: Record<string, string> = {
  'Windows Audio': 'Works with any device, shared with other apps. Fine for playing along; too slow to hear your bass live.',
  'Windows Audio (Exclusive Mode)': 'Takes the device for Nøta alone: lower latency, other apps go quiet.',
  ASIO: 'Your interface’s own driver: the lowest latency. Use this to hear your bass live.'
}

export const formatRate = (r: number) => `${(r / 1000).toFixed(r % 1000 ? 1 : 0)} kHz`

/** Opens Settings, where Audio comes first. */
export function openAudioSettings() {
  setState({ sidePane: 'settings' })
}

/** Change the device setup, keeping the engine's error to show beside the controls. */
export function useSetDevice() {
  const [error, setError] = useState<string | null>(null)
  const setDevice = async (req: DeviceRequest) => {
    setError(null)
    const state = await attempt(() => window.nota.engine.setDevice(req), 'Audio device')
    if (state?.error) setError(state.error)
  }
  return { setDevice, error, clearError: () => setError(null) }
}

/** One line for the device: "M-Audio M-Track Eight · ASIO · 256 @ 44.1 kHz". */
export function deviceSummary(d: EngineDeviceState) {
  const name = d.outputDevice
  const driver = (d.availableDeviceTypes?.length ?? 0) > 1 && d.deviceType ? DRIVER_LABELS[d.deviceType] ?? d.deviceType : null
  const rate = d.bufferSize && d.sampleRate ? `${d.bufferSize} @ ${formatRate(d.sampleRate)}` : null
  return { name: name ?? 'No output', detail: [driver, rate].filter(Boolean).join(' · ') }
}

/** The inputs your bass can come in on: each channel (mono), and each pair 1+2, 3+4, … (stereo). */
export function inputChannelChoice(d: EngineDeviceState) {
  const names = d.inputChannelNames ?? []
  const name = (i: number) => names[i] || `Input ${i + 1}`
  const options = [
    ...names.map((_, i) => ({ value: String(i), label: name(i) })),
    ...names.flatMap((_, i) => (i % 2 === 0 && i + 1 < names.length ? [{ value: `${i},${i + 1}`, label: `${name(i)} + ${name(i + 1)} (stereo)` }] : []))
  ]
  const current = (d.inputChannels ?? [0]).join(',')
  return { options, value: options.some((o) => o.value === current) ? current : null, toChannels: (v: string) => v.split(',').map(Number) }
}

function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="set-row audio-field">
      <div className="set-label">{label}</div>
      <div className="set-control">{children}</div>
      {help && <div className="set-help">{help}</div>}
    </div>
  )
}

export function AudioSection() {
  const engine = useStore((s) => s.engine)
  const { setDevice, error } = useSetDevice()
  if (engine?.status !== 'running') {
    return (
      <div className="set-row">
        <div className="set-help">{engine?.status === 'starting' ? 'Starting the audio engine…' : (engine?.message ?? 'The audio engine isn’t running.')}</div>
      </div>
    )
  }
  const d = engine.device ?? {}
  const driverTypes = (d.availableDeviceTypes ?? []).filter((t) => t in DRIVER_LABELS || t === d.deviceType)
  // ASIO: one driver is both input and output.
  const oneDevice = d.separateInputs === false
  const sr = d.sampleRate ?? 0
  const bufferMs = (b: number) => (sr ? ` (${((1000 * b) / sr).toFixed(1)} ms)` : '')
  const devices = (names: string[] | undefined) => (names ?? []).map((n) => ({ value: n, label: n }))
  const channels = inputChannelChoice(d)
  const channelField = channels.options.length > 1 && (
    <Field label="Input channel" help="The input your bass is plugged into: one for a mono bass, a pair for a stereo rig. Also in the Mixer.">
      <Select value={channels.value} placeholder="Choose an input" options={channels.options} onChange={(v) => void setDevice({ inputChannels: channels.toChannels(v) })} />
    </Field>
  )

  return (
    <>
      {driverTypes.length > 1 && (
        <Field label="Driver" help={d.deviceType ? DRIVER_HELP[d.deviceType] : undefined}>
          <Select value={d.deviceType ?? null} options={driverTypes.map((t) => ({ value: t, label: DRIVER_LABELS[t] ?? t }))} onChange={(deviceType) => void setDevice({ deviceType })} />
        </Field>
      )}
      {oneDevice ? (
        <>
          <Field label="Interface">
            <Select value={d.outputDevice ?? null} placeholder="No device" options={devices(d.outputDevices)} onChange={(outputDevice) => void setDevice({ outputDevice })} />
          </Field>
          {channelField}
        </>
      ) : (
        <>
          <Field label="Input" help="Where your bass comes in: your audio interface.">
            <Select value={d.inputDevice ?? null} placeholder="No input" options={devices(d.inputDevices)} onChange={(inputDevice) => void setDevice({ inputDevice })} />
          </Field>
          {channelField}
          <Field label="Output" help="Headphones or your interface: the song and your bass.">
            <Select value={d.outputDevice ?? null} placeholder="No output" options={devices(d.outputDevices)} onChange={(outputDevice) => void setDevice({ outputDevice })} />
          </Field>
        </>
      )}
      <Field label="Sample rate">
        <Select value={d.sampleRate ?? null} options={(d.availableSampleRates ?? []).map((r) => ({ value: r, label: formatRate(r) }))} onChange={(sampleRate) => void setDevice({ sampleRate })} />
      </Field>
      <Field label="Buffer size" help="Smaller hears your bass sooner; larger if you hear clicks or dropouts.">
        <Select
          value={d.bufferSize ?? null}
          options={(d.availableBufferSizes ?? []).filter((b) => b <= 2048).map((b) => ({ value: b, label: `${b} samples${bufferMs(b)}` }))}
          onChange={(bufferSize) => void setDevice({ bufferSize })}
        />
      </Field>
      {d.hasControlPanel && (
        <div className="set-row">
          <div className="set-buttons">
            <Button size="sm" icon="sliders" onClick={() => void attempt(() => window.nota.engine.showControlPanel(), 'Driver settings')}>
              Driver settings…
            </Button>
          </div>
          <div className="set-help">The interface’s own control panel: its buffer size, clock and inputs.</div>
        </div>
      )}
      {(error || d.error) && (
        <div className="set-row audio-error" role="alert">
          <Icon name="alert" size={13} />
          <span>{error || d.error}</span>
        </div>
      )}
    </>
  )
}
