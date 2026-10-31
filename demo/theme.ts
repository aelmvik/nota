// Settings → Appearance in the demo. In the app the main process sets
// nativeTheme, which drives prefers-color-scheme; here the dark rules in the
// stylesheets and the matchMedia query the canvases read are switched instead.

type Theme = 'system' | 'light' | 'dark'

const DARK = '(prefers-color-scheme: dark)'
const system = window.matchMedia(DARK)
const realMatchMedia = window.matchMedia.bind(window)
let theme: Theme = 'system'

const isDark = () => (theme === 'system' ? system.matches : theme === 'dark')

// One stand-in for the dark query, so a change reaches every listener.
const listeners = new Set<(e: MediaQueryListEvent) => void>()
const darkQuery = {
  media: DARK,
  get matches() {
    return isDark()
  },
  onchange: null,
  addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
  removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
  addListener: (cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
  removeListener: (cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
  dispatchEvent: () => true
} as unknown as MediaQueryList

window.matchMedia = (q: string) => (q.replace(/\s+/g, ' ').trim() === DARK ? darkQuery : realMatchMedia(q))

/** Points each dark rule at the chosen theme: always, never, or the system's. */
function applyRules() {
  const media = theme === 'system' ? DARK : theme === 'dark' ? 'all' : 'not all'
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSMediaRule)) continue
      const tagged = (rule as CSSMediaRule & { notaDark?: boolean })
      if (tagged.notaDark === undefined) tagged.notaDark = rule.media.mediaText.includes('prefers-color-scheme: dark')
      if (tagged.notaDark) rule.media.mediaText = media
    }
  }
}

function changed() {
  applyRules()
  const e = { matches: isDark(), media: DARK } as MediaQueryListEvent
  for (const cb of listeners) cb(e)
}

system.addEventListener('change', () => theme === 'system' && changed())

export function setTheme(next: Theme) {
  theme = next
  changed()
}
