import { BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { transposeKey } from '../shared/music'
import type { Project, Song } from '../shared/types'

// Printable setlist: every song in playlist order with its artist and the
// key to play it in. Rendered to A4 by Chromium's print engine.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** The key to play the song in: the detected key, transposed if the song is. */
export function setlistKey(song: Song): string {
  const original = song.analysis.status === 'ready' ? song.analysis.key : undefined
  return original ? transposeKey(original, song.pitch.semitones) : '—'
}

export function buildSetlistHtml(project: Project, date = new Date()): string {
  const rows = project.songs
    .map((song, i) => {
      const key = setlistKey(song)
      return `
      <section class="song">
        <div class="head">
          <span class="num">${i + 1}</span>
          <div class="names">
            <div class="title">${esc(song.title)}</div>
            ${song.artist ? `<div class="artist">${esc(song.artist)}</div>` : ''}
          </div>
          <div class="key">
            <div class="key-label">Key</div>
            <div class="key-value">${esc(key)}</div>
          </div>
        </div>
      </section>`
    })
    .join('')

  const when = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(project.name)} setlist</title>
<style>
  @page { size: A4; margin: 16mm 16mm 18mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; color: #1c1c1e; font-size: 10.5pt; }
  header { display: flex; align-items: baseline; justify-content: space-between; border-bottom: 1.5pt solid #1c1c1e; padding-bottom: 5mm; margin-bottom: 6mm; }
  h1 { font-size: 20pt; margin: 0; letter-spacing: -0.01em; }
  .meta { color: #6b6b70; font-size: 9.5pt; }
  .song { break-inside: avoid; padding: 0 0 4mm; margin-bottom: 4mm; border-bottom: 0.5pt solid #d4d4d8; }
  .song:last-child { border-bottom: none; }
  .head { display: flex; align-items: flex-start; gap: 5mm; }
  .num { width: 8mm; font-size: 14pt; font-weight: 600; color: #9a9aa0; font-variant-numeric: tabular-nums; }
  .names { flex: 1; min-width: 0; }
  .title { font-size: 13pt; font-weight: 650; }
  .artist { color: #55555a; margin-top: 0.8mm; }
  .key { text-align: right; min-width: 38mm; }
  .key-label { font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.08em; color: #9a9aa0; }
  .key-value { font-size: 13pt; font-weight: 650; margin-top: 0.5mm; }
  .empty { color: #6b6b70; padding: 10mm 0; }
</style></head>
<body>
  <header>
    <h1>${esc(project.name)}</h1>
    <span class="meta">${project.songs.length} ${project.songs.length === 1 ? 'song' : 'songs'} · ${esc(when)}</span>
  </header>
  ${rows || '<p class="empty">This project has no songs yet.</p>'}
</body></html>`
}

/** Render the setlist to a PDF file. */
export async function exportSetlistPdf(project: Project, path: string): Promise<void> {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, javascript: false } })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildSetlistHtml(project)))
    const pdf = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font-size:8px;color:#9a9aa0;padding:0 16mm;display:flex;justify-content:space-between;font-family:-apple-system,Helvetica,sans-serif">
        <span>${esc(project.name)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`
    })
    await writeFile(path, pdf)
  } finally {
    win.destroy()
  }
}
