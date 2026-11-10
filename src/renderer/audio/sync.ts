import { useEffect, useRef, useState } from 'react'
import type { BeatGrid } from '../../shared/beats'
import { beatGrid, beatsPerBarOf, bpmOf, effectiveGrid, isPitchNeutral, pitchRatio, trainerNext, type GridLike } from '../../shared/music'
import { effectiveMode, isModeAvailable } from '../../shared/project'
import type { Song } from '../../shared/types'
import { attempt, getState, metronome, player, setState, toast, useStore } from '../state/store'
import type { Sources } from './player'

// Bridges project state (owned by the main process) and song playback.

export function sourcesFor(song: Song): Sources {
  const out: Sources = {}
  const cache = (path: string) => ({ scope: 'cache' as const, path })
  // The original plays from its FLAC copy when there is one: decoded by the
  // same decoder as the stems, so switching modes never shifts the timing.
  if (isModeAvailable(song, 'original'))
    out.original = song.playbackProxy
      ? cache(song.playbackProxy)
      : { scope: 'local', path: song.source.path }
  if (isModeAvailable(song, 'bass') && song.stems.bass) out.bass = cache(song.stems.bass.cachePath)
  if (isModeAvailable(song, 'playalong') && song.stems.backing) out.playalong = cache(song.stems.backing.cachePath)
  return out
}

let pendingPlay: string | null = null
let countInToken = 0

function selectedSong(): Song | null {
  const p = getState().snapshot?.project
  return p?.songs.find((x) => x.id === p.selectedSongId) ?? null
}

/** Start playback, with a count-in when enabled and the tempo is known. */
export async function startPlayback() {
  const s = getState()
  const song = selectedSong()
  const settings = s.snapshot?.project?.metronome
  const bpm = song ? bpmOf(song) : null
  if (!song || !settings || settings.countInBars === 0 || !bpm || s.countingIn) {
    if (!s.countingIn) await player.play()
    return
  }
  const token = ++countInToken
  setState({ countingIn: true })
  metronome.setVolume(settings.volume)
  const perBar = beatsPerBarOf(song)
  const period = 60 / bpm / song.speed
  // The engine counts in and starts the song on the next beat, on one clock.
  await player.countInAndPlay(settings.countInBars * perBar, period, perBar)
  if (token === countInToken) setState({ countingIn: false })
}

export function stopPlayback() {
  if (getState().countingIn) {
    countInToken++
    setState({ countingIn: false })
  }
  player.stop()
}

export function togglePlayback() {
  if (player.isPlaying || getState().countingIn) stopPlayback()
  else void startPlayback()
}

export function useSelectedSong(): Song | null {
  return useStore((s) => {
    const p = s.snapshot?.project
    return p?.songs.find((x) => x.id === p.selectedSongId) ?? null
  })
}

/** Play a song from its row: select it first if needed. */
export function playSong(id: string) {
  const p = getState().snapshot?.project
  if (!p) return
  if (p.selectedSongId === id && getState().player.songId === id) {
    togglePlayback()
    return
  }
  pendingPlay = id
  void attempt(() => window.nota.songs.select(id))
}

export function savePosition() {
  const id = getState().player.songId
  if (id && getState().snapshot?.project?.songs.some((s) => s.id === id))
    void window.nota.songs.update(id, { position: player.currentTime }).catch(() => {})
}

const gridCache = new Map<string, Promise<BeatGrid | null>>()

/** The regularised, detected beat grid (null until analysis is ready). */
export function useDetectedGrid(song: Song | null): BeatGrid | null {
  const [grid, setGrid] = useState<BeatGrid | null>(null)
  const key = song && song.analysis.status === 'ready' ? `${song.source.hash}:${song.analysis.version}:${song.analysis.beatCount}` : null
  useEffect(() => {
    if (!key || !song) {
      setGrid(null)
      return
    }
    let job = gridCache.get(key)
    if (!job) {
      job = window.nota.songs.beats(song.id).catch(() => null)
      gridCache.set(key, job)
    }
    let alive = true
    void job.then((g) => alive && setGrid(g))
    return () => {
      alive = false
    }
  }, [key])
  return grid
}

/** The grid in use for a song (manual tempo or detected), memoised per input. */
export function useSongGrid(song: Song | null): GridLike | null {
  const detected = useDetectedGrid(song)
  const [grid, setGrid] = useState<GridLike | null>(null)
  const key = song ? JSON.stringify([song.id, song.tempo, song.beatsPerBar, song.downbeat, song.gridScale, song.evenBars, song.durationSec, !!detected]) : ''
  useEffect(() => setGrid(song ? effectiveGrid(song, detected) : null), [key, detected])
  return grid
}

