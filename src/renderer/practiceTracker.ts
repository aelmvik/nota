import { useEffect } from 'react'
import { getState } from './state/store'

// Counts practice time and reports it to the main process every 30 seconds.
// A second counts while a song is playing, or while Monitor is on and the
// input shows signal (the bass is actually being played) within the last
// 10 seconds, so leaving the app open with Monitor on doesn't count.

const INPUT_ACTIVE = Math.pow(10, -45 / 20) // −45 dBFS
const BASS_GRACE_MS = 10_000
const REPORT_EVERY = 30

export function usePracticeTracker() {
  useEffect(() => {
    let lastInput = 0
    let pending = 0
    let pendingSong: string | null = null
    const offMeters = window.nota.engine.onMeters((m) => {
      if (m.inputPeakRaw > INPUT_ACTIVE) lastInput = Date.now()
    })
    const report = () => {
      if (!pending) return
      const seconds = pending
      pending = 0
      void window.nota.project.addPractice(seconds, pendingSong).catch(() => {})
    }
    const tick = setInterval(() => {
      const s = getState()
      const song = s.player.playing ? s.player.songId : null
      const bass = !!s.engine?.monitoring && Date.now() - lastInput < BASS_GRACE_MS
      if (!song && !bass) return report() // stopped: report what's left right away
      if (song !== pendingSong) report() // keep each song's time separate
      pendingSong = song
      if (++pending >= REPORT_EVERY) report()
    }, 1000)
    window.addEventListener('beforeunload', report)
    return () => {
      clearInterval(tick)
      offMeters()
      window.removeEventListener('beforeunload', report)
      report()
    }
  }, [])
}
