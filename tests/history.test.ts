import { describe, expect, it } from 'vitest'
import { applyEntry, diff, History } from '../src/main/history'
import * as P from '../src/shared/project'
import type { EffectSlot, Project, SongSource } from '../src/shared/types'

const source = (hash: string): SongSource => ({ path: `/music/${hash}.mp3`, hash, sizeBytes: 1, format: 'mp3', codec: 'mp3', sampleRate: 44100, channels: 2, missing: false })
const song = (hash: string) => P.makeSong({ title: hash, artist: null, durationSec: 200, source: source(hash) })
const effect = (slotId: string): EffectSlot => ({ slotId, pluginId: 'p', name: slotId, manufacturer: 'm', format: 'VST3', descriptionXml: '<x/>', bypassed: false, state: null })

function setup() {
  const p = P.addSongs(P.createProject('Test'), [song('a'), song('b'), song('c')])
  return { p, ids: p.songs.map((s) => s.id) }
}
const undo = (h: History, p: Project) => applyEntry(p, h.takeUndo()!, 'undo')
const redo = (h: History, p: Project) => applyEntry(p, h.takeRedo()!, 'redo')

describe('undo history', () => {
  it('undoes and redoes a song edit, keeping background changes made since', () => {
    const { p, ids } = setup()
    const h = new History()
    const edited = P.updateSong(p, ids[1], { speed: 0.8 })
    h.record('Speed', p, edited)
    // Separation finished and practice time grew after the edit.
    const later = { ...P.updateSong(edited, ids[1], { position: 42 }), practiceSec: 99 }
    const undone = undo(h, later)
    expect(undone.songs[1].speed).toBe(1)
    expect(undone.songs[1].position).toBe(42)
    expect(undone.practiceSec).toBe(99)
    expect(redo(h, undone).songs[1].speed).toBe(0.8)
  })

  it('ignores playback position, selection and generated data', () => {
    const { p, ids } = setup()
    expect(diff(p, P.selectSong(P.updateSong(p, ids[0], { position: 10 }), ids[2]))).toEqual([])
  })

  it('finds songs by id after the playlist was reordered', () => {
    const { p, ids } = setup()
    const h = new History()
    const edited = P.updateSong(p, ids[2], { title: 'New' })
    h.record('Rename song', p, edited)
    const moved = P.moveSong(edited, ids[2], 0)
    const undone = undo(h, moved)
    expect(undone.songs[0].id).toBe(ids[2])
    expect(undone.songs[0].title).toBe('c')
  })

  it('undoes moves, and effect adds and removes', () => {
    const { p, ids } = setup()
    const h = new History()
    const moved = P.moveSong(p, ids[0], 2)
    h.record('Move song', p, moved)
    expect(undo(h, moved).songs.map((s) => s.id)).toEqual(ids)

    const withFx = { ...p, effects: [effect('x'), effect('y')] }
    const removed = { ...withFx, effects: [effect('y')] }
    h.record('Remove effect', withFx, removed)
    expect(undo(h, removed).effects.map((e) => e.slotId)).toEqual(['x', 'y'])
  })

  it('merges quick repeated edits of the same value into one step', () => {
    const { p, ids } = setup()
    const h = new History()
    let cur = p
    for (const v of [0.9, 0.8, 0.7]) {
      const next = P.updateSong(cur, ids[0], { speed: v })
      h.record('Speed', cur, next)
      cur = next
    }
    expect(undo(h, cur).songs[0].speed).toBe(1)
    expect(h.canUndo).toBe(false)
  })

  it('skips edits to a song that has been removed', () => {
    const { p, ids } = setup()
    const h = new History()
    const edited = P.updateSong(p, ids[1], { speed: 0.5 })
    h.record('Speed', p, edited)
    const removed = P.removeSong(edited, ids[1])
    expect(undo(h, removed).songs.map((s) => s.id)).toEqual([ids[0], ids[2]])
  })
})