export function usePlaybackSync() {
  const song = useSelectedSong()
  const masterVolume = useStore((s) => s.snapshot?.project?.audio.playbackVolume ?? 0.9)
  const projectId = useStore((s) => s.snapshot?.project?.id ?? null)
  const loaded = useRef<string | null>(null)
  const sources = song ? sourcesFor(song) : {}
  const sourcesKey = JSON.stringify(sources)

  // Load the selected song (and remember where the previous one was).
  useEffect(() => {
    if (!song) {
      if (loaded.current) savePosition()
      loaded.current = null
      player.unload()
      return
    }
    if (loaded.current === song.id) return
    if (loaded.current) savePosition()
    loaded.current = song.id
    const mode = effectiveMode(song) ?? 'original'
    const position = song.position
    void player
      .load(song.id, sources, {
        mode,
        position,
        speed: song.speed,
        volume: song.volume,
        loop: song.loop,
        duration: song.durationSec
      })
      .then(() => {
        if (pendingPlay === song.id) {
          pendingPlay = null
          void startPlayback()
        }
      })
  }, [song?.id, projectId])

  // The engine went away mid-song (crash or restart): say so. It comes back
  // paused where it was.
  useEffect(
    () =>
      window.nota.transport.onInterrupted((e) => {
        if (e.wasPlaying) toast('Playback stopped: the audio engine restarted.', 'error', 7000)
      }),
    []
  )

  // Stems finishing while the song is loaded.
  useEffect(() => {
    if (song && loaded.current === song.id) player.updateSources(sources)
  }, [sourcesKey])

  const mode = song ? effectiveMode(song) : null
  useEffect(() => {
    if (song && mode && loaded.current === song.id) void player.setMode(mode)
  }, [mode, sourcesKey])

  useEffect(() => {
    if (song) player.setSpeed(song.speed)
  }, [song?.speed])

  useEffect(() => {
    if (song) player.setVolume(song.volume)
  }, [song?.volume])

  const cutsKey = JSON.stringify(song?.cuts ?? [])
  useEffect(() => {
    player.setCuts(song?.cuts ?? [])
  }, [song?.id, cutsKey])

  useEffect(() => {
    player.setLoop(song?.loop ?? null)
  }, [song?.loop?.start, song?.loop?.end, song?.loop?.enabled])

  useEffect(() => {
    player.setMasterVolume(masterVolume)
  }, [masterVolume])

  const stopBehavior = useStore((s) => s.prefs.stopBehavior)
  useEffect(() => {
    player.returnToStart = stopBehavior === 'return'
  }, [stopBehavior])

  // Key and fine tuning, live in the engine.
  const ratio = song && !isPitchNeutral(song.pitch) ? pitchRatio(song.pitch) : 1
  useEffect(() => {
    player.setPitchRatio(ratio)
  }, [ratio])
  const accent = useStore((s) => s.prefs.accent)
  useEffect(() => {
    document.documentElement.dataset.accent = accent
  }, [accent])

  // Metronome: settings and the beat grid of the selected song.
  const metro = useStore((s) => s.snapshot?.project?.metronome ?? null)
  const grid = useSongGrid(song)
  const accentBars = metro?.accent !== false
  useEffect(() => {
    metronome.setBeats(beatGrid(grid), accentBars)
  }, [grid, accentBars])
  useEffect(() => {
    metronome.setVolume(metro?.volume ?? 0.6)
    metronome.setEnabled(!!metro?.enabled)
  }, [metro?.enabled, metro?.volume])

  // Speed trainer: step the speed up every N loop repetitions.
  const trainerKey = song ? JSON.stringify([song.id, song.trainer, song.loop?.start, song.loop?.end]) : ''
  useEffect(() => {
    let wraps = 0
    return player.onLoopWrap(() => {
      const cur = selectedSong()
      const t = cur?.trainer
      if (!cur || !t?.enabled) return
      wraps++
      if (wraps % t.everyLoops === 0) {
        const next = trainerNext(cur.speed, t)
        if (next !== cur.speed) void window.nota.songs.update(cur.id, { speed: next })
      }
    })
  }, [trainerKey])

  // Persist the position whenever playback stops.
  const playing = useStore((s) => s.player.playing)
  const wasPlaying = useRef(false)
  useEffect(() => {
    if (wasPlaying.current && !playing) savePosition()
    wasPlaying.current = playing
  }, [playing])

  useEffect(() => {
    window.addEventListener('beforeunload', savePosition)
    return () => window.removeEventListener('beforeunload', savePosition)
  }, [])
}
