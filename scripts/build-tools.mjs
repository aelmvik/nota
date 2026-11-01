// Builds the command-line tools bundled in the app, so users need neither
// Homebrew nor a Python install (native/build/tools):
//
//   ffmpeg, ffprobe  FFmpeg built from source, audio only and LGPL: decoding
//                    for import, separation and waveforms, FLAC/WAV/MP3 export
//                    (MP3 through LAME, also built from source)
//   uv               Astral's Python manager (a pinned release, checksum
//                    verified). It installs a standalone Python and the
//                    separation packages on first use.
//
// Sources go into native/third_party; each tool is only rebuilt when missing.
// On Windows the same FFmpeg and LAME are built in MSYS2 (buildWindowsTools at
// the end); uv is a pinned, checksummed release. On Linux they're built with the
// system's GCC, as on the Mac (x64 and arm64).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const thirdParty = join(root, 'native', 'third_party')
const out = join(root, 'native', 'build', 'tools')
const jobs = String(cpus().length)
const MACOS_MIN = '11.0' // same as the audio engine

const FFMPEG = { tag: 'n8.1.3', url: 'https://github.com/FFmpeg/FFmpeg.git' }
const LAME = {
  version: '3.100',
  url: 'https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz',
  sha256: 'ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e'
}
const UV = {
  version: '0.12.19',
  url: 'https://github.com/astral-sh/uv/releases/download/0.12.19/uv-aarch64-apple-darwin.tar.gz',
  sha256: 'a9a8df1eedeb192f2e47e40e2faabfb387db4b850209118786d42f89dde3e0ba'
}

// What FFmpeg is built with, on every platform: audio only, LGPL 2.1, LAME linked in.
const list = (...names) => names.join(',')
const FFMPEG_AUDIO_ONLY = [
  '--enable-static',
  '--disable-shared',
  '--disable-doc',
  '--disable-debug',
  '--disable-network',
  '--disable-autodetect',
  '--disable-everything',
  '--disable-avdevice',
  '--disable-swscale',
  '--disable-ffplay',
  '--enable-ffmpeg',
  '--enable-ffprobe',
  '--enable-libmp3lame',
  '--enable-protocol=fd,file,pipe',
  `--enable-demuxer=${list('aac', 'ac3', 'aiff', 'ape', 'asf', 'au', 'caf', 'dts', 'eac3', 'flac', 'matroska', 'mov', 'mp3', 'mpc', 'mpc8', 'ogg', 'pcm_*', 'tta', 'w64', 'wav', 'wv')}`,
  `--enable-decoder=${list('aac', 'aac_latm', 'ac3', 'adpcm_ima_wav', 'adpcm_ms', 'alac', 'ape', 'dca', 'eac3', 'flac', 'mp1', 'mp1float', 'mp2', 'mp2float', 'mp3', 'mp3float', 'mpc7', 'mpc8', 'opus', 'pcm_*', 'tta', 'vorbis', 'wavpack', 'wmalossless', 'wmapro', 'wmav1', 'wmav2')}`,
  `--enable-parser=${list('aac', 'aac_latm', 'ac3', 'dca', 'flac', 'mpegaudio', 'opus', 'vorbis')}`,
  `--enable-encoder=${list('flac', 'libmp3lame', 'pcm_f32le', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le')}`,
  `--enable-muxer=${list('flac', 'mp3', 'null', 'pcm_f32le', 'wav')}`,
  `--enable-filter=${list('abuffer', 'abuffersink', 'aformat', 'anull', 'aresample')}`
]

