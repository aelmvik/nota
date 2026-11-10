import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { EngineHost } from '../src/main/engineHost'
import type { EngineSnapshot } from '../src/shared/types'

// The supervisor around the audio engine, with stand-ins for the engine: a
// file that can't be run, and a script that exits at once. No audio device is opened.

const dir = mkdtempSync(join(tmpdir(), 'nota-host-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Resolves with the first snapshot that passes `test`. */
const next = (host: EngineHost, test: (s: EngineSnapshot) => boolean) =>
  new Promise<EngineSnapshot>((resolve) => {
    const on = (s: EngineSnapshot) => {
      if (!test(s)) return
      host.off('snapshot', on)
      resolve(s)
    }
    host.on('snapshot', on)
  })

describe('engine host', () => {
  it('can try again after the engine could not be started at all', async () => {
    const host = new EngineHost(join(dir, 'no-such-engine'))
    const failed = next(host, (s) => s.status === 'crashed')
    host.start()
    expect((await failed).message).toMatch(/Could not start/)
    // Restart starts it again (and fails again) instead of doing nothing.
    const statuses: string[] = []
    host.on('snapshot', (s: EngineSnapshot) => statuses.push(s.status))
    const again = next(host, (s) => s.status === 'crashed')
    host.restart()
    await again
    expect(statuses).toEqual(['starting', 'crashed'])
  })

  it.skipIf(process.platform === 'win32')('stays stopped when it is stopped while waiting to restart after a crash', async () => {
    const script = join(dir, 'crashes.sh')
    writeFileSync(script, '#!/bin/sh\nexit 3\n')
    chmodSync(script, 0o755)
    const host = new EngineHost(script)
    const crashed = next(host, (s) => s.status === 'crashed')
    host.start()
    expect((await crashed).message).toMatch(/Restarting/)
    host.stop()
    expect(host.snapshot().status).toBe('stopped')
    const statuses: string[] = []
    host.on('snapshot', (s: EngineSnapshot) => statuses.push(s.status))
    await new Promise((r) => setTimeout(r, 1200)) // the restart was due after 0.8 s
    expect(statuses).toEqual([])
  })
})
