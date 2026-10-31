import type { ImportResult } from '../shared/types'
import { attempt, toast } from './state/store'

export function reportImport(res: ImportResult) {
  if (res.added.length) toast(`Added ${res.added.length} ${res.added.length === 1 ? 'song' : 'songs'}`, 'success')
  for (const s of res.skipped.slice(0, 4)) toast(`${s.path.split('/').pop()}: ${s.reason}`, 'error', 7000)
  if (res.skipped.length > 4) toast(`${res.skipped.length - 4} more files were skipped`, 'error')
}

export async function importViaDialog() {
  const res = await attempt(() => window.nota.songs.importDialog(), 'Import')
  if (res) reportImport(res)
}

export async function importPaths(paths: string[]) {
  if (!paths.length) return
  const res = await attempt(() => window.nota.songs.importPaths(paths), 'Import')
  if (res) reportImport(res)
}

export async function exportSetlist() {
  const path = await attempt(() => window.nota.project.exportSetlist(), 'Setlist')
  if (path) toast(`Setlist saved as ${path.split('/').pop()}`, 'success')
}
