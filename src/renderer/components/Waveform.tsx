import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { WaveformData } from '../../shared/api'
import { barBeatAt } from '../../shared/beats'
import { CutMap, cutGrid, cutRegion, isBarLine } from '../../shared/cuts'
import { isGridGap, positionOf, type GridLike } from '../../shared/music'
import { ACCENTS, type LoopRegion, type TimeRegion } from '../../shared/types'
import { useStore } from '../state/store'
import { useColorScheme, type Scheme } from '../theme'
import { formatTime } from './ui'
import { flipHeld } from '../platform'

// ---- Data ----------------------------------------------------------------------

export interface DecodedWave {
  perSecond: number
  count: number
  min: Int8Array
  max: Int8Array
  colour: Uint8Array
  /** Largest absolute sample (1..127), used to normalise the display */
  peak: number
}

function decode(w: WaveformData): DecodedWave {
  const n = Math.floor(w.data.length / 3)
  const min = new Int8Array(n)
  const max = new Int8Array(n)
  const colour = new Uint8Array(n)
  const signed = new Int8Array(w.data.buffer, w.data.byteOffset, w.data.byteLength)
  let peak = 1
  for (let i = 0; i < n; i++) {
    min[i] = signed[i * 3]
    max[i] = signed[i * 3 + 1]
    colour[i] = w.data[i * 3 + 2]
    peak = Math.max(peak, max[i], -min[i])
  }
  return { perSecond: w.perSecond, count: n, min, max, colour, peak }
}

const waveCache = new Map<string, Promise<DecodedWave | null>>()

export function useWaveform(songId: string | null, kind: 'original' | 'bass' | 'backing', version: string | null) {
  const [wave, setWave] = useState<DecodedWave | null>(null)
  useEffect(() => {
    if (!songId || version === null) {
      setWave(null)
      return
    }
    const key = `${songId}:${kind}:${version}`
    let job = waveCache.get(key)
    if (!job) {
      job = window.nota.songs
        .waveform(songId, kind)
        .then((w) => (w ? decode(w) : null))
        .catch(() => null)
      waveCache.set(key, job)
    }
    let alive = true
    void job.then((w) => alive && setWave(w))
    return () => {
      alive = false
    }
  }, [songId, kind, version])
  return wave
}

// ---- Colours -----------------------------------------------------------------------

/**
 * Colour by frequency content: bass-heavy → brick red, mids → orange/ochre,
 * treble → olive/teal. Tuned for the light display; the dark one lifts the
 * same colours towards white so they glow on graphite.
 */
const STOPS: [number, [number, number, number]][] = [
  [0, [190, 64, 48]],
  [0.3, [222, 112, 52]],
  [0.55, [205, 154, 46]],
  [0.78, [128, 160, 72]],
  [1, [64, 146, 140]]
]

function buildPalette(alpha: number, lift = 0): string[] {
  const out: string[] = []
  for (let i = 0; i < 256; i++) {
    const t = i / 255
    let k = 0
    while (k < STOPS.length - 2 && t > STOPS[k + 1][0]) k++
    const [t0, c0] = STOPS[k]
    const [t1, c1] = STOPS[k + 1]
    const f = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)))
    const c = c0.map((v, j) => {
      const mixed = v + (c1[j] - v) * f
      return Math.round(mixed + (255 - mixed) * lift)
    })
    out.push(`rgba(${c[0]},${c[1]},${c[2]},${alpha})`)
  }
  return out
}
interface WaveTheme {
  palette: string[]
  paletteDim: string[]
  /** Settings → Waveform → Single colour */
  mono: string[]
  monoDim: string[]
  bg: string
  gridBeat: string
  gridBar: string
  baseline: string
  loopFill: string
  loopFillOff: string
  loopEdgeOff: string
  hover: string
  accent: string
  playhead: string
}

