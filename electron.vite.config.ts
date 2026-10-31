import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: { rollupOptions: { input: 'src/main/index.ts' } }
  },
  preload: {
    build: { rollupOptions: { input: 'src/preload/index.ts' } }
  },
  renderer: {
    root: 'src/renderer',
    // Absolute: Vite resolves a relative input against `root`, so the dev server's scan missed it.
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
    plugins: [react()]
  }
})
