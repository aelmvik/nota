// Creates separation/.venv for development with the bundled uv (a standalone
// Python 3.13 and requirements.txt), then runs a check. Needs `npm run tools:build`
// first; nothing has to be installed on the Mac.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const win = process.platform === 'win32'
const tools = join(root, 'native', 'build', 'tools')
const venv = join(root, 'separation', '.venv')
// As venvPython() and exe() in src/main/platform.ts (not imported: older Node can't load .ts).
const python = win ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')
const uv = join(tools, win ? 'uv.exe' : 'uv')
const run = (cmd, args, env = process.env) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, env })

if (!existsSync(uv)) run('node', ['scripts/build-tools.mjs'])
const env = { ...process.env, UV_PYTHON_PREFERENCE: 'only-managed', NOTA_FFMPEG: join(tools, win ? 'ffmpeg.exe' : 'ffmpeg') }
if (!existsSync(python)) {
  console.log('Creating separation/.venv …')
  run(uv, ['venv', '--python', '3.13', venv], env)
}
run(uv, ['pip', 'install', '--python', python, '-r', join(root, 'separation', 'requirements.txt')], env)
run(python, [join(root, 'separation', 'separate.py'), '--check'], env)
console.log('\nSeparation is ready. The Demucs model (~80 MB) downloads on first use.')
