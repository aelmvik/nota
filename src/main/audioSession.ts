import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { DeviceRequest } from '../shared/api'
import * as P from '../shared/project'
import type { AudioConfig, EffectChain, EffectSlot, EngineDeviceState, PluginInfo, Project } from '../shared/types'
import type { EngineHost } from './engineHost'
import type { ProjectService } from './projectService'
import { useProAudio } from './pipewire'

// Keeps the native engine in step with the open project: device selection,
// levels and the effect chain (including plugin state) are restored when a
// project opens or the engine restarts, and written back when they change.


export class AudioSession extends EventEmitter {
  /** Per-slot load errors (e.g. a plugin that was uninstalled). Not persisted. */
  private slotErrors = new Map<string, string>()
  private chainProjectId: string | null = null
  private syncing: Promise<void> = Promise.resolve()
  private tuner = { enabled: false, mute: true }

  constructor(
    private readonly engine: EngineHost,
    private readonly projects: ProjectService,
    private readonly defaults: { get: () => AudioConfig | null; set: (a: AudioConfig) => void }
  ) {
    super()
    engine.on('ready', () => this.sync(true))
    // Opening another project brings its effects, device and levels to the running engine.
    projects.on('change', () => {
      if ((projects.project?.id ?? null) !== this.chainProjectId) void this.sync()
    })
  }

  getSlotErrors(): Record<string, string> {
    return Object.fromEntries(this.slotErrors)
  }

  private emitChain() {
    this.emit('chain', this.getSlotErrors())
    void this.refreshDevice()
  }

  /** Device state includes plugin latency, so refresh it after chain edits. */
  private async refreshDevice() {
    try {
      this.engine.updateDevice(await this.engine.call('getDeviceState'))
    } catch {
      // engine not running
    }
  }

  /** Re-apply the project's audio setup to the engine (serialised). */
  sync(force = false): Promise<void> {
    this.syncing = this.syncing.then(() => this.doSync(force)).catch(() => {})
    return this.syncing
  }

  private async doSync(force: boolean) {
    if (!this.engine.running) return
    const project = this.projects.project
    const audio = project?.audio ?? this.defaults.get() ?? P.DEFAULT_AUDIO

    await this.applyDevice(audio, false).catch(() => {})
    await this.engine.call('setInputTrim', { db: audio.inputTrimDb }).catch(() => {})
    await this.engine.call('setOutputLevel', { db: audio.monitorLevelDb }).catch(() => {})
    await this.engine.call('setTuner', this.tuner).catch(() => {})

    await this.engine.call('setOutputIncludesBass', { include: project?.outputIncludesBass ?? true }).catch(() => {})
    const projectId = project?.id ?? null
    if (force || projectId !== this.chainProjectId) {
      this.chainProjectId = projectId
      await this.loadChain(project?.effects ?? [])
    }
  }

  private async applyDevice(audio: Partial<AudioConfig>, persist: boolean): Promise<EngineDeviceState> {
    const current = this.engine.snapshot().device
    const req: DeviceRequest = {}
    // Another driver type (ASIO) has its own device list, which the engine checks itself.
    const switching = !!audio.deviceType && audio.deviceType !== current?.deviceType && !!current?.availableDeviceTypes?.includes(audio.deviceType)
    if (switching) req.deviceType = audio.deviceType!
    // Only ask for devices that exist right now; otherwise keep the current one.
    if (audio.inputDevice && (switching || current?.inputDevices?.includes(audio.inputDevice))) req.inputDevice = audio.inputDevice
    if (audio.outputDevice && (switching || current?.outputDevices?.includes(audio.outputDevice))) req.outputDevice = audio.outputDevice
    if (audio.inputChannels?.length) req.inputChannels = audio.inputChannels
    if (audio.sampleRate) req.sampleRate = audio.sampleRate
    if (audio.bufferSize) req.bufferSize = audio.bufferSize

    let state: EngineDeviceState
    try {
      state = await this.engine.call<EngineDeviceState>('setDevice', req as Record<string, unknown>, 15_000)
    } catch (err) {
      state = await this.engine.call<EngineDeviceState>('getDeviceState')
      state = { ...state, error: err instanceof Error ? err.message : String(err) }
    }
    this.engine.updateDevice(state)

    if (persist) {
      const patch: Partial<AudioConfig> = {
        deviceType: state.deviceType ?? null,
        inputDevice: state.inputDevice ?? null,
        outputDevice: state.outputDevice ?? null,
        inputChannels: state.inputChannels ?? [0],
        sampleRate: state.sampleRate ?? null,
        bufferSize: state.bufferSize ?? null
      }
      this.persistAudio(patch)
    }
    return state
  }