const THEMES: Record<Scheme, WaveTheme> = {
  light: {
    palette: buildPalette(1),
    paletteDim: buildPalette(0.42),
    mono: new Array(256).fill('rgba(62,78,104,1)'),
    monoDim: new Array(256).fill('rgba(62,78,104,0.4)'),
    bg: '#E8ECEF',
    gridBeat: 'rgba(35,36,39,0.07)',
    gridBar: 'rgba(35,36,39,0.2)',
    baseline: 'rgba(35,36,39,0.15)',
    loopFill: 'rgba(45,80,210,0.13)',
    loopFillOff: 'rgba(35,36,39,0.05)',
    loopEdgeOff: 'rgba(35,36,39,0.35)',
    hover: 'rgba(35,36,39,0.3)',
    accent: '#2D50D2',
    playhead: '#232427'
  },
  dark: {
    palette: buildPalette(1, 0.12),
    paletteDim: buildPalette(0.62, 0.18),
    mono: new Array(256).fill('rgba(150,168,200,1)'),
    monoDim: new Array(256).fill('rgba(150,168,200,0.35)'),
    bg: '#151619',
    gridBeat: 'rgba(232,233,235,0.06)',
    gridBar: 'rgba(232,233,235,0.17)',
    baseline: 'rgba(232,233,235,0.15)',
    loopFill: 'rgba(90,124,245,0.2)',
    loopFillOff: 'rgba(232,233,235,0.06)',
    loopEdgeOff: 'rgba(232,233,235,0.35)',
    hover: 'rgba(232,233,235,0.35)',
    accent: '#6F8EFF',
    playhead: '#F2F3F5'
  }
}

/** The theme with the chosen brand colour for the loop and markers (lifted a little in dark, as in the CSS). */
function withAccent(t: WaveTheme, hex: string, scheme: Scheme): WaveTheme {
  const n = parseInt(hex.slice(1), 16)
  const lift = scheme === 'dark' ? 0.12 : 0
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((c) => Math.round(c + (255 - c) * lift))
  return { ...t, accent: `rgb(${r},${g},${b})`, loopFill: `rgba(${r},${g},${b},${scheme === 'dark' ? 0.2 : 0.13})` }
}

// ---- Helpers ---------------------------------------------------------------------------

/**
 * Nearest grid position to `t`: beats, or sixteenth notes when zoomed in far
 * enough that a beat is at least `fineAtPx` pixels wide.
 */
export function snapToGrid(beats: number[], t: number, pxPerSec = 0, fineAtPx = 64): number {
  let lo = 0
  let hi = beats.length - 1
  if (hi < 1) return t
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (beats[mid] < t) lo = mid
    else hi = mid
  }
  const span = beats[hi] - beats[lo]
  const sub = span * pxPerSec >= fineAtPx ? 4 : 1
  // Where there's no grid (talk or silence before, after or between the music), the position stays free.
  const n = beats.length
  if (t < beats[0] - (beats[1] - beats[0]) / 2 || t > beats[n - 1] + (beats[n - 1] - beats[n - 2]) / 2) return t
  if (t <= beats[0]) return beats[0]
  if (t >= beats[n - 1]) return beats[n - 1]
  if (isGridGap(beats, lo)) {
    // Inside a gap: snap only to a beat at its edge, within half a beat of it
    const before = lo > 0 ? beats[lo] - beats[lo - 1] : span
    const after = hi + 1 < n ? beats[hi + 1] - beats[hi] : span
    if (t - beats[lo] < before / 2) return beats[lo]
    if (beats[hi] - t < after / 2) return beats[hi]
    return t
  }
  const step = span / sub
  return beats[lo] + Math.round((t - beats[lo]) / step) * step
}

export function formatPosition(t: number, mode: 'time' | 'bars', grid: GridLike | null, tenths = false): string {
  if (mode === 'bars' && grid) {
    const p = barBeatAt(t, grid)
    if (p) return `${p.bar}.${p.beat}${tenths ? `.${Math.floor(p.frac * 4) + 1}` : ''}`
  }
  return formatTime(t, tenths)
}

