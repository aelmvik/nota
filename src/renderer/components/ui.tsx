import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { optKey } from '../platform'

// ---- Icons (1.5px stroke, 16px grid) -----------------------------------------

const paths: Record<string, ReactNode> = {
  // Rounded corners come from the stroke; centroid sits on the circle's centre.
  play: <path d="M5.3 3.6v8.8L12.7 8z" fill="currentColor" strokeWidth={1.6} />,
  pause: (
    <g fill="currentColor" stroke="none">
      <rect x="4.2" y="3" width="2.6" height="10" rx="1.3" />
      <rect x="9.2" y="3" width="2.6" height="10" rx="1.3" />
    </g>
  ),
  // Rewind / fast-forward: filled double triangles that pair with play.
  back: <path d="M7.4 4.6v6.8L3 8zM13 4.6v6.8L8.6 8z" fill="currentColor" strokeWidth={1.2} />,
  forward: <path d="M8.6 4.6v6.8L13 8zM3 4.6v6.8L7.4 8z" fill="currentColor" strokeWidth={1.2} />,
  loop: <path d="M3 7V6a2 2 0 0 1 2-2h7l-2-2M13 9v1a2 2 0 0 1-2 2H4l2 2" />,
  plus: <path d="M8 3v10M3 8h10" />,
  import: <path d="M8 2.5v7.5m0 0L5 7m3 3 3-3M3 11v1.5A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V11" />,
  folder: <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />,
  file: <path d="M4 2h5l3 3v9H4zM9 2v3h3" />,
  gear: (
    <g>
      <circle cx="8" cy="8" r="2" />
      <path d="M12.72 6.69 L14.21 6.92 L14.21 9.08 L12.72 9.31 L12.26 10.42 L13.15 11.62 L11.62 13.15 L10.42 12.26 L9.31 12.72 L9.08 14.21 L6.92 14.21 L6.69 12.72 L5.58 12.26 L4.38 13.15 L2.85 11.62 L3.74 10.42 L3.28 9.31 L1.79 9.08 L1.79 6.92 L3.28 6.69 L3.74 5.58 L2.85 4.38 L4.38 2.85 L5.58 3.74 L6.69 3.28 L6.92 1.79 L9.08 1.79 L9.31 3.28 L10.42 3.74 L11.62 2.85 L13.15 4.38 L12.26 5.58Z" strokeLinejoin="round" />
    </g>
  ),
  sliders: <path d="M3 4h6M12 4h1M3 8h1M7 8h6M3 12h5M11 12h2M10.5 2.5v3M5.5 6.5v3M9.5 10.5v3" />,
  power: <path d="M8 1.9v5.3M4.6 4.2a5 5 0 1 0 6.8 0" strokeWidth={1.8} />,
  waveform: <path d="M1.5 8h1.5M4.5 5.5v5M7 3v10M9.5 5v6M12 6.5v3M14.5 8h0" />,
  notes: (
    <g>
      <rect x="2" y="3" width="5" height="2" rx="0.6" />
      <rect x="6" y="7" width="6" height="2" rx="0.6" />
      <rect x="9" y="11" width="5" height="2" rx="0.6" />
    </g>
  ),
  scissors: (
    <g>
      <circle cx="4.5" cy="11.5" r="2" />
      <circle cx="11.5" cy="11.5" r="2" />
      <path d="M5.9 10.1 12 2.5M10.1 10.1 4 2.5" />
    </g>
  ),
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />,
  grip: (
    <g fill="currentColor" stroke="none">
      {[4, 8, 12].map((y) => (
        <g key={y}>
          <circle cx="6" cy={y} r="1" />
          <circle cx="10" cy={y} r="1" />
        </g>
      ))}
    </g>
  ),
  more: (
    <g fill="currentColor" stroke="none">
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.5" cy="8" r="1.2" />
    </g>
  ),
  check: <path d="m3.5 8.5 3 3 6-7" />,
  alert: <path d="M8 2.5 14 13H2zM8 6.5v3M8 11.2v.3" />,
  x: <path d="m4 4 8 8M12 4l-8 8" />,
  input: <path d="M2 8h7m0 0L6.5 5.5M9 8l-2.5 2.5M11 3h2.5v10H11" />,
  headphones: <path d="M2.5 11V8a5.5 5.5 0 0 1 11 0v3M2.5 10h2v4h-2zM11.5 10h2v4h-2z" />,
  edit: <path d="M10.5 3 13 5.5 6 12.5H3.5V10z" />,
  refresh: <path d="M13 3v3.5H9.5M3 13V9.5h3.5M12.4 6.5A5 5 0 0 0 3.6 6M3.6 9.5a5 5 0 0 0 8.8.5" />,
  speaker: <path d="M2.5 6h2.5L8.5 3v10L5 10H2.5zM11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4" />,
  up: <path d="m4 10 4-4 4 4" />,
  down: <path d="m4 6 4 4 4-4" />,
  bass: <path d="M3.5 13.5 9 8m0 0 1.5-4.5L13 2l1 1-1.5 2.5L8 7m1 1-1 1M5 9.5a2 2 0 1 0 1.5 1.5" />,
  music: <path d="M6 12V3.5l7-1.5V10M6 12a2 2 0 1 1-2-2 2 2 0 0 1 2 2zm7-2a2 2 0 1 1-2-2 2 2 0 0 1 2 2z" />,
  keyboard: <path d="M1.5 4.5h13v7h-13zM4 7h.5M6.5 7H7M9 7h.5M11.5 7h.5M5 9.5h6" />,
  link: <path d="M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-.7.7M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.7-.7" />,
  flag: <path d="M3.5 14V2.5M3.5 3h8l-2 3 2 3h-8" />,
  metronome: <path d="M5.8 2.5h4.4L13 14H3zM8 11l3.5-6.5M4.3 10.5h7.4" />,
  trend: <path d="M2 12l4-4 3 3 5-6M10 5h4v4" />,
  tap: <path d="M6 8.5V3.5a1.2 1.2 0 0 1 2.4 0V7l3.1.6a1.5 1.5 0 0 1 1.2 1.7L12.2 13H6.6L3.8 10a1.2 1.2 0 0 1 1.7-1.6z" />,
  // A tuning fork
  tune: <path d="M5.25 1.75v4.5a2.75 2.75 0 0 0 5.5 0v-4.5M8 9v5.25" strokeWidth={1.6} />,
  reset: <path d="M3 8a5 5 0 1 0 1.5-3.5M3 2.5V5h2.5" />,
  chevLeft: <path d="M10 3 5 8l5 5" />,
  // Half-filled circle: light/dark appearance
  contrast: (
    <g>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
    </g>
  ),
  download: <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />,
  chevRight: <path d="m6 3 5 5-5 5" />
}

