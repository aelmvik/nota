import { useMemo, useState } from 'react'
import type { EffectChain, EffectSlot, PluginInfo } from '../../shared/types'
import { attempt, setState, toast, useStore } from '../state/store'
import { Button, Icon, useDismiss } from './ui'
import { isMac } from '../platform'

function PluginPicker({ chain, onClose }: { chain: EffectChain; onClose: () => void }) {
  const catalog = useStore((s) => s.catalog)
  const scan = useStore((s) => s.scan)
  const [query, setQuery] = useState('')
  const [showFolders, setShowFolders] = useState(false)
  const [adding, setAdding] = useState<string | null>(null)
  const ref = useDismiss(true, onClose)

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = catalog?.plugins ?? []
    return q ? list.filter((p) => `${p.name} ${p.manufacturer} ${p.category}`.toLowerCase().includes(q)) : list
  }, [catalog, query])

  const runScan = async () => {
    const c = await attempt(() => window.nota.effects.scan(), 'Plugin scan')
    if (c) {
      setState({ catalog: c })
      toast(`Found ${c.plugins.length} effects${c.failed.length ? ` (${c.failed.length} could not be loaded)` : ''}`, 'success')
    }
  }

  const add = async (p: PluginInfo) => {
    setAdding(p.id)
    const ok = await attempt(() => window.nota.effects.add(p, chain).then(() => true), `Could not load ${p.name}`)
    setAdding(null)
    if (ok) onClose()
  }

  return (
    <div className="picker" ref={ref}>
      <div className="picker-head">
        <input autoFocus placeholder="Search effects…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button size="sm" variant="ghost" icon="refresh" title="Rescan plugins" disabled={scan.running} onClick={() => void runScan()} />
        <Button size="sm" variant="ghost" icon="folder" title="Plugin folders" active={showFolders} onClick={() => setShowFolders((v) => !v)} />
      </div>

      {showFolders && catalog && (
        <div className="picker-folders">
          <span className="picker-note">VST3 folders{isMac && ' (Audio Units are found automatically)'}</span>
          {catalog.directories.map((d) => (
            <div key={d} className="picker-folder">
              <span title={d}>{d}</span>
              <Button size="sm" variant="ghost" icon="x" title="Remove folder" onClick={() => void attempt(() => window.nota.effects.removeDirectory(d)).then((c) => c && setState({ catalog: c }))} />
            </div>
          ))}
          <Button size="sm" icon="plus" onClick={() => void attempt(() => window.nota.effects.addDirectory()).then((c) => c && setState({ catalog: c }))}>
            Add folder…
          </Button>
        </div>
      )}

      {scan.running ? (
        <div className="picker-empty">
          <span className="spinner" />
          <span>
            Scanning plugins {scan.total ? `${scan.done} / ${scan.total}` : ''}
            <br />
            <small>{scan.current}</small>
          </span>
        </div>
      ) : !catalog?.scannedAt ? (
        <div className="picker-empty">
          <span>Nøta hasn't looked for plugins yet. Each plugin is checked in a separate process, so a faulty one can't crash the app.</span>
          <Button variant="primary" onClick={() => void runScan()}>
            Scan for plugins
          </Button>
        </div>
      ) : (
        <div className="picker-list">
          {results.length === 0 && <div className="picker-empty">No effects match “{query}”.</div>}
          {results.map((p) => (
            <button key={p.id} type="button" className="picker-item" disabled={adding !== null} onClick={() => void add(p)}>
              <span className="picker-name">{p.name}</span>
              <span className="picker-meta">
                {p.manufacturer} · {p.format === 'AudioUnit' ? 'AU' : p.format}
              </span>
              {adding === p.id && <span className="spinner" />}
            </button>
          ))}
          {catalog.failed.length > 0 && (
            <div className="picker-note" title={catalog.failed.map((f) => `${f.fileOrIdentifier}: ${f.reason}`).join('\n')}>
              {catalog.failed.length} plugin file(s) could not be loaded and are hidden.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** One effects chain (the bass's or the output's): its plugins top to bottom, and an Add button. Shown in the Mixer. */
export function Chain({ chain, effects }: { chain: EffectChain; effects: EffectSlot[] }) {
  const project = useStore((s) => s.snapshot?.project ?? null)
  const slotErrors = useStore((s) => s.slotErrors)
  const [picking, setPicking] = useState(false)
  const fx = window.nota.effects
  return (
    <>
      {effects.map((e, i) => {
        const err = slotErrors[e.slotId]
        return (
          <div key={e.slotId} className={`fx${e.bypassed ? ' is-bypassed' : ''}${err ? ' is-error' : ''}`}>
            <button
              type="button"
              className={`fx-power${e.bypassed || err ? '' : ' is-on'}`}
              title={e.bypassed ? 'Enable effect' : 'Bypass effect'}
              disabled={!!err}
              onClick={() => void attempt(() => fx.setBypass(e.slotId, !e.bypassed))}
            >
              <Icon name="power" size={13} />
            </button>
            <button type="button" className="fx-body" title={err ? err : 'Open plugin window'} disabled={!!err} onClick={() => void attempt(() => fx.openEditor(e.slotId), e.name)}>
              <span className="fx-name">{e.name}</span>
              <span className="fx-meta">{err ? (e.format === 'AudioUnit' && !isMac ? 'Audio Unit · Mac only' : 'Could not load') : `${e.manufacturer} · ${e.format === 'AudioUnit' ? 'AU' : e.format}`}</span>
            </button>
            <div className="fx-actions">
              <Button size="sm" variant="ghost" icon="up" title="Move up" disabled={i === 0} onClick={() => void attempt(() => fx.move(e.slotId, i - 1))} />
              <Button size="sm" variant="ghost" icon="down" title="Move down" disabled={i === effects.length - 1} onClick={() => void attempt(() => fx.move(e.slotId, i + 1))} />
              <Button size="sm" variant="ghost" icon="trash" title="Remove effect" onClick={() => void attempt(() => fx.remove(e.slotId))} />
            </div>
          </div>
        )
      })}
      <div className="picker-anchor">
        <Button size="sm" icon="plus" className="chain-add" disabled={!project} title={project ? undefined : 'Open a project first'} onClick={() => setPicking((v) => !v)}>
          Add effect
        </Button>
        {picking && <PluginPicker chain={chain} onClose={() => setPicking(false)} />}
      </div>
    </>
  )
}
