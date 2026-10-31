import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// npm run demo:build → demo/dist, a static page for the website (no Electron).
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  build: { outDir: resolve(__dirname, 'dist'), emptyOutDir: true, target: 'es2022' }
})
