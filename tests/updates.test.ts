import { describe, expect, it } from 'vitest'
import { isNewer, newerRelease, parseVersion } from '../src/shared/updates'

describe('update check', () => {
  it('compares versions as numbers', () => {
    expect(parseVersion('v1.10.2')).toEqual([1, 10, 2])
    expect(parseVersion('2.0')).toEqual([2, 0, 0])
    expect(isNewer('1.10.0', '1.9.3')).toBe(true)
    expect(isNewer('v1.0.1', '1.0.0')).toBe(true)
    expect(isNewer('1.0.0', '1.0.0')).toBe(false)
    expect(isNewer('0.9.9', '1.0.0')).toBe(false)
    expect(isNewer('nightly', '1.0.0')).toBe(false)
  })

  it('takes only a published, newer release on GitHub', () => {
    const release = { tag_name: 'v1.1.0', html_url: 'https://github.com/owner/nota/releases/tag/v1.1.0', draft: false, prerelease: false }
    expect(newerRelease(release, '1.0.0')).toEqual({ version: '1.1.0', url: release.html_url })
    expect(newerRelease(release, '1.1.0')).toBeNull()
    expect(newerRelease({ ...release, prerelease: true }, '1.0.0')).toBeNull()
    expect(newerRelease({ ...release, html_url: 'https://example.com/nota' }, '1.0.0')).toBeNull()
    expect(newerRelease(null, '1.0.0')).toBeNull()
  })
})
