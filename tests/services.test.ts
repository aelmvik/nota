import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AssetCache, validateStems } from '../src/main/assetCache'
import { getTools } from '../src/main/media'
import { ProjectService } from '../src/main/projectService'
import { SettingsStore } from '../src/main/projectStore'
import { SeparationQueue } from '../src/main/separationQueue'
import { SeparationCancelledError, type SeparationProvider, type SeparationRequest } from '../src/main/separation/provider'
import type { SeparationEvent } from '../src/shared/processing'

// These tests use real audio written by ffmpeg; the separation itself is
// faked (Demucs is too slow for a unit test), but the fake writes genuine
// audio files that go through the same validation as real output.

const ffmpeg = getTools().ffmpeg
const hasFfmpeg = !!ffmpeg && !!getTools().ffprobe
let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nota-test-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Windows (antivirus, the search indexer) can hold a just-closed folder for a moment. */
async function renameWhenFree(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return renameSync(from, to)
    } catch (err) {
      if (attempt >= 30 || !['EPERM', 'EBUSY', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}

/** A stereo sine, written here as WAV or AIFF, or converted by ffmpeg (the bundled ffmpeg has no lavfi or AIFF muxer). */
function tone(path: string, seconds: number, freq = 220, volume = 0.3) {
  const rate = 44100
  const frames = Math.round(seconds * rate)
  const wav = Buffer.alloc(44 + frames * 4)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + frames * 4, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20) // PCM
  wav.writeUInt16LE(2, 22)
  wav.writeUInt32LE(rate, 24)
  wav.writeUInt32LE(rate * 4, 28)
  wav.writeUInt16LE(4, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(frames * 4, 40)
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * volume * 32767)
    wav.writeInt16LE(v, 44 + i * 4)
    wav.writeInt16LE(v, 46 + i * 4)
  }
  if (path.endsWith('.wav')) return writeFileSync(path, wav)
  if (path.endsWith('.aiff')) {
    // Big-endian PCM; 44100 Hz as an 80-bit float.
    const aiff = Buffer.alloc(54 + frames * 4)
    aiff.write('FORM', 0)
    aiff.writeUInt32BE(46 + frames * 4, 4)
    aiff.write('AIFFCOMM', 8)
    aiff.writeUInt32BE(18, 16)
    aiff.writeUInt16BE(2, 20)
    aiff.writeUInt32BE(frames, 22)
    aiff.writeUInt16BE(16, 26)
    Buffer.from([0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0]).copy(aiff, 28)
    aiff.write('SSND', 38)
    aiff.writeUInt32BE(8 + frames * 4, 42)
    for (let i = 0; i < frames * 2; i++) aiff.writeInt16BE(wav.readInt16LE(44 + i * 2), 54 + i * 2)
    return writeFileSync(path, aiff)
  }
  const src = `${path}.src.wav`
  writeFileSync(src, wav)
  execFileSync(ffmpeg!, ['-v', 'error', '-y', '-i', src, path])
  unlinkSync(src)
}

class FakeProvider implements SeparationProvider {
  readonly name = 'Fake'
  readonly model = 'fake-v1'
  calls = 0
  constructor(private opts: { fail?: string; silentBacking?: boolean; durationScale?: number; delayMs?: number; available?: boolean } = {}) {}
  async checkAvailability() {
    return this.opts.available === false ? { available: false, reason: 'Fake provider disabled' } : { available: true }
  }
  async separate(req: SeparationRequest) {
    this.calls++
    req.onProgress(0.5, 'separating')
    if (this.opts.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.opts.delayMs)
        req.signal.addEventListener('abort', () => (clearTimeout(t), reject(new SeparationCancelledError())))
      })
    }
    if (this.opts.fail) throw new Error(this.opts.fail)
    const seconds = 2 * (this.opts.durationScale ?? 1)
    const bass = join(req.outDir, 'bass.flac')
    const backing = join(req.outDir, 'backing.flac')
    tone(bass, seconds, 55)
    tone(backing, seconds, 440, this.opts.silentBacking ? 0 : 0.3)
    return { model: this.model, bass: { path: bass, rmsDb: -18 }, backing: { path: backing, rmsDb: this.opts.silentBacking ? -120 : -14 } }
  }
}

