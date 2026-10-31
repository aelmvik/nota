import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {} }))
const { buildSetlistHtml, setlistKey } = await import('../src/main/setlist')
const P = await import('../src/shared/project')

const song = (title: string, artist: string | null, extra: Partial<import('../src/shared/types').Song> = {}) => ({
  ...P.makeSong({ title, artist, durationSec: 200, source: { path: `/${title}`, hash: title, sizeBytes: 1, format: 'mp3', codec: null, sampleRate: null, channels: null, missing: false } }),
  ...extra
})

describe('setlist', () => {
  it('shows only the key you play in', () => {
    const analysed = { status: 'ready' as const, key: 'E♭ major', version: 2 }
    expect(setlistKey(song('a', null, { analysis: analysed }))).toBe('E♭ major')
    expect(setlistKey(song('a', null, { analysis: analysed, pitch: { semitones: 2, cents: -23 } }))).toBe('F major')
    expect(setlistKey(song('a', null))).toBe('—')
  })

  it('lists every song in playlist order, escaping text', () => {
    let p = P.createProject('Friday <rehearsal>')
    p = P.addSongs(p, [song('Tuikkikaa, oi joulun tähtöset', 'BESS'), song('Fish & Chips', null)])
    const html = buildSetlistHtml(p, new Date('2026-10-14'))
    expect(html).toContain('Friday &lt;rehearsal&gt;')
    expect(html).toContain('Fish &amp; Chips')
    expect(html.indexOf('Tuikkikaa')).toBeLessThan(html.indexOf('Fish'))
    expect(html.match(/class="song"/g)).toHaveLength(2)
    expect(html).not.toContain('Notes')
    expect(html).not.toContain('original')
    expect(html).toContain('2 songs · 14 October 2026')
  })

  it('handles an empty project', () => {
    expect(buildSetlistHtml(P.createProject('Empty'))).toContain('no songs yet')
  })
})