  private persistAudio(patch: Partial<AudioConfig>) {
    if (this.projects.project) this.projects.mutate((p) => P.updateAudio(p, patch))
    const base = this.projects.project?.audio ?? this.defaults.get() ?? P.DEFAULT_AUDIO
    this.defaults.set({ ...base, ...patch })
  }

  async setDevice(req: DeviceRequest): Promise<EngineDeviceState> {
    const state = await this.applyDevice({ ...req }, true)
    // Switching devices restarts the stream; monitoring stays as it was.
    return state
  }

  /**
   * Linux: puts the input's sound card in PipeWire's Pro Audio profile, so its
   * inputs are numbered as on the hardware, then selects it again under its new
   * names (the output too, when it's the same card), from Input 1.
   */
  async useProAudio(): Promise<EngineDeviceState> {
    const current = this.engine.snapshot().device ?? {}
    if (process.platform !== 'linux' || current.deviceType !== 'JACK' || !current.inputDevice) throw new Error('Only for a JACK input on Linux')
    const names = await useProAudio(current.inputDevice)
    // JACK lists the new client a moment after PipeWire creates it.
    for (let i = 0; i < 20; i++) {
      const state = await this.engine.call<EngineDeviceState>('getDeviceState')
      this.engine.updateDevice(state)
      if (names.input && state.inputDevices?.includes(names.input)) break
      await new Promise((r) => setTimeout(r, 250))
    }
    const sameCard = current.outputDevice === current.inputDevice
    return this.applyDevice({ inputDevice: names.input ?? undefined, ...(sameCard && names.output ? { outputDevice: names.output } : {}), inputChannels: [0] }, true)
  }

  /** The driver's own settings window (ASIO); its buffer size and so on are kept afterwards. */
  async showControlPanel(): Promise<EngineDeviceState> {
    const state = await this.engine.call<EngineDeviceState>('showDeviceControlPanel', {}, 30 * 60_000)
    this.engine.updateDevice(state)
    this.persistAudio({ sampleRate: state.sampleRate ?? null, bufferSize: state.bufferSize ?? null })
    return state
  }

  async setMonitoring(enabled: boolean) {
    const state = await this.engine.call<EngineDeviceState>('setMonitoring', { enabled })
    this.engine.updateDevice(state)
    this.engine.setMonitoringFlag(enabled)
  }

  async setInputTrim(db: number) {
    await this.engine.call('setInputTrim', { db })
    this.persistAudio({ inputTrimDb: db })
  }

  async setMonitorLevel(db: number) {
    await this.engine.call('setOutputLevel', { db })
    this.persistAudio({ monitorLevelDb: db })
  }

  async setTuner(enabled: boolean, mute: boolean) {
    this.tuner = { enabled, mute }
    await this.engine.call('setTuner', this.tuner)
    // The tuner opens or closes the input device.
    await this.refreshDevice()
  }

  setPlaybackVolume(volume: number) {
    // Linear gain; up to 2 (≈ +6 dB) so quiet songs can be lifted.
    this.persistAudio({ playbackVolume: Math.max(0, Math.min(2, volume)) })
  }

  // ---- Effects chain ----------------------------------------------------------

  private async loadChain(effects: EffectSlot[]) {
    this.slotErrors.clear()
    await this.engine.call('clearChain')
    for (const slot of effects) {
      try {
        await this.engine.call(
          'addPlugin',
          { slotId: slot.slotId, descriptionXml: slot.descriptionXml, state: slot.state ?? '', bypassed: slot.bypassed, chain: slot.chain ?? 'input' },
          60_000
        )
      } catch (err) {
        this.slotErrors.set(slot.slotId, err instanceof Error ? err.message : String(err))
      }
    }
    this.emitChain()
  }

  private requireProject(): Project {
    if (!this.projects.project) throw new Error('Open a project first')
    return this.projects.project
  }

  async addEffect(plugin: PluginInfo, chain: EffectChain = 'input') {
    this.requireProject()
    const slotId = randomUUID()
    await this.engine.call('addPlugin', { slotId, descriptionXml: plugin.descriptionXml, bypassed: false, chain }, 60_000)
    const slot: EffectSlot = {
      slotId,
      pluginId: plugin.id,
      name: plugin.name,
      manufacturer: plugin.manufacturer,
      format: plugin.format,
      descriptionXml: plugin.descriptionXml,
      bypassed: false,
      state: null,
      chain
    }
    this.projects.mutate((p) => ({ ...p, effects: [...p.effects, slot] }))
    void this.engine.call('openEditor', { slotId }).catch(() => {})
    this.emitChain()
  }

  async removeEffect(slotId: string) {
    this.requireProject()
    if (!this.slotErrors.has(slotId)) await this.engine.call('removePlugin', { slotId }).catch(() => {})
    this.slotErrors.delete(slotId)
    this.projects.mutate((p) => ({ ...p, effects: p.effects.filter((e) => e.slotId !== slotId) }))
    this.emitChain()
  }