function collect() {
  const events: [string, SeparationEvent['type']][] = []
  return { events, listener: (hash: string, e: SeparationEvent) => events.push([hash, e.type]) }
}

describe('stem validation', () => {
  const ok = { path: 'x', durationSec: 180, rmsDb: -20 }
  it('accepts matching stems', () => expect(validateStems(180, ok, ok)).toEqual({ ok: true }))
  it('rejects wrong lengths', () => expect(validateStems(180, { ...ok, durationSec: 90 }, ok).ok).toBe(false))
  it('rejects a silent backing track', () => expect(validateStems(180, ok, { ...ok, rmsDb: -100 })).toMatchObject({ ok: false }))
  it('warns but accepts a song with almost no bass', () =>
    expect(validateStems(180, { ...ok, rmsDb: -60 }, ok)).toMatchObject({ ok: true, warning: expect.stringContaining('little bass') }))
})

describe.skipIf(!hasFfmpeg)('separation queue with asset cache', () => {
  it('runs a job, validates output and reuses it from cache next time', async () => {
    const cache = new AssetCache(join(dir, 'cache1'))
    const provider = new FakeProvider()
    const { events, listener } = collect()
    const queue = new SeparationQueue(provider, cache, listener)
    await queue.enqueue({ hash: 'h1', inputPath: '/dev/null', durationSec: 2, label: 'Song' })
    await queue.whenIdle()
    expect(events.map((e) => e[1])).toEqual(['enqueue', 'start', 'progress', 'progress', 'succeed'])
    expect(existsSync(join(cache.root, 'h1/fake-v1/manifest.json'))).toBe(true)

    await queue.enqueue({ hash: 'h1', inputPath: '/dev/null', durationSec: 2, label: 'Song' })
    await queue.whenIdle()
    expect(provider.calls).toBe(1) // second time served from cache
  })

  it('fails when the output does not match the song or is silent', async () => {
    const cache = new AssetCache(join(dir, 'cache2'))
    for (const opts of [{ durationScale: 3 }, { silentBacking: true }, { fail: 'model crashed' }]) {
      const { events, listener } = collect()
      const queue = new SeparationQueue(new FakeProvider(opts), cache, listener)
      const hash = `bad-${JSON.stringify(opts).length}`
      await queue.enqueue({ hash, inputPath: '/dev/null', durationSec: 2, label: 'Song' })
      await queue.whenIdle()
      expect(events.at(-1)?.[1]).toBe('fail')
      expect(existsSync(join(cache.root, hash, 'fake-v1/manifest.json'))).toBe(false)
    }
  })

  it('cancels running and waiting jobs', async () => {
    const cache = new AssetCache(join(dir, 'cache3'))
    const { events, listener } = collect()
    const queue = new SeparationQueue(new FakeProvider({ delayMs: 2000 }), cache, listener)
    await queue.enqueue({ hash: 'run', inputPath: '/dev/null', durationSec: 2, label: 'A' })
    await queue.enqueue({ hash: 'wait', inputPath: '/dev/null', durationSec: 2, label: 'B' })
    queue.cancel('wait')
    queue.cancel('run')
    await queue.whenIdle()
    expect(events.filter((e) => e[1] === 'cancel').map((e) => e[0]).sort()).toEqual(['run', 'wait'])
    expect(events.some((e) => e[1] === 'succeed')).toBe(false)
  })

  it('queues a song again while its dropped job is still shutting down (another project opened)', async () => {
    const cache = new AssetCache(join(dir, 'cache6'))
    const { events, listener } = collect()
    const real = new FakeProvider()
    let first = true
    let started!: () => void
    const firstStarted = new Promise<void>((r) => (started = r))
    // Like Demucs: after a cancel the process takes a while to exit.
    const provider: SeparationProvider = {
      name: 'Slow stop',
      model: real.model,
      checkAvailability: () => real.checkAvailability(),
      separate: (req) =>
        first
          ? ((first = false),
            new Promise((_, reject) => {
              req.signal.addEventListener('abort', () => setTimeout(() => reject(new SeparationCancelledError()), 100))
              started()
            }))
          : real.separate(req)
    }
    const queue = new SeparationQueue(provider, cache, listener)
    await queue.enqueue({ hash: 'same', inputPath: '/dev/null', durationSec: 2, label: 'A' })
    await firstStarted // a fixed wait can fall before the job reaches the provider on a slow machine
    queue.clear() // project closed
    await queue.enqueue({ hash: 'same', inputPath: '/dev/null', durationSec: 2, label: 'A' }) // the next project has it too
    await queue.whenIdle()
    await new Promise((r) => setTimeout(r, 150))
    expect(events.map((e) => e[1])).toEqual(['enqueue', 'start', 'enqueue', 'start', 'progress', 'progress', 'succeed'])
  })

  it('reports an unavailable provider instead of pretending', async () => {
    const { events, listener } = collect()
    const queue = new SeparationQueue(new FakeProvider({ available: false }), new AssetCache(join(dir, 'cache4')), listener)
    await queue.enqueue({ hash: 'x', inputPath: '/dev/null', durationSec: 2, label: 'A' })
    expect(events).toEqual([['x', 'unavailable']])
  })

  it('prioritises a selected song', async () => {
    const order: string[] = []
    const queue = new SeparationQueue(new FakeProvider({ delayMs: 50 }), new AssetCache(join(dir, 'cache5')), (h, e) => e.type === 'start' && order.push(h))
    for (const h of ['a', 'b', 'c']) await queue.enqueue({ hash: h, inputPath: '/dev/null', durationSec: 2, label: h })
    queue.prioritize('c')
    await queue.whenIdle()
    expect(order).toEqual(['a', 'c', 'b'])
  })
})

