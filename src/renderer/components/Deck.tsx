import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { effectiveMode } from '../../shared/project'
import { SKIP_SECONDS, type LoopRegion, type Song } from '../../shared/types'
import { CutMap, cutGrid, isBarLine } from '../../shared/cuts'
import { bpmOf, transposeKey, type GridLike } from '../../shared/music'
import { togglePlayback, useDetectedGrid, useSelectedSong, useSongGrid } from '../audio/sync'
import { attempt, player, readPref, setState, toast, useStore, writePref } from '../state/store'
import { ModeSelector } from './ModeSelector'
import { KeyControl, MetronomeControl, SpeedControl } from './PracticeControls'
import { MonitorButton, SONG_DB_MIN, useLevels } from './Mixer'
import { toggleSidePane } from './Settings'
import { Button, formatDb, Icon, InlineEdit, Popover, Slider } from './ui'
import { formatPosition, useWaveform, Waveform, type View } from './Waveform'
import { NotesView, useBassNotes, useTake } from './NotesView'
import { shortcut } from '../platform'

/**
 * Position and length. In minutes both leave out practice cuts (the song as you
 * hear it); in bars the position keeps the song's own bar numbers, like the
 * ruler, and the length counts the bars that are left.
 */
function Clock({ duration, grid, cuts }: { duration: number; grid: GridLike | null; cuts: Song['cuts'] }) {
  const mode = useStore((s) => s.timeFormat)
  const [t, setT] = useState(0)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      setT(player.currentTime)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  const bars = mode === 'bars' && !!grid
  const cutsKey = JSON.stringify(cuts)
  const map = useMemo(() => new CutMap(cuts, duration), [cutsKey, duration])
  const keptBars = useMemo(() => {
    if (!grid || map.empty) return null
    const g = cutGrid(grid, map)
    return g.beats.filter((_, i) => isBarLine(g, i)).length
  }, [grid, map])
  const toggle = () => {
    const next = mode === 'bars' ? 'time' : 'bars'
    writePref('timeFormat', next)
    setState({ timeFormat: next })
  }
  return (
    <button
      type="button"
      className="clock"
      onClick={toggle}
      title={grid ? `Showing ${bars ? 'bar.beat.sixteenth' : 'minutes:seconds'} — click to switch` : 'Bars appear once beats are detected'}
    >
      <span className="clock-now">{bars ? formatPosition(t, 'bars', grid, true) : formatPosition(map.toDisplay(t), 'time', null, true)}</span>
      <span className="clock-sep">/</span>
      <span className="clock-total" title={map.empty ? undefined : 'Length without the cut parts'}>
        {bars ? (keptBars ?? formatPosition(duration, 'bars', grid)) : formatPosition(map.kept, 'time', null)}
      </span>
      <span className="clock-unit">{bars ? 'bars' : 'min'}</span>
    </button>
  )
}

export function setLoop(song: Song, loop: LoopRegion | null) {
  void attempt(() => window.nota.songs.update(song.id, { loop }))
}

/**
 * Cut the selected part (the loop region) out of the song: playback skips it
 * and the views leave it out. Backspace, or the Cut button. Undo with ⌘Z.
 */
export function cutSelection(song: Song) {
  if (!song.loop) {
    toast('Select a part first: Ctrl-drag on the waveform, then press Backspace to cut it')
    return
  }
  const { start, end } = song.loop
  void attempt(async () => {
    await window.nota.songs.update(song.id, { cuts: [...song.cuts, { start, end }], loop: null })
    toast(`Cut out. Playback skips it; ${shortcut('Z')} or Restore brings it back.`, 'info', 3500)
  })
}

export function restoreCuts(song: Song, keep: Song['cuts'] = []) {
  void attempt(() => window.nota.songs.update(song.id, { cuts: keep }))
}

