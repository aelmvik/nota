import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { CutMap, cutGrid, cutRegion, isBarLine } from '../../shared/cuts'
import type { GridLike } from '../../shared/music'
import type { TakeState } from '../../shared/takes'
import type { BassNote, LoopRegion, NotesState, Song } from '../../shared/types'
import { useStore } from '../state/store'
import { useColorScheme } from '../theme'
import { Button } from './ui'
import { followStart, formatPosition, snapToGrid, zoomAnchor, type View } from './Waveform'
import { flipHeld, flipKey } from '../platform'

// The Notes view (any mode): the separated bass transcribed into notes
// (main/transcription.ts) and drawn as a piano roll in the waveform's place.
// Time works as on the waveform (Ctrl+scroll or pinch zooms, sideways scroll moves
// along, click seeks); ⌘+scroll (Alt+scroll off the Mac) zooms the pitch axis, plain scroll moves up
// and down the keyboard, and double-clicking the keyboard fits all notes.
// Ctrl+right-click fits both: the whole song and all its notes.

const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']
const pc = (m: number) => ((m % 12) + 12) % 12
export const noteName = (m: number) => `${NAMES[pc(m)]}${Math.floor(m / 12) - 1}`
const isBlack = (m: number) => [1, 3, 6, 8, 10].includes(pc(m))

const KEYS_W = 48
const RULER_H = 18
const PITCH_MIN = 12 // C0
const PITCH_MAX = 96 // C7
/** Row height limits in pixels (⌘+scroll zooms between them) */
const ROW_H_MIN = 4
const ROW_H_MAX = 48

/** The song's notes, fetched (and transcribed on first use) while `enabled`. */
export function useBassNotes(song: Song | null, enabled: boolean): NotesState | null {
  const [state, setState] = useState<NotesState | null>(null)
  const hash = song?.source.hash
  const stem = song?.stems.bass?.cachePath
  useEffect(() => {
    if (!song || !enabled) return
    let alive = true
    const off = window.nota.songs.onNotesState((e) => alive && e.hash === hash && setState(e.state))
    void window.nota.songs.notes(song.id).then(
      (s) => alive && setState(s),
      (err) => alive && setState({ status: 'failed', error: String(err?.message ?? err) })
    )
    return () => {
      alive = false
      off()
    }
  }, [song?.id, hash, stem, enabled, song?.separation.status])
  return enabled ? state : null
}

/** Your latest take of the song, kept current while it's recorded and transcribed. */
export function useTake(song: Song | null): TakeState {
  const [state, setState] = useState<TakeState>({ status: 'none' })
  const hash = song?.source.hash
  useEffect(() => {
    setState({ status: 'none' })
    if (!song) return
    let alive = true
    const off = window.nota.songs.onTakeState((e) => alive && e.hash === hash && setState(e.state))
    void window.nota.songs.take(song.id).then((s) => alive && setState(s), () => {})
    return () => {
      alive = false
      off()
    }
  }, [song?.id, hash])
  return state
}

/** Resolve a CSS custom property (which may be a color-mix) to a colour the canvas understands. */
function useThemeColors(el: React.RefObject<HTMLElement | null>) {
  const scheme = useColorScheme()
  const accent = useStore((s) => s.prefs.accent)
  const [c, setC] = useState<Record<string, string> | null>(null)
  useEffect(() => {
    const host = el.current
    if (!host) return
    const read = () => {
      const probe = document.createElement('span')
      probe.style.display = 'none'
      host.appendChild(probe)
      const get = (v: string) => {
        probe.style.color = `var(${v})`
        return getComputedStyle(probe).color
      }
      setC({
        bg: get('--display'),
        surface: get('--surface'),
        ink: get('--ink'),
        ink2: get('--ink-2'),
        ink3: get('--ink-3'),
        line: get('--line'),
        brand: get('--brand'),
        onBrand: get('--on-brand'),
        tint: get('--brand-tint'),
        note: get('--note'),
        noteInk: get('--note-ink'),
        take: get('--note-take')
      })
      probe.remove()
    }
    // A frame later: the accent is put on <html> by another effect, which can run
    // after this one, and reading now would keep the previous theme's colours.
    const frame = requestAnimationFrame(read)
    const watch = new MutationObserver(() => requestAnimationFrame(read))
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-accent', 'class', 'style'] })
    return () => {
      cancelAnimationFrame(frame)
      watch.disconnect()
    }
  }, [scheme, accent, el])
  return c
}