// Windows (x64): FFmpeg and LAME are built the same way inside MSYS2's UCRT64
// environment (MinGW-w64 GCC); uv is a prebuilt release.
const MSYS2_PACKAGES = ['make', 'diffutils', 'mingw-w64-ucrt-x86_64-gcc', 'mingw-w64-ucrt-x86_64-nasm', 'mingw-w64-ucrt-x86_64-pkgconf']
// Linux: uv's glibc builds, for the machine's architecture.
const UV_LINUX = {
  x64: { url: `https://github.com/astral-sh/uv/releases/download/${UV.version}/uv-x86_64-unknown-linux-gnu.tar.gz`, sha256: '23bf5552d220e0842b65c862097b2ebaeba0064b74eda5e565e77fd25969d8c8' },
  arm64: { url: `https://github.com/astral-sh/uv/releases/download/${UV.version}/uv-aarch64-unknown-linux-gnu.tar.gz`, sha256: '0804e9b164c64b6914182d5920c08551958a095986f10a3731056df701126436' }
}
const UV_WIN = {
  url: `https://github.com/astral-sh/uv/releases/download/${UV.version}/uv-x86_64-pc-windows-msvc.zip`,
  sha256: '6dbb02d79e419522f1c500f0adb1cddcff0cda7d59b0d66ea7f5e3b4a1b2f5f0'
}

const run = (cmd, args, cwd = root, env = process.env) => execFileSync(cmd, args, { stdio: 'inherit', cwd, env })

function download(url, file, sha256) {
  if (!existsSync(file)) run('curl', ['--fail', '--location', '--silent', '--show-error', '-o', file, url])
  const got = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (got !== sha256) {
    rmSync(file)
    throw new Error(`Checksum mismatch for ${url}: got ${got}`)
  }
}

if (process.platform === 'win32') {
  buildWindowsTools()
  process.exit(0)
}

const linux = process.platform === 'linux'
if (linux && !UV_LINUX[process.arch]) throw new Error(`Linux builds are for x64 and arm64, not ${process.arch}`)
// FFmpeg's x86 assembly needs NASM (as on Windows); arm64 assembly needs nothing extra.
if (linux && process.arch === 'x64') {
  try {
    execFileSync('nasm', ['-v'], { stdio: 'ignore' })
  } catch {
    throw new Error('Building FFmpeg needs NASM: sudo apt install nasm (or your distribution\'s package)')
  }
}

mkdirSync(thirdParty, { recursive: true })
mkdirSync(out, { recursive: true })
const cflags = linux ? '-O2' : `-arch arm64 -mmacosx-version-min=${MACOS_MIN} -O2`

// ---- LAME (static library for FFmpeg's MP3 encoder) ----
const lameSrc = join(thirdParty, `lame-${LAME.version}`)
const lamePrefix = join(thirdParty, 'lame-install')
if (!existsSync(join(lamePrefix, 'lib', 'libmp3lame.a'))) {
  const tgz = join(thirdParty, `lame-${LAME.version}.tar.gz`)
  console.log(`Fetching LAME ${LAME.version} …`)
  download(LAME.url, tgz, LAME.sha256)
  rmSync(lameSrc, { recursive: true, force: true })
  run('tar', ['-xzf', tgz, '-C', thirdParty])
  // 3.100 lists a symbol it no longer defines; the exports file breaks linking on macOS.
  // (GNU sed on Linux takes -i without a suffix.)
  const sym = join(lameSrc, 'include', 'libmp3lame.sym')
  execFileSync('sed', linux ? ['-i', '/lame_init_old/d', sym] : ['-i', '', '/lame_init_old/d', sym])
  const env = { ...process.env, CFLAGS: cflags }
  const host = linux ? [] : ['--host=aarch64-apple-darwin']
  run('./configure', ['--prefix', lamePrefix, ...host, '--disable-shared', '--enable-static', '--disable-frontend', '--disable-decoder', '--disable-dependency-tracking'], lameSrc, env)
  run('make', ['-j', jobs], lameSrc, env)
  run('make', ['install'], lameSrc, env)
}

// ---- FFmpeg (audio only, LGPL) ----
const ffSrc = join(thirdParty, 'ffmpeg')
if (!existsSync(join(out, 'ffmpeg')) || !existsSync(join(out, 'ffprobe'))) {
  if (!existsSync(join(ffSrc, 'configure'))) {
    console.log(`Fetching FFmpeg ${FFMPEG.tag} …`)
    run('git', ['clone', '--depth', '1', '--branch', FFMPEG.tag, FFMPEG.url, ffSrc])
  }
  run(
    './configure',
    [
      ...(linux ? ['--cc=gcc'] : ['--arch=arm64', '--cc=clang']),
      `--extra-cflags=${cflags} -I${join(lamePrefix, 'include')}`,
      `--extra-ldflags=${linux ? '' : `-arch arm64 -mmacosx-version-min=${MACOS_MIN} `}-L${join(lamePrefix, 'lib')}`,
      ...FFMPEG_AUDIO_ONLY
    ],
    ffSrc
  )
  run('make', ['-j', jobs], ffSrc)
  for (const tool of ['ffmpeg', 'ffprobe']) copyFileSync(join(ffSrc, tool), join(out, tool))
  copyFileSync(join(ffSrc, 'COPYING.LGPLv2.1'), join(out, 'FFmpeg-COPYING.LGPLv2.1.txt'))
  copyFileSync(join(lameSrc, 'COPYING'), join(out, 'LAME-COPYING.txt'))
}

