// Writes the data for the website's interactive demo (demo/public/data) from a real
// Nøta project: the project file without paths or plug-in states, and per
// song its waveforms (at 200 columns a second, to keep the download small),
// beat grid and bass notes.
//
//   npx tsx demo/export-data.ts "path/to/Some Project.nota"

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { WaveformData } from '../src/shared/api'
import { parseProject } from '../src/shared/project'
import { computeWaveform, setBundledToolsDir } from '../src/main/media'

const PER_SECOND = 200

const pkg = process.argv[2]
if (!pkg) throw new Error('Usage: npx tsx demo/export-data.ts <project.nota>')
const out = resolve(__dirname, 'public', 'data')
setBundledToolsDir(resolve(__dirname, '..', 'native', 'build', 'tools'))

function readWave(file: string): WaveformData | null {
  if (!existsSync(file)) return null
  const buf = readFileSync(file)
  if (buf.readUInt32LE(0) !== 0x4e574156) return null
  return { perSecond: buf.readUInt32LE(4), durationSec: buf.readFloatLE(8), data: new Uint8Array(buf.subarray(12)) }
}

/** Fewer columns: each keeps the lowest min, highest max and the louder column's colour. */
function downsample(w: WaveformData): WaveformData {
  const step = Math.max(1, Math.round(w.perSecond / PER_SECOND))
  const n = Math.floor(w.data.length / 3)
  const m = Math.ceil(n / step)
  const data = new Uint8Array(m * 3)
  for (let i = 0; i < m; i++) {
    let lo = 127
    let hi = -128
    let colour = 0
    let loudest = -1
    for (let j = i * step; j < Math.min(n, (i + 1) * step); j++) {
      const mn = (w.data[j * 3] << 24) >> 24
      const mx = (w.data[j * 3 + 1] << 24) >> 24
      if (mn < lo) lo = mn
      if (mx > hi) hi = mx
      if (mx - mn > loudest) {
        loudest = mx - mn
        colour = w.data[j * 3 + 2]
      }
    }
    data[i * 3] = lo & 0xff
    data[i * 3 + 1] = hi & 0xff
    data[i * 3 + 2] = colour
  }
  return { perSecond: w.perSecond / step, durationSec: w.durationSec, data }
}

function writeWave(file: string, w: WaveformData) {
  const head = Buffer.alloc(12)
  head.writeUInt32LE(0x4e574156, 0)
  head.writeUInt32LE(w.perSecond, 4)
  head.writeFloatLE(w.durationSec, 8)
  writeFileSync(file, Buffer.concat([head, Buffer.from(w.data)]))
}

async function main() {
  const project = parseProject(readFileSync(join(pkg, 'project.json'), 'utf8'))
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  for (const song of project.songs) {
    const dir = join(pkg, 'Generated', song.source.hash)
    const sources: Record<string, string | null> = {
      original: song.playbackProxy ? join(pkg, 'Generated', song.playbackProxy) : join(pkg, song.source.path),
      bass: song.stems.bass ? join(pkg, 'Generated', song.stems.bass.cachePath) : null,
      backing: song.stems.backing ? join(pkg, 'Generated', song.stems.backing.cachePath) : null
    }
    for (const kind of ['original', 'bass', 'backing'] as const) {
      const cached = readWave(join(dir, kind === 'original' ? 'wave2-original.bin' : `wave2-${song.stems[kind]?.model}-${kind}.bin`))
      const audio = sources[kind]
      const wave = cached ?? (audio && existsSync(audio) ? await computeWaveform(audio) : null)
      if (wave) writeWave(join(out, `wave-${song.source.hash}-${kind}.bin`), downsample(wave))
    }
    const analysis = JSON.parse(readFileSync(join(dir, 'analysis-v2.json'), 'utf8'))
    writeFileSync(join(out, `grid-${song.source.hash}.json`), JSON.stringify(analysis.grid ?? null))
    const notes = join(dir, `notes-v3-${song.stems.bass?.model}.json`)
    if (existsSync(notes)) writeFileSync(join(out, `notes-${song.source.hash}.json`), readFileSync(notes))
  }
  // No paths from this computer, and generic effects in place of real plug-ins and their states.
  const generic = [
    { name: 'Bass Compressor', manufacturer: 'VST3 plug-in', format: 'VST3' },
    { name: 'Tilt EQ', manufacturer: 'VST3 plug-in', format: 'VST3' }
  ]
  const clean = {
    ...project,
    songs: project.songs.map((s) => ({ ...s, source: { ...s.source, path: `Songs/${s.title}` } })),
    effects: project.effects.map((e, i) => ({ ...e, ...(generic[i] ?? generic[0]), descriptionXml: '', state: null }))
  }
  writeFileSync(join(out, 'project.json'), JSON.stringify(clean))
  console.log(`Demo data for ${project.songs.length} songs in ${out}`)
}

void main()
