// Builds dist/mac-arm64/Nøta.app: compiles the app, makes sure the native
// engine and the bundled tools exist, packages with electron-builder and signs ad hoc (Apple
// Silicon refuses to run unsigned code). For distribution to other Macs,
// sign with a Developer ID and notarize instead. On Windows it builds an
// installer instead, and on Linux an AppImage and a .deb (see below).
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// NOTA_OUT=dist-next builds beside a copy that is currently running.
const out = process.env.NOTA_OUT || 'dist'
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root })

// Windows: dist/Nøta Setup <version>.exe, an NSIS installer for x64. Not signed,
// so SmartScreen warns on first run.
if (process.platform === 'win32') {
  // npx is a .cmd script there, which only runs through a shell.
  const npx = (args) => execFileSync('npx', args, { stdio: 'inherit', cwd: root, shell: true })
  if (!existsSync(join(root, 'native/build/NotaEngine_artefacts/Release/NotaEngine.exe'))) run('node', ['scripts/build-engine.mjs'])
  run('node', ['scripts/build-tools.mjs'])
  if (!existsSync(join(root, 'build/icon.ico'))) npx(['electron', 'scripts/render-icon.cjs'])
  npx(['electron-vite', 'build'])
  // Never publish: on CI electron-builder would otherwise try to upload a GitHub release.
  npx(['electron-builder', '--win', '--x64', '--publish', 'never', `-c.directories.output=${out}`])
  const installer = readdirSync(join(root, out)).find((f) => f.endsWith('.exe') && f.includes('Setup'))
  console.log(`\nBuilt ${join(root, out, installer)}`)
  process.exit(0)
}

// Linux: dist/Nøta-<version>.AppImage and dist/nota_<version>_amd64.deb, for x64.
// They run on systems with the glibc they were built against or newer.
if (process.platform === 'linux') {
  if (!existsSync(join(root, 'native/build/NotaEngine_artefacts/Release/NotaEngine'))) run('node', ['scripts/build-engine.mjs'])
  run('node', ['scripts/build-tools.mjs'])
  if (!existsSync(join(root, 'build/icons/512x512.png'))) run('npx', ['electron', 'scripts/render-icon.cjs'])
  run('npx', ['electron-vite', 'build'])
  run('npx', ['electron-builder', '--linux', '--x64', '--publish', 'never', `-c.directories.output=${out}`])
  for (const f of readdirSync(join(root, out)).filter((f) => f.endsWith('.AppImage') || f.endsWith('.deb'))) console.log(`Built ${join(root, out, f)}`)
  process.exit(0)
}

if (!existsSync(join(root, 'native/build/NotaEngine_artefacts/Release/NotaEngine.app'))) run('node', ['scripts/build-engine.mjs'])
// ffmpeg, ffprobe and uv (the script skips what's already built)
run('node', ['scripts/build-tools.mjs'])
if (!existsSync(join(root, 'build/icon.icns'))) run('npx', ['electron', 'scripts/render-icon.cjs'])
run('npx', ['electron-vite', 'build'])
run('npx', ['electron-builder', '--mac', '--arm64', '--dir', '--publish', 'never', `-c.directories.output=${out}`])

const app = join(root, out, 'mac-arm64/Nøta.app')
run('codesign', ['--force', '--deep', '--sign', '-', app])
run('codesign', ['--verify', '--deep', '--strict', app])
console.log(`\nBuilt ${app}`)
