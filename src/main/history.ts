// Undo and redo for project edits (⌘Z / ⇧⌘Z).
//
// Each user action records only what it changed, as operations on the
// project: a value set at a path, an item added to or removed from a list,
// or a list reordered. Lists of songs and effects are addressed by id, not
// index, so undo still lands on the right song after the playlist changed.
// Undo applies the inverse operations to the project as it is now, so work
// that happened in between (a separation finishing, practice time) is kept.
// Operations whose target no longer exists (a removed song) are skipped.

import type { Project } from '../shared/types'

type Seg = string | { id: string }
type Path = Seg[]

export type Op =
  | { kind: 'set'; path: Path; old: unknown; new: unknown }
  | { kind: 'insert'; path: Path; index: number; item: unknown }
  | { kind: 'remove'; path: Path; index: number; item: unknown }
  | { kind: 'order'; path: Path; old: string[]; new: string[] }

export interface Entry {
  label: string
  ops: Op[]
  at: number
}

/** Keys that are never part of an edit: progress, playback position, generated data, plugin internals. */
const IGNORED = new Set([
  'updatedAt',
  'selectedSongId',
  'practiceSec',
  'position',
  'separation',
  'analysis',
  'stems',
  'playbackProxy',
  'source',
  'durationSec',
  'mode', // which version plays is navigation, like selecting a song
  'state', // plugin state blobs, captured from the engine in the background
  'inputDevice',
  'outputDevice',
  'inputChannels',
  'sampleRate',
  'bufferSize'
])

const idKey = (item: unknown): string | null => {
  if (!item || typeof item !== 'object') return null
  const o = item as Record<string, unknown>
  return typeof o.id === 'string' ? 'id' : typeof o.slotId === 'string' ? 'slotId' : null
}
const idOf = (item: unknown): string => {
  const k = idKey(item)
  return k ? String((item as Record<string, unknown>)[k]) : ''
}
const isIdList = (v: unknown): v is unknown[] => Array.isArray(v) && v.length > 0 && v.every((x) => idKey(x) !== null)
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

/** What changed from `a` to `b`, skipping ignored keys. */
export function diff(a: unknown, b: unknown, path: Path = []): Op[] {
  if (a === b) return []
  const last = path[path.length - 1]
  if (typeof last === 'string' && IGNORED.has(last)) return []
  if ((isIdList(a) || isIdList(b)) && Array.isArray(a) && Array.isArray(b)) {
    const ops: Op[] = []
    const aIds = a.map(idOf)
    const bIds = b.map(idOf)
    a.forEach((item, i) => !bIds.includes(aIds[i]) && ops.push({ kind: 'remove', path, index: i, item }))
    b.forEach((item, i) => !aIds.includes(bIds[i]) && ops.push({ kind: 'insert', path, index: i, item }))
    const keptA = aIds.filter((id) => bIds.includes(id))
    const keptB = bIds.filter((id) => aIds.includes(id))
    if (!same(keptA, keptB)) ops.push({ kind: 'order', path, old: keptA, new: keptB })
    for (const item of b) {
      const before = a.find((x) => idOf(x) === idOf(item))
      if (before) ops.push(...diff(before, item, [...path, { id: idOf(item) }]))
    }
    return ops
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)])
    return [...keys].flatMap((k) => diff(ao[k], bo[k], [...path, k]))
  }
  return same(a, b) ? [] : [{ kind: 'set', path, old: a, new: b }]
}

/** Copy-on-write update of the value at `path`; returns `root` unchanged if the path no longer exists. */
function update(root: unknown, path: Path, fn: (v: unknown) => unknown): unknown {
  if (path.length === 0) return fn(root)
  const [seg, ...rest] = path
  if (typeof seg === 'string') {
    if (!root || typeof root !== 'object') return root
    const o = root as Record<string, unknown>
    if (rest.length > 0 && !(seg in o)) return root
    const next = update(o[seg], rest, fn)
    return next === o[seg] ? root : { ...o, [seg]: next }
  }
  if (!Array.isArray(root)) return root
  const i = root.findIndex((x) => idOf(x) === seg.id)
  if (i < 0) return root
  const next = update(root[i], rest, fn)
  if (next === root[i]) return root
  const copy = [...root]
  copy[i] = next
  return copy
}

