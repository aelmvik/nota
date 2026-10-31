import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initStore } from './state/store'
import './styles.css'

document.documentElement.dataset.platform = window.nota.platform
if (window.nota.platform === 'win32') {
  const root = document.documentElement
  window.nota.onWindowFramed((framed) => root.toggleAttribute('data-framed', framed))
  // One device pixel in CSS pixels, for the frame line under the window buttons.
  const devicePx = () => root.style.setProperty('--device-px', `${1 / (window.devicePixelRatio || 1)}px`)
  devicePx()
  window.addEventListener('resize', devicePx)
}

void initStore().then(() => {
  createRoot(document.getElementById('root')!).render(<App />)
})