describe.skipIf(!hasFfmpeg)('project service: import, persist, reopen', () => {
  it('imports real audio, separates it, saves and restores everything', async () => {
    const root = join(dir, 'svc')
    const plain = join(dir, 'Song A.wav')
    const tagged = join(dir, 'tagged.wav')
    const aiff = join(dir, 'Song B.aiff')
    tone(plain, 2, 330)
    tone(aiff, 2, 262)
    execFileSync(ffmpeg!, ['-v', 'error', '-y', '-i', plain, '-metadata', 'title=First Tune', '-metadata', 'artist=Tester', tagged])

    const make = () =>
      new ProjectService({
        cache: new AssetCache(join(root, 'cache')),
        provider: new FakeProvider(),
        settings: new SettingsStore(join(root, 'settings.json')),
        projectsDir: join(root, 'projects'),
        autosaveDelayMs: 10
      })

    const svc = make()
    await svc.create('Session')
    const res = await svc.importFiles([tagged, aiff, join(dir, 'missing.mp3'), join(dir, 'notes.txt')])
    expect(res.added).toHaveLength(2)
    expect(res.skipped.map((s) => s.reason)).toEqual([expect.any(String), 'Unsupported file type'])
    const again = await svc.importFiles([aiff])
    expect(again.skipped[0].reason).toBe('Already in this playlist')

    const p1 = svc.project!
    expect(p1.songs[0]).toMatchObject({ title: 'First Tune', artist: 'Tester' })
    expect(p1.songs[0].durationSec).toBeCloseTo(2, 1)
    // AIFF can't be played by Chromium directly, so a FLAC proxy is made; the source is untouched.
    expect(p1.songs[1].playbackProxy).toMatch(/playback\.flac$/)
    expect(existsSync(aiff)).toBe(true)

    await svc.scheduleSeparations()
    await svc.queue.whenIdle()
    expect(svc.project!.songs.every((s) => s.separation.status === 'ready' && s.stems.bass && s.stems.backing)).toBe(true)

    svc.moveSong(svc.project!.songs[1].id, 0)
    const first = svc.project!.songs[0].id
    svc.updateSong(first, { mode: 'playalong', speed: 0.75, loop: { start: 0.5, end: 1.5, enabled: true } })
    const path = svc.filePath!
    await svc.close()
    expect(path).toMatch(/Session\.nota$/)
    expect(JSON.parse(readFileSync(join(path, 'project.json'), 'utf8')).songs).toHaveLength(2)
    // Generated audio lives inside the project.
    expect(readdirSync(join(path, 'Generated')).filter((n) => /^[0-9a-f]{64}$/.test(n))).toHaveLength(2)

    // Reopen in a fresh service, as after an app restart. Delete one source first.
    unlinkSync(tagged)
    const svc2 = make()
    await svc2.open(path)
    const p2 = svc2.project!
    expect(p2.name).toBe('Session')
    expect(p2.songs.map((s) => s.title)).toEqual(['Song B', 'First Tune'])
    expect(p2.songs[0]).toMatchObject({ mode: 'playalong', speed: 0.75, loop: { start: 0.5, end: 1.5, enabled: true } })
    expect(p2.songs[0].separation.status).toBe('ready')
    expect(p2.songs[0].stems.backing?.cachePath).toMatch(/fake-v1\/backing\.flac$/)
    expect(p2.songs[1].source.missing).toBe(true)
    await svc2.close()
  })
})

