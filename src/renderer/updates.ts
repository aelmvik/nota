import { useEffect, useState } from 'react'
import type { UpdateInfo, UpdateProgress } from '../shared/updates'

/** A newer Nøta on GitHub, once the main process has found one. */
export function useUpdate(): UpdateInfo | null {
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  useEffect(() => {
    void window.nota.app.update().then(setUpdate)
    return window.nota.app.onUpdate(setUpdate)
  }, [])
  return update
}

/** Downloading and installing the update, once it's been clicked. */
export function useUpdateProgress(): UpdateProgress | null {
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  useEffect(() => window.nota.app.onUpdateProgress(setProgress), [])
  return progress
}

/** What the status bar says about an update, and what clicking it does. */
export function updateStatus(update: UpdateInfo, progress: UpdateProgress | null): { text: string; title: string; onClick?: () => void; fraction?: number } {
  const install = () => void window.nota.app.installUpdate()
  const page = () => void window.nota.app.openUpdate()
  switch (progress?.status) {
    case 'downloading':
      return { text: `Downloading Nøta ${update.version}… ${Math.round(progress.progress * 100)}%`, title: 'Nøta installs it when it’s downloaded', fraction: progress.progress }
    case 'installing':
      return { text: `Installing Nøta ${update.version}…`, title: 'Nøta restarts when it’s done' }
    case 'opened':
      return { text: `Nøta ${update.version} downloaded`, title: 'Install it, then open Nøta again. Click for the download page.', onClick: page }
    case 'failed':
      return { text: `Update failed: ${progress.error}`, title: 'Click to download it from the release page instead', onClick: page }
    default:
      return update.asset
        ? { text: `Update to Nøta ${update.version}`, title: 'Download and install it now (your project is saved first)', onClick: install }
        : { text: `Nøta ${update.version} is out`, title: 'Open the download page', onClick: page }
  }
}
