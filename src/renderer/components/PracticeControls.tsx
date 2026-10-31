import { useEffect, useState } from 'react'
import {
  BPM_MAX,
  BPM_MIN,
  CENTS_RANGE,
  DEFAULT_TRAINER,
  SEMITONE_RANGE,
  bpmOf,
  formatCents,
  formatSemitones,
  localBpm,
  tapOffset,
  tapTempo,
  transposeKey,
  tuningCorrection
} from '../../shared/music'
import { SPEED_MAX, SPEED_MIN } from '../../shared/project'
import type { Song } from '../../shared/types'
import { useDetectedGrid, useSongGrid } from '../audio/sync'
import { attempt, getState, player, useStore } from '../state/store'
import { Button, Icon, Popover, Slider, Stepper, Toggle, parseNumber } from './ui'
import { optKey, withShift } from '../platform'

const update = (song: Song, patch: Parameters<typeof window.nota.songs.update>[1]) =>
  void attempt(() => window.nota.songs.update(song.id, patch))

// ---- Speed ------------------------------------------------------------------------

const SPEED_PRESETS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1]

export function setSpeed(song: Song, speed: number) {
  update(song, { speed: Math.round(speed * 100) / 100 })
}

export function SpeedControl({ song }: { song: Song }) {
  const [draft, setDraft] = useState<number | null>(null)
  const value = draft ?? song.speed
  const trainer = song.trainer
  const training = !!trainer?.enabled

  return (
    <div className="practice-group">
      <span className="ctl-label">Speed</span>
      <Slider
        className="speed-slider"
        value={value}
        min={SPEED_MIN}
        max={SPEED_MAX}
        step={0.01}
        defaultValue={1}
        format={(v) => `${Math.round(v * 100)}%`}
        parse={(t) => {
          const n = parseNumber(t)
          return n === null ? null : n / 100
        }}
        title={`Playback speed, pitch preserved. Drag, or click and type a percentage. ${optKey}-click resets to 100%.`}
        onChange={setDraft}
        onCommit={(v) => {
          setDraft(null)
          setSpeed(song, v)
        }}
      />
      <Popover
        align="center"
        trigger={(open, toggle) => (
          <Button size="sm" variant="ghost" icon="trend" active={open || training} title="Speed presets and trainer" onClick={toggle}>
            {training ? `→ ${Math.round(trainer!.target * 100)}%` : undefined}
          </Button>
        )}
      >
        <div className="pop-section">
          <h5>Presets</h5>
          <div className="preset-grid">
            {SPEED_PRESETS.map((s) => (
              <button key={s} type="button" className={`preset${Math.abs(song.speed - s) < 0.001 ? ' is-active' : ''}`} onClick={() => setSpeed(song, s)}>
                {Math.round(s * 100)}%
              </button>
            ))}
          </div>
        </div>
        <TrainerSettings song={song} />
      </Popover>
    </div>
  )
}