/** Set loop start/end at the playhead (I / O keys). */
export function markLoop(song: Song, edge: 'start' | 'end') {
  const t = player.currentTime
  const cur = song.loop
  if (edge === 'start') {
    const end = cur && cur.end > t + 0.1 ? cur.end : Math.min(song.durationSec, t + 8)
    setLoop(song, { start: t, end, enabled: true })
  } else {
    const start = cur && cur.start < t - 0.1 ? cur.start : Math.max(0, t - 8)
    setLoop(song, { start, end: t, enabled: true })
  }
}

export function Deck() {
  const song = useSelectedSong()
  if (!song)
    return (
      <section className="deck deck-empty">
        <span>Select a song to start practicing</span>
      </section>
    )
  return <DeckInner song={song} />
}

const VIEW_DEFAULT = 140
const VIEW_MIN = 90
/** How tall the deck grows by itself into space a short playlist leaves empty. */
const VIEW_AUTO_MAX = 560
/** The playlist keeps room for its header and about one song row; the rest of its songs scroll. */
const PLAYLIST_MIN = 100

/**
 * The tallest the waveform can be: the workspace (the playlist above, the deck
 * below), less the deck's own bars and controls and the playlist's minimum.
 * Measured, so it holds however the deck's controls wrap, and it stays put while you drag.
 */
function maxViewHeight(): number {
  const workspace = document.querySelector<HTMLElement>('.workspace')
  const deck = workspace?.querySelector<HTMLElement>('.deck')
  const view = deck?.querySelector<HTMLElement>('.deck-view')
  if (!workspace || !deck || !view) return Infinity
  return workspace.clientHeight - (deck.offsetHeight - view.offsetHeight) - PLAYLIST_MIN
}

/**
 * The deck's top edge: drag it up to make the waveform (or notes) taller and
 * the playlist shorter, down for the opposite. Double-click resets it.
 */
function ResizeHandle({ height, onChange, onReset }: { height: number; onChange: (h: number) => void; onReset: () => void }) {
  const start = (e: React.PointerEvent) => {
    e.preventDefault()
    const y0 = e.clientY
    const h0 = height
    const max = maxViewHeight()
    const move = (ev: PointerEvent) => onChange(Math.round(Math.min(max, Math.max(VIEW_MIN, h0 + (y0 - ev.clientY)))))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('is-resizing')
    }
    document.body.classList.add('is-resizing')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div
      className="deck-resize"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the waveform"
      title="Drag to resize the waveform · double-click to let it fit the window again"
      onPointerDown={start}
      onDoubleClick={onReset}
    />
  )
}

/** Space under the playlist's last row that the songs don't need (negative when they scroll). */
function playlistFreeSpace(): number {
  const main = document.querySelector<HTMLElement>('.workspace .main')
  const rows = document.querySelector<HTMLElement>('.playlist-rows')
  const last = rows?.lastElementChild as HTMLElement | null
  if (!main || !rows || !last) return 0
  const used = last.getBoundingClientRect().bottom + parseFloat(getComputedStyle(last).marginBottom) - rows.getBoundingClientRect().top + rows.scrollTop
  return rows.clientHeight - used
}

/**
 * Waveform height. Until you drag it, it grows into the space a short playlist
 * leaves empty (up to VIEW_AUTO_MAX) and gives it back as songs are added; a
 * height you drag is remembered, and double-clicking the edge goes back to
 * fitting. Either way it shrinks with the window so the playlist never disappears.
 */
