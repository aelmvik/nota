import type { Preferences } from '../../shared/types'
import { setState, useStore } from '../state/store'
import { closeSidePane, toggleSidePane, useEscToClose } from './Settings'
import { Button, Icon } from './ui'
import { flipKey, optKey, shortcut, withShift } from '../platform'

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'],
  ['1  2  3', 'Original · Bass Solo · Play Along'],
  ['← →', `Skip back / forward (${withShift()} for 1 s)`],
  ['↑ ↓', 'Previous / next song'],
  [`${withShift('↑')} ${withShift('↓')}`, 'Key up / down a semitone'],
  ['−  =', `Speed −1% / +1% (${withShift()} for 5%)`],
  ['0', 'Normal speed'],
  ['I  O', 'Loop start / end at the playhead'],
  ['L', 'Loop on / off'],
  ['K', 'Metronome on / off'],
  ['M', 'Monitoring on / off'],
  [`${shortcut('Z')}  ${shortcut('Z', true)}`, 'Undo / redo'],
  ['Backspace', 'Cut the selected part out (playback skips it)'],
  [shortcut(','), 'Settings'],
  ['T', 'Tuner on / off'],
  [`${shortcut('I')} ${shortcut('N')} ${shortcut('O')}`, 'Import songs · New · Open project']
]

function mouseShortcuts(p: Preferences): [string, string][] {
  return [
    ['Click / drag', 'Move the playhead'],
    ['Ctrl + drag', 'Select a loop'],
    ['Double-click', 'Remove the loop'],
    [`Hold ${flipKey}`, p.snapToGrid ? 'No snapping, for precise positions' : 'Snap to the beat grid'],
    ['Drag ▪ handle', 'Adjust a loop edge'],
    ['Ctrl + scroll', 'Zoom (or pinch on a trackpad)'],
    ['Ctrl + right-click', 'Zoom out to show the whole song'],
    ['Scroll', 'Move along when zoomed in'],
    ['Click the clock', 'Switch between time and bars'],
    [`${flipKey} + scroll`, 'Notes: zoom the keyboard'],
    ['Right-click a song', 'Song menu']
  ]
}

function noteEditShortcuts(p: Preferences): [string, string][] {
  return [
    ['E', 'Edit mode on / off'],
    ['Click', 'Add a note (as long as the last one you touched)'],
    ['Drag a note', `Move it, with the selection (${withShift()} copies)`],
    ['Drag its end', 'Make it longer or shorter'],
    ['Right-click / drag', 'Delete notes'],
    ['Ctrl + drag', `Select notes (${withShift()} adds)`],
    [`Hold ${flipKey}`, p.snapToGrid ? 'No snapping' : 'Snap to the beat grid'],
    ['↑ ↓', `Move the selection a semitone (${withShift()} for an octave)`],
    ['← →', `Move the selection a step (${withShift()} for a beat)`],
    ['Backspace', 'Delete the selection'],
    [`${shortcut('C')} ${shortcut('X')} ${shortcut('V')}`, 'Copy · Cut · Paste at the playhead'],
    [shortcut('A'), 'Select all notes'],
    ['Click the ruler', 'Move the playhead']
  ]
}

const SLIDERS: [string, string][] = [
  ['Drag the tag', `Change the value (${withShift()} for fine steps)`],
  ['Click + type', 'Type a value, then Enter (Esc cancels)'],
  ['Double-click tag', 'Edit the value'],
  [`${optKey}-click`, 'Reset to default'],
  ['← → ↑ ↓', 'Step the value of a selected slider']
]

export const toggleKeys = () => toggleSidePane('keys')

/** Opens Shortcuts at the note-editing keys (from the Notes view's edit mode). */
export function showNoteEditKeys() {
  setState({ sidePane: 'keys' })
  // Once the pane is there (a few frames), scroll to them.
  let frames = 0
  const scroll = () => {
    const group = document.getElementById('keys-editing-notes')
    if (group) group.scrollIntoView({ block: 'start', behavior: 'smooth' })
    else if (++frames < 30) requestAnimationFrame(scroll)
  }
  requestAnimationFrame(scroll)
}

function Group({ title, rows, id }: { title: string; rows: [string, string][]; id?: string }) {
  return (
    <section className="set-group" id={id}>
      <h4>{title}</h4>
      {rows.map(([k, d]) => (
        <div key={k} className="shortcut-row">
          <kbd>{k}</kbd>
          <span>{d}</span>
        </div>
      ))}
    </section>
  )
}

export function ShortcutsPanel() {
  const prefs = useStore((s) => s.prefs)
  useEscToClose()
  return (
    <aside className="side side-keys" aria-label="Shortcuts">
      <div className="side-head">
        <h3>
          <Icon name="keyboard" size={14} /> Shortcuts
        </h3>
        <Button size="sm" variant="ghost" icon="x" title="Close (Esc)" onClick={closeSidePane} />
      </div>
      <div className="set-scroll">
        <Group title="Keyboard" rows={SHORTCUTS} />
        <Group title="Sliders" rows={SLIDERS} />
        <Group title="Waveform" rows={mouseShortcuts(prefs)} />
        <Group title="Editing notes" rows={noteEditShortcuts(prefs)} id="keys-editing-notes" />
      </div>
    </aside>
  )
}
