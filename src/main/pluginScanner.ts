import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { PluginCatalog, PluginInfo, ScanProgress } from '../shared/types'
import { defaultVst3Dirs } from './platform'
import { writeFileAtomic } from './projectStore'

// Discovers VST3 (and on macOS, Audio Unit) effects. Every plugin is probed
// in its own short-lived engine process, so a plugin that crashes or hangs
// during scanning is recorded as failed instead of taking the app down.

export const DEFAULT_VST3_DIRS = defaultVst3Dirs()

const DESCRIBE_TIMEOUT_MS = 30_000
const CONCURRENCY = 4

interface CacheEntry {
  mtimeMs: number | null
  plugins: PluginInfo[]
  error?: string
}

function runEngine(binary: string, args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      const last = stdout.trim().split('\n').filter(Boolean).pop()
      if (last) {
        try {
          return resolve(JSON.parse(last))
        } catch {
          // fall through
        }
      }
      if (err) {
        const killed = (err as { killed?: boolean }).killed
        return reject(new Error(killed ? 'Timed out while loading' : err.signal ? `Crashed while loading (${err.signal})` : err.message))
      }
      reject(new Error('No response from the scanner'))
    })
  })
}

export class PluginScanner extends EventEmitter {
  private catalog: PluginCatalog = { plugins: [], failed: [], directories: DEFAULT_VST3_DIRS, scannedAt: null }
  private cache: Record<string, CacheEntry> = {}
  private progress: ScanProgress = { running: false, done: 0, total: 0, current: null }

  constructor(private readonly catalogPath: string) {
    super()
  }

  async load(directories: string[] | null) {
    try {
      const data = JSON.parse(await readFile(this.catalogPath, 'utf8'))
      this.catalog = data.catalog ?? this.catalog
      this.cache = data.cache ?? {}
    } catch {
      // first run
    }
    if (directories) this.catalog = { ...this.catalog, directories }
  }

  getCatalog(): PluginCatalog {
    return this.catalog
  }

  getProgress(): ScanProgress {
    return this.progress
  }

  private setProgress(p: Partial<ScanProgress>) {
    this.progress = { ...this.progress, ...p }
    this.emit('progress', this.progress)
  }

  async scan(binary: string, directories: string[], formats: string[]): Promise<PluginCatalog> {
    if (this.progress.running) throw new Error('A plugin scan is already running')
    this.setProgress({ running: true, done: 0, total: 0, current: 'Looking for plugins…' })

    try {
      const candidates: { format: string; id: string }[] = []
      if (formats.includes('VST3')) {
        const dirs = directories.filter((d) => existsSync(d))
        if (dirs.length) {
          const res = await runEngine(binary, ['--list', 'VST3', dirs.join(';')], 60_000)
          for (const id of (res.identifiers as string[]) ?? []) candidates.push({ format: 'VST3', id })
        }
      }
      if (formats.includes('AudioUnit')) {
        const res = await runEngine(binary, ['--list', 'AudioUnit'], 60_000)
        // Only effects ("aufx"/"aumf"): instruments and generators don't belong in a bass chain.
        for (const id of (res.identifiers as string[]) ?? [])
          if (/\/(aufx|aumf),/.test(id)) candidates.push({ format: 'AudioUnit', id })
      }

      this.setProgress({ total: candidates.length })
      const nextCache: Record<string, CacheEntry> = {}
      let index = 0

      const worker = async () => {
        while (index < candidates.length) {
          const c = candidates[index++]
          const key = `${c.format}|${c.id}`
          this.setProgress({ current: c.id.split('/').pop()?.replace(/\.vst3$/, '') ?? c.id })

          const mtimeMs = c.format === 'VST3' ? await stat(c.id).then((s) => s.mtimeMs, () => null) : null
          const prior = this.cache[key]
          // An unchanged plugin that loaded before is reused; one that failed (a timeout,
          // a licence prompt) is tried again on every scan.
          if (prior && !prior.error && prior.mtimeMs === mtimeMs && c.format === 'VST3') {
            nextCache[key] = prior
          } else {
            try {
              const res = await runEngine(binary, ['--describe', c.format, c.id], DESCRIBE_TIMEOUT_MS)
              if (res.error) throw new Error(String(res.error))
              const plugins = ((res.plugins as Record<string, unknown>[]) ?? []).map((p) => ({
                id: String(p.identifier),
                name: String(p.name),
                manufacturer: String(p.manufacturer || 'Unknown'),
                format: String(p.format),
                category: String(p.category ?? ''),
                version: String(p.version ?? ''),
                isInstrument: Boolean(p.isInstrument),
                fileOrIdentifier: String(p.fileOrIdentifier),
                descriptionXml: String(p.descriptionXml)
              }))
              if (plugins.length === 0) throw new Error('No loadable plugin found in this file')
              nextCache[key] = { mtimeMs, plugins }
            } catch (err) {
              nextCache[key] = { mtimeMs, plugins: [], error: err instanceof Error ? err.message : String(err) }
            }
          }
          this.setProgress({ done: this.progress.done + 1 })
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker))

      const plugins: PluginInfo[] = []
      const failed: PluginCatalog['failed'] = []
      for (const [key, entry] of Object.entries(nextCache)) {
        const [format, fileOrIdentifier] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)]
        if (entry.error) failed.push({ format, fileOrIdentifier, reason: entry.error })
        plugins.push(...entry.plugins.filter((p) => !p.isInstrument))
      }
      plugins.sort((a, b) => a.name.localeCompare(b.name) || a.format.localeCompare(b.format))

      this.cache = nextCache
      this.catalog = { plugins, failed, directories, scannedAt: new Date().toISOString() }
      await writeFileAtomic(this.catalogPath, JSON.stringify({ catalog: this.catalog, cache: this.cache }))
      return this.catalog
    } finally {
      this.setProgress({ running: false, current: null })
    }
  }
}