export type IconName = keyof typeof paths

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ display: 'block', flex: 'none' }}
    >
      {paths[name]}
    </svg>
  )
}

// ---- Buttons -------------------------------------------------------------------

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: IconName
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  active?: boolean
}

export function Button({ icon, variant = 'default', size = 'md', active, className = '', children, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      className={`btn btn-${variant} btn-${size}${active ? ' is-active' : ''}${children ? '' : ' btn-icon'} ${className}`}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children && <span>{children}</span>}
    </button>
  )
}

// ---- Slider ---------------------------------------------------------------------

/** "−6.0 dB" → number part and unit, so the unit can be set smaller in tags. */
export function ValueText({ text }: { text: string }) {
  const m = /^([−+\-]?[\d.,∞]+)\s*(.*)$/.exec(text)
  if (!m) return <>{text}</>
  return (
    <>
      <b>{m[1]}</b>
      {m[2] && <small>{m[2]}</small>}
    </>
  )
}

/**
 * Slider: a hairline track with ticks, where the value tag
 * is the handle. Drag the tag for relative moves (hold Shift for fine
 * control), click the track to jump, arrow keys step, ⌥-click resets.
 * To type a value: focus the slider and start typing, press Enter, or
 * double-click the tag.
 */
export function Slider({
  value,
  min,
  max,
  step = 0.01,
  onChange,
  onCommit,
  label,
  title,
  disabled,
  className = '',
  format,
  parse,
  vertical = false,
  defaultValue,
  ticks = 4
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  onCommit?: (v: number) => void
  label?: string
  title?: string
  disabled?: boolean
  className?: string
  format?: (v: number) => string
  /** Typed text → value (default: the number in the text, units ignored) */
  parse?: (text: string) => number | null
  vertical?: boolean
  /** ⌥-click resets to this */
  defaultValue?: number
  ticks?: number
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [draft, setDraftState] = useState<string | null>(null)
  // Enter commits and unmounts the field, which can also fire blur: commit once.
  const committed = useRef(false)
  const setDraft = (d: string | null) => {
    if (d !== null) committed.current = false
    setDraftState(d)
  }
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)))
  const quantize = (v: number) => Number(Math.min(max, Math.max(min, Math.round(v / step) * step)).toFixed(decimals))
  const frac = Math.min(1, Math.max(0, (value - min) / (max - min)))
  const editable = !!format && !disabled

  const set = (v: number) => {
    onChange(v)
    onCommit?.(v)
  }

  const reset = () => {
    if (defaultValue !== undefined && !disabled) set(defaultValue)
  }

  /** The number as shown on the tag, without its unit, as a starting point for typing. */
  const editText = () => {
    const shown = format ? format(value) : String(value)
    return /^([−+-]?[\d.,∞]+)/.exec(shown)?.[1]?.replace('−', '-') ?? ''
  }

  const commitDraft = (text: string) => {
    if (committed.current) return
    committed.current = true
    setDraft(null)
    const n = parse ? parse(text) : parseNumber(text)
    if (n !== null && Number.isFinite(n)) set(quantize(n))
    else if (/∞|inf/i.test(text) || /^-$/.test(text.trim())) set(min)
    trackRef.current?.focus()
  }

  const fromPointer = (x: number, y: number) => {
    const r = trackRef.current!.getBoundingClientRect()
    const f = vertical ? 1 - (y - r.top) / r.height : (x - r.left) / r.width
    return min + Math.min(1, Math.max(0, f)) * (max - min)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0 || draft !== null) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).focus()
    if (e.altKey) {
      reset()
      return
    }
    const onTag = !!(e.target as HTMLElement).closest('.tslider-tag')
    const r = trackRef.current!.getBoundingClientRect()
    const length = vertical ? r.height : r.width
    const start = vertical ? e.clientY : e.clientX
    const startValue = value
    let last = value
    if (!onTag) {
      last = quantize(fromPointer(e.clientX, e.clientY))
      onChange(last)
    }
    const move = (ev: PointerEvent) => {
      let v: number
      if (onTag) {
        const delta = ((vertical ? start - ev.clientY : ev.clientX - start) / length) * (max - min)
        v = startValue + delta * (ev.shiftKey ? 0.2 : 1)
      } else v = fromPointer(ev.clientX, ev.clientY)
      last = quantize(v)
      onChange(last)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      onCommit?.(last)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled || draft !== null) return
    // Typing a number starts editing straight away.
    if (editable && !e.metaKey && !e.ctrlKey && /^[0-9.,+−-]$/.test(e.key)) {
      e.preventDefault()
      e.stopPropagation()
      setDraft(e.key)
      return
    }
    if (editable && e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      setDraft(editText())
      return
    }
    // Backspace/Delete belong to the slider while it has focus (not the Cut shortcut).
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    const dir = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0
    if (!dir) return
    e.preventDefault()
    e.stopPropagation()
    set(quantize(value + dir * step * (e.shiftKey ? 10 : 1)))
  }

  const pos = `${frac * 100}%`
  const tagStyle = vertical ? { bottom: pos } : { left: pos }
  return (
    <div
      className={`tslider${vertical ? ' is-vertical' : ''}${disabled ? ' is-disabled' : ''}${draft !== null ? ' is-editing' : ''} ${className}`}
      title={title ?? (editable ? `Drag, or click and type a value. ${optKey}-click resets.` : undefined)}
    >
      {label && <span className="tslider-label">{label}</span>}
      <div
        ref={trackRef}
        className="tslider-track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label ?? title}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={format?.(value)}
        aria-orientation={vertical ? 'vertical' : 'horizontal'}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      >
        <span className="tslider-line" />
        {Array.from({ length: ticks + 1 }, (_, i) => (
          <span key={i} className="tslider-tick" style={vertical ? { bottom: `${(i / ticks) * 100}%` } : { left: `${(i / ticks) * 100}%` }} />
        ))}
        {draft !== null ? (
          <input
            className="tslider-tag tslider-input"
            style={tagStyle}
            autoFocus
            defaultValue={draft}
            size={Math.max(3, draft.length + 1)}
            onFocus={(e) => {
              // A typed first character should be kept; a prefilled value selected.
              const el = e.target
              if (draft.length > 1) el.select()
              else el.setSelectionRange(el.value.length, el.value.length)
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commitDraft((e.target as HTMLInputElement).value)
              if (e.key === 'Escape') {
                committed.current = true // the blur that follows must not save
                setDraft(null)
                trackRef.current?.focus()
              }
            }}
            onBlur={(e) => commitDraft(e.target.value)}
          />
        ) : (
          <span
            className={`tslider-tag${format ? '' : ' is-bare'}`}
            style={tagStyle}
            onDoubleClick={(e) => {
              e.stopPropagation()
              if (editable) setDraft(editText())
            }}
          >
            {format && <ValueText text={format(value)} />}
          </span>
        )}
      </div>
    </div>
  )
}