describe.skipIf(!hasFfmpeg)('project packages', () => {
  const make = (root: string, extra: Partial<ConstructorParameters<typeof ProjectService>[0]> = {}) =>
    new ProjectService({
      cache: new AssetCache(),
      provider: new FakeProvider(),
      settings: new SettingsStore(join(root, 'settings.json')),
      projectsDir: join(root, 'projects'),
      autosaveDelayMs: 10,
      ...extra
    })

  it('copies songs in, keeps them by relative path, and survives the project being moved', async () => {
    const root = join(dir, 'pkg1')
    mkdirSync(root, { recursive: true })
    const song = join(root, 'Tune.wav')
    tone(song, 2, 300)
    const svc = make(root)
    await svc.create('Gig')
    const pkg = svc.filePath!
    await svc.importFiles([song], undefined, { copy: true })
    const copied = svc.project!.songs[0].source.path
    expect(copied).toBe(join(pkg, 'Songs', 'Tune.wav'))
    expect(existsSync(song)).toBe(true)
    expect(svc.outsideSongs()).toHaveLength(0)
    await svc.close()
    expect(JSON.parse(readFileSync(join(pkg, 'project.json'), 'utf8')).songs[0].source.path).toBe('Songs/Tune.wav')

    // Move the whole project: the copied song still resolves.
    const moved = join(root, 'Elsewhere.nota')
    await renameWhenFree(pkg, moved)
    const svc2 = make(root)
    await svc2.open(moved)
    expect(svc2.project!.songs[0].source).toMatchObject({ path: join(moved, 'Songs', 'Tune.wav'), missing: false })
    await svc2.close()
  })

  it('still makes playback copies for later songs when one fails', async () => {
    const root = join(dir, 'pkg-copies')
    mkdirSync(root, { recursive: true })
    const [a, b] = [join(root, 'A.mp3'), join(root, 'B.mp3')]
    tone(a, 2, 330)
    tone(b, 2, 440)
    const svc = make(root)
    await svc.create('Copies')
    await svc.importFiles([a, b])
    for (let i = 0; i < 100 && svc.project!.songs.some((s) => !s.playbackProxy); i++) await new Promise((r) => setTimeout(r, 50))
    // Start over with A broken: its copy fails, B's must still be made.
    for (const s of svc.project!.songs) rmSync(join(svc.filePath!, 'Generated', s.source.hash, 'playback.flac'), { force: true })
    svc.mutate((p) => ({ ...p, songs: p.songs.map((s) => ({ ...s, playbackProxy: null })) }))
    writeFileSync(a, 'not audio')
    await svc.ensurePlaybackCopies()
    expect(svc.project!.songs.map((s) => !!s.playbackProxy)).toEqual([false, true])
    await svc.close()
  })

  it('references songs in place, collects them on request, and cleans up removed songs', async () => {
    const root = join(dir, 'pkg2')
    mkdirSync(root, { recursive: true })
    const a = join(root, 'A.wav')
    const b = join(root, 'B.wav')
    tone(a, 2, 330)
    tone(b, 2, 440)
    const trashed: string[] = []
    const svc = make(root, { trash: async (p) => (trashed.push(p), rmSync(p)) })
    await svc.create('Ref')
    const pkg = svc.filePath!
    await svc.importFiles([a, b], undefined, { copy: false })
    expect(svc.outsideSongs()).toHaveLength(2)
    await svc.scheduleSeparations()
    await svc.queue.whenIdle()
    const [sa, sb] = svc.project!.songs
    expect(existsSync(join(pkg, 'Generated', sa.source.hash))).toBe(true)

    expect(await svc.collectSongs()).toBe(2)
    expect(svc.outsideSongs()).toHaveLength(0)
    expect(existsSync(a)).toBe(true) // originals untouched

    await svc.removeSong(sb.id)
    expect(existsSync(join(pkg, 'Generated', sb.source.hash))).toBe(false)
    expect(trashed).toEqual([join(pkg, 'Songs', 'B.wav')])
    expect(existsSync(b)).toBe(true)
    await svc.close()
  })

  it('reuses a song already separated in another project instead of separating it again', async () => {
    const root = join(dir, 'pkg3')
    mkdirSync(root, { recursive: true })
    const song = join(root, 'Shared.wav')
    tone(song, 2, 250)
    const first = make(root)
    await first.create('One')
    const pkgOne = first.filePath!
    await first.importFiles([song])
    await first.scheduleSeparations()
    await first.queue.whenIdle()
    await first.close()

    const provider = new FakeProvider()
    const second = make(root, { provider, generatedSources: () => [join(pkgOne, 'Generated')] })
    await second.create('Two')
    await second.importFiles([song])
    await second.scheduleSeparations()
    await second.queue.whenIdle()
    expect(second.project!.songs[0].separation.status).toBe('ready')
    expect(provider.calls).toBe(0)
    expect(existsSync(join(second.filePath!, 'Generated', second.project!.songs[0].source.hash))).toBe(true)
    await second.close()
  })
})