export interface View {
  start: number
  span: number
}

/**
 * Following the playhead (like Logic's Catch and Live's Follow): the view turns a
 * page when the playhead reaches 85 % of it, so the next bars are always in sight,
 * and puts it back at 15 %. Returns the new start, or null to stay.
 */
export function followStart(view: View, pos: number, duration: number): number | null {
  const end = view.start + view.span
  // At the end of the song the view can't turn further: the playhead runs to the end.
  const canTurn = end < duration - 1e-3
  if ((canTurn && pos > view.start + view.span * 0.85) || pos < view.start) return pos - view.span * 0.15
  return null
}

/** Where a zoom keeps its place: the playhead while following it, else the pointer (as a fraction of the width). */
/**
 * A trackpad swipe sends a little of the other axis too, and a slow one can
 * have more of it than of the swipe itself. Each gesture (wheel events less
 * than 200 ms apart) keeps the axis it started on, so it never stalls, jitters
 * or turns back.
 */
export function makeWheelAxis() {
  let axis: 'x' | 'y' = 'y'
  let last = -Infinity
  return (e: WheelEvent): 'x' | 'y' => {
    if (e.timeStamp - last > 200 && (e.deltaX || e.deltaY)) axis = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? 'x' : 'y'
    last = e.timeStamp
    return axis
  }
}

export function zoomAnchor(view: View, pointerFrac: number, playhead: number | null): number {
  if (playhead === null || playhead < view.start || playhead > view.start + view.span) return pointerFrac
  return (playhead - view.start) / view.span
}

// ---- Component ---------------------------------------------------------------------------

interface Props {
  wave: DecodedWave | null
  duration: number
  /** Polled every frame; null hides the playhead */
  getPosition: (() => number) | null
  isPlaying?: () => boolean
  loop?: LoopRegion | null
  grid?: GridLike | null
  /** Click / drag to move the playhead (snaps to the grid; hold ⌘, or Alt off the Mac, for free) */
  onSeek?: (t: number) => void
  /** Ctrl+drag to make a loop, drag its handles to adjust (also snapped) */
  onLoopChange?: (loop: LoopRegion) => void
  /** Double-click removes the loop */
  onLoopRemove?: () => void
  compact?: boolean
  dim?: boolean
  ruler?: 'time' | 'bars' | null
  pending?: string | null
  /** Practice cuts (song time): left out of the drawing, as if the song were shorter */
  cuts?: TimeRegion[]
  /** False while the user has scrolled away during playback: the view stays put */
  following?: boolean
  /** The user moved or zoomed the timeline (wheel or pinch) */
  onUserScroll?: () => void
  /** Zoom and position shared with another view (the Notes view); otherwise kept here */
  view?: View
  onViewChange?: Dispatch<SetStateAction<View>>
}

const MIN_SPAN = 0.25

/** Waveform buckets with the cut regions removed. */
function cutWave(w: DecodedWave, map: CutMap): DecodedWave {
  if (map.empty) return w
  const keep: [number, number][] = []
  let from = 0
  for (const c of map.cuts) {
    keep.push([from, Math.round(c.start * w.perSecond)])
    from = Math.round(c.end * w.perSecond)
  }
  keep.push([from, w.count])
  const count = keep.reduce((n, [a, b]) => n + Math.max(0, Math.min(b, w.count) - a), 0)
  const min = new Int8Array(count)
  const max = new Int8Array(count)
  const colour = new Uint8Array(count)
  let o = 0
  for (const [a, b] of keep) {
    const e = Math.min(b, w.count)
    if (e <= a) continue
    min.set(w.min.subarray(a, e), o)
    max.set(w.max.subarray(a, e), o)
    colour.set(w.colour.subarray(a, e), o)
    o += e - a
  }
  return { ...w, count, min, max, colour }
}

