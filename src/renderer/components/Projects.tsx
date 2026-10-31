import { useState } from 'react'
import { formatDuration } from '../../shared/practice'
import { exportSetlist } from '../actions'
import { EMPTY, attempt, toast, useStore } from '../state/store'
import { closeSidePane, toggleSidePane, useEscToClose } from './Settings'
import { Button, Icon, InlineEdit } from './ui'
import { revealLabel, shortcut } from '../platform'

export const toggleProjects = () => toggleSidePane('projects')

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

/** Current project, new / open, and recent projects — in the right-hand pane. */
export function ProjectsPanel() {
  const snap = useStore((s) => s.snapshot)
  const all = useStore((s) => s.snapshot?.recent ?? EMPTY)
  const project = snap?.project ?? null
  const recent = all.filter((r) => r.path !== snap?.filePath)
  const p = window.nota.project
  const pkg = snap?.filePath ?? ''
  const outside = project?.songs.filter((s) => !s.source.missing && !s.source.path.startsWith(pkg + '/')).length ?? 0
  const [collecting, setCollecting] = useState(false)
  const collect = async () => {
    setCollecting(true)
    const n = await attempt(() => p.collectSongs(), 'Copying songs')
    setCollecting(false)
    if (n) toast(`Copied ${n} song${n === 1 ? '' : 's'} into the project`, 'success')
  }
  useEscToClose()

  return (
    <aside className="side side-projects" aria-label="Projects">
      <div className="side-head">
        <h3>
          <Icon name="folder" size={14} /> Projects
        </h3>
        <Button size="sm" variant="ghost" icon="x" title="Close (Esc)" onClick={closeSidePane} />
      </div>
      <div className="set-scroll">
        {project && (
          <section className="set-group">
            <h4>Open now</h4>
            <div className="proj-current">
              <InlineEdit
                className="set-label proj-name"
                value={project.name}
                placeholder="Project name"
                onCommit={(name) => name && name !== project.name && void attempt(() => p.rename(name), 'Rename project')}
              />
              <div className="set-help">
                {project.songs.length} song{project.songs.length === 1 ? '' : 's'}
              </div>
            </div>
            {outside > 0 && (
              <div className="proj-outside">
                <span>
                  {outside} song{outside === 1 ? ' lives' : 's live'} outside the project folder, so moving {outside === 1 ? 'it' : 'them'} breaks the link.
                </span>
                <Button size="sm" icon="import" disabled={collecting} onClick={() => void collect()}>
                  {collecting ? 'Copying…' : 'Copy into project'}
                </Button>
              </div>
            )}
            <div className="proj-actions">
              <Button size="sm" icon="file" title={shortcut('P')} onClick={() => void exportSetlist()}>
                Setlist PDF…
              </Button>
              <Button size="sm" icon="folder" onClick={() => void p.revealInFinder()}>
                {revealLabel}
              </Button>
              <Button size="sm" icon="x" title="Close this project and go back to the start screen; it's saved and stays in Recent" onClick={() => void attempt(() => p.close(), 'Close project')}>
                Close
              </Button>
            </div>
          </section>
        )}

        <PracticeStats />

        <section className="set-group">
          <h4>Start</h4>
          <div className="proj-actions">
            <Button size="sm" icon="plus" title={shortcut('N')} onClick={() => void attempt(() => p.create(''))}>
              New project
            </Button>
            <Button size="sm" icon="folder" title={shortcut('O')} onClick={() => void attempt(() => p.openDialog())}>
              Open…
            </Button>
          </div>
        </section>

        {recent.length > 0 && (
          <section className="set-group">
            <h4>Recent</h4>
            {recent.map((r) => (
              <div key={r.path} className="recent-row">
                <button type="button" className="recent-open" title={r.path} onClick={() => void attempt(() => p.open(r.path))}>
                  <Icon name="file" size={14} />
                  <span className="recent-name">{r.name}</span>
                  <span className="recent-date">{day(r.openedAt)}</span>
                </button>
                <Button size="sm" variant="ghost" icon="x" title="Remove from list" onClick={() => void p.forgetRecent(r.path)} />
              </div>
            ))}
          </section>
        )}

        {/* Out of the way of the everyday buttons; it asks first anyway. */}
        {project && (
          <section className="set-group proj-danger">
            <Button size="sm" variant="ghost" icon="trash" className="proj-delete" onClick={() => void attempt(() => p.delete(), 'Delete project')}>
              Delete this project…
            </Button>
          </section>
        )}
      </div>
    </aside>
  )
}

/** How long you've practised: today, this week, all time, this project, and the songs you've spent most time on. */
function PracticeStats() {
  const totals = useStore((s) => s.snapshot?.practice)
  const project = useStore((s) => s.snapshot?.project ?? null)
  if (!totals) return null
  const top = (project?.songs ?? [])
    .filter((s) => s.practiceSec >= 60)
    .sort((a, b) => b.practiceSec - a.practiceSec)
    .slice(0, 3)
  const rows: [string, number][] = [
    ['Today', totals.today],
    ['This week', totals.week],
    // Practice is counted per computer; a project brought from another one still counts.
    ['All time', Math.max(totals.total, project?.practiceSec ?? 0)],
    ...(project ? ([['This project', project.practiceSec]] as [string, number][]) : [])
  ]
  return (
    <section className="set-group">
      <h4>Practice</h4>
      <div className="stats" title="Counts while a song plays, or while you play your bass with Monitor on">
        {rows.map(([label, sec]) => (
          <div key={label} className="stat-row">
            <span>{label}</span>
            <b>{formatDuration(sec)}</b>
          </div>
        ))}
      </div>
      {top.length > 0 && (
        <>
          <div className="stats-sub">Most practised</div>
          <div className="stats">
            {top.map((s) => (
              <div key={s.id} className="stat-row">
                <span className="stat-song">{s.title}</span>
                <b>{formatDuration(s.practiceSec)}</b>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
