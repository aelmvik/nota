import { EventEmitter } from 'node:events'
import { newerRelease, type UpdateCheck, type UpdateInfo, type UpdateTarget } from '../shared/updates'
import type { SettingsStore } from './projectStore'

/** Where Nøta's releases are published. */
export const RELEASES_REPO = 'aelmvik/nota'

const DAY = 24 * 60 * 60 * 1000

/**
 * Asks GitHub for the latest release, at most once a day (or when asked from
 * Settings). One anonymous request: nothing about the user or their projects
 * is sent. Emits 'change' with the newer release, or null.
 */
export class UpdateChecker extends EventEmitter {
  private found: UpdateInfo | null = null

  constructor(
    private readonly currentVersion: string,
    private readonly settings: SettingsStore,
    /** Which release file this copy installs from (null: open the release page instead) */
    private readonly target: UpdateTarget | null = null
  ) {
    super()
  }

  get available(): UpdateInfo | null {
    return this.found
  }

  /** The daily check, if it's on in Settings and due. */
  async checkIfDue() {
    const s = this.settings.get()
    if (!s.preferences.checkForUpdates) return
    const last = s.lastUpdateCheck ? Date.parse(s.lastUpdateCheck) : 0
    if (Date.now() - last < DAY) return
    await this.check()
  }

  async check(): Promise<UpdateCheck> {
    try {
      const res = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Nota/${this.currentVersion}` },
        signal: AbortSignal.timeout(15_000)
      })
      await this.settings.update({ lastUpdateCheck: new Date().toISOString() })
      // No release published yet.
      if (res.status === 404) return this.set(null)
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
      return this.set(newerRelease(await res.json(), this.currentVersion, this.target))
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
  }

  private set(update: UpdateInfo | null): UpdateCheck {
    this.found = update
    this.emit('change', update)
    return update ? { status: 'available', update } : { status: 'current' }
  }
}
