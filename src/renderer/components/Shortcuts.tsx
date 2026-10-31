import type { Preferences } from '../../shared/types'
import { useStore } from '../state/store'
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

const SLIDERS: [string, string][] = [
  ['Drag the tag', `Change the value (${withShift()} for fine steps)`],
  ['Click + type', 'Type a value, then Enter (Esc cancels)'],
  ['Double-click tag', 'Edit the value'],
  [`${optKey}-click`, 'Reset to default'],
  ['← → ↑ ↓', 'Step the value of a selected slider']
]

export const toggleKeys = () => toggleSidePane('keys')

function Group({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <section className="set-group">
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
      </div>
    </aside>
  )
}