// ---- Select ----------------------------------------------------------------------

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  title,
  disabled,
  className = '',
  placeholder
}: {
  value: T | null
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  title?: string
  disabled?: boolean
  className?: string
  placeholder?: string
}) {
  return (
    <span className={`select ${className}`} title={title}>
      <select
        value={value === null ? '' : String(value)}
        disabled={disabled}
        aria-label={title}
        onChange={(e) => {
          const opt = options.find((o) => String(o.value) === e.target.value)
          if (opt) onChange(opt.value)
          // Give the keyboard back: Space should play, not reopen the list.
          e.currentTarget.blur()
        }}
      >
        {value === null && <option value="">{placeholder ?? 'Select…'}</option>}
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="down" size={12} className="select-caret" />
    </span>
  )
}

// ---- Popover menu -------------------------------------------------------------------

export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, close])
  return ref
}

export interface MenuItem {
  label: string
  icon?: IconName
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  hint?: string
}

export function Menu({
  trigger,
  items,
  align = 'right',
  title,
  at: point
}: {
  trigger: (open: boolean) => ReactNode
  items: (MenuItem | 'separator' | { heading: string })[]
  align?: 'left' | 'right'
  title?: string
  /** Open at this point instead (a right-click); a new object reopens it */
  at?: { x: number; y: number } | null
}) {
  // The menu is drawn on <body>, above everything: inside the playlist it
  // would be clipped by the scrolling list and covered by the deck below it.
  const [at, setAt] = useState<{ top: number; left?: number; right?: number; fromPoint?: boolean; placed?: boolean } | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = () => setAt(null)

  const openAt = () => {
    const r = wrap.current!.getBoundingClientRect()
    setAt(align === 'right' ? { top: r.bottom + 4, right: window.innerWidth - r.right } : { top: r.bottom + 4, left: r.left })
  }

  useEffect(() => {
    if (point) setAt({ top: point.y, left: point.x, fromPoint: true })
  }, [point])

  // Not enough room below: open upwards instead (and keep a right-click menu inside the window).
  useLayoutEffect(() => {
    if (!at || !menu.current || !wrap.current) return
    const h = menu.current.offsetHeight
    const w = menu.current.offsetWidth
    if (at.fromPoint) {
      if (at.placed) return
      const top = at.top + h > window.innerHeight - 8 ? Math.max(8, at.top - h) : at.top
      const left = Math.min(at.left ?? 0, window.innerWidth - w - 8)
      if (top !== at.top || left !== at.left) setAt({ top, left, fromPoint: true, placed: true })
      return
    }
    const r = wrap.current.getBoundingClientRect()
    if (at.top + h > window.innerHeight - 8 && r.top - h - 4 > 8) setAt({ ...at, top: r.top - h - 4 })
  }, [at])

  useEffect(() => {
    if (!at) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!wrap.current?.contains(t) && !menu.current?.contains(t)) close()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    // It's positioned against the window, so it would float away from its button on scroll.
    const onScroll = (e: Event) => !menu.current?.contains(e.target as Node) && close()
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [at])

  return (
    <div className="menu-wrap" ref={wrap}>
      <span onClick={() => (at ? close() : openAt())} title={title}>
        {trigger(!!at)}
      </span>
      {at &&
        createPortal(
          <div ref={menu} className="menu menu-floating" role="menu" style={{ top: at.top, left: at.left, right: at.right }}>
            {items.map((item, i) =>
              item === 'separator' ? (
                <div key={i} className="menu-sep" />
              ) : 'heading' in item ? (
                <div key={i} className="menu-heading">
                  {item.heading}
                </div>
              ) : (
                <button
                  key={i}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  className={`menu-item${item.danger ? ' is-danger' : ''}`}
                  onClick={() => {
                    close()
                    item.onSelect()
                  }}
                >
                  {item.icon ? <Icon name={item.icon} size={14} /> : <span className="menu-icon-spacer" />}
                  <span className="menu-label">{item.label}</span>
                  {item.hint && <span className="menu-hint">{item.hint}</span>}
                </button>
              )
            )}
          </div>,
          document.body
        )}
    </div>
  )
}

