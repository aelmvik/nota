// Checking for a newer Nøta: the latest release on GitHub against this
// version. The app says a new version is out; clicking it downloads this
// system's file from the release and installs it (main/updateInstaller.ts).

/** Which release file this copy of Nøta updates from */
export type UpdateTarget = 'mac-arm64' | 'windows' | 'linux-deb' | 'linux-appimage'

export interface UpdateAsset {
  name: string
  /** Its download link on GitHub */
  url: string
  /** Bytes */
  size: number
}

export interface UpdateInfo {
  /** "1.2.0" */
  version: string
  /** The release page on GitHub */
  url: string
  /** This system's file in the release; null opens the release page instead */
  asset: UpdateAsset | null
}

/** Downloading and installing an update, as the status bar shows it */
export type UpdateProgress =
  | { status: 'downloading'; progress: number }
  | { status: 'installing' }
  | { status: 'failed'; error: string }
  /** Downloaded and opened for the system to install (a .deb without a password prompt, or a development build) */
  | { status: 'opened' }

const ASSET_PATTERNS: Record<UpdateTarget, RegExp> = {
  'mac-arm64': /-mac-arm64\.zip$/i,
  windows: /Setup-[\d.]+\.exe$/i,
  'linux-deb': /_amd64\.deb$/i,
  'linux-appimage': /\.AppImage$/i
}

/** This system's file among a GitHub release's assets, or null. */
export function pickAsset(assets: unknown, target: UpdateTarget | null): UpdateAsset | null {
  if (!target || !Array.isArray(assets)) return null
  for (const a of assets) {
    if (!a || typeof a !== 'object') continue
    const { name, browser_download_url: url, size } = a as Record<string, unknown>
    if (typeof name !== 'string' || typeof url !== 'string' || !url.startsWith('https://github.com/')) continue
    if (ASSET_PATTERNS[target].test(name)) return { name, url, size: typeof size === 'number' ? size : 0 }
  }
  return null
}

export type UpdateCheck = { status: 'available'; update: UpdateInfo } | { status: 'current' } | { status: 'failed'; error: string }

/** "v1.2.0" or "1.2" as numbers; a pre-release suffix ("-beta.1") is ignored. */
export function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null
}

/** Whether `latest` is a newer version than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/** The newer release in a GitHub "latest release" response, with this system's file, or null. */
export function newerRelease(release: unknown, current: string, target: UpdateTarget | null = null): UpdateInfo | null {
  if (!release || typeof release !== 'object') return null
  const { tag_name: tag, html_url: url, draft, prerelease, assets } = release as Record<string, unknown>
  if (typeof tag !== 'string' || typeof url !== 'string' || draft || prerelease) return null
  if (!url.startsWith('https://github.com/') || !isNewer(tag, current)) return null
  return { version: parseVersion(tag)!.join('.'), url, asset: pickAsset(assets, target) }
}
