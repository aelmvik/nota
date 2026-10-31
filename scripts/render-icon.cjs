// Renders build/icon.html (the stacked nø/ta wordmark in Archivo) to
// build/icon.png (1024²) with Electron's own renderer, then builds
// build/icon.icns with sips + iconutil.
// On Windows it builds build/icon.ico from that build/icon.png instead.
// Run: npx electron scripts/render-icon.cjs
const { app, BrowserWindow, nativeImage } = require('electron')
const { writeFileSync, mkdirSync, rmSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

const buildDir = join(__dirname, '..', 'build')

/**
 * A Windows .ico with the usual sizes. Windows icons fill their square, so the
 * tile is cropped out of the macOS margin. Small sizes are 32-bit bitmaps
 * (readable everywhere, NSIS included), 256 px is PNG.
 */
function windowsIcon(image) {
  const tile = image.crop({ x: 84, y: 84, width: 856, height: 856 }) // the 824 px tile and its shadow
  const entries = [16, 20, 24, 32, 40, 48, 64, 128, 256].map((size) => {
    const img = tile.resize({ width: size, height: size, quality: 'best' })
    if (size === 256) return { size, data: img.toPNG() }
    const bgra = img.toBitmap() // premultiplied BGRA, top-down
    const maskRow = Math.ceil(size / 32) * 4
    const dib = Buffer.alloc(40 + size * size * 4 + maskRow * size)
    dib.writeUInt32LE(40, 0)
    dib.writeInt32LE(size, 4)
    dib.writeInt32LE(size * 2, 8) // colour rows + mask rows
    dib.writeUInt16LE(1, 12)
    dib.writeUInt16LE(32, 14)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const s = (y * size + x) * 4
        const d = 40 + ((size - 1 - y) * size + x) * 4 // bottom-up
        const a = bgra[s + 3]
        for (let c = 0; c < 3; c++) dib[d + c] = a ? Math.min(255, Math.round((bgra[s + c] * 255) / a)) : 0
        dib[d + 3] = a
      }
    }
    return { size, data: dib } // the AND mask stays empty: alpha decides
  })
  const header = Buffer.alloc(6 + 16 * entries.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = header.length
  entries.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i
    header[e] = size === 256 ? 0 : size
    header[e + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, e + 4)
    header.writeUInt16LE(32, e + 6)
    header.writeUInt32LE(data.length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([header, ...entries.map((e) => e.data)])
}

app.dock?.hide()
app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    writeFileSync(join(buildDir, 'icon.ico'), windowsIcon(nativeImage.createFromPath(join(buildDir, 'icon.png'))))
    console.log('Wrote build/icon.ico')
    app.quit()
    return
  }
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } })
  win.webContents.setZoomFactor(1)
  await win.loadFile(join(buildDir, 'icon.html'))
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
  await new Promise((r) => setTimeout(r, 300))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  const png = image.resize({ width: 1024, height: 1024 }).toPNG()
  writeFileSync(join(buildDir, 'icon.png'), png)

  const iconset = join(buildDir, 'icon.iconset')
  rmSync(iconset, { recursive: true, force: true })
  mkdirSync(iconset)
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = size * scale
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
      execFileSync('sips', ['-z', String(px), String(px), join(buildDir, 'icon.png'), '--out', join(iconset, name)], { stdio: 'ignore' })
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(buildDir, 'icon.icns')])
  rmSync(iconset, { recursive: true, force: true })
  console.log('Wrote build/icon.png and build/icon.icns')
  app.quit()
})