// ---- Formatting ---------------------------------------------------------------------

export function formatTime(sec: number, withTenths = false): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  if (withTenths) return `${m}:${s.toFixed(1).padStart(4, '0')}`
  return `${m}:${Math.floor(s).toString().padStart(2, '0')}`
}

export function formatDb(db: number): string {
  if (db <= -59.5) return '−∞ dB'
  return `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db).toFixed(1)} dB`
}

// ---- Brand ------------------------------------------------------------------------

/** The Nøta wordmark in Archivo black italic, condensed. */
export function Wordmark({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <span className={`wordmark ${className}`} style={{ fontSize: size }} role="img" aria-label="Nøta">
      nøta
    </span>
  )
}

// ---- Popover ----------------------------------------------------------------------

/**
 * Nudges an open popover sideways so it never hangs past the window edge (a
 * centred popover on the leftmost control would otherwise be cut off), and
 * caps its height so it scrolls instead of running off the top.
 */
function useKeepInWindow(open: boolean, el: React.RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const node = el.current
    if (!open || !node) return
    const margin = 8
    let nudge = 0
    const fit = () => {
      const r = node.getBoundingClientRect()
      const left = r.left - nudge
      const right = r.right - nudge
      const max = window.innerWidth - margin
      nudge = left < margin ? margin - left : right > max ? Math.max(margin - left, max - right) : 0
      node.style.translate = nudge ? `${nudge}px 0` : ''
      node.style.maxHeight = ''
      const top = node.getBoundingClientRect().top
      if (top < margin) {
        node.style.maxHeight = `${node.offsetHeight - (margin - top)}px`
        node.style.overflowY = 'auto'
      }
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(node)
    window.addEventListener('resize', fit)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', fit)
    }
  }, [open, el])
}

