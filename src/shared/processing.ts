import type { SeparationState, SeparationStatus } from './types'

// Separation state machine. Every status change in the app goes through
// `transition`, so a song can never jump to "ready" without the job
// having actually completed and its output validated.

export type SeparationEvent =
  | { type: 'enqueue' }
  | { type: 'start'; model: string }
  | { type: 'progress'; progress: number; stage?: string }
  | { type: 'succeed'; model: string; warning?: string }
  | { type: 'fail'; error: string }
  | { type: 'cancel' }
  | { type: 'unavailable'; reason: string }
  | { type: 'reset' }

const ALLOWED: Record<SeparationEvent['type'], readonly SeparationStatus[]> = {
  enqueue: ['pending', 'failed', 'cancelled', 'unavailable', 'ready'],
  start: ['queued'],
  progress: ['processing'],
  succeed: ['processing', 'pending'], // 'pending' -> 'ready' when valid cached stems are found
  fail: ['processing', 'queued', 'pending'],
  cancel: ['queued', 'processing'],
  unavailable: ['pending', 'queued', 'failed', 'cancelled', 'unavailable'],
  reset: ['pending', 'queued', 'processing', 'ready', 'failed', 'cancelled', 'unavailable']
}

export class InvalidTransitionError extends Error {
  constructor(from: SeparationStatus, event: SeparationEvent['type']) {
    super(`Cannot apply "${event}" to a separation that is ${from}`)
  }
}

export function canTransition(state: SeparationState, event: SeparationEvent['type']): boolean {
  return ALLOWED[event].includes(state.status)
}

export function transition(state: SeparationState, event: SeparationEvent): SeparationState {
  if (!canTransition(state, event.type)) throw new InvalidTransitionError(state.status, event.type)

  switch (event.type) {
    case 'enqueue':
      return { status: 'queued', progress: 0 }
    case 'start':
      return { status: 'processing', progress: 0, stage: 'starting', model: event.model }
    case 'progress':
      return {
        ...state,
        progress: Math.max(state.progress, Math.min(1, Math.max(0, event.progress))),
        stage: event.stage ?? state.stage
      }
    case 'succeed':
      return { status: 'ready', progress: 1, model: event.model, warning: event.warning }
    case 'fail':
      return { status: 'failed', progress: 0, error: event.error, model: state.model }
    case 'cancel':
      return { status: 'cancelled', progress: 0 }
    case 'unavailable':
      return { status: 'unavailable', progress: 0, error: event.reason }
    case 'reset':
      return { status: 'pending', progress: 0 }
  }
}

/** On reopen, jobs that were in flight when the app closed must be redone. */
export function recoverAfterRestart(state: SeparationState): SeparationState {
  if (state.status === 'queued' || state.status === 'processing') return { status: 'pending', progress: 0 }
  return state
}

export const STAGE_LABELS: Record<string, string> = {
  starting: 'Starting',
  'loading-model': 'Loading model',
  decoding: 'Decoding',
  separating: 'Separating',
  writing: 'Writing stems',
  validating: 'Validating'
}
