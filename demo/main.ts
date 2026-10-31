// The website's demo: the real renderer, with a stand-in for the preload API.
import { createFakeNota } from './fakeNota'
import { setTheme } from './theme'

window.nota = await createFakeNota('./data')
await import('../src/renderer/main')

// Settings → Appearance works as in the app.
setTheme((await window.nota.prefs.get()).theme)
window.nota.prefs.onChange((p) => setTheme(p.theme))

// The website's "Three ways to hear a song" switch plays along: it sets the selected song's mode.
window.addEventListener('message', (e: MessageEvent<{ type?: string; mode?: 'original' | 'bass' | 'playalong' }>) => {
  const mode = e.data?.type === 'nota:mode' ? e.data.mode : undefined
  if (!mode) return
  void window.nota.project.get().then((s) => {
    const id = s.project?.selectedSongId
    if (id) void window.nota.songs.update(id, { mode })
  })
})
