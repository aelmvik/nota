import { execFile, spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, copyFile, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { UpdateAsset, UpdateTarget } from '../shared/updates'

// Downloads this system's file from a newer release and installs it, so an
// update is one click in the status bar:
//   Mac             unpacks the zip and swaps it in for the running app, then restarts.
//                   (Downloaded by Nøta itself, it carries no quarantine mark, so macOS
//                   doesn't call it damaged.)
//   Windows         runs the installer; Nøta quits so it can be replaced.
//   Linux AppImage  replaces the AppImage file and starts the new one.
//   Linux .deb      installs it through the system's password prompt (pkexec), then
//                   restarts; without pkexec, opens it for Software to install.
// A development build only downloads the file and shows it.

const run = promisify(execFile)

/** Which release file this copy updates from, or null when it can't update itself. */
export function updateTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch, env: NodeJS.ProcessEnv = process.env): UpdateTarget | null {
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : null
  if (platform === 'win32') return arch === 'x64' || arch === 'arm64' ? 'windows' : null
  if (platform === 'linux' && arch === 'x64') return env.APPIMAGE ? 'linux-appimage' : 'linux-deb'
  return null
}

/** Downloads the asset into a new temporary folder; `onProgress` hears 0..1. Returns the file. */
export async function downloadAsset(asset: UpdateAsset, userAgent: string, onProgress: (progress: number) => void): Promise<string> {
  const res = await fetch(asset.url, { headers: { 'User-Agent': userAgent }, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`The download failed (GitHub answered ${res.status})`)
  const total = Number(res.headers.get('content-length')) || asset.size
  const file = join(await mkdtemp(join(tmpdir(), 'nota-update-')), basename(asset.name))
  const out = createWriteStream(file)
  let received = 0
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
      received += chunk.byteLength
      if (total > 0) onProgress(Math.min(1, received / total))
    }
  } finally {
    await new Promise<void>((r) => out.end(r))
  }
  if (total > 0 && received < total) throw new Error('The download was cut short')
  return file
}

/** What happens next: the app restarts or quits to finish, or the file was opened for the system to install. */
export type InstallOutcome = 'restart' | 'quit' | 'opened'

export async function installUpdate(file: string, target: UpdateTarget, packaged: boolean, open: (path: string) => void): Promise<InstallOutcome> {
  if (!packaged) {
    open(file)
    return 'opened'
  }
  if (target === 'mac-arm64') return installMac(file)
  if (target === 'windows') {
    spawn(file, [], { detached: true, stdio: 'ignore' }).unref()
    return 'quit'
  }
  if (target === 'linux-appimage') {
    const current = process.env.APPIMAGE!
    const next = `${current}.new`
    await copyFile(file, next)
    await chmod(next, 0o755)
    await rename(next, current)
    spawn(current, [], { detached: true, stdio: 'ignore' }).unref()
    return 'quit'
  }
  // .deb: the system's password prompt, then a restart; or Software, if there's no prompt to be had.
  const pkexec = ['/usr/bin/pkexec', '/bin/pkexec'].find((p) => existsSync(p))
  if (pkexec) {
    try {
      await run(pkexec, ['apt-get', 'install', '-y', file])
      return 'restart'
    } catch {
      // cancelled, or apt refused: let Software try
    }
  }
  open(file)
  return 'opened'
}

/** Swaps the running Nøta.app for the one in the zip (beside it, so it's a rename on the same disk). */
async function installMac(zip: string): Promise<InstallOutcome> {
  const bundle = resolve(process.execPath, '..', '..', '..')
  if (!bundle.endsWith('.app')) throw new Error('Nøta isn’t running from an app bundle')
  const staging = await mkdtemp(join(dirname(bundle), '.nota-update-'))
  try {
    await run('ditto', ['-x', '-k', zip, staging])
    const name = (await readdir(staging)).find((n) => n.endsWith('.app'))
    if (!name) throw new Error('The download has no app in it')
    const old = join(staging, 'previous.app')
    await rename(bundle, old)
    try {
      await rename(join(staging, name), bundle)
    } catch (err) {
      await rename(old, bundle)
      throw err
    }
    await run('xattr', ['-dr', 'com.apple.quarantine', bundle]).catch(() => {})
    return 'restart'
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