function TrainerSettings({ song }: { song: Song }) {
  const t = song.trainer ?? { ...DEFAULT_TRAINER, enabled: false }
  const set = (patch: Partial<typeof t>) => update(song, { trainer: { ...t, ...patch } })
  return (
    <div className="pop-section">
      <div className="pop-row">
        <h5>Speed trainer</h5>
        <label className="switch">
          <input type="checkbox" checked={t.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          <span />
        </label>
      </div>
      <p className="pop-note">
        Each time the loop repeats{t.everyLoops === 1 ? '' : ` ${t.everyLoops} times`}, the speed goes up by {Math.round(t.step * 100)}% until it reaches{' '}
        {Math.round(t.target * 100)}%.{!song.loop?.enabled && ' Set a loop to use it.'}
      </p>
      <div className="pop-grid">
        <span>Step</span>
        <Stepper value={t.step} format={(v) => `+${Math.round(v * 100)}%`} onStep={(d) => set({ step: Math.max(0.01, Math.min(0.1, t.step + d * 0.01)) })} />
        <span>Every</span>
        <Stepper value={t.everyLoops} format={(v) => `${v} loop${v === 1 ? '' : 's'}`} onStep={(d) => set({ everyLoops: Math.max(1, Math.min(16, t.everyLoops + d)) })} />
        <span>Up to</span>
        <Stepper
          value={t.target}
          format={(v) => `${Math.round(v * 100)}%`}
          onStep={(d) => set({ target: Math.max(SPEED_MIN, Math.min(SPEED_MAX, t.target + d * 0.05)) })}
          onEdit={(text) => {
            const n = parseNumber(text)
            if (n !== null) set({ target: Math.max(SPEED_MIN, Math.min(SPEED_MAX, n / 100)) })
          }}
          editValue={String(Math.round(t.target * 100))}
        />
      </div>
    </div>
  )
}

// ---- Key & tuning ------------------------------------------------------------------

export function shiftKey(song: Song, delta: number) {
  update(song, { pitch: { ...song.pitch, semitones: song.pitch.semitones + delta } })
}

export function KeyControl({ song }: { song: Song }) {
  const { semitones, cents } = song.pitch
  const a = song.analysis
  const keyNow = a.key ? transposeKey(a.key, semitones) : null
  const correction = a.tuningCents !== undefined ? tuningCorrection(a.tuningCents) : null
  const changed = semitones !== 0 || cents !== 0

  return (
    <div className="practice-group">
      <span className="ctl-label">Key</span>
      <Stepper
        value={semitones}
        format={formatSemitones}
        editValue={String(semitones)}
        highlight={semitones !== 0}
        minusTitle={`Down a semitone (${withShift('↓')})`}
        plusTitle={`Up a semitone (${withShift('↑')})`}
        disableMinus={semitones <= -SEMITONE_RANGE}
        disablePlus={semitones >= SEMITONE_RANGE}
        onStep={(d) => shiftKey(song, d)}
        onEdit={(text) => {
          const n = parseNumber(text)
          if (n !== null) update(song, { pitch: { semitones: Math.round(n), cents } })
        }}
        title={keyNow ? `Now in ${keyNow} — click the value to type semitones` : 'Transpose the song'}
      />
      <Popover
        align="center"
        trigger={(open, toggle) => (
          <button
            type="button"
            className={`tune-chip${cents !== 0 ? ' is-changed' : ''}${open ? ' is-open' : ''}`}
            onClick={toggle}
            title={cents !== 0 ? `Tuned ${formatCents(cents)}: fine tuning and matching the song to A440` : 'Fine tuning: shift the song by cents, or match it to A440'}
          >
            <Icon name="tune" size={13} />
            {cents !== 0 ? formatCents(cents) : 'Tuning'}
          </button>
        )}
      >
        <div className="pop-section">
          <h5>Fine tune</h5>
          <div className="pop-row">
            <Slider
              className="cents-slider"
              value={cents}
              min={-CENTS_RANGE}
              max={CENTS_RANGE}
              step={1}
              title="Shift the whole song by up to ±50 cents"
              onChange={(v) => update(song, { pitch: { semitones, cents: v } })}
            />
            <Stepper
              value={cents}
              format={formatCents}
              editValue={String(cents)}
              onStep={(d, big) => update(song, { pitch: { semitones, cents: cents + d * (big ? 5 : 1) } })}
              onEdit={(text) => {
                const n = parseNumber(text)
                if (n !== null) update(song, { pitch: { semitones, cents: Math.round(n) } })
              }}
            />
          </div>
          <div className="pop-row pop-buttons">
            <span />
            <div className="spacer" />
            <Button size="sm" variant="ghost" icon="reset" disabled={!changed} onClick={() => update(song, { pitch: { semitones: 0, cents: 0 } })}>
              Reset
            </Button>
          </div>
        </div>

        <div className="pop-section">
          <h5>Detected</h5>
          {a.status === 'ready' ? (
            <>
              <div className="pop-facts">
                <span>Key</span>
                <strong>
                  {a.key}
                  {semitones !== 0 && keyNow && ` → ${keyNow}`}
                </strong>
                <span>Tuning</span>
                <strong>
                  {Math.abs(a.tuningCents ?? 0) < 1
                    ? 'In tune with A440'
                    : `${Math.abs(a.tuningCents!).toFixed(0)}¢ ${a.tuningCents! > 0 ? 'sharp' : 'flat'}`}
                </strong>
              </div>
              {correction !== null && correction !== 0 && (
                <Button
                  size="sm"
                  variant={cents === correction ? 'default' : 'primary'}
                  active={cents === correction}
                  onClick={() => update(song, { pitch: { semitones, cents: correction } })}
                  title="Shift the recording so it lines up with a bass tuned to A440"
                >
                  {cents === correction ? 'Matched to A440' : `Match A440 (${formatCents(correction)})`}
                </Button>
              )}
            </>
          ) : (
            <AnalysisStatus song={song} />
          )}
        </div>
      </Popover>
    </div>
  )
}

function AnalysisStatus({ song }: { song: Song }) {
  const a = song.analysis
  if (a.status === 'running' || a.status === 'pending')
    return (
      <p className="pop-note">
        <span className="spinner" /> Analysing beats, key and tuning…
      </p>
    )
  return (
    <div className="pop-note">
      {a.status === 'unavailable' ? 'Analysis needs the audio environment (see the top bar).' : `Analysis failed: ${a.error ?? 'unknown error'}`}{' '}
      {a.status === 'failed' && (
        <Button size="sm" variant="ghost" icon="refresh" onClick={() => void attempt(() => window.nota.songs.retryAnalysis(song.id))}>
          Retry
        </Button>
      )}
    </div>
  )
}

// ---- Metronome -----------------------------------------------------------------------

const taps: { wall: number; song: number | null }[] = []

function tapBeat(song: Song) {
  const wall = performance.now() / 1000
  if (taps.length && wall - taps[taps.length - 1].wall > 2.5) taps.length = 0
  // You tap on what you hear, which leaves the speakers a little after the
  // media clock reports it; subtract the output latency.
  const latency = player.heardDelay * song.speed
  taps.push({ wall, song: player.isPlaying ? player.currentTime - latency : null })
  if (taps.length > 12) taps.shift()
  const bpm = tapTempo(taps.map((t) => t.wall))
  if (!bpm) return
  const songTimes = taps.map((t) => t.song).filter((t): t is number => t !== null)
  const songBpm = bpm * song.speed // taps are in real time; the grid is in song time
  const offset = songTimes.length >= 3 ? tapOffset(songTimes, songBpm) : (song.tempo?.offset ?? 0)
  update(song, { tempo: { bpm: Math.round(songBpm * 10) / 10, offset } })
}

export function toggleMetronome() {
  const m = getState().snapshot?.project?.metronome
  if (m) void attempt(() => window.nota.project.updateMetronome({ enabled: !m.enabled }))
}

/**
 * The detected tempo where the playhead is, rounded to whole BPM so it only
 * changes when the music does. Null for a fixed tempo you set yourself.
 */
function useTempoAtPlayhead(song: Song): number | null {
  const grid = useSongGrid(song)
  const beats = song.tempo ? null : grid?.beats
  const [bpm, setBpm] = useState<number | null>(null)
  useEffect(() => {
    if (!beats) return setBpm(null)
    const tick = () => {
      const b = localBpm(beats, player.currentTime)
      setBpm(b === null ? null : Math.round(b))
    }
    tick()
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [beats])
  return bpm
}

export function MetronomeControl({ song }: { song: Song }) {
  const metro = useStore((s) => s.snapshot!.project!.metronome)
  const detected = useDetectedGrid(song)
  const bpm = bpmOf(song)
  const nowBpm = useTempoAtPlayhead(song)
  const setMetro = (patch: Partial<typeof metro>) => void attempt(() => window.nota.project.updateMetronome(patch))
  const noTempo = bpm === null
  const perBar = song.beatsPerBar ?? (detected ? Math.max(1, Math.round(detected.beatsPerBar * song.gridScale)) : 4)
  const firstBeat = detected?.beats[detected.downbeatIndex] ?? 0
  const setBpm = (n: number) => update(song, { tempo: { bpm: Math.max(BPM_MIN, Math.min(BPM_MAX, n)), offset: song.tempo?.offset ?? firstBeat } })

  return (
    <div className="practice-group">
      <Button
        size="sm"
        icon="metronome"
        active={metro.enabled}
        disabled={noTempo}
        title={noTempo ? 'Waiting for beat detection…' : 'Metronome on/off (K)'}
        onClick={() => setMetro({ enabled: !metro.enabled })}
      >
        Click
      </Button>
      <span
        className="bpm-readout"
        title={song.tempo ? 'Fixed tempo you set' : `Tempo at the playhead (song average ${bpm ? bpm.toFixed(1) : '—'} BPM)`}
      >
        {nowBpm !== null && detected && !detected.steady && <span className="bpm-now">now</span>}
        {nowBpm ?? (bpm ? bpm.toFixed(1) : '—')} <span>BPM</span>
        {song.analysis.status === 'ready' && !song.tempo && <span className="bpm-meter">{perBar}/4</span>}
      </span>
      <Popover
        align="right"
        trigger={(open, toggle) => <Button size="sm" variant="ghost" icon="more" active={open} title="Metronome and grid settings" onClick={toggle} />}
      >
        <div className="pop-section">
          <h5>Click</h5>
          <div className="pop-grid">
            <span>Volume</span>
            <Slider
              value={metro.volume}
              min={0}
              max={1}
              defaultValue={0.6}
              onChange={(v) => setMetro({ volume: v })}
              format={(v) => `${Math.round(v * 100)}%`}
              parse={(t) => {
                const n = parseNumber(t)
                return n === null ? null : n / 100
              }}
            />
            <span>Count-in</span>
            <div className="seg">
              {[0, 1, 2].map((n) => (
                <button key={n} type="button" className={metro.countInBars === n ? 'is-active' : ''} onClick={() => setMetro({ countInBars: n })}>
                  {n === 0 ? 'Off' : `${n} bar${n > 1 ? 's' : ''}`}
                </button>
              ))}
            </div>
            <span>Accent the 1</span>
            <Toggle checked={metro.accent !== false} label="Click the first beat of each bar louder" onChange={(accent) => setMetro({ accent })} />
          </div>
        </div>
        <div className="pop-section">
          <h5>Beat grid</h5>
          <p className="pop-note">
            {song.tempo
              ? 'Using a fixed tempo you set.'
              : song.analysis.status === 'ready'
                ? `Detected ${song.analysis.steady ? 'a steady' : 'a varying'} tempo — the grid and click follow the song${song.analysis.steady ? '' : '’s tempo changes'}.`
                : 'Beat detection is still running.'}
          </p>
          <div className="pop-grid">
            <span>Beats per bar</span>
            <Stepper
              value={perBar}
              format={(v) => `${v}${song.beatsPerBar === null ? ' (auto)' : ''}`}
              onStep={(d) => update(song, { beatsPerBar: Math.max(1, Math.min(12, perBar + d)) })}
            />
            <span>Feel</span>
            <div className="seg">
              {([0.5, 1, 2] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  className={song.gridScale === g ? 'is-active' : ''}
                  disabled={!!song.tempo}
                  title={g === 0.5 ? 'Half time: click on every other detected beat' : g === 2 ? 'Double time: click twice per detected beat' : 'As detected'}
                  onClick={() => update(song, { gridScale: g })}
                >
                  {g === 0.5 ? '½×' : g === 2 ? '2×' : '1×'}
                </button>
              ))}
            </div>
            <span>Bars</span>
            <div className="seg">
              {([false, true] as const).map((even) => (
                <button
                  key={String(even)}
                  type="button"
                  className={song.evenBars === even ? 'is-active' : ''}
                  disabled={!!song.tempo}
                  title={even ? 'Count bars evenly through the whole song, even where the detection hears a short bar or a shifted downbeat' : 'Bar lines follow short bars and shifted downbeats the detection hears'}
                  onClick={() => update(song, { evenBars: even })}
                >
                  {even ? 'Even' : 'Follow song'}
                </button>
              ))}
            </div>
            <span>Bar starts</span>
            <Stepper
              value={song.downbeat}
              format={(v) => (v === 0 ? 'as detected' : `${v > 0 ? '+' : ''}${v} beat${Math.abs(v) === 1 ? '' : 's'}`)}
              onStep={(d) => update(song, { downbeat: song.downbeat + d })}
            />
            <span>Tempo</span>
            <Stepper
              value={bpm ?? 0}
              format={(v) => (v ? v.toFixed(1) : '—')}
              editValue={bpm ? bpm.toFixed(1) : ''}
              disableMinus={noTempo}
              disablePlus={noTempo}
              onStep={(d, big) => bpm && setBpm(bpm + d * (big ? 1 : 0.1))}
              onEdit={(text) => {
                const n = parseNumber(text)
                if (n !== null) setBpm(n)
              }}
            />
          </div>
          <div className="pop-row pop-buttons">
            <Button size="sm" variant="ghost" icon="tap" title="Tap along while the song plays to set a fixed tempo grid" onClick={() => tapBeat(song)}>
              Tap tempo
            </Button>
            <div className="spacer" />
            {(song.tempo || song.beatsPerBar !== null || song.downbeat !== 0 || song.gridScale !== 1 || song.evenBars) && (
              <Button
                size="sm"
                variant="ghost"
                icon="reset"
                disabled={song.analysis.status !== 'ready'}
                onClick={() => update(song, { tempo: null, beatsPerBar: null, downbeat: 0, gridScale: 1, evenBars: false })}
              >
                Use detected
              </Button>
            )}
          </div>
        </div>
      </Popover>
    </div>
  )
}