export function Waveform(props: Props) {
  // Everything below works in display time: the song with its cuts removed.
  // Positions coming in are converted from song time, and seeks and loops going out back to it.
  const { wave: rawWave, duration: songDuration, getPosition: rawGetPosition, loop: rawLoop, grid: songGrid, onSeek: rawOnSeek, onLoopChange: rawOnLoopChange, cuts, ...rest } = props
  const { isPlaying, compact, dim, ruler, pending, following = true, onUserScroll, ...shared } = rest
  const cutsKey = JSON.stringify(cuts ?? [])
  const cm = useMemo(() => new CutMap(cuts, songDuration), [cutsKey, songDuration])
  const wave = useMemo(() => (rawWave ? cutWave(rawWave, cm) : rawWave), [rawWave, cm])
  const duration = cm.kept
  const grid = useMemo(() => (songGrid ? cutGrid(songGrid, cm) : songGrid), [songGrid, cm])
  const loop = rawLoop ? cutRegion(rawLoop, cm) : rawLoop
  const getPosition = useMemo(() => (rawGetPosition ? () => cm.toDisplay(rawGetPosition()) : rawGetPosition), [rawGetPosition, cm])
  const onSeek = rawOnSeek && ((t: number) => rawOnSeek(cm.toSong(t)))
  const onLoopChange = rawOnLoopChange && ((l: LoopRegion) => rawOnLoopChange({ ...l, start: cm.toSong(l.start), end: cm.toSong(l.end, 'before') }))
  const label = (t: number, tenths: boolean) => formatPosition(cm.toSong(t), ruler ?? 'time', songGrid ?? null, tenths)

  const mono = useStore((s) => s.prefs.waveformColors === 'mono')
  const scheme = useColorScheme()
  const accent = useStore((s) => s.prefs.accent)
  const T = useMemo(() => withAccent(THEMES[scheme], ACCENTS[accent].hex, scheme), [scheme, accent])
  const snapPref = useStore((s) => s.prefs.snapToGrid)
  const showGrid = useStore((s) => s.prefs.showGrid)
  // With the metronome's accent off, bar lines look like the other beats too
  const accentBars = useStore((s) => s.snapshot?.project?.metronome.accent !== false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const baseRef = useRef<HTMLCanvasElement>(null)
  const overRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [ownView, setOwnView] = useState<View>({ start: 0, span: duration || 1 })
  const view = shared.view ?? ownView
  const setView = shared.onViewChange ?? setOwnView
  const [drag, setDrag] = useState<LoopRegion | null>(null)
  const [hoverX, setHoverX] = useState<number | null>(null)
  const zoomable = !compact && !!onSeek
  const zoomed = view.span < duration - 1e-3

  // Reset the view when the song (duration) changes. A shared view is reset by its owner.
  useEffect(() => setOwnView({ start: 0, span: duration || 1 }), [duration])

  const clampView = useCallback(
    (v: View): View => {
      const span = Math.max(MIN_SPAN, Math.min(duration || 1, v.span))
      const start = Math.max(0, Math.min((duration || 1) - span, v.start))
      return { start, span }
    },
    [duration]
  )

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ---- Static layer: background, grid, waveform ----
  // Drawn before the frame is shown (a layout effect), in the same frame the ruler
  // labels move, so scrolling never shows the two a frame apart.
  useLayoutEffect(() => {
    const c = baseRef.current
    const { w, h } = size
    if (!c || !w || !h) return
    const dpr = window.devicePixelRatio || 1
    c.width = w * dpr
    c.height = h * dpr
    const g = c.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.fillStyle = T.bg
    g.fillRect(0, 0, w, h)

    const pxPerSec = w / view.span
    const toX = (t: number) => (t - view.start) * pxPerSec

    // Grid: bars always, beats when there is room.
    if (showGrid && grid && grid.beats.length > 1) {
      const beatPx = pxPerSec * (grid.beats[1] - grid.beats[0])
      const barPx = beatPx * grid.beatsPerBar
      const barEvery = barPx >= 5 ? 1 : barPx * 4 >= 5 ? 4 : 16
      for (let i = 0; i < grid.beats.length; i++) {
        const t = grid.beats[i]
        if (t < view.start - 1 || t > view.start + view.span + 1) continue
        const isBar = isBarLine(grid, i)
        if (isBar) {
          const barNo = positionOf(grid, i).bar - 1
          if (barNo % barEvery !== 0) continue
          g.fillStyle = accentBars ? T.gridBar : T.gridBeat
        } else {
          if (beatPx < 6 || compact) continue
          g.fillStyle = T.gridBeat
        }
        g.fillRect(Math.round(toX(t)), 0, 1, h)
      }
    }

    if (!wave || duration <= 0) {
      g.fillStyle = T.baseline
      g.fillRect(0, h / 2, w, 1)
      return
    }

    const mid = h / 2
    const scale = (h / 2) * (compact ? 0.92 : 0.9) / wave.peak
    const palette = mono ? (dim ? T.monoDim : T.mono) : dim ? T.paletteDim : T.palette
    const bucketsPerPx = wave.perSecond / pxPerSec
    const b0 = Math.max(0, Math.floor(view.start * wave.perSecond))

    if (bucketsPerPx >= 1) {
      // One coloured column per pixel.
      for (let x = 0; x < w; x++) {
        const s = Math.floor(b0 + x * bucketsPerPx)
        const e = Math.min(wave.count, Math.max(s + 1, Math.floor(b0 + (x + 1) * bucketsPerPx)))
        if (s >= wave.count) break
        let lo = 127
        let hi = -128
        let cs = 0
        let ws = 0
        for (let b = s; b < e; b++) {
          if (wave.min[b] < lo) lo = wave.min[b]
          if (wave.max[b] > hi) hi = wave.max[b]
          const amp = wave.max[b] - wave.min[b] + 1
          cs += wave.colour[b] * amp
          ws += amp
        }
        g.fillStyle = palette[Math.round(cs / ws)]
        const top = mid - hi * scale
        g.fillRect(x, top, 1, Math.max(1, (hi - lo) * scale))
      }
    } else {
      // Zoomed in past one bucket per pixel: a continuous coloured shape.
      const first = Math.max(0, b0 - 1)
      const last = Math.min(wave.count - 1, Math.ceil((view.start + view.span) * wave.perSecond) + 1)
      const bx = (b: number) => ((b + 0.5) / wave.perSecond - view.start) * pxPerSec
      for (let b = first; b < last; b++) {
        g.fillStyle = palette[wave.colour[b]]
        g.beginPath()
        g.moveTo(bx(b), mid - wave.max[b] * scale)
        g.lineTo(bx(b + 1), mid - wave.max[b + 1] * scale)
        g.lineTo(bx(b + 1), mid - wave.min[b + 1] * scale)
        g.lineTo(bx(b), mid - wave.min[b] * scale)
        g.closePath()
        g.fill()
      }
    }
  }, [wave, size, view, grid, showGrid, accentBars, duration, compact, dim, mono, T])

  // ---- Overlay: loop, hover, playhead (every frame) ----
  const marks = useMemo(() => cm.marks(), [cm])
  const live = useRef({ loop: drag ?? loop ?? null, hoverX, view, getPosition, isPlaying, zoomed, T, marks, duration, following })
  live.current = { loop: drag ?? loop ?? null, hoverX, view, getPosition, isPlaying, zoomed, T, marks, duration, following }
  const dirty = useRef(true)
  dirty.current = true

  const paintOverlay = useRef<() => void>(() => {})
  useEffect(() => {
    let raf = 0
    let lastPos: number | null = null
    const paint = () => {
      const c = overRef.current
      const { w, h } = size
      if (!c || !w || !h) return
      const L = live.current
      const pos = L.getPosition ? L.getPosition() : null

      if (pos !== null && L.zoomed && L.following && L.isPlaying?.()) {
        const start = followStart(L.view, pos, L.duration)
        if (start !== null) {
          setView((v) => clampView({ start, span: v.span }))
          return
        }
      }
      // Nothing moved and nothing changed (e.g. paused): skip the redraw.
      if (!dirty.current && pos === lastPos) return
      dirty.current = false
      lastPos = pos

      const dpr = window.devicePixelRatio || 1
      // Width and height: the deck can be resized taller or shorter.
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr)
        c.height = Math.round(h * dpr)
      }
      const g = c.getContext('2d')!
      // Clear in device pixels: at 125% scaling w × dpr can end in half a pixel, and a
      // half-cleared last row keeps a trail of every playhead position.
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.clearRect(0, 0, c.width, c.height)
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      const pxPerSec = w / L.view.span
      const toX = (t: number) => (t - L.view.start) * pxPerSec

      if (L.loop) {
        const x0 = toX(L.loop.start)
        const x1 = toX(L.loop.end)
        g.fillStyle = L.loop.enabled ? L.T.loopFill : L.T.loopFillOff
        g.fillRect(x0, 0, x1 - x0, h)
        if (!compact) {
          g.fillStyle = L.loop.enabled ? L.T.accent : L.T.loopEdgeOff
          g.fillRect(Math.round(x0), 0, 1.5, h)
          g.fillRect(Math.round(x1) - 1, 0, 1.5, h)
          // Grab handles
          g.fillRect(Math.round(x0), 0, 9, 9)
          g.fillRect(Math.round(x1) - 9, 0, 9, 9)
        }
      }
      // Where a cut was: a small notch top and bottom.
      g.fillStyle = L.T.loopEdgeOff
      for (const m of L.marks) {
        const x = Math.round(toX(m))
        if (x < -4 || x > w + 4) continue
        g.fillRect(x, 0, 1, h)
        if (!compact) {
          g.beginPath()
          g.moveTo(x - 4, h)
          g.lineTo(x + 4, h)
          g.lineTo(x, h - 5)
          g.fill()
        }
      }
      if (L.hoverX !== null && !compact) {
        g.fillStyle = L.T.hover
        g.fillRect(Math.round(L.hoverX), 0, 1, h)
      }
      if (pos !== null) {
        const x = Math.round(toX(pos))
        g.fillStyle = L.T.playhead
        g.fillRect(x - (compact ? 0.5 : 1), 0, compact ? 1.5 : 2, h)
        if (!compact) {
          g.beginPath()
          g.moveTo(x - 5, 0)
          g.lineTo(x + 5, 0)
          g.lineTo(x, 6)
          g.fill()
        }
      }
    }
    paintOverlay.current = paint
    const loop = () => {
      raf = requestAnimationFrame(loop)
      paint()
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [size, compact, clampView])
  // A scroll or zoom repaints the loop and playhead in the same frame as the waveform.
  useLayoutEffect(() => paintOverlay.current(), [view, size])

  // ---- Interaction ----
  const timeAt = (clientX: number) => {
    const r = wrapRef.current!.getBoundingClientRect()
    return Math.max(0, Math.min(duration, view.start + ((clientX - r.left) / r.width) * view.span))
  }
  // Snapping follows Settings → Waveform; holding ⌘ (Alt off the Mac) does the opposite.
  const snap = (t: number, e: { metaKey: boolean; altKey: boolean }) =>
    grid && !compact && snapPref !== flipHeld(e) ? snapToGrid(grid.beats, t, size.w / view.span) : t

  const handleAt = (clientX: number, clientY: number): 'start' | 'end' | null => {
    if (!loop || !onLoopChange || compact) return null
    const r = wrapRef.current!.getBoundingClientRect()
    if (clientY - r.top > 14) return null
    const px = (t: number) => r.left + ((t - view.start) / view.span) * r.width
    if (Math.abs(clientX - px(loop.start) - 4) < 8) return 'start'
    if (Math.abs(clientX - px(loop.end) + 4) < 8) return 'end'
    return null
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2 && e.ctrlKey && zoomable) return setView({ start: 0, span: duration }) // show the whole song
    if (e.button !== 0 || duration <= 0) return
    const t0 = timeAt(e.clientX)
    const handle = handleAt(e.clientX, e.clientY)
    const canLoop = !!onLoopChange && !compact
    // Ctrl+drag selects a loop; a click or plain drag moves the playhead.
    const mode: 'handle' | 'loop' | 'scrub' = handle ? 'handle' : canLoop && e.ctrlKey ? 'loop' : 'scrub'
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    if (mode === 'scrub') onSeek?.(snap(t0, e))
    const start = snap(t0, e)
    let moved = false

    const move = (ev: PointerEvent) => {
      const t = timeAt(ev.clientX)
      moved = true
      if (mode === 'handle' && loop) {
        const v = snap(t, ev)
        setDrag(handle === 'start' ? { ...loop, start: Math.min(v, loop.end - 0.05) } : { ...loop, end: Math.max(v, loop.start + 0.05) })
      } else if (mode === 'loop') {
        const v = snap(t, ev)
        setDrag({ start: Math.min(start, v), end: Math.max(start, v), enabled: true })
      } else if (mode === 'scrub' && (!compact || getPosition)) onSeek?.(snap(t, ev)) // the playlist's mini waveform scrubs once its song is selected
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const t = timeAt(ev.clientX)
      setDrag(null)
      if (mode === 'handle' && loop && moved) {
        const v = snap(t, ev)
        onLoopChange?.(handle === 'start' ? { ...loop, start: Math.min(v, loop.end - 0.05) } : { ...loop, end: Math.max(v, loop.start + 0.05) })
      } else if (mode === 'loop' && moved) {
        const v = snap(t, ev)
        if (Math.abs(v - start) > 0.04) {
          onLoopChange?.({ start: Math.min(start, v), end: Math.max(start, v), enabled: true })
          onSeek?.(Math.min(start, v))
        }
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Ctrl+wheel (and trackpad pinch) zooms around the cursor; wheel pans when zoomed.
  // The axis memory outlives the listener, which is set up again as the view changes.
  const wheelAxisRef = useRef(makeWheelAxis())
  useEffect(() => {
    const el = wrapRef.current
    if (!el || !zoomable) return
    const wheelAxis = wheelAxisRef.current
    const onWheel = (e: WheelEvent) => {
      const r = el.getBoundingClientRect()
      if (e.ctrlKey) {
        e.preventDefault()
        const L = live.current
        const playhead = L.following && L.isPlaying?.() && L.getPosition ? L.getPosition() : null
        setView((v) => {
          const frac = zoomAnchor(v, (e.clientX - r.left) / r.width, playhead)
          const anchor = v.start + frac * v.span
          // Capped before placing, so zooming on at the limit leaves the view where it is.
          const span = Math.max(MIN_SPAN, Math.min(duration || 1, v.span * Math.exp(e.deltaY * 0.01)))
          return clampView({ start: anchor - frac * span, span })
        })
      } else if (zoomed) {
        e.preventDefault()
        onUserScroll?.()
        const delta = wheelAxis(e) === 'x' ? e.deltaX : e.deltaY
        setView((v) => clampView({ start: v.start + (delta / r.width) * v.span, span: v.span }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomable, zoomed, clampView, onUserScroll])

  const cursor = useMemo(() => (compact ? 'pointer' : 'text'), [compact])
  const [cmdHeld, setCmdHeld] = useState(false)
  useEffect(() => {
    const on = (e: KeyboardEvent) => setCmdHeld(flipHeld(e))
    window.addEventListener('keydown', on)
    window.addEventListener('keyup', on)
    return () => {
      window.removeEventListener('keydown', on)
      window.removeEventListener('keyup', on)
    }
  }, [])
  const rawHover = hoverX !== null && size.w ? view.start + (hoverX / size.w) * view.span : null
  const hoverTime = rawHover !== null && !compact ? snap(rawHover, { metaKey: cmdHeld, altKey: cmdHeld }) : rawHover
  live.current.hoverX = hoverTime !== null && size.w ? ((hoverTime - view.start) / view.span) * size.w : null

  return (
    <div className={`waveform${compact ? ' is-compact' : ''}`}>
      <div
        ref={wrapRef}
        className="waveform-canvas"
        style={{ cursor }}
        onPointerDown={onSeek || onLoopChange ? onPointerDown : undefined}
        onDoubleClick={() => !compact && loop && props.onLoopRemove?.()}
        onPointerMove={(e) => {
          if (compact) return
          const r = wrapRef.current!.getBoundingClientRect()
          setHoverX(e.clientX - r.left)
          const el = e.currentTarget as HTMLElement
          el.style.cursor = handleAt(e.clientX, e.clientY) ? 'ew-resize' : e.ctrlKey ? 'col-resize' : cursor
        }}
        onPointerLeave={() => setHoverX(null)}
        onContextMenu={(e) => e.preventDefault()}
      >
        <canvas ref={baseRef} className="wave-layer" />
        <canvas ref={overRef} className="wave-layer" />
        {pending && <div className="waveform-pending">{pending}</div>}
        {hoverTime !== null && !compact && (
          <div className="waveform-hover-time" style={{ left: Math.min(size.w - 60, Math.max(0, (hoverX ?? 0) + 6)) }}>
            {label(hoverTime, true)}
          </div>
        )}
        {zoomed && !compact && (
          <button
            type="button"
            className="wave-fit"
            title="Show the whole song (Ctrl+right-click)"
            // The button sits on the waveform: without this, pressing it also seeks to where it was clicked.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setView({ start: 0, span: duration })}
          >
            {Math.round(duration / view.span)}× · Fit
          </button>
        )}
      </div>
      {ruler && duration > 0 && <Ruler view={view} width={size.w} mode={ruler} grid={grid ?? null} label={label} />}
    </div>
  )
}

function Ruler({ view, width, mode, grid, label }: { view: View; width: number; mode: 'time' | 'bars'; grid: GridLike | null; label: (t: number, tenths: boolean) => string }) {
  const ticks: { x: number; label: string }[] = []
  if (width > 0) {
    const pxPerSec = width / view.span
    if (mode === 'bars' && grid && grid.beats.length > 1) {
      const barPx = pxPerSec * (grid.beats[1] - grid.beats[0]) * grid.beatsPerBar
      const every = [1, 2, 4, 8, 16, 32, 64].find((n) => n * barPx >= 44) ?? 128
      for (let i = 0; i < grid.beats.length; i++) {
        if (!isBarLine(grid, i)) continue
        const bar = positionOf(grid, i).bar
        const t = grid.beats[i]
        if (t < view.start - (every * barPx) / pxPerSec || t > view.start + view.span) continue
        if ((bar - 1) % every !== 0) continue
        ticks.push({ x: (t - view.start) * pxPerSec, label: String(bar) })
      }
    } else {
      const step = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120].find((s) => s * pxPerSec >= 56) ?? 300
      // From one step before the view: a label whose tick has scrolled out on the left still shows its end.
      for (let t = Math.max(0, Math.ceil(view.start / step) * step - step); t <= view.start + view.span; t += step)
        ticks.push({ x: (t - view.start) * pxPerSec, label: label(t, step < 1) })
    }
  }
  return (
    <div className="ruler">
      {ticks.map((t) => (
        // Whole pixels, like the grid lines in the waveform, so labels and lines move together.
        <span key={t.label} style={{ left: Math.round(t.x) }}>
          {t.label}
        </span>
      ))}
    </div>
  )
}