interface Props {
  song: Song
  state: NotesState | null
  duration: number
  getPosition: () => number
  isPlaying: () => boolean
  onSeek: (t: number) => void
  /** Ctrl+drag (or a plain drag, per Settings) makes a loop; the edge handles adjust it. Song time. */
  onLoopChange?: (loop: LoopRegion) => void
  /** Double-click removes the loop */
  onLoopRemove?: () => void
  loop: LoopRegion | null
  grid: GridLike | null
  ruler: 'time' | 'bars'
  /** Practice cuts (song time): left out, as on the waveform */
  cuts: Song['cuts']
  /** Time zoom and position, shared with the waveform so switching views keeps them (display time) */
  view: View
  onViewChange: Dispatch<SetStateAction<View>>
  /** False while the user has scrolled away during playback: the view stays put */
  following?: boolean
  /** The user moved or zoomed the timeline (wheel or pinch) */
  onUserScroll?: () => void
  /** Your latest take, drawn over the song's notes */
  take?: TakeState
}

export function NotesView(props: Props) {
  // Display time, as on the waveform: the song with its cuts removed.
  const { song, state, duration: songDuration, getPosition: rawGetPosition, isPlaying, onSeek: rawOnSeek, onLoopChange: rawOnLoopChange, loop: rawLoop, grid: songGrid, ruler, view, onViewChange: setView, cuts, following = true, onUserScroll, take: takeState } = props
  const cutsKey = JSON.stringify(cuts)
  const cm = useMemo(() => new CutMap(cuts, songDuration), [cutsKey, songDuration])
  const duration = cm.kept
  const grid = useMemo(() => (songGrid ? cutGrid(songGrid, cm) : songGrid), [songGrid, cm])
  const [drag, setDrag] = useState<LoopRegion | null>(null)
  const loop = drag ?? (rawLoop ? cutRegion(rawLoop, cm) : rawLoop)
  const onLoopChange = (l: LoopRegion) => rawOnLoopChange?.({ ...l, start: cm.toSong(l.start), end: cm.toSong(l.end, 'before') })
  const getPosition = useMemo(() => () => cm.toDisplay(rawGetPosition()), [rawGetPosition, cm])
  const onSeek = (t: number) => rawOnSeek(cm.toSong(t))
  const box = useRef<HTMLDivElement>(null)
  const roll = useRef<HTMLCanvasElement>(null)
  const keys = useRef<HTMLCanvasElement>(null)
  const colors = useThemeColors(box)
  const snapPref = useStore((s) => s.prefs.snapToGrid)
  const [size, setSize] = useState({ w: 0, h: 0 })
  // Pitch axis as a centre note and a row height in pixels: resizing the deck
  // shows more or fewer rows at the same size; only ⌘+scroll changes the size.
  const [pitch, setPitch] = useState<{ center: number; rowH: number } | null>(null)
  const shift = song.pitch.semitones // show what you hear after a key change
  const allNotes: BassNote[] = state?.status === 'ready' ? state.notes : []
  // Notes in display time; notes inside cuts are left out, notes across a cut's edge are shortened.
  const notes = useMemo(
    () => (cm.empty ? allNotes : allNotes.flatMap((n) => (cutRegion(n, cm) ? [cutRegion(n, cm)!] : []))),
    [state, cm]
  )

  // Your take, layered over the song's notes (in display time). It isn't graded:
  // both are transcriptions, and neither is exact.
  const takeData = takeState?.status === 'ready' ? takeState.take : null
  const [takeHidden, setTakeHidden] = useState(false)
  useEffect(() => setTakeHidden(false), [takeData])
  const takeShown = useMemo(
    () => (!takeData || takeHidden ? [] : cm.empty ? takeData.notes : takeData.notes.flatMap((n) => (cutRegion(n, cm) ? [cutRegion(n, cm)!] : []))),
    [takeData, takeHidden, cm]
  )

  // Fit the pitch range to the notes when they arrive (or the key changes).
  // Fits the range the bass mostly plays in (5th–95th percentile), so a few
  // stray notes don't squash the rows too thin for names; scroll for the rest.
  const fit = useMemo(() => {
    if (!allNotes.length) return { low: 28 - 2, rows: 24 }
    const ps = allNotes.map((n) => n.pitch + shift).sort((a, b) => a - b)
    const lo = ps[Math.floor(ps.length * 0.05)]
    const hi = ps[Math.min(ps.length - 1, Math.floor(ps.length * 0.95))]
    const rows = Math.min(28, Math.max(14, hi - lo + 5))
    return { low: Math.max(PITCH_MIN, Math.round((lo + hi) / 2 - rows / 2)), rows }
  }, [state, shift])
  const fitAxis = (h: number) => ({ center: fit.low + fit.rows / 2, rowH: Math.min(ROW_H_MAX, Math.max(ROW_H_MIN, h / fit.rows)) })

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.max(0, e.contentRect.width - KEYS_W), h: Math.max(0, e.contentRect.height - RULER_H) }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const spanLimit = (span: number) => Math.min(duration || 1, Math.max(0.5, span))
  const clampView = (v: { start: number; span: number }) => {
    const span = spanLimit(v.span)
    return { start: Math.max(0, Math.min((duration || 1) - span, v.start)), span }
  }
  const clampPitch = (p: { center: number; rowH: number }, h: number) => {
    const rowH = Math.min(ROW_H_MAX, Math.max(ROW_H_MIN, p.rowH))
    const half = h / rowH / 2
    return { center: Math.max(PITCH_MIN + half, Math.min(PITCH_MAX - half, p.center)), rowH }
  }
  // Fit when the notes arrive (and once the view has a height).
  useEffect(() => {
    if (size.h) setPitch(fitAxis(size.h))
  }, [state, size.h > 0])
  // A key change moves every note: follow them at the same zoom.
  const lastShift = useRef(shift)
  useEffect(() => {
    const d = shift - lastShift.current
    lastShift.current = shift
    if (d && size.h) setPitch((p) => p && clampPitch({ ...p, center: p.center + d }, size.h))
  }, [shift])
  const P = pitch ?? fitAxis(size.h || 200)

  // Wheel: Ctrl (and a trackpad pinch) zooms time, ⌘ (Alt) zooms the keyboard,
  // sideways moves in time, up/down moves along the keyboard.
  useEffect(() => {
    const el = roll.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      if (e.ctrlKey) {
        const L = live.current
        const playhead = L.following && L.isPlaying() ? L.getPosition() : null
        setView((v) => {
          const frac = zoomAnchor(v, (e.clientX - r.left) / r.width, playhead)
          const anchor = v.start + frac * v.span
          // Capped before placing, so zooming on at the limit leaves the view where it is.
          const span = spanLimit(v.span * Math.exp(e.deltaY * 0.01))
          return clampView({ start: anchor - frac * span, span })
        })
      } else if (flipHeld(e)) {
        // Zoom around the note under the cursor.
        const frac = 1 - (e.clientY - r.top) / r.height
        setPitch((p0) => {
          const p = p0 ?? fitAxis(r.height)
          const rows = r.height / p.rowH
          const anchor = p.center - rows / 2 + frac * rows
          const rowH = Math.min(ROW_H_MAX, Math.max(ROW_H_MIN, p.rowH * Math.exp(-e.deltaY * 0.01)))
          const rows2 = r.height / rowH
          return clampPitch({ center: anchor - frac * rows2 + rows2 / 2, rowH }, r.height)
        })
      } else {
        // Both at once, so a diagonal swipe moves through time and along the keyboard
        // together; with Shift, up and down moves in time instead.
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX
        const dy = e.shiftKey ? 0 : e.deltaY
        if (dx) {
          onUserScroll?.()
          setView((v) => clampView({ start: v.start + (dx / r.width) * v.span, span: v.span }))
        }
        if (dy)
          setPitch((p0) => {
            const p = p0 ?? fitAxis(r.height)
            return clampPitch({ center: p.center - dy / p.rowH, rowH: p.rowH }, r.height)
          })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [duration, fit, onUserScroll])

  const marks = useMemo(() => cm.marks(), [cm])
  const showGrid = useStore((s) => s.prefs.showGrid)
  // With the metronome's accent off, bar lines look like the other beats too
  const accentBars = useStore((s) => s.snapshot?.project?.metronome.accent !== false)
  const live = useRef({ view, P, notes, loop, grid, showGrid, accentBars, colors, size, shift, getPosition, isPlaying, marks, duration, following, takeShown })
  live.current = { view, P, notes, loop, grid, showGrid, accentBars, colors, size, shift, getPosition, isPlaying, marks, duration, following, takeShown }

  // Draw every frame: rows, grid, loop, notes, playhead, keyboard.
  const paintRoll = useRef<() => void>(() => {})
  useEffect(() => {
    let raf = 0
    const paint = () => {
      const L = live.current
      const c = L.colors
      const rc = roll.current
      const kc = keys.current
      const { w, h } = L.size
      if (!c || !rc || !kc || !w || !h) return
      const dpr = window.devicePixelRatio || 1
      for (const [cv, cw] of [
        [rc, w],
        [kc, KEYS_W]
      ] as const) {
        if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(h * dpr)) {
          cv.width = Math.round(cw * dpr)
          cv.height = Math.round(h * dpr)
        }
      }
      const pos = L.getPosition()
      const turn = L.following && L.isPlaying() ? followStart(L.view, pos, L.duration) : null
      if (turn !== null) setView((v) => clampView({ start: turn, span: v.span }))
      const { start, span } = L.view
      const { center, rowH } = L.P
      const rows = h / rowH
      const low = center - rows / 2
      const toX = (t: number) => ((t - start) / span) * w
      const rowTop = (m: number) => h - (m + 1 - low) * rowH

      const g = rc.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.fillStyle = c.bg
      g.fillRect(0, 0, w, h)
      // Pitch rows: black-key rows shaded, a firmer line under every C.
      for (let m = Math.floor(low); m < low + rows + 1; m++) {
        const y = rowTop(m)
        if (isBlack(m)) {
          g.globalAlpha = 0.06
          g.fillStyle = c.ink
          g.fillRect(0, y, w, rowH)
        }
        g.globalAlpha = pc(m) === 0 ? 0.22 : 0.07
        g.fillStyle = c.ink
        g.fillRect(0, Math.round(y + rowH) - 0.5, w, 1)
      }
      // Beat and bar lines.
      if (L.showGrid && L.grid && L.grid.beats.length > 1) {
        const pxPerBeat = (w / span) * ((L.grid.beats[L.grid.beats.length - 1] - L.grid.beats[0]) / (L.grid.beats.length - 1))
        L.grid.beats.forEach((t, i) => {
          if (t < start || t > start + span) return
          const bar = isBarLine(L.grid!, i)
          if (!bar && pxPerBeat < 8) return
          g.globalAlpha = bar && L.accentBars ? 0.2 : 0.07
          g.fillStyle = c.ink
          g.fillRect(Math.round(toX(t)), 0, 1, h)
        })
      }
      g.globalAlpha = 1
      // Loop.
      if (L.loop) {
        const x0 = toX(L.loop.start)
        const x1 = toX(L.loop.end)
        g.globalAlpha = L.loop.enabled ? 0.14 : 0.05
        g.fillStyle = L.loop.enabled ? c.brand : c.ink
        g.fillRect(x0, 0, x1 - x0, h)
        // Edges, with grab handles at the top (as on the waveform).
        g.globalAlpha = 1
        g.fillStyle = L.loop.enabled ? c.brand : c.ink3
        g.fillRect(Math.round(x0), 0, 1.5, h)
        g.fillRect(Math.round(x1) - 1, 0, 1.5, h)
        g.fillRect(Math.round(x0), 0, 9, 9)
        g.fillRect(Math.round(x1) - 9, 0, 9, 9)
      }
      // Where a cut was.
      g.globalAlpha = 0.35
      g.fillStyle = c.ink
      for (const m of L.marks) g.fillRect(Math.round(toX(m)), 0, 1, h)
      g.globalAlpha = 1
      // Notes, with their names when there's room.
      const sounding = new Set<number>()
      const labelSize = Math.min(11, rowH - 3)
      g.font = `600 ${labelSize}px Archivo, sans-serif`
      g.textBaseline = 'middle'
      for (const n of L.notes) {
        if (n.end < start || n.start > start + span) continue
        const m = n.pitch + L.shift
        if (m < low - 1 || m > low + rows) continue
        const x0 = toX(n.start)
        const x1 = Math.max(x0 + 2, toX(n.end))
        const y = rowTop(m) + 1
        const hh = Math.max(2, rowH - 2)
        const on = pos >= n.start && pos < n.end
        if (on) sounding.add(m)
        g.globalAlpha = on ? 1 : 0.55 + 0.4 * n.velocity
        g.fillStyle = c.note
        g.beginPath()
        g.roundRect(x0, y, x1 - x0, hh, Math.min(3, hh / 2))
        g.fill()
        if (on) {
          g.globalAlpha = 1
          g.strokeStyle = c.ink
          g.lineWidth = 1.5
          g.stroke()
        }
        if (x1 - x0 >= 22 && rowH >= 10) {
          g.globalAlpha = 1
          g.fillStyle = c.noteInk
          g.save()
          g.beginPath()
          g.rect(x0, y, x1 - x0 - 2, hh)
          g.clip()
          g.fillText(noteName(m), x0 + 4, y + hh / 2 + 0.5)
          g.restore()
        }
      }
      g.globalAlpha = 1
      // Your take: slim bars along the bottom of their row, so the song's notes still show.
      g.globalAlpha = 0.95
      g.fillStyle = c.take
      for (const n of L.takeShown) {
        if (n.end < start || n.start > start + span || n.pitch < low - 1 || n.pitch > low + rows) continue
        const x0 = toX(n.start)
        const hh = Math.max(3, Math.round(rowH * 0.42))
        g.beginPath()
        g.roundRect(x0, rowTop(n.pitch) + rowH - hh - 1, Math.max(3, toX(n.end) - x0), hh, Math.min(2, hh / 2))
        g.fill()
      }
      g.globalAlpha = 1
      // Playhead.
      if (pos >= start && pos <= start + span) {
        g.fillStyle = c.ink
        g.fillRect(Math.round(toX(pos)) - 0.75, 0, 1.5, h)
      }

      // Keyboard: white and black keys, octave names on C, sounding keys lit.
      const k = kc.getContext('2d')!
      k.setTransform(dpr, 0, 0, dpr, 0, 0)
      k.fillStyle = c.surface
      k.fillRect(0, 0, KEYS_W, h)
      k.font = `500 ${Math.min(10, Math.max(8, rowH - 2))}px Archivo, sans-serif`
      k.textBaseline = 'middle'
      for (let m = Math.floor(low); m < low + rows + 1; m++) {
        const y = rowTop(m)
        if (sounding.has(m)) {
          k.fillStyle = c.note
          k.fillRect(0, y, KEYS_W, rowH)
        } else if (isBlack(m)) {
          k.fillStyle = c.ink2
          k.fillRect(0, y, KEYS_W * 0.62, rowH)
        }
        k.globalAlpha = pc(m) === 0 ? 0.35 : 0.12
        k.fillStyle = c.ink
        k.fillRect(0, Math.round(y + rowH) - 0.5, KEYS_W, 1)
        k.globalAlpha = 1
        if (pc(m) === 0 && rowH >= 7) {
          k.fillStyle = sounding.has(m) ? c.noteInk : c.ink3
          k.fillText(noteName(m), KEYS_W - 22, y + rowH / 2 + 0.5)
        }
      }
      k.fillStyle = c.line
      k.fillRect(KEYS_W - 1, 0, 1, h)
    }
    paintRoll.current = paint
    const loop = () => {
      raf = requestAnimationFrame(loop)
      paint()
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [duration])
  // A scroll or zoom repaints the roll before the frame is shown, the same frame the ruler moves.
  useLayoutEffect(() => paintRoll.current(), [view, size, P])

  // Time ruler under the roll.
  const ticks = useMemo(() => {
    if (!size.w) return []
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120]
    const step = steps.find((s) => (s / view.span) * size.w >= 70) ?? 300
    const out: { x: number; label: string }[] = []
    // From one step before the view: a label whose tick has scrolled out on the left still shows its end.
    for (let t = Math.max(0, Math.ceil(view.start / step) * step - step); t <= view.start + view.span; t += step)
      out.push({ x: Math.round(((t - view.start) / view.span) * size.w), label: formatPosition(cm.toSong(t), ruler, songGrid) })
    return out
  }, [view, size.w, ruler, songGrid, cm])

  const message =
    !state || state.status === 'running'
      ? state?.status === 'running' && state.progress > 0
        ? `Writing out the bass notes… ${Math.round(state.progress * 100)}%`
        : 'Writing out the bass notes… starting'
      : state.status === 'failed'
        ? `Couldn’t write out the notes: ${state.error}`
        : state.status === 'unavailable'
          ? state.error
          : notes.length === 0
            ? 'No bass notes were found in this song'
            : null

  return (
    <div className="notes-view" ref={box}>
      <canvas
        ref={keys}
        className="notes-keys"
        style={{ width: KEYS_W, height: size.h }}
        title={`Scroll moves up and down · ${flipKey}+scroll zooms the keyboard · double-click fits all notes`}
        onDoubleClick={() => setPitch(fitAxis(size.h))}
      />
      <canvas
        ref={roll}
        className="notes-roll"
        style={{ left: KEYS_W, width: size.w, height: size.h }}
        onDoubleClick={() => rawLoop && props.onLoopRemove?.()}
        onPointerDown={(e) => {
          // As on the waveform: click or drag moves the playhead (snapped; ⌘ does the
          // opposite), Ctrl+drag (or a plain drag, per Settings) makes a loop, and the
          // handles at the top of the loop's edges adjust it.
          if (e.button === 2 && e.ctrlKey) {
            setView({ start: 0, span: duration })
            setPitch(fitAxis(size.h))
            return
          }
          if (e.button !== 0) return
          const el = e.currentTarget
          const r0 = el.getBoundingClientRect()
          const timeAt = (clientX: number) => {
            const r = el.getBoundingClientRect()
            return Math.max(0, Math.min(duration, view.start + ((clientX - r.left) / r.width) * view.span))
          }
          const snap = (t: number, ev: { metaKey: boolean; altKey: boolean }) => (grid && snapPref !== flipHeld(ev) ? snapToGrid(grid.beats, t, size.w / view.span) : t)
          const xOf = (t: number) => r0.left + ((t - view.start) / view.span) * r0.width
          const handle =
            loop && rawOnLoopChange && e.clientY - r0.top <= 14
              ? Math.abs(e.clientX - xOf(loop.start) - 4) < 8
                ? 'start'
                : Math.abs(e.clientX - xOf(loop.end) + 4) < 8
                  ? 'end'
                  : null
              : null
          const mode: 'handle' | 'loop' | 'scrub' = handle ? 'handle' : rawOnLoopChange && e.ctrlKey ? 'loop' : 'scrub'
          const start = snap(timeAt(e.clientX), e)
          let moved = false
          el.setPointerCapture(e.pointerId)
          if (mode === 'scrub') onSeek(start)
          const region = (ev: PointerEvent): LoopRegion | null => {
            const v = snap(timeAt(ev.clientX), ev)
            if (mode === 'handle' && loop)
              return handle === 'start' ? { ...loop, start: Math.min(v, loop.end - 0.05) } : { ...loop, end: Math.max(v, loop.start + 0.05) }
            if (mode === 'loop') return { start: Math.min(start, v), end: Math.max(start, v), enabled: true }
            return null
          }
          const move = (ev: PointerEvent) => {
            moved = true
            if (mode === 'scrub') onSeek(snap(timeAt(ev.clientX), ev))
            else setDrag(region(ev))
          }
          const up = (ev: PointerEvent) => {
            el.removeEventListener('pointermove', move)
            el.removeEventListener('pointerup', up)
            setDrag(null)
            if (mode !== 'scrub' && moved) {
              const l = region(ev)
              if (l && l.end - l.start > 0.04) {
                onLoopChange(l)
                if (mode === 'loop') onSeek(l.start)
              }
            }
          }
          el.addEventListener('pointermove', move)
          el.addEventListener('pointerup', up)
        }}
        onPointerMove={(e) => {
          // Show the resize cursor over a loop handle, the loop cursor while Ctrl is held.
          const el = e.currentTarget
          const r = el.getBoundingClientRect()
          const xOf = (t: number) => r.left + ((t - view.start) / view.span) * r.width
          const onHandle = !!loop && e.clientY - r.top <= 14 && (Math.abs(e.clientX - xOf(loop.start) - 4) < 8 || Math.abs(e.clientX - xOf(loop.end) + 4) < 8)
          el.style.cursor = onHandle ? 'ew-resize' : e.ctrlKey ? 'col-resize' : ''
        }}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="notes-ruler" style={{ left: KEYS_W }}>
        {ticks.map((t) => (
          <span key={t.label} style={{ left: t.x }}>
            {t.label}
          </span>
        ))}
      </div>
      {view.span < (duration || 1) - 0.01 && (
        <button type="button" className="wave-fit" onPointerDown={(e) => e.stopPropagation()} onClick={() => setView({ start: 0, span: duration })}>
          {Math.round(duration / view.span)}× · Fit
        </button>
      )}
      {takeState && takeState.status !== 'none' && (
        <div className={`take-summary is-${takeState.status}`}>
          {takeState.status === 'recording' && <span>● Recording your take…</span>}
          {takeState.status === 'transcribing' && <span>Reading the notes you played…</span>}
          {takeState.status === 'failed' && <span>{takeState.error}</span>}
          {takeState.status === 'ready' && (
            <>
              <span className="take-key" />
              <span>Your take</span>
              <Button size="sm" variant="ghost" onClick={() => setTakeHidden((h) => !h)}>
                {takeHidden ? 'Show' : 'Hide'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void window.nota.songs.clearTake(song.id)}>
                Clear
              </Button>
            </>
          )}
        </div>
      )}
      {message && (
        <div className="notes-message">
          <span>{message}</span>
          {state?.status === 'failed' && (
            <Button size="sm" onClick={() => void window.nota.songs.notes(song.id)}>
              Try again
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