  /** Move an effect within its own chain; `toIndex` counts within that chain. */
  async moveEffect(slotId: string, toIndex: number) {
    const project = this.requireProject()
    const slot = project.effects.find((e) => e.slotId === slotId)
    if (!slot) return
    const chainOf = (e: EffectSlot) => e.chain ?? 'input'
    const same = project.effects.filter((e) => chainOf(e) === chainOf(slot) && e.slotId !== slotId)
    const to = Math.max(0, Math.min(same.length, toIndex))
    same.splice(to, 0, slot)
    // Both chains share one list: put the reordered chain back into its slots.
    let k = 0
    const effects = project.effects.map((e) => (chainOf(e) === chainOf(slot) ? same[k++] : e))
    // The engine only holds slots that loaded; translate to its index space.
    const engineIndex = same.slice(0, to).filter((e) => !this.slotErrors.has(e.slotId)).length
    if (!this.slotErrors.has(slotId)) await this.engine.call('movePlugin', { slotId, index: engineIndex })
    this.projects.mutate((p) => ({ ...p, effects }))
  }

  /**
   * Bring the engine's chains from `prev` to `next` (after undo or redo) with
   * the fewest changes: remove, add, bypass and reorder only the slots that
   * differ, so the other plugins keep running and their windows stay open.
   */
  async applyEffects(prev: EffectSlot[], next: EffectSlot[]) {
    const chainOf = (e: EffectSlot) => e.chain ?? 'input'
    const ids = (list: EffectSlot[]) => new Set(list.map((e) => e.slotId))
    const prevIds = ids(prev)
    const nextIds = ids(next)
    for (const slot of prev) {
      if (nextIds.has(slot.slotId)) continue
      if (!this.slotErrors.has(slot.slotId)) await this.engine.call('removePlugin', { slotId: slot.slotId }).catch(() => {})
      this.slotErrors.delete(slot.slotId)
    }
    for (const slot of next) {
      if (prevIds.has(slot.slotId)) continue
      const index = next.filter((e) => chainOf(e) === chainOf(slot)).findIndex((e) => e.slotId === slot.slotId)
      try {
        await this.engine.call(
          'addPlugin',
          { slotId: slot.slotId, descriptionXml: slot.descriptionXml, state: slot.state ?? '', bypassed: slot.bypassed, chain: chainOf(slot), index },
          60_000
        )
      } catch (err) {
        this.slotErrors.set(slot.slotId, err instanceof Error ? err.message : String(err))
      }
    }
    for (const slot of next) {
      const before = prev.find((e) => e.slotId === slot.slotId)
      if (before && before.bypassed !== slot.bypassed && !this.slotErrors.has(slot.slotId))
        await this.engine.call('setBypass', { slotId: slot.slotId, bypassed: slot.bypassed }).catch(() => {})
    }
    // Order within each chain, counting only the slots the engine holds.
    for (const chain of ['input', 'output'] as const) {
      const loaded = next.filter((e) => chainOf(e) === chain && !this.slotErrors.has(e.slotId))
      for (let i = 0; i < loaded.length; i++) await this.engine.call('movePlugin', { slotId: loaded[i].slotId, index: i }).catch(() => {})
    }
    this.emitChain()
  }

  /** Whether your bass goes through the output chain or joins the mix after it. */
  async setOutputIncludesBass(include: boolean) {
    this.requireProject()
    await this.engine.call('setOutputIncludesBass', { include })
    this.projects.mutate((p) => ({ ...p, outputIncludesBass: include }))
    void this.refreshDevice()
  }

  async setBypass(slotId: string, bypassed: boolean) {
    this.requireProject()
    await this.engine.call('setBypass', { slotId, bypassed })
    this.projects.mutate((p) => ({ ...p, effects: p.effects.map((e) => (e.slotId === slotId ? { ...e, bypassed } : e)) }))
    void this.refreshDevice()
  }

  async openEditor(slotId: string) {
    await this.engine.call('openEditor', { slotId })
  }

  /** Pull current plugin states from the engine so they are saved with the project. */
  async captureStates(project: Project): Promise<Project> {
    if (!this.engine.running || project.effects.length === 0 || this.chainProjectId !== project.id) return project
    try {
      const chain = await this.engine.call<{ slotId: string; state?: string }[]>('getChainState', {}, 15_000)
      const states = new Map(chain.map((c) => [c.slotId, c.state ?? null]))
      return { ...project, effects: project.effects.map((e) => (states.has(e.slotId) ? { ...e, state: states.get(e.slotId) ?? e.state } : e)) }
    } catch {
      return project
    }
  }
}
