// Checking for a newer Nøta: the latest release on GitHub against this
// version. Nothing is downloaded or installed; the app says a new version is
// out and opens its release page.

export interface UpdateInfo {
  /** "1.2.0" */
  version: string
  /** The release page on GitHub */
  url: string
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

/** The newer release in a GitHub "latest release" response, or null. */
export function newerRelease(release: unknown, current: string): UpdateInfo | null {
  if (!release || typeof release !== 'object') return null
  const { tag_name: tag, html_url: url, draft, prerelease } = release as Record<string, unknown>
  if (typeof tag !== 'string' || typeof url !== 'string' || draft || prerelease) return null
  if (!url.startsWith('https://github.com/') || !isNewer(tag, current)) return null
  return { version: parseVersion(tag)!.join('.'), url }
}
