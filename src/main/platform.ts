import { homedir } from 'node:os'
import { existsSync, readdirSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { basename, dirname, join, posix, relative, sep, win32 } from 'node:path'

// Where things live on each platform: macOS and Windows, and Linux for a port
// (see "Linux" in the README).

type Platform = NodeJS.Platform

/** A command-line tool's file name: `ffmpeg` here, `ffmpeg.exe` on Windows. */
export function exe(name: string, platform: Platform = process.platform): string {
  return platform === 'win32' ? `${name}.exe` : name
}

/** The Python interpreter inside a virtual environment. */
export function venvPython(envDir: string, platform: Platform = process.platform): string {
  return platform === 'win32' ? win32.join(envDir, 'Scripts', 'python.exe') : posix.join(envDir, 'bin', 'python')
}

/** The audio engine's executable, relative to the folder its build or the app's resources put it in. */
export function engineExecutable(platform: Platform = process.platform): string {
  if (platform === 'darwin') return posix.join('NotaEngine.app', 'Contents', 'MacOS', 'NotaEngine')
  return exe('NotaEngine', platform)
}

/** A relative path as projects store it: always with `/`, so a project opens on any platform. */
export function portableRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join('/')
}

/**
 * Move a finished temp file over its target. On Windows a virus scanner or the
 * search indexer can hold a just-written file for a moment, so EPERM/EBUSY are
 * retried for a few seconds. (A file the engine has open can't be replaced at
 * all there; the app unloads a song's tracks before rewriting them.)
 */
export async function replaceFile(from: string, to: string, platform: Platform = process.platform): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (platform !== 'win32') throw err
      if (attempt >= 7 || !(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        await rm(from, { force: true }).catch(() => {})
        throw err
      }
      await new Promise((r) => setTimeout(r, 25 * 2 ** attempt))
    }
  }
}

// Code page 437's upper half: what Windows' zip extractor turns UTF-8 name
// bytes into when a zip doesn't flag its names as UTF-8 (macOS's zips don't).
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

/** A file name as it was before a zip extractor read its UTF-8 bytes as code page 437, or null. */
function undoCp437(name: string): string | null {
  const bytes: number[] = []
  for (const ch of name) {
    const code = ch.codePointAt(0)!
    const i = code < 0x80 ? code : CP437.indexOf(ch) + 0x80
    if (i < 0x80 && code >= 0x80) return null
    bytes.push(i)
  }
  const text = Buffer.from(bytes).toString('utf8')
  return text.includes('�') ? null : text
}

/**
 * The file as it is on disk, for a path stored by another computer. macOS
 * writes names decomposed (NFD) and Windows mostly composed (NFC), and NTFS
 * tells them apart; a zip without the UTF-8 flag also arrives garbled. Returns
 * the path unchanged when it exists or nothing in its folder matches.
 */
export function findOnDisk(path: string): string {
  if (existsSync(path)) return path
  const want = basename(path).normalize('NFC')
  try {
    const found = readdirSync(dirname(path)).find((name) => name.normalize('NFC') === want || undoCp437(name)?.normalize('NFC') === want)
    return found ? join(dirname(path), found) : path
  } catch {
    return path
  }
}

/**
 * Where large, re-downloadable data lives (the Python environment, model
 * weights): beside the settings, except on Windows, where the settings folder
 * roams with the user's profile and a gigabyte of PyTorch belongs in the local one.
 */
export function bulkDataDir(userData: string, platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  return platform === 'win32' && env.LOCALAPPDATA && !env.NOTA_USER_DATA ? win32.join(env.LOCALAPPDATA, win32.basename(userData)) : userData
}

/** Where deleted files go, as messages name it. */
export function trashName(platform: Platform = process.platform): string {
  return platform === 'win32' ? 'Recycle Bin' : 'Trash'
}

/** The user's computer, as messages name it. */
export function computerName(platform: Platform = process.platform): string {
  return platform === 'darwin' ? 'your Mac' : 'this computer'
}

/**
 * uv's PyTorch index. PyPI's Linux PyTorch brings NVIDIA's CUDA libraries
 * (about 2.5 GB), so Linux gets the CPU build; the Mac's and Windows' PyPI
 * builds are the right ones already (Apple's GPU on the Mac, CPU on Windows).
 */
export function torchBackendArgs(platform: Platform = process.platform): string[] {
  return platform === 'linux' ? ['--torch-backend', 'cpu'] : []
}

/** The standard VST3 plugin folders. */
export function defaultVst3Dirs(platform: Platform = process.platform, home = homedir()): string[] {
  if (platform === 'darwin') return ['/Library/Audio/Plug-Ins/VST3', `${home}/Library/Audio/Plug-Ins/VST3`]
  if (platform === 'win32') return [win32.join(process.env.CommonProgramFiles ?? 'C:\\Program Files\\Common Files', 'VST3')]
  return ['/usr/lib/vst3', '/usr/local/lib/vst3', `${home}/.vst3`]
}

/**
 * The audio engine's environment. Debian and Ubuntu keep PipeWire's JACK
 * library out of the default path (`pw-jack` adds it), and the JACK library
 * there needs a running jackd: put PipeWire's first, so JACK works on a
 * PipeWire desktop. Elsewhere, and without pipewire-jack, nothing changes.
 */
export function engineEnv(
  platform: Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  arch: string = process.arch,
  exists: (path: string) => boolean = existsSync
): NodeJS.ProcessEnv {
  if (platform !== 'linux') return env
  const triplet = { x64: 'x86_64-linux-gnu', arm64: 'aarch64-linux-gnu' }[arch]
  const dir = triplet && posix.join('/usr/lib', triplet, 'pipewire-0.3', 'jack')
  if (!dir || !exists(posix.join(dir, 'libjack.so.0'))) return env
  const current = env.LD_LIBRARY_PATH?.split(':').filter(Boolean) ?? []
  if (current.includes(dir)) return env
  return { ...env, LD_LIBRARY_PATH: [dir, ...current].join(':') }
}
