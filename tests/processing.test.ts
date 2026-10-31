import { describe, expect, it } from 'vitest'
import { canTransition, InvalidTransitionError, recoverAfterRestart, transition } from '../src/shared/processing'
import type { SeparationState } from '../src/shared/types'

const pending: SeparationState = { status: 'pending', progress: 0 }

describe('separation state machine', () => {
  it('follows the happy path', () => {
    let s = transition(pending, { type: 'enqueue' })
    expect(s.status).toBe('queued')
    s = transition(s, { type: 'start', model: 'htdemucs' })
    expect(s).toMatchObject({ status: 'processing', model: 'htdemucs' })
    s = transition(s, { type: 'progress', progress: 0.5, stage: 'separating' })
    expect(s).toMatchObject({ progress: 0.5, stage: 'separating' })
    s = transition(s, { type: 'succeed', model: 'htdemucs' })
    expect(s).toMatchObject({ status: 'ready', progress: 1 })
  })

  it('cannot become ready without running (or finding cached stems)', () => {
    const queued = transition(pending, { type: 'enqueue' })
    expect(canTransition(queued, 'succeed')).toBe(false)
    expect(() => transition(queued, { type: 'succeed', model: 'm' })).toThrow(InvalidTransitionError)
    // From pending it is allowed: that is the "valid cached stems found" path.
    expect(transition(pending, { type: 'succeed', model: 'm' }).status).toBe('ready')
  })

  it('progress never goes backwards and is clamped', () => {
    let s = transition(transition(pending, { type: 'enqueue' }), { type: 'start', model: 'm' })
    s = transition(s, { type: 'progress', progress: 0.6 })
    s = transition(s, { type: 'progress', progress: 0.3 })
    expect(s.progress).toBe(0.6)
    expect(transition(s, { type: 'progress', progress: 4 }).progress).toBe(1)
  })

  it('supports cancel and retry', () => {
    const running = transition(transition(pending, { type: 'enqueue' }), { type: 'start', model: 'm' })
    const cancelled = transition(running, { type: 'cancel' })
    expect(cancelled.status).toBe('cancelled')
    expect(transition(cancelled, { type: 'enqueue' }).status).toBe('queued')
  })

  it('records failure reasons and allows retry', () => {
    const running = transition(transition(pending, { type: 'enqueue' }), { type: 'start', model: 'm' })
    const failed = transition(running, { type: 'fail', error: 'out of memory' })
    expect(failed).toMatchObject({ status: 'failed', error: 'out of memory' })
    expect(transition(failed, { type: 'enqueue' }).status).toBe('queued')
  })

  it('rejects progress for jobs that are not running', () => {
    expect(() => transition(pending, { type: 'progress', progress: 0.2 })).toThrow(InvalidTransitionError)
    expect(() => transition({ status: 'ready', progress: 1 }, { type: 'cancel' })).toThrow(InvalidTransitionError)
  })

  it('resets in-flight work after a restart only', () => {
    expect(recoverAfterRestart({ status: 'processing', progress: 0.7 }).status).toBe('pending')
    expect(recoverAfterRestart({ status: 'queued', progress: 0 }).status).toBe('pending')
    expect(recoverAfterRestart({ status: 'ready', progress: 1 }).status).toBe('ready')
    expect(recoverAfterRestart({ status: 'failed', progress: 0, error: 'x' }).status).toBe('failed')
  })
})
