import { useEffect, useState } from 'react'
import type { UpdateInfo } from '../shared/updates'

/** A newer Nøta on GitHub, once the main process has found one. */
export function useUpdate(): UpdateInfo | null {
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  useEffect(() => {
    void window.nota.app.update().then(setUpdate)
    return window.nota.app.onUpdate(setUpdate)
  }, [])
  return update
}
