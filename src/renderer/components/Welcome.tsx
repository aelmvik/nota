import { useState } from 'react'
import { EMPTY, attempt, readPref, useStore, writePref } from '../state/store'
import { Button, Icon, Wordmark } from './ui'

// Back again: one of these, a different one from last time.
const GREETINGS = [
  'What’s on the agenda today?',
  'Back at it, huh?',
  'Ready to pick up where you left off?',
  'What’s the plan for today?',
  'Let’s see what we’re working on.',
  'A little practice never hurts.',
  'Back for another round?',
  'What are we tackling today?',
  'Time to get into it.',
  'Alright, what’s next?'
]

function pickGreeting(): string {
  const last = readPref<number>('lastGreeting', -1)
  const repeat = last >= 0 && last < GREETINGS.length
  let i = Math.floor(Math.random() * (GREETINGS.length - (repeat ? 1 : 0)))
  if (repeat && i >= last) i++
  writePref('lastGreeting', i)
  return GREETINGS[i]
}

export function Welcome() {
  const recent = useStore((s) => s.snapshot?.recent ?? EMPTY)
  const [name, setName] = useState('')
  // The first time (no projects yet) says what Nøta is; after that, a greeting.
  const firstTime = recent.length === 0
  const [greeting] = useState(pickGreeting)

  return (
    <div className="welcome">
      <div className="welcome-card">
        <Wordmark size={84} className="welcome-mark" />
        {firstTime ? (
          <>
            <h1>Start with a project</h1>
            <p className="welcome-lead">
              A project holds the songs you’re working on, like a setlist or a gig. Add songs to it and Nøta gives each one a bass-only track to learn from and a version without bass to play along with.
            </p>
          </>
        ) : (
          <h1>{greeting}</h1>
        )}
        <form
          className="welcome-create"
          onSubmit={(e) => {
            e.preventDefault()
            void attempt(() => window.nota.project.create(name))
          }}
        >
          <input placeholder="Practice session name (optional)" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <Button variant="primary" type="submit" icon="plus">
            Create project
          </Button>
        </form>
        <div className="welcome-alt">
          <Button variant="ghost" icon="folder" onClick={() => void attempt(() => window.nota.project.openDialog())}>
            Open existing project…
          </Button>
        </div>

        {recent.length > 0 && (
          <div className="welcome-recent">
            <h4>Recent projects</h4>
            {recent.map((r) => (
              <div key={r.path} className="recent-row">
                <button type="button" className="recent-open" title={r.path} onClick={() => void attempt(() => window.nota.project.open(r.path))}>
                  <Icon name="file" size={14} />
                  <span className="recent-name">{r.name}</span>
                  <span className="recent-date">{new Date(r.openedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                </button>
                <Button size="sm" variant="ghost" icon="x" title="Remove from list" onClick={() => void window.nota.project.forgetRecent(r.path)} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
