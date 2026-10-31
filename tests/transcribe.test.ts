import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { venvPython } from '../src/main/platform'

// The notes decoder (separation/transcribe.py) on made-up model output with a
// known answer. Runs with the development Python environment; skipped without one.

const root = join(__dirname, '..')
const python = [process.env.NOTA_PYTHON, venvPython(join(root, 'separation', '.venv'))].find((p): p is string => !!p && existsSync(p))

const SCRIPT = `
import importlib.util, json, sys
import numpy as np
spec = importlib.util.spec_from_file_location('t', sys.argv[1]); T = importlib.util.module_from_spec(spec); spec.loader.exec_module(T)
F = 300
note, onset = np.zeros((F, 88)), np.zeros((F, 88))
level, fine = np.full(F, -80.0), np.full(F, -80.0)
k = lambda midi: midi - T.KEY0
# E1, plucked at frame 10, ringing to 110 while the model's confidence fades
note[10:110, k(28)] = np.r_[np.full(50, 0.8), np.linspace(0.8, 0.15, 50)]
onset[10, k(28)] = 0.9
# a brief wrong note in the middle of it
note[50:53, k(29)] = 0.9
note[50:53, k(28)] = 0.3
# A1 at 130, plucked again at 180 (the bass dips and comes back)
note[130:230, k(33)] = 0.8
onset[130, k(33)] = onset[180, k(33)] = 0.9
level[10:110] = level[130:230] = -20
fine[:] = level
fine[176:180] = -35
print(json.dumps(T.decode(note, onset, level, fine, -20.0)))
`

describe.skipIf(!python)('notes decoder', () => {
  it('reads one line: no blips, sustains whole, repeated notes separate', () => {
    const out = execFileSync(python!, ['-I', '-c', SCRIPT, join(root, 'separation/transcribe.py')], { encoding: 'utf8' })
    const notes = (JSON.parse(out) as [number, number, number, number][]).map(([a, b, midi]) => ({ a, b, midi }))
    expect(notes.map((n) => n.midi)).toEqual([28, 33, 33])
    expect(Math.abs(notes[0].a - 10)).toBeLessThanOrEqual(2)
    expect(notes[0].b).toBeGreaterThanOrEqual(105) // not cut short as the confidence fades
    expect(Math.abs(notes[1].a - 130)).toBeLessThanOrEqual(2)
    expect(Math.abs(notes[2].a - 180)).toBeLessThanOrEqual(2)
  })
})