// ---- uv ----
if (!existsSync(join(out, 'uv'))) {
  const tgz = join(thirdParty, `uv-${UV.version}.tar.gz`)
  console.log(`Fetching uv ${UV.version} …`)
  const release = linux ? UV_LINUX[process.arch] : UV
  download(release.url, tgz, release.sha256)
  const dir = join(thirdParty, `uv-${UV.version}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir)
  run('tar', ['-xzf', tgz, '-C', dir, '--strip-components', '1'])
  copyFileSync(join(dir, 'uv'), join(out, 'uv'))
}
// The release archive has no licence files; take them from the same tag.
for (const name of ['LICENSE-MIT', 'LICENSE-APACHE']) {
  const file = join(out, `uv-${name}.txt`)
  if (!existsSync(file)) run('curl', ['--fail', '--location', '--silent', '--show-error', '-o', file, `https://raw.githubusercontent.com/astral-sh/uv/${UV.version}/${name}`])
}

console.log(`\nTools built: ${out.slice(root.length + 1)} (ffmpeg, ffprobe, uv)`)

// ---- Windows: the same tools as .exe. FFmpeg and LAME are built in MSYS2 ----
function buildWindowsTools() {
  mkdirSync(thirdParty, { recursive: true })
  mkdirSync(out, { recursive: true })
  // Windows' own bsdtar reads zip archives (Git's GNU tar, if first on PATH, doesn't).
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  const unpack = (archive, dir, ...args) => {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir)
    run(tar, ['-xf', archive, '-C', dir, ...args])
  }

  if (!existsSync(join(out, 'ffmpeg.exe')) || !existsSync(join(out, 'ffprobe.exe'))) {
    // MSYS2's UCRT64 shell: a login shell started in `cwd`, with MinGW-w64 GCC first on PATH.
    const msysRoot = process.env.MSYS2_ROOT ?? 'C:\\msys64'
    const bash = join(msysRoot, 'usr', 'bin', 'bash.exe')
    const install = `pacman -S --needed ${MSYS2_PACKAGES.join(' ')}`
    if (!existsSync(bash))
      throw new Error(`Building FFmpeg on Windows needs MSYS2 (${bash} not found). Install it with "winget install MSYS2.MSYS2" (or set MSYS2_ROOT), then run in its shell: ${install}`)
    const msys = (cmd, cwd = root) => execFileSync(bash, ['-lc', cmd], { stdio: 'inherit', cwd, env: { ...process.env, MSYSTEM: 'UCRT64', CHERE_INVOKING: '1' } })
    try {
      execFileSync(bash, ['-lc', `pacman -Q ${MSYS2_PACKAGES.join(' ')}`], { stdio: 'ignore', env: { ...process.env, MSYSTEM: 'UCRT64' } })
    } catch {
      throw new Error(`MSYS2 is missing build tools. In an MSYS2 shell, run: ${install}`)
    }
    const posixPath = (p) => p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/')
    const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`

    // LAME, static, for FFmpeg's MP3 encoder (the same pinned source as the Mac's).
    const lameSrc = join(thirdParty, `lame-${LAME.version}`)
    const lamePrefix = join(thirdParty, 'lame-install')
    if (!existsSync(join(lamePrefix, 'lib', 'libmp3lame.a'))) {
      const tgz = join(thirdParty, `lame-${LAME.version}.tar.gz`)
      console.log(`Fetching LAME ${LAME.version} …`)
      download(LAME.url, tgz, LAME.sha256)
      rmSync(lameSrc, { recursive: true, force: true })
      run(tar, ['-xzf', tgz, '-C', thirdParty])
      // 3.100 lists a symbol it no longer defines (as on the Mac).
      msys(`sed -i '/lame_init_old/d' include/libmp3lame.sym`, lameSrc)
      msys(`./configure --prefix=${q(posixPath(lamePrefix))} --host=x86_64-w64-mingw32 --disable-shared --enable-static --disable-frontend --disable-decoder --disable-dependency-tracking CFLAGS=-O2`, lameSrc)
      msys(`make -j${jobs} && make install`, lameSrc)
    }

    // FFmpeg: the same pinned tag and feature list as the Mac, linked statically
    // (-static), so the .exe needs nothing beyond Windows' own DLLs.
    const ffSrc = join(thirdParty, 'ffmpeg')
    if (!existsSync(join(ffSrc, 'configure'))) {
      console.log(`Fetching FFmpeg ${FFMPEG.tag} …`)
      // LF line endings: configure is a shell script.
      run('git', ['-c', 'core.autocrlf=false', 'clone', '--depth', '1', '--branch', FFMPEG.tag, FFMPEG.url, ffSrc])
    }
    const configure = [
      '--arch=x86_64',
      '--target-os=mingw32',
      '--cc=gcc',
      `--extra-cflags=-O2 -I${posixPath(join(lamePrefix, 'include'))}`,
      `--extra-ldflags=-static -L${posixPath(join(lamePrefix, 'lib'))}`,
      ...FFMPEG_AUDIO_ONLY
    ]
    msys(`./configure ${configure.map(q).join(' ')}`, ffSrc)
    msys(`make -j${jobs}`, ffSrc)
    for (const tool of ['ffmpeg.exe', 'ffprobe.exe']) copyFileSync(join(ffSrc, tool), join(out, tool))
    copyFileSync(join(ffSrc, 'COPYING.LGPLv2.1'), join(out, 'FFmpeg-COPYING.LGPLv2.1.txt'))
    copyFileSync(join(lameSrc, 'COPYING'), join(out, 'LAME-COPYING.txt'))
  }

  if (!existsSync(join(out, 'uv.exe'))) {
    const zip = join(thirdParty, `uv-${UV.version}-windows.zip`)
    console.log(`Fetching uv ${UV.version} …`)
    download(UV_WIN.url, zip, UV_WIN.sha256)
    const dir = join(thirdParty, `uv-${UV.version}-windows`)
    unpack(zip, dir)
    copyFileSync(join(dir, 'uv.exe'), join(out, 'uv.exe'))
  }
  for (const name of ['LICENSE-MIT', 'LICENSE-APACHE']) {
    const file = join(out, `uv-${name}.txt`)
    if (!existsSync(file)) run('curl', ['--fail', '--location', '--silent', '--show-error', '-o', file, `https://raw.githubusercontent.com/astral-sh/uv/${UV.version}/${name}`])
  }

  // Microsoft's C++ runtime, for PyTorch and other Python packages: a clean Windows
  // doesn't have it, and installing the Visual C++ Redistributable needs admin rights.
  // Microsoft allows shipping these DLLs with an app; the Python workers load them
  // from here (NOTA_VCRUNTIME, set by the app).
  const vcDir = join(out, 'vcruntime')
  if (!existsSync(join(vcDir, 'msvcp140.dll'))) {
    const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
    const crt = execFileSync(vswhere, ['-latest', '-products', '*', '-find', 'VC\\Redist\\MSVC\\*\\x64\\Microsoft.VC143.CRT'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean)
      .sort()
      .pop()
    if (!crt) throw new Error('The Visual C++ runtime DLLs were not found. Install the Visual Studio Build Tools with the C++ workload.')
    mkdirSync(vcDir, { recursive: true })
    for (const dll of readdirSync(crt).filter((f) => f.endsWith('.dll'))) copyFileSync(join(crt, dll), join(vcDir, dll))
  }

  console.log(`\nTools built: ${out.slice(root.length + 1)} (ffmpeg.exe, ffprobe.exe, uv.exe, vcruntime)`)
}
