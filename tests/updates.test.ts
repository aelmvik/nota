import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isNewer, newerRelease, parseVersion, pickAsset } from '../src/shared/updates'
import { downloadAsset, updateTarget } from '../src/main/updateInstaller'

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
    // The checksum GitHub lists comes along, if it is one.
    const digest = `sha256:${'AB'.repeat(32)}`
    expect(pickAsset([{ ...asset('Nota-Setup-1.1.0.exe'), digest }], 'windows')?.digest).toBe(digest.toLowerCase())
    expect(pickAsset([{ ...asset('Nota-Setup-1.1.0.exe'), digest: 'md5:1234' }], 'windows')).not.toHaveProperty('digest')
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

describe('update download', () => {
  const body = Buffer.from('not really an installer, but long enough to be worth hashing')
  const sha = `sha256:${createHash('sha256').update(body).digest('hex')}`
  const asset = (over: Record<string, unknown> = {}) => ({ name: 'Nota-Setup-9.9.9.exe', url: 'https://github.com/owner/nota/releases/download/v9.9.9/Nota-Setup-9.9.9.exe', size: body.length, ...over })
  const serve = () => vi.stubGlobal('fetch', async () => new Response(body, { headers: { 'content-length': String(body.length) } }))
  afterEach(() => vi.unstubAllGlobals())

  it('saves the file and reports progress', async () => {
    serve()
    const progress: number[] = []
    const file = await downloadAsset(asset({ digest: sha }), 'Nota/test', (p) => progress.push(p))
    expect(readFileSync(file)).toEqual(body)
    expect(progress.at(-1)).toBe(1)
    rmSync(dirname(file), { recursive: true, force: true })
  })

  it('refuses a download that doesn’t match the release’s checksum, and removes it', async () => {
    serve()
    const folders = () => readdirSync(tmpdir()).filter((n) => n.startsWith('nota-update-')).sort()
    const before = folders()
    await expect(downloadAsset(asset({ digest: `sha256:${'0'.repeat(64)}` }), 'Nota/test', () => {})).rejects.toThrow(/doesn’t match/)
    expect(folders()).toEqual(before)
  })

  it('fails as an error, not a crash, when the file can’t be written', async () => {
    serve()
    // A name too long for any file system: the write stream fails when it opens.
    await expect(downloadAsset(asset({ name: `${'x'.repeat(400)}.exe` }), 'Nota/test', () => {})).rejects.toThrow()
  })
})
