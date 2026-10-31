// Configures and builds the native JUCE audio engine (native/ -> native/build).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { cpus } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nativeDir = join(root, 'native')
const buildDir = join(nativeDir, 'build')
const juceDir = join(nativeDir, 'third_party', 'JUCE')

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root })

// Pinned sources, cloned once into native/third_party.
const deps = [
  // Windows: shared-mode WASAPI devices open in a fraction of a second instead of 2–7 s.
  { name: 'JUCE', tag: '8.0.4', url: 'https://github.com/juce-framework/JUCE.git', dir: juceDir, patches: process.platform === 'win32' ? ['juce-wasapi-shared-channels.patch'] : [] },
  // Time stretch and key change (MIT), and the FFT library it uses.
  { name: 'Signalsmith Stretch', tag: '1.4.0', url: 'https://github.com/Signalsmith-Audio/signalsmith-stretch.git', dir: join(nativeDir, 'third_party', 'signalsmith-stretch'), patches: ['signalsmith-stretch-pitch-accuracy.patch'] },
  { name: 'Signalsmith Linear', tag: '0.6.4', url: 'https://github.com/Signalsmith-Audio/linear.git', dir: join(nativeDir, 'third_party', 'signalsmith-linear') }
]
for (const dep of deps) {
  if (existsSync(join(dep.dir, 'CMakeLists.txt'))) continue
  console.log(`Fetching ${dep.name} ${dep.tag} into ${dep.dir.slice(root.length + 1)} …`)
  // Keep LF line endings (Git for Windows converts by default), so the patches apply.
  run('git', ['-c', 'core.autocrlf=false', 'clone', '--depth', '1', '--branch', dep.tag, dep.url, dep.dir])
}

// Local fixes on top of the pinned sources (native/patches), applied once.
const quiet = (cmd, args, cwd) => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', cwd })
    return true
  } catch {
    return false
  }
}
for (const dep of deps) {
  for (const name of dep.patches ?? []) {
    const patch = join(nativeDir, 'patches', name)
    if (quiet('git', ['apply', '--reverse', '--check', patch], dep.dir)) continue
    console.log(`Applying ${name} …`)
    execFileSync('git', ['apply', patch], { stdio: 'inherit', cwd: dep.dir })
  }
}

// Windows ships x64 (also when built on an ARM machine); Visual Studio picks the architecture with -A.
const arch = process.platform === 'win32' ? ['-A', 'x64'] : []
// Windows: Steinberg's ASIO SDK for low-latency audio interfaces, used under its
// GPLv3 option (see THIRD_PARTY_NOTICES.md). Pinned by checksum.
const ASIO_SDK = {
  url: 'https://download.steinberg.net/sdk_downloads/ASIO-SDK_2.3.4_2025-10-15.zip',
  sha256: 'd5ebf0c20dd2c5f43771fd0c1418f4b361bf52434ee670097cfa6b3a335e2eca',
  dir: join(nativeDir, 'third_party', 'asiosdk')
}
const asio = []
if (process.platform === 'win32') {
  const sdk = join(ASIO_SDK.dir, 'ASIOSDK')
  if (!existsSync(join(sdk, 'common', 'iasiodrv.h'))) {
    console.log('Fetching the ASIO SDK …')
    rmSync(ASIO_SDK.dir, { recursive: true, force: true })
    mkdirSync(ASIO_SDK.dir, { recursive: true })
    const zip = join(ASIO_SDK.dir, 'asiosdk.zip')
    run('curl', ['--fail', '--location', '--silent', '--show-error', '-o', zip, ASIO_SDK.url])
    const got = createHash('sha256').update(readFileSync(zip)).digest('hex')
    if (got !== ASIO_SDK.sha256) throw new Error(`ASIO SDK checksum mismatch: got ${got}`)
    // Windows' own bsdtar reads zip archives.
    run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', ASIO_SDK.dir])
  }
  asio.push(`-DNOTA_ASIO_SDK=${sdk.replace(/\\/g, '/')}`)
}

run('cmake', ['-S', nativeDir, '-B', buildDir, '-DCMAKE_BUILD_TYPE=Release', ...arch, ...asio])
run('cmake', ['--build', buildDir, '--config', 'Release', '--parallel', String(cpus().length)])
const product = { darwin: 'NotaEngine.app', win32: 'NotaEngine.exe' }[process.platform] ?? 'NotaEngine'
console.log(`\nEngine built: native/build/NotaEngine_artefacts/Release/${product}`)