describe('saving with plugin states', () => {
  it('keeps an effect added while the engine reports plugin states', async () => {
    const root = mkdtempSync(join(dir, 'states-'))
    let answer: (() => void) | null = null
    const slot = (slotId: string, state: string | null) =>
      ({ slotId, pluginId: 'p', name: 'Comp', manufacturer: 'm', format: 'VST3', descriptionXml: '', bypassed: false, state, chain: 'input' }) as const
    const svc = new ProjectService({
      cache: new AssetCache(),
      provider: new FakeProvider({ available: false }),
      settings: new SettingsStore(join(root, 'settings.json')),
      projectsDir: root,
      autosaveDelayMs: 60_000,
      // Like AudioSession.captureStates: the engine answers later with each plugin's state.
      beforeSave: (p) =>
        new Promise((resolve) => {
          answer = () => resolve({ ...p, effects: p.effects.map((e) => ({ ...e, state: 'captured' })) })
        })
    })
    // Wait for the save to ask the engine; a fixed delay was too short on slow disks.
    const asked = async () => {
      while (!answer) await new Promise((r) => setTimeout(r, 1))
    }
    const reply = () => {
      const a = answer!
      answer = null
      a()
    }
    const created = svc.create('States')
    await asked()
    reply()
    await created
    svc.mutate((p) => ({ ...p, effects: [slot('old', null)] }))
    const saving = svc.saveNow()
    await asked()
    svc.mutate((p) => ({ ...p, effects: [...p.effects, slot('new', null)] })) // added mid-save
    reply()
    await saving
    expect(svc.project!.effects.map((e) => [e.slotId, e.state])).toEqual([
      ['old', 'captured'],
      ['new', null]
    ])
  })
})