function useViewHeight(songCount: number): [number, (h: number) => void, () => void] {
  // (A new key: heights dragged before the deck could fit itself don't hold it back.)
  const [manual, setManual] = useState<number | null>(() => readPref<number | null>('deckHeight', null))
  const [auto, setAuto] = useState(VIEW_DEFAULT)
  const [winH, setWinH] = useState(window.innerHeight)
  // Measured, not estimated: the deck's controls take more or less room with the window's width.
  const [max, setMax] = useState(Infinity)
  useEffect(() => {
    const on = () => setWinH(window.innerHeight)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  useLayoutEffect(() => {
    const measure = () => setMax(maxViewHeight())
    measure()
    const observer = new ResizeObserver(measure)
    for (const el of document.querySelectorAll('.workspace, .workspace .deck')) observer.observe(el)
    return () => observer.disconnect()
  }, [winH])
  // The deck and the playlist share the height, so the current height plus the
  // playlist's free space is where it settles: one step, no back and forth.
  useLayoutEffect(() => {
    if (manual !== null) return
    const fit = () => setAuto((h) => {
      const next = Math.round(Math.max(VIEW_DEFAULT, Math.min(VIEW_AUTO_MAX, h + playlistFreeSpace())))
      return Math.abs(next - h) > 1 ? next : h
    })
    fit()
    const main = document.querySelector('.workspace .main')
    const observer = new ResizeObserver(fit)
    if (main) observer.observe(main)
    return () => observer.disconnect()
  }, [manual, songCount, winH])
  const set = (v: number) => {
    setManual(v)
    writePref('deckHeight', v)
  }
  const reset = () => {
    setManual(null)
    writePref('deckHeight', null)
  }
  return [Math.max(VIEW_MIN, Math.min(manual ?? auto, max)), set, reset]
}

function DeckInner({ song }: { song: Song }) {
  const songCount = useStore((s) => s.snapshot?.project?.songs.length ?? 0)
  const [viewHeight, setViewHeight, fitViewHeight] = useViewHeight(songCount)
  const [deckView, setDeckViewState] = useState<'waveform' | 'notes'>(() => readPref('bassView', 'waveform'))
  const setDeckView = (v: 'waveform' | 'notes') => {
    setDeckViewState(v)
    writePref('bassView', v)
  }
  const { playing, buffering, error } = useStore((s) => s.player)
  const countingIn = useStore((s) => s.countingIn)
  const mode = effectiveMode(song)
  const waveKind = mode === 'bass' ? 'bass' : mode === 'playalong' ? 'backing' : 'original'
  // Notes work in every mode: read the bass line while hearing the original or the play-along.
  const showNotes = mode !== null && deckView === 'notes'
  // Correcting the notes (the Notes view's edit mode)
  const [noteEditing, setNoteEditing] = useState(false)
  // Time zoom and position, shared by the waveform and the Notes view.
  const [view, setView] = useState<View>({ start: 0, span: song.durationSec || 1 })
  // In display time (the song without its cuts). A new song starts at the
  // whole-song view; a cut keeps the zoom and the place in the song.
  const cutsKey = JSON.stringify(song.cuts)
  const shownCuts = useRef({ id: song.id, map: new CutMap(song.cuts, song.durationSec) })
  useEffect(() => {
    const map = new CutMap(song.cuts, song.durationSec)
    const before = shownCuts.current
    shownCuts.current = { id: song.id, map }
    if (before.id !== song.id) return setView({ start: 0, span: map.kept || 1 })
    setView((v) => {
      const span = Math.min(v.span, map.kept || 1)
      const start = map.toDisplay(before.map.toSong(v.start))
      return { start: Math.max(0, Math.min((map.kept || 1) - span, start)), span }
    })
  }, [song.id, song.durationSec, cutsKey])
  // Follow (like Logic's Catch and Live's Follow): while playing, a zoomed-in view
  // turns the page as the playhead nears its edge. Scrolling the timeline yourself
  // while playing pauses it until playback next starts; the Follow button turns it
  // off or on for good. Pausing never moves the view.
  const [followOn, setFollowOn] = useState(() => readPref('followPlayhead', true))
  const [followPaused, setFollowPaused] = useState(false)
  const following = followOn && !followPaused
  const zoomedIn = view.span < (shownCuts.current.map.kept || 1) - 0.01
  const catchPlayhead = () => {
    const pos = shownCuts.current.map.toDisplay(player.currentTime)
    const kept = shownCuts.current.map.kept || 1
    setView((v) => (pos >= v.start && pos <= v.start + v.span ? v : { start: Math.max(0, Math.min(kept - v.span, pos - v.span * 0.15)), span: v.span }))
  }
  const toggleFollow = () => {
    const on = !following
    setFollowOn(on)
    writePref('followPlayhead', on)
    setFollowPaused(false)
    if (on) catchPlayhead()
  }
  useEffect(() => {
    if (!playing) return
    setFollowPaused(false)
    if (followOn) catchPlayhead()
  }, [playing]) // eslint-disable-line react-hooks/exhaustive-deps
  const scrolledByUser = () => {
    if (player.isPlaying) setFollowPaused(true)
  }
  const notes = useBassNotes(song, showNotes)
  // The Notes view opens on about 8 bars around the playhead, where the notes and
  // their names are readable (the whole song makes them specks); Fit shows it all.
  useEffect(() => {
    if (!showNotes) return
    const map = shownCuts.current.map
    const kept = map.kept || 1
    setView((v) => {
      if (v.span < kept - 0.01) return v
      const bpm = bpmOf(song)
      const beatsPerBar = song.beatsPerBar ?? (song.analysis.status === 'ready' ? song.analysis.beatsPerBar : null) ?? 4
      const span = Math.min(kept, bpm ? (8 * beatsPerBar * 60) / bpm : 16)
      const pos = map.toDisplay(player.currentTime)
      return { start: Math.max(0, Math.min(kept - span, pos - span * 0.15)), span }
    })
  }, [showNotes, song.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Takes: record yourself playing along, then see your notes over the song's.
  const take = useTake(song)
  const recording = take.status === 'recording'
  const record = async () => {
    if (recording) return void attempt(() => window.nota.songs.stopTake(), 'Recording')
    const started = await attempt(() => window.nota.songs.recordTake(song.id).then(() => true), 'Recording')
    if (started && !player.isPlaying && !countingIn) togglePlayback()
  }
  // A take ends when playback stops or pauses, or the song changes.
  const wasPlaying = useRef(playing)
  useEffect(() => {
    if (wasPlaying.current && !playing && recording) void window.nota.songs.stopTake()
    wasPlaying.current = playing
  }, [playing, recording])
  const recordingRef = useRef(recording)
  recordingRef.current = recording
  useEffect(() => () => void (recordingRef.current && window.nota.songs.stopTake()), [song.id])
  // A finished take (or why it failed) is shown in the Notes view.
  const takeStatus = take.status
  useEffect(() => {
    if ((takeStatus === 'ready' || takeStatus === 'failed') && deckView !== 'notes') setDeckView('notes')
  }, [takeStatus]) // eslint-disable-line react-hooks/exhaustive-deps
  const stem = waveKind === 'original' ? null : song.stems[waveKind]
  const wave = useWaveform(song.id, waveKind, waveKind === 'original' ? song.source.hash : (stem?.cachePath ?? null))
  const grid = useSongGrid(song)
  const timeFormat = useStore((s) => s.timeFormat)
  const loop = song.loop
  const canPlay = mode !== null
  const a = song.analysis
  // A string, not an object: store selectors must return stable values.
  const [prevId, nextId] = useStore((s) => {
    const list = s.snapshot?.project?.songs ?? []
    const i = list.findIndex((x) => x.id === song.id)
    return `${list[i - 1]?.id ?? ''}|${list[i + 1]?.id ?? ''}`
  }).split('|')
  const neighbours = { prev: prevId || null, next: nextId || null }

  return (
    <section className="deck">
      <ResizeHandle height={viewHeight} onChange={setViewHeight} onReset={fitViewHeight} />
      <div className="deck-head">
        <div className="deck-nav">
          <button type="button" className="deck-step" title="Previous song (↑)" aria-label="Previous song" disabled={!neighbours.prev} onClick={() => neighbours.prev && void attempt(() => window.nota.songs.select(neighbours.prev!))}>
            <Icon name="chevLeft" size={16} />
          </button>
        <div className="deck-title">
          <InlineEdit
            className="deck-song"
            value={song.title}
            placeholder="Title"
            onCommit={(title) => title && title !== song.title && void attempt(() => window.nota.songs.update(song.id, { title }))}
          />
          <InlineEdit
            className="deck-artist"
            value={song.artist ?? ''}
            placeholder="Add artist"
            onCommit={(artist) => artist !== (song.artist ?? '') && void attempt(() => window.nota.songs.update(song.id, { artist: artist || null }))}
          />
          {a.status === 'ready' && <SongFacts song={song} />}
          {song.separation.warning && (
            <span className="deck-note" title={song.separation.warning}>
              <Icon name="alert" size={12} />
              <span className="deck-note-text">{song.separation.warning}</span>
            </span>
          )}
          {error && <span className="deck-error">{error}</span>}
        </div>
          <button type="button" className="deck-step" title="Next song (↓)" aria-label="Next song" disabled={!neighbours.next} onClick={() => neighbours.next && void attempt(() => window.nota.songs.select(neighbours.next!))}>
            <Icon name="chevRight" size={16} />
          </button>
        </div>
        {mode !== null && (
          <div className="seg view-switch" role="radiogroup" aria-label="Show">
            {(['waveform', 'notes'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={deckView === v}
                aria-label={v === 'waveform' ? 'Waveform' : 'Notes'}
                title={v === 'waveform' ? 'Show the waveform' : 'Show the bass notes (piano roll)'}
                className={deckView === v ? 'is-active' : ''}
                onClick={() => setDeckView(v)}
              >
                <Icon name={v} size={14} />
              </button>
            ))}
          </div>
        )}
        {showNotes && (
          <div className="seg view-switch">
            <button
              type="button"
              aria-pressed={noteEditing}
              title={noteEditing ? 'Stop editing the notes (E)' : song.editedNotes ? 'Edit the notes (E). You’ve corrected them already' : 'Edit the notes (E): add, move, resize and delete them'}
              className={noteEditing ? 'is-active' : ''}
              onClick={() => setNoteEditing((v) => !v)}
            >
              <Icon name="edit" size={14} />
              <span className="view-switch-label">{noteEditing ? 'Editing' : song.editedNotes ? 'Edited' : 'Edit'}</span>
            </button>
          </div>
        )}
        <ModeSelector song={song} />
      </div>

      <div className="deck-view" style={{ height: viewHeight }}>
        {showNotes ? (
          <NotesView
            song={song}
            state={notes}
            duration={song.durationSec}
            getPosition={() => player.currentTime}
            isPlaying={() => player.isPlaying}
            onSeek={(t) => player.seek(t)}
            onLoopChange={(l) => setLoop(song, l)}
            onLoopRemove={() => setLoop(song, null)}
            loop={loop}
            grid={grid}
            ruler={timeFormat === 'bars' && grid ? 'bars' : 'time'}
            view={view}
            onViewChange={setView}
            following={following}
            onUserScroll={scrolledByUser}
            cuts={song.cuts}
            take={take}
            editing={noteEditing}
            onEditingChange={setNoteEditing}
          />
        ) : (
        <Waveform
          wave={wave}
          duration={song.durationSec}
          getPosition={() => player.currentTime}
          isPlaying={() => player.isPlaying}
          loop={loop}
          grid={grid}
          ruler={timeFormat === 'bars' && grid ? 'bars' : 'time'}
          onSeek={(t) => player.seek(t)}
          onLoopChange={(l) => setLoop(song, l)}
          onLoopRemove={() => setLoop(song, null)}
          pending={!canPlay ? 'Nothing to play yet' : null}
          view={view}
          onViewChange={setView}
          following={following}
          onUserScroll={scrolledByUser}
          cuts={song.cuts}
        />
        )}
        {zoomedIn && (
          <button
            type="button"
            className={`wave-follow${following ? ' is-on' : ''}`}
            aria-pressed={following}
            title={following ? 'Following the playhead: the view turns the page as it plays. Click to stop.' : followOn ? 'Paused while you look around. Click, or press play, to follow the playhead again.' : 'Follow the playhead while playing'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={toggleFollow}
          >
            <Icon name="play" size={10} />
            Follow
          </button>
        )}
      </div>

      <div className="deck-controls">
        <div className="transport">
          <Button variant="ghost" icon="back" title={`Back ${SKIP_SECONDS} s (←)`} onClick={() => player.skip(-SKIP_SECONDS)} disabled={!canPlay} />
          <button
            type="button"
            className={`play-btn${playing || countingIn ? ' is-playing' : ''}`}
            title={playing ? 'Pause (Space)' : 'Play (Space)'}
            disabled={!canPlay}
            onClick={() => togglePlayback()}
          >
            {buffering ? <span className="spinner" /> : <Icon name={playing || countingIn ? 'pause' : 'play'} size={18} />}
          </button>
          <Button variant="ghost" icon="forward" title={`Forward ${SKIP_SECONDS} s (→)`} onClick={() => player.skip(SKIP_SECONDS)} disabled={!canPlay} />
          <button
            type="button"
            className={`rec-btn${recording ? ' is-recording' : ''}`}
            title={recording ? 'Stop recording' : 'Record yourself playing along, then compare your notes with the song'}
            aria-pressed={recording}
            disabled={!canPlay || take.status === 'transcribing'}
            onClick={() => void record()}
          >
            <span className="rec-dot" />
            <span className="rec-label">{recording ? 'Stop' : 'Take'}</span>
          </button>
          <Clock duration={song.durationSec} grid={grid} cuts={song.cuts} />
          {countingIn && <span className="count-in">Count-in…</span>}
        </div>

        <div className="loop-controls">
          <Button
            size="sm"
            icon="loop"
            active={!!loop?.enabled}
            disabled={!loop}
            title={!loop ? 'Ctrl-drag across the waveform to make a loop' : loop.enabled ? 'Remove the loop' : 'Loop this part (L)'}
            // On: remove the loop. A loop turned off with L can be turned back on here.
            onClick={() => loop && setLoop(song, loop.enabled ? null : { ...loop, enabled: true })}
          >
            Loop
          </Button>
          <span className={`loop-range${loop ? '' : ' is-empty'}`}>
            {loop
              ? `${formatPosition(loop.start, timeFormat, grid, true)} – ${formatPosition(loop.end, timeFormat, grid, true)}`
              : 'Ctrl-drag to loop'}
          </span>
          {loop && (
            <Button size="sm" variant="ghost" icon="scissors" className="loop-cut" title="Cut this part out: playback skips it (Backspace)" onClick={() => cutSelection(song)}>
              Cut
            </Button>
          )}
          {song.cuts.length > 0 && <CutsMenu song={song} />}
        </div>

        <QuickLevels />
      </div>

      <div className="deck-practice">
        <SpeedControl song={song} />
        <span className="practice-sep" />
        <KeyControl song={song} />
        <span className="practice-sep" />
        <MetronomeControl song={song} />
      </div>
    </section>
  )
}

/**
 * Key and tempo after the title: as recorded, and what you hear now when the
 * key or speed is changed ("G major → A major"). A tempo that moves around
 * is shown as the song's average.
 */
function SongFacts({ song }: { song: Song }) {
  const detected = useDetectedGrid(song)
  const a = song.analysis
  const semis = song.pitch.semitones
  const bpm = bpmOf(song)
  const steady = !!song.tempo || detected?.steady !== false
  const heard = bpm !== null && song.speed !== 1 ? Math.round(bpm * song.speed) : null
  const keyTitle = semis ? `Recorded in ${a.key}; you hear it in ${transposeKey(a.key ?? '', semis)}` : 'Detected from the recording'
  const bpmTitle = [
    song.tempo ? 'Tempo you set' : steady ? 'Detected tempo' : 'Average tempo: it changes through the song (the metronome follows it)',
    heard !== null ? `${Math.round(song.speed * 100)}% speed: you hear ${heard} BPM` : null
  ]
    .filter(Boolean)
    .join('. ')
  return (
    <span className="deck-facts">
      {a.key && (
        <span title={keyTitle}>
          {a.key}
          {semis !== 0 && <b> → {transposeKey(a.key, semis)}</b>}
        </span>
      )}
      {a.key && bpm !== null && ' · '}
      {bpm !== null && (
        <span title={bpmTitle}>
          {steady ? '' : 'avg '}
          {Math.round(bpm)}
          {heard !== null && <b> → {heard}</b>} BPM
        </span>
      )}
    </span>
  )
}

/** The song's cuts, each restorable, or all at once. */
function CutsMenu({ song }: { song: Song }) {
  const grid = useSongGrid(song)
  const timeFormat = useStore((s) => s.timeFormat)
  const n = song.cuts.length
  return (
    <Popover
      align="right"
      trigger={(open, toggle) => (
        <Button size="sm" variant="ghost" icon="scissors" active={open} title="Parts cut out of this song" onClick={toggle}>
          {n} {n === 1 ? 'cut' : 'cuts'}
        </Button>
      )}
    >
      <div className="pop-section">
        <h5>Cut out</h5>
        <p className="pop-note">Playback skips these parts. Nothing is deleted.</p>
        <div className="cut-list">
          {song.cuts.map((c, i) => (
            <div key={`${c.start}-${c.end}`} className="cut-row">
              <span>
                {formatPosition(c.start, timeFormat, grid, true)} – {formatPosition(c.end, timeFormat, grid, true)}
              </span>
              <Button size="sm" variant="ghost" icon="reset" title="Put this part back" onClick={() => restoreCuts(song, song.cuts.filter((_, j) => j !== i))}>
                Restore
              </Button>
            </div>
          ))}
        </div>
        <Button size="sm" icon="reset" onClick={() => restoreCuts(song)}>
          Restore all
        </Button>
      </div>
    </Popover>
  )
}

/**
 * The everyday balance at the end of the transport row: hear your bass or
 * not, and how loud it and the song are. The full strips live in the Mixer.
 */
function QuickLevels() {
  const running = useStore((s) => s.engine?.status === 'running')
  const monitoring = useStore((s) => s.engine?.monitoring ?? false)
  const levels = useLevels()
  const mixerShown = useStore((s) => s.effectsOpen && !s.sidePane)
  return (
    <div className={`quick-levels${monitoring ? ' is-monitoring' : ''}`}>
      <MonitorButton compact />
      <div className="quick-level is-bass" title="How loud you hear your bass (the Monitor level)">
        <span>Bass</span>
        <Slider value={levels.monitor} min={-60} max={6} step={0.5} defaultValue={-6} format={formatDb} disabled={!running} ticks={1} onChange={levels.setMonitor} />
      </div>
      <div className="quick-level" title="Song playback level (0 dB = as recorded)">
        <span>Song</span>
        <Slider value={levels.songDb} min={SONG_DB_MIN} max={6} step={0.5} defaultValue={0} format={formatDb} ticks={1} onChange={levels.setSongDb} />
      </div>
      <Button
        size="sm"
        variant="ghost"
        icon="sliders"
        active={mixerShown}
        title={mixerShown ? 'Hide the Mixer' : 'Show the Mixer: inputs, effects, tuner and output'}
        onClick={() => toggleSidePane('effects')}
      />
    </div>
  )
}
