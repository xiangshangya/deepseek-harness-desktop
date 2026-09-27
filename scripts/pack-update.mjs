/**
 * Build the in-place update package.
 *
 * Layout matches the install directory, so the shell can extract it straight
 * over its own files and relaunch — no installer, no UAC, no registry or
 * shortcut changes, and `~/.dsh` is never touched:
 *
 *   resources/app/main.js          app shell
 *   resources/app/preload.js       desktop carrier for the web client
 *   resources/app/loading.html     boot placeholder
 *   resources/app/package.json     app manifest (carries the version)
 *   resources/server.zip           bundled DSH runtime
 *   update.json                    version + per-file sha256 manifest
 *
 * Usage: node scripts/pack-update.mjs
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')
const staging = join(appDir, 'dist', 'update-staging')
// Take the payload from the packaged tree, so the update package carries exactly
// the same files the installer would lay down (pruned package.json included).
const packaged = join(appDir, 'dist', 'win-unpacked')
const manifest = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))
const version = manifest.version
const zip = join(appDir, 'dist', `DeepSeek.Harness.Desktop-${version}-update.zip`)

const shellFiles = ['main.js', 'preload.js', 'loading.html', 'package.json']
const payload = [
  ...shellFiles.map((name) => ({ from: join(packaged, 'resources', 'app', name), to: `resources/app/${name}` })),
  { from: join(packaged, 'resources', 'server.zip'), to: 'resources/server.zip' },
]

for (const entry of payload) {
  if (!existsSync(entry.from)) {
    throw new Error(`missing ${entry.from} — run "npx electron-builder --win" first`)
  }
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

rmSync(staging, { recursive: true, force: true })
for (const entry of payload) {
  const target = join(staging, entry.to)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(entry.from, target)
}

writeFileSync(
  join(staging, 'update.json'),
  JSON.stringify({
    format: 'dsh-desktop-update',
    protocol: 1,
    version,
    files: payload.map((entry) => ({
      path: entry.to.replace(/\\/g, '/'),
      sha256: sha256(join(staging, entry.to)),
      size: statSync(join(staging, entry.to)).size,
    })),
  }, null, 2) + '\n',
)

rmSync(zip, { force: true })
execFileSync('tar.exe', ['-a', '-cf', zip, '-C', staging, '.'], { stdio: 'inherit' })
rmSync(staging, { recursive: true, force: true })

process.stdout.write(
  `pack-update: ${zip} (${(statSync(zip).size / 1048576).toFixed(1)} MB, version ${version})\n`,
)
