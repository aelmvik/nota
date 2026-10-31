import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { StemAsset, StemKind } from '../shared/types'
import { computeWaveform, probe, type WaveformData } from './media'
import { portableRelative } from './platform'
import { writeFileAtomic } from './projectStore'

// Generated audio for the open project, kept in its package's Generated
// folder (the root switches when another project opens):
//
//   <root>/<sha256 of source>/
//       peaks-original.json
//       playback.flac               (only when the source can't be played directly)
//       <model>/bass.flac
//       <model>/backing.flac
//       <model>/manifest.json       (written last: its presence marks the stems valid)
//
// Projects store root-relative paths, so a song's folder can be copied into
// another project (see ProjectService.adoptGenerated) and used as is.

export interface StemOutput {
  path: string
  durationSec: number
  rmsDb: number
}

export interface StemManifest {
  sourceHash: string
  model: string
  createdAt: string
  bass: StemOutput
  backing: StemOutput
  warning?: string
}

export interface StemValidation {
  ok: boolean
  error?: string
  warning?: string
}

/** Below this the backing track is considered silent, i.e. separation failed. */
export const SILENT_DB = -70
/** Below this, the song likely has (almost) no bass; still usable, but worth a note. */
export const LOW_BASS_DB = -55

export function durationTolerance(expected: number): number {
  return Math.max(0.5, expected * 0.005)
}

/** Decide whether separated output is genuinely usable. Pure, so it is unit tested. */
export function validateStems(expectedDurationSec: number, bass: StemOutput, backing: StemOutput): StemValidation {
  const tol = durationTolerance(expectedDurationSec)
  for (const [label, stem] of [['bass stem', bass], ['backing track', backing]] as const) {
    if (!Number.isFinite(stem.durationSec) || stem.durationSec <= 0) return { ok: false, error: `The ${label} is empty` }
    if (Math.abs(stem.durationSec - expectedDurationSec) > tol)
      return {
        ok: false,
        error: `The ${label} is ${stem.durationSec.toFixed(1)}s long but the song is ${expectedDurationSec.toFixed(1)}s`
      }
  }
  if (backing.rmsDb < SILENT_DB) return { ok: false, error: 'The backing track came out silent' }
  if (bass.rmsDb < SILENT_DB) return { ok: true, warning: 'No bass was detected in this song' }
  if (bass.rmsDb < LOW_BASS_DB) return { ok: true, warning: 'Very little bass was detected in this song' }
  return { ok: true }
}

export class AssetCache {
  constructor(private _root = '') {}

  get root() {
    return this._root
  }

  setRoot(root: string) {
    this._root = root
  }

  songDir(hash: string) {
    return join(this.root, hash)
  }

  stemDir(hash: string, model: string) {
    return join(this.root, hash, model)
  }

  abs(cachePath: string) {
    return join(this.root, cachePath)
  }

  rel(absPath: string) {
    return portableRelative(this.root, absPath)
  }

  contains(absPath: string): boolean {
    if (!this._root) return false
    const r = relative(this.root, resolve(absPath))
    return !!r && !r.startsWith('..') && !isAbsolute(r)
  }

  private manifestPath(hash: string, model: string) {
    return join(this.stemDir(hash, model), 'manifest.json')
  }

  async readManifest(hash: string, model: string): Promise<StemManifest | null> {
    try {
      const m = JSON.parse(await readFile(this.manifestPath(hash, model), 'utf8')) as StemManifest
      if (m.sourceHash !== hash || m.model !== model) return null
      return m
    } catch {
      return null
    }
  }

  toAssets(m: StemManifest): Record<StemKind, StemAsset> {
    const mk = (kind: StemKind, o: StemOutput): StemAsset => ({
      kind,
      cachePath: this.rel(isAbsolute(o.path) ? o.path : this.abs(o.path)),
      durationSec: o.durationSec,
      rmsDb: o.rmsDb,
      model: m.model,
      createdAt: m.createdAt
    })
    return { bass: mk('bass', m.bass), backing: mk('backing', m.backing) }
  }

  /** Previously generated stems that still exist on disk and pass validation, if any. */
  async findValidStems(hash: string, model: string, expectedDurationSec: number) {
    const m = await this.readManifest(hash, model)
    if (!m) return null
    const bassPath = this.abs(m.bass.path)
    const backingPath = this.abs(m.backing.path)
    if (!existsSync(bassPath) || !existsSync(backingPath)) return null
    const v = validateStems(expectedDurationSec, m.bass, m.backing)
    if (!v.ok) return null
    return { assets: this.toAssets(m), warning: v.warning }
  }

  /**
   * Validate freshly separated files by probing them independently of what
   * the separation worker reported, then record the manifest.
   */
  async commitStems(
    hash: string,
    model: string,
    expectedDurationSec: number,
    reported: { bass: { path: string; rmsDb: number }; backing: { path: string; rmsDb: number } }
  ) {
    const measure = async (o: { path: string; rmsDb: number }): Promise<StemOutput> => {
      const info = await probe(o.path)
      if ((await stat(o.path)).size < 1024) throw new Error('A generated stem file is empty')
      return { path: this.rel(o.path), durationSec: info.durationSec, rmsDb: o.rmsDb }
    }
    const bass = await measure(reported.bass)
    const backing = await measure(reported.backing)
    const v = validateStems(expectedDurationSec, bass, backing)
    if (!v.ok) throw new Error(v.error)

    const manifest: StemManifest = { sourceHash: hash, model, createdAt: new Date().toISOString(), bass, backing, warning: v.warning }
    await writeFileAtomic(this.manifestPath(hash, model), JSON.stringify(manifest, null, 2))
    return { assets: this.toAssets(manifest), warning: v.warning }
  }

  private waveInFlight = new Map<string, Promise<WaveformData>>()

  /** Waveform data for an audio file, computed once and cached as binary next to the stems. */
  async getWaveform(hash: string, key: string, audioPath: string): Promise<WaveformData> {
    const file = join(this.songDir(hash), `wave2-${key.replace(/[^a-z0-9-]/gi, '_')}.bin`)
    const existing = this.waveInFlight.get(file)
    if (existing) return existing
    const job = (async () => {
      try {
        const buf = await readFile(file)
        const header = buf.readUInt32LE(0)
        if (header !== 0x4e574156) throw new Error('bad header')
        return { perSecond: buf.readUInt32LE(4), durationSec: buf.readFloatLE(8), data: new Uint8Array(buf.subarray(12)) }
      } catch {
        const w = await computeWaveform(audioPath)
        const head = Buffer.alloc(12)
        head.writeUInt32LE(0x4e574156, 0) // "VAWN"
        head.writeUInt32LE(w.perSecond, 4)
        head.writeFloatLE(w.durationSec, 8)
        await writeFileAtomic(file, Buffer.concat([head, Buffer.from(w.data.buffer, w.data.byteOffset, w.data.byteLength)]))
        return w
      }
    })().finally(() => this.waveInFlight.delete(file))
    this.waveInFlight.set(file, job)
    return job
  }
}
