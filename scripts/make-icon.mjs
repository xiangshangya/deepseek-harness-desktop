// Render build/icon.svg into build/icon.png (512x512) for electron-builder.
// App icons cannot adapt to the OS theme, so we pin the palette: dark rounded
// background + white mark (visible on both light and dark surfaces).
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')
const svgPath = join(appDir, 'build', 'icon.svg')
const pngPath = join(appDir, 'build', 'icon.png')

const raw = readFileSync(svgPath, 'utf8')
// Strip the prefers-color-scheme style, force the mark white, add a dark bg.
const composited = raw
  .replace(/<style>[\s\S]*?<\/style>/, '')
  .replace('width="50.000000" height="50.000000"', 'width="512" height="512"')
  .replace('<path id="path"', '<rect width="50" height="50" rx="10" fill="#0d1117"/><path id="path"')
  .replace('fill="#000" fill-opacity="1.000000"', 'fill="#ffffff"')

await sharp(Buffer.from(composited))
  .resize(512, 512, { fit: 'contain', background: { r: 13, g: 17, b: 23, alpha: 1 } })
  .png()
  .toFile(pngPath)
console.log('[make-icon] wrote ' + pngPath)
