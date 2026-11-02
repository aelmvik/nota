import { describe, expect, it } from 'vitest'
import { isNewer, newerRelease, parseVersion, pickAsset } from '../src/shared/updates'
import { updateTarget } from '../src/main/updateInstaller'

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
    expect(newerRelease(release, '1.0.0')).toEqual({ version: '1.1.0', url: release.html_url, asset: null })
    expect(newerRelease(release, '1.1.0')).toBeNull()
    expect(newerRelease({ ...release, prerelease: true }, '1.0.0')).toBeNull()
    expect(newerRelease({ ...release, html_url: 'https://example.com/nota' }, '1.0.0')).toBeNull()
    expect(newerRelease(null, '1.0.0')).toBeNull()
  })

  it('picks this system’s file from the release', () => {
    const asset = (name: string) => ({ name, browser_download_url: `https://github.com/owner/nota/releases/download/v1.1.0/${name}`, size: 100 })
    const assets = ['Nota-1.1.0-mac-arm64.zip', 'Nota-Setup-1.1.0.exe', 'nota_1.1.0_amd64.deb', 'Nota-1.1.0-x86_64.AppImage', 'ffmpeg-8.1.3-source.tar.gz'].map(asset)
    expect(pickAsset(assets, 'mac-arm64')?.name).toBe('Nota-1.1.0-mac-arm64.zip')
    expect(pickAsset(assets, 'windows')?.name).toBe('Nota-Setup-1.1.0.exe')
    expect(pickAsset(assets, 'linux-deb')?.name).toBe('nota_1.1.0_amd64.deb')
    expect(pickAsset(assets, 'linux-appimage')?.name).toBe('Nota-1.1.0-x86_64.AppImage')
    expect(pickAsset(assets, null)).toBeNull()
    // Only from GitHub.
    expect(pickAsset([{ ...asset('Nota-Setup-1.1.0.exe'), browser_download_url: 'https://example.com/Nota-Setup-1.1.0.exe' }], 'windows')).toBeNull()
    const release = { tag_name: 'v1.1.0', html_url: 'https://github.com/owner/nota/releases/tag/v1.1.0', assets }
    expect(newerRelease(release, '1.0.0', 'windows')?.asset?.url).toBe(assets[1].browser_download_url)
  })

  it('knows which file this copy updates from', () => {
    expect(updateTarget('darwin', 'arm64', {})).toBe('mac-arm64')
    expect(updateTarget('darwin', 'x64', {})).toBeNull()
    expect(updateTarget('win32', 'x64', {})).toBe('windows')
    expect(updateTarget('linux', 'x64', {})).toBe('linux-deb')
    expect(updateTarget('linux', 'x64', { APPIMAGE: '/home/me/Nota.AppImage' })).toBe('linux-appimage')
    expect(updateTarget('linux', 'arm64', {})).toBeNull()
  })
})
