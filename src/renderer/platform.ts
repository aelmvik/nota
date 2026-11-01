// Modifier keys and wording that differ by platform. On the Mac, Ctrl+drag
// makes a loop and Ctrl+scroll zooms time, and ⌘ flips snapping and zooms the
// keyboard. Elsewhere ⌘ is the Windows/Super key, which the system keeps, so
// Alt takes its place; Ctrl stays as it is.

export const isMac = window.nota.platform === 'darwin'

/** The key that flips snapping and zooms the Notes keyboard: ⌘ on the Mac, Alt elsewhere. */
export const flipKey = isMac ? '⌘' : 'Alt'

/** Whether the flip key is down in a pointer, wheel or key event. */
export const flipHeld = (e: { metaKey: boolean; altKey: boolean }) => (isMac ? e.metaKey : e.altKey)

/** Option, as in "⌥-click": Alt off the Mac. */
export const optKey = isMac ? '⌥' : 'Alt'

/** Shift alone or before a key: ⇧ and ⇧↑ on the Mac, Shift and Shift+↑ elsewhere. */
export const withShift = (key = '') => (isMac ? `⇧${key}` : key ? `Shift+${key}` : 'Shift')

/** A menu shortcut as it reads here: `shortcut('Z')` is ⌘Z on the Mac, Ctrl+Z elsewhere. */
export function shortcut(key: string, shift = false): string {
  return isMac ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`
}

/** "Show in Finder", or what the file manager is called here. */
export const revealLabel = isMac ? 'Show in Finder' : window.nota.platform === 'win32' ? 'Show in File Explorer' : 'Show in Folder'

/**
 * A device as it reads here. ALSA's names are "card, device; description", and
 * the system default reads "Default ALSA Output (currently PipeWire Media Server)"
 * for the input too: show "HDA Intel PCH, Analog" (the card and device) and "System default
 * (PipeWire Media Server)". The engine's name is still what's sent back.
 */
export function deviceLabel(name: string): string {
  if (window.nota.platform !== 'linux') return name
  const def = /^Default ALSA (?:Output|Input)(?: \(currently (.+)\))?$/.exec(name)
  if (def) return def[1] ? `System default (${def[1]})` : 'System default'
  return name.includes(';') ? name.slice(0, name.indexOf(';')) : name
}