function apply(project: Project, op: Op): Project {
  return update(project, op.path, (v) => {
    switch (op.kind) {
      case 'set':
        return op.new
      case 'insert': {
        const list = Array.isArray(v) ? v : []
        if (list.some((x) => idOf(x) === idOf(op.item))) return v
        const copy = [...list]
        copy.splice(Math.min(op.index, copy.length), 0, op.item)
        return copy
      }
      case 'remove':
        return Array.isArray(v) ? v.filter((x) => idOf(x) !== idOf(op.item)) : v
      case 'order': {
        if (!Array.isArray(v)) return v
        // Reorder the listed items among themselves; items added since stay where they are.
        const queue = op.new.filter((id) => v.some((x) => idOf(x) === id))
        const moving = new Set(queue)
        const byId = new Map(v.map((x) => [idOf(x), x]))
        return v.map((x) => (moving.has(idOf(x)) ? byId.get(queue.shift()!) : x))
      }
    }
  }) as Project
}

function invert(op: Op): Op {
  switch (op.kind) {
    case 'set':
      return { ...op, old: op.new, new: op.old }
    case 'insert':
      return { ...op, kind: 'remove' }
    case 'remove':
      return { ...op, kind: 'insert' }
    case 'order':
      return { ...op, old: op.new, new: op.old }
  }
}

/** Apply an entry forwards (redo) or backwards (undo). */
export function applyEntry(project: Project, entry: Entry, direction: 'undo' | 'redo'): Project {
  const ops = direction === 'undo' ? [...entry.ops].reverse().map(invert) : entry.ops
  return ops.reduce(apply, project)
}

/** Song ids an entry touches (so undo can show the song it changed). */
export function songsIn(entry: Entry): string[] {
  const ids = new Set<string>()
  for (const op of entry.ops) {
    if (op.path[0] === 'songs' && typeof op.path[1] === 'object') ids.add(op.path[1].id)
    if (op.path.length === 1 && op.path[0] === 'songs' && (op.kind === 'insert' || op.kind === 'remove')) ids.add(idOf(op.item))
  }
  return [...ids]
}

const MERGE_MS = 1500
const LIMIT = 200

export class History {
  private undoStack: Entry[] = []
  private redoStack: Entry[] = []

  clear() {
    this.undoStack = []
    this.redoStack = []
  }

  /**
   * Record an edit. Repeated edits of the same values in quick succession
   * (dragging a slider, typing) merge into one step.
   */
  record(label: string, before: Project, after: Project) {
    const ops = diff(before, after)
    if (ops.length === 0) return
    const top = this.undoStack[this.undoStack.length - 1]
    const now = Date.now()
    const key = (o: Op[]) => JSON.stringify(o.map((x) => [x.kind, x.path]))
    if (top && top.label === label && now - top.at < MERGE_MS && ops.every((o) => o.kind === 'set') && key(top.ops) === key(ops)) {
      top.ops = top.ops.map((o, i) => ({ ...(o as Extract<Op, { kind: 'set' }>), new: (ops[i] as Extract<Op, { kind: 'set' }>).new }))
      top.at = now
    } else {
      this.undoStack.push({ label, ops, at: now })
      if (this.undoStack.length > LIMIT) this.undoStack.shift()
    }
    this.redoStack = []
  }

  takeUndo(): Entry | null {
    const e = this.undoStack.pop() ?? null
    if (e) this.redoStack.push(e)
    return e
  }

  takeRedo(): Entry | null {
    const e = this.redoStack.pop() ?? null
    if (e) this.undoStack.push({ ...e, at: 0 }) // never merge into a redone step
    return e
  }

  get canUndo() {
    return this.undoStack.length > 0
  }

  get canRedo() {
    return this.redoStack.length > 0
  }
}
