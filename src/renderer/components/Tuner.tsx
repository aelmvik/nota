import { useEffect, useRef, useState } from 'react'
import { IN_TUNE_CENTS, readNote, referenceA4, smoothHz, type TunerReading } from '../../shared/tuner'
import { useSelectedSong } from '../audio/sync'
import { attempt, getState, readPref, setState, useStore, writePref } from '../state/store'
import { Button, Icon, Popover } from './ui'

// Bass tuner in the Mixer's bass strip. Pitch detection runs in the native engine
// (YIN, 25–500 Hz); this shows the note, a cents needle and the string.

type RefMode = 'a440' | 'song'

export function toggleTuner() {
  const s = getState()
  // The tuner lives in the Mixer: show it when turning the tuner on.
  if (!s.tunerOn && (s.sidePane || !s.effectsOpen)) {
    writePref('effectsOpen', true)
    setState({ sidePane: null, effectsOpen: true })
  }
  setState((st) => ({ tunerOn: !st.tunerOn }))
}

/** How far the selected song is from A440 as you hear it (detected tuning + fine-tune). */
function songOffsetCents(): number | null {
  const p = getState().snapshot?.project
  const song = p?.songs.find((s) => s.id === p.selectedSongId)
  if (!song || song.analysis.status !== 'ready' || song.analysis.tuningCents === undefined) return null
  return song.analysis.tuningCents + song.pitch.cents
}

/**
 * Keeps the engine's tuner in step with the app, whether or not the Mixer
 * (where the tuner is shown) is open. Hiding the Mixer turns the tuner off:
 * a tuner you can't see shouldn't keep the input open and the bass muted.
 */
export function useTunerSync() {
  const on = useStore((s) => s.tunerOn)
  const mute = useStore((s) => s.tunerMute)
  const running = useStore((s) => s.engine?.status === 'running')
  const visible = useStore((s) => s.effectsOpen && !s.sidePane)
  useEffect(() => {
    if (on && !visible) setState({ tunerOn: false })
  }, [on, visible])
  // Tell the engine; re-sent if it restarts.
  useEffect(() => {
    if (running) void attempt(() => window.nota.engine.setTuner(on && visible, mute), 'Tuner')
  }, [on, visible, mute, running])
}

export function Tuner() {
  const on = useStore((s) => s.tunerOn)
  const running = useStore((s) => s.engine?.status === 'running')
  const song = useSelectedSong()
  const [refMode, setRefMode] = useState<RefMode>(readPref('tunerRef', 'a440'))
  const mute = useStore((s) => s.tunerMute)
  const setMute = (m: boolean) => setState({ tunerMute: m })
  const [reading, setReading] = useState<TunerReading | null>(null)
  const history = useRef<number[]>([])

  const songOffset = song ? songOffsetCents() : null
  const useSong = refMode === 'song' && songOffset !== null
  const baseA4 = useStore((s) => s.prefs.tunerA4)
  const a4 = referenceA4(useSong ? songOffset! : 0, baseA4)
  const a4Ref = useRef(a4)
  a4Ref.current = a4

  useEffect(() => {
    if (!on) {
      history.current = []
      setReading(null)
      return
    }
    return window.nota.engine.onTuner((t) => {
      history.current = [...history.current.slice(-4), t.hz]
      const hz = smoothHz(history.current)
      setReading(hz ? readNote(hz, a4Ref.current) : null)
    })
  }, [on])

  if (!running) return null

  if (!on)
    return (
      <div className="mix-tuner is-off">
        <button type="button" className="tuner-toggle" title="Tuner (T)" onClick={toggleTuner}>
          <Icon name="tune" size={16} />
          <span>Tuner</span>
        </button>
      </div>
    )

  const inTune = reading !== null && Math.abs(reading.cents) <= IN_TUNE_CENTS
  const needle = reading ? Math.max(-50, Math.min(50, reading.cents)) : 0

  return (
    <div className={`mix-tuner${inTune ? ' is-in-tune' : ''}`}>
      <div className="tuner-row">
        <div className={`tuner-note${reading ? '' : ' is-idle'}`} title={reading ? `${reading.hz.toFixed(2)} Hz` : 'Play a single note'}>
          {reading ? (
            <>
              {reading.note}
              <sub>{reading.octave}</sub>
            </>
          ) : (
            '—'
          )}
        </div>
        <div className="tuner-gauge">
          <div className="tuner-scale">
            <span className="tick is-center" />
            {[-40, -30, -20, -10, 10, 20, 30, 40].map((c) => (
              <span key={c} className="tick" style={{ left: `${50 + c}%` }} />
            ))}
            <span className="tuner-zone" style={{ left: `${50 - IN_TUNE_CENTS}%`, width: `${IN_TUNE_CENTS * 2}%` }} />
            {reading && <span className="tuner-needle" style={{ left: `${50 + needle}%` }} />}
          </div>
          <div className="tuner-labels">
            <span>♭</span>
            <span className="tuner-cents">
              {reading ? `${reading.cents > 0 ? '+' : reading.cents < 0 ? '−' : ''}${Math.abs(reading.cents).toFixed(0)}¢` : ''}
              {reading?.string && <em> · {reading.string} string</em>}
            </span>
            <span>♯</span>
          </div>
        </div>
        <div className="tuner-actions">
          <Popover
            align="right"
            trigger={(open, toggle) => <Button size="sm" variant="ghost" icon="more" active={open} title="Tuner settings" onClick={toggle} />}
          >
            <div className="pop-section">
              <h5>Tune to</h5>
              <div className="seg">
                <button type="button" className={!useSong ? 'is-active' : ''} onClick={() => (setRefMode('a440'), writePref('tunerRef', 'a440'))}>
                  A = {baseA4 % 1 ? baseA4.toFixed(1) : baseA4} Hz
                </button>
                <button
                  type="button"
                  className={useSong ? 'is-active' : ''}
                  disabled={songOffset === null}
                  title={songOffset === null ? 'The selected song’s tuning hasn’t been detected yet' : undefined}
                  onClick={() => (setRefMode('song'), writePref('tunerRef', 'song'))}
                >
                  The song{songOffset !== null ? ` (A = ${referenceA4(songOffset, baseA4).toFixed(1)})` : ''}
                </button>
              </div>
              <p className="pop-note">
                {useSong
                  ? 'Tunes your bass to the recording as you hear it, including any fine-tune you’ve applied.'
                  : 'Standard tuning. Use “Match A440” on a detuned song, or tune to the song instead.'}
              </p>
            </div>
            <div className="pop-section">
              <div className="pop-row">
                <h5>Mute output while tuning</h5>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={mute}
                    onChange={(e) => {
                      setMute(e.target.checked)
                      writePref('tunerMute', e.target.checked)
                    }}
                  />
                  <span />
                </label>
              </div>
            </div>
          </Popover>
          <Button size="sm" variant="ghost" icon="x" title="Close tuner (T)" onClick={toggleTuner} />
        </div>
      </div>
      <span className="mix-tuner-sub">
        {useSong ? `Tuning to the song · A = ${a4.toFixed(1)} Hz` : `A = ${baseA4 % 1 ? baseA4.toFixed(1) : baseA4} Hz`}
        {mute ? ' · output muted' : ''}
      </span>
    </div>
  )
}
