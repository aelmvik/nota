import { useEffect, useState } from 'react'

// The effective light/dark theme. CSS follows prefers-color-scheme by itself;
// this is for things drawn in code (the waveform canvas).

export type Scheme = 'light' | 'dark'

const query = () => window.matchMedia('(prefers-color-scheme: dark)')

export function useColorScheme(): Scheme {
  const [scheme, setScheme] = useState<Scheme>(() => (query().matches ? 'dark' : 'light'))
  useEffect(() => {
    const q = query()
    const on = () => setScheme(q.matches ? 'dark' : 'light')
    q.addEventListener('change', on)
    return () => q.removeEventListener('change', on)
  }, [])
  return scheme
}

/** A CSS colour (any syntax the page understands) as #rrggbb. */
function toHex(css: string): string {
  const ctx = document.createElement('canvas').getContext('2d')!
  ctx.fillStyle = css
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** Off the Mac, colour the system's window buttons like the brand bar they sit on. */
export function useTitleBarColors(accent: string) {
  const scheme = useColorScheme()
  useEffect(() => {
    if (window.nota.platform === 'darwin') return
    const probe = document.body.appendChild(document.createElement('div'))
    probe.style.cssText = 'display:none;background:var(--brand);color:var(--on-brand)'
    const style = getComputedStyle(probe)
    void window.nota.setTitleBarColors(toHex(style.backgroundColor), toHex(style.color))
    probe.remove()
  }, [accent, scheme])
}
