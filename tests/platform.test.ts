import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bulkDataDir, defaultVst3Dirs, engineEnv, engineExecutable, torchBackendArgs, exe, findOnDisk, portableRelative, replaceFile, venvPython } from '../src/main/platform'

// macOS answers must stay exactly what the app has always used; the others are for a port.
describe('platform paths', () => {
  it('keeps the macOS paths', () => {
    expect(exe('ffmpeg', 'darwin')).toBe('ffmpeg')
    expect(venvPython('/env', 'darwin')).toBe('/env/bin/python')
    expect(engineExecutable('darwin')).toBe('NotaEngine.app/Contents/MacOS/NotaEngine')
    expect(defaultVst3Dirs('darwin', '/Users/me')).toEqual(['/Library/Audio/Plug-Ins/VST3', '/Users/me/Library/Audio/Plug-Ins/VST3'])
  })

  it('knows the Windows and Linux equivalents', () => {
    expect(exe('uv', 'win32')).toBe('uv.exe')
    expect(venvPython('C:\\env', 'win32')).toBe('C:\\env\\Scripts\\python.exe')
    expect(engineExecutable('win32')).toBe('NotaEngine.exe')
    expect(engineExecutable('linux')).toBe('NotaEngine')
    expect(defaultVst3Dirs('linux', '/home/me')).toContain('/home/me/.vst3')
    expect(defaultVst3Dirs('win32', 'C:\\Users\\me')[0]).toMatch(/VST3$/)
  })

  // Windows: a file another process holds open (a virus scanner, the engine) can't be replaced.
  it.skipIf(process.platform !== 'win32')('replaces a briefly locked file, and gives up on one that stays locked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nota-replace-'))
    const target = join(dir, 'bass.flac')
    writeFileSync(target, 'old')
    const lock = (ms: number) =>
      new Promise<{ child: ChildProcess; exited: Promise<unknown> }>((resolve) => {
        const child = spawn('powershell', ['-NoProfile', '-Command', `$f = [IO.File]::Open('${target}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${ms}; $f.Close()`])
        const exited = new Promise((r) => child.once('exit', r))
        child.stdout!.once('data', () => resolve({ child, exited }))
      })
    const held = await lock(400)
    writeFileSync(`${target}.tmp`, 'new')
    await replaceFile(`${target}.tmp`, target)
    expect(readFileSync(target, 'utf8')).toBe('new')
    await held.exited

    const stuck = await lock(10_000)
    writeFileSync(`${target}.tmp`, 'newer')
    await expect(replaceFile(`${target}.tmp`, target)).rejects.toMatchObject({ code: 'EPERM' })
    expect(existsSync(`${target}.tmp`)).toBe(false)
    stuck.child.kill()
    await stuck.exited
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds a song whose name changed form or was garbled by unzipping', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nota-names-'))
    const stored = 'Tuikkikaa, oi joulun tähtöset.mp3'.normalize('NFD') // as the Mac writes it
    mkdirSync(join(dir, 'nfc'))
    writeFileSync(join(dir, 'nfc', stored.normalize('NFC')), '')
    expect(existsSync(findOnDisk(join(dir, 'nfc', stored)))).toBe(true)
    // Windows' extractor reading the NFD UTF-8 bytes as code page 437.
    const garbled = 'Tuikkikaa, oi joulun ta╠êhto╠êset.mp3'
    mkdirSync(join(dir, 'zip'))
    writeFileSync(join(dir, 'zip', garbled), '')
    expect(findOnDisk(join(dir, 'zip', stored))).toBe(join(dir, 'zip', garbled))
    expect(findOnDisk(join(dir, 'zip', 'other.mp3'))).toBe(join(dir, 'zip', 'other.mp3'))
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the Python environment out of the roaming profile on Windows', () => {
    expect(bulkDataDir('/Users/me/Library/Application Support/Nøta', 'darwin', {})).toBe('/Users/me/Library/Application Support/Nøta')
    expect(bulkDataDir('C:\\Users\\me\\AppData\\Roaming\\Nøta', 'win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' })).toBe('C:\\Users\\me\\AppData\\Local\\Nøta')
    expect(bulkDataDir('D:\\test', 'win32', { LOCALAPPDATA: 'C:\\x', NOTA_USER_DATA: 'D:\\test' })).toBe('D:\\test')
  })

  it('keeps the Python environment in ~/.local/share on Linux, beside the settings in ~/.config', () => {
    expect(bulkDataDir('/home/me/.config/Nøta', 'linux', {}, '/home/me')).toBe('/home/me/.local/share/Nøta')
    expect(bulkDataDir('/home/me/.config/Nøta', 'linux', { XDG_DATA_HOME: '/data' }, '/home/me')).toBe('/data/Nøta')
    expect(bulkDataDir('/tmp/test', 'linux', { NOTA_USER_DATA: '/tmp/test' }, '/home/me')).toBe('/tmp/test')
  })

  it('puts PipeWire’s JACK library first for the engine on Debian-style Linux', () => {
    const dir = '/usr/lib/x86_64-linux-gnu/pipewire-0.3/jack'
    const has = (p: string) => p === `${dir}/libjack.so.0`
    expect(engineEnv('linux', {}, 'x64', has).LD_LIBRARY_PATH).toBe(dir)
    expect(engineEnv('linux', { LD_LIBRARY_PATH: '/opt/lib' }, 'x64', has).LD_LIBRARY_PATH).toBe(`${dir}:/opt/lib`)
    expect(engineEnv('linux', { LD_LIBRARY_PATH: dir }, 'x64', has).LD_LIBRARY_PATH).toBe(dir)
    expect(engineEnv('linux', {}, 'x64', () => false).LD_LIBRARY_PATH).toBeUndefined()
    expect(engineEnv('darwin', {}, 'arm64', () => true).LD_LIBRARY_PATH).toBeUndefined()
  })

  it('installs PyTorch’s CPU build on Linux only', () => {
    expect(torchBackendArgs('linux')).toEqual(['--torch-backend', 'cpu'])
    expect(torchBackendArgs('darwin')).toEqual([])
    expect(torchBackendArgs('win32')).toEqual([])
  })

  it('stores relative paths with forward slashes on every platform', () => {
    const root = join(tmpdir(), 'Set.nota')
    expect(portableRelative(root, join(root, 'Generated', 'abc', 'bass.flac'))).toBe('Generated/abc/bass.flac')
  })
})