export function Popover({
  trigger,
  children,
  align = 'left',
  className = ''
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode
  children: ReactNode
  align?: 'left' | 'right' | 'center'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  // Drawn over the whole window (a portal, placed from its button), so a row that
  // clips what overflows it (the transport's loop area in a narrow window) can't hide it.
  const [place, setPlace] = useState<React.CSSProperties | null>(null)
  useLayoutEffect(() => {
    if (!open) return setPlace(null)
    const update = () => {
      const r = anchor.current?.getBoundingClientRect()
      if (!r) return
      const x = align === 'right' ? { right: window.innerWidth - r.right } : { left: align === 'center' ? r.left + r.width / 2 : r.left }
      setPlace({ position: 'fixed', zIndex: 250, top: 'auto', bottom: window.innerHeight - r.top + 8, ...x })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, align])
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!anchor.current?.contains(t) && !pop.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  useKeepInWindow(open && !!place, pop)
  return (
    <div className="menu-wrap" ref={anchor}>
      {trigger(open, () => setOpen((o) => !o))}
      {open &&
        place &&
        createPortal(
          <div ref={pop} className={`popover popover-${align} ${className}`} style={place}>
            {children}
          </div>,
          document.body
        )}
    </div>
  )
}

/**
 * Compact −/value/+ control. With `onEdit`, clicking the value turns it into
 * a text field: type a number and press Enter (Escape cancels).
 */
export function Stepper({
  value,
  onStep,
  format,
  title,
  minusTitle,
  plusTitle,
  disableMinus,
  disablePlus,
  onEdit,
  editValue,
  highlight
}: {
  value: number
  onStep: (dir: -1 | 1, big: boolean) => void
  format: (v: number) => string
  title?: string
  minusTitle?: string
  plusTitle?: string
  disableMinus?: boolean
  disablePlus?: boolean
  /** Receives the typed text */
  onEdit?: (text: string) => void
  /** Initial text when editing (defaults to the formatted value) */
  editValue?: string
  highlight?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const commit = (text: string) => {
    setEditing(false)
    if (text.trim()) onEdit?.(text.trim())
  }
  return (
    <span className="stepper" title={title}>
      <button type="button" className="stepper-btn" title={minusTitle} aria-label={minusTitle ?? 'Decrease'} disabled={disableMinus} onClick={(e) => onStep(-1, e.shiftKey)}>
        <Icon name="chevLeft" size={12} />
      </button>
      {editing ? (
        <input
          className="stepper-input"
          autoFocus
          defaultValue={editValue ?? format(value)}
          onFocus={(e) => e.target.select()}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit((e.target as HTMLInputElement).value)
            if (e.key === 'Escape') setEditing(false)
            e.stopPropagation()
          }}
        />
      ) : (
        <button
          type="button"
          className={`stepper-value${highlight ? ' is-changed' : ''}${onEdit ? ' is-editable' : ''}`}
          title={onEdit ? 'Click to type a value' : undefined}
          onClick={() => onEdit && setEditing(true)}
          tabIndex={onEdit ? 0 : -1}
        >
          <ValueText text={format(value)} />
        </button>
      )}
      <button type="button" className="stepper-btn" title={plusTitle} aria-label={plusTitle ?? 'Increase'} disabled={disablePlus} onClick={(e) => onStep(1, e.shiftKey)}>
        <Icon name="chevRight" size={12} />
      </button>
    </span>
  )
}

/** Parses "75", "75%", "-3", "+2,5", "−12" into a number (Unicode minus allowed). */
export function parseNumber(text: string): number | null {
  const n = Number(text.replace(/[%¢a-z\s]/gi, '').replace('−', '-').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

// ---- Inline text editing ------------------------------------------------------------

/**
 * Text that turns into an input when activated (click or double-click).
 * Enter or leaving the field saves; Escape cancels.
 */
/** On/off switch. */
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="switch" title={label}>
      <input type="checkbox" checked={checked} aria-label={label} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  )
}

export function InlineEdit({
  value,
  placeholder,
  onCommit,
  className = '',
  trigger = 'click',
  editing: editingProp,
  onEditingChange,
  title
}: {
  value: string
  placeholder?: string
  onCommit: (value: string) => void
  className?: string
  trigger?: 'click' | 'dblclick'
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
  title?: string
}) {
  const [own, setOwn] = useState(false)
  const editing = editingProp ?? own
  const setEditing = (v: boolean) => (onEditingChange ? onEditingChange(v) : setOwn(v))
  const done = useRef(false)

  if (editing)
    return (
      <input
        className={`inline-edit-input ${className}`}
        autoFocus
        defaultValue={value}
        placeholder={placeholder}
        onFocus={(e) => {
          done.current = false
          e.target.select()
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onBlur={(e) => {
          if (!done.current) onCommit(e.target.value.trim())
          done.current = true
          setEditing(false)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && !done.current) {
            done.current = true
            onCommit((e.target as HTMLInputElement).value.trim())
            setEditing(false)
          }
          if (e.key === 'Escape') {
            done.current = true
            setEditing(false)
          }
        }}
      />
    )

  const start = (e: React.MouseEvent) => {
    e.stopPropagation()
    setEditing(true)
  }
  return (
    <span
      className={`inline-edit ${value ? '' : 'is-empty'} ${className}`}
      title={title ?? (trigger === 'click' ? 'Click to rename' : 'Double-click to rename')}
      onClick={trigger === 'click' ? start : undefined}
      onDoubleClick={trigger === 'dblclick' ? start : undefined}
    >
      {value || placeholder}
    </span>
  )
}
