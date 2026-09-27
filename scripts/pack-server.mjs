// Build resources/server.zip — the DSH server runtime (npm-installed
// @deepseek-ai/dsh with its full dependency tree) compressed into a single
// archive. The installer ships this archive + a tiny app shell, so installing
// writes a handful of files instead of ~16k; the app extracts the archive to
// real directories on first launch, where DSH's plugin loader (profile module
// fallback junctions) can resolve packages normally.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')
const tmp = join(appDir, 'resources', 'server-tmp')
const zip = join(appDir, 'resources', 'server.zip')
const SERVER_PKG = process.env.DSH_DESKTOP_SERVER_PKG || '@deepseek-ai/dsh@0.1.7-rc.2'

const reuseTmp = process.env.DSH_DESKTOP_SKIP_INSTALL === '1' && existsSync(join(tmp, 'node_modules'))
if (reuseTmp) {
  console.log('[pack-server] DSH_DESKTOP_SKIP_INSTALL=1: reusing existing ' + tmp)
} else {
  console.log('[pack-server] installing ' + SERVER_PKG + ' into ' + tmp)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  execFileSync(npm, ['install', '--prefix', tmp, '--no-audit', '--no-fund', '--no-package-lock', SERVER_PKG], { stdio: 'inherit', shell: process.platform === 'win32' })
}

console.log('[pack-server] pruning runtime-unneeded files')
// Remove what the server never loads at runtime, to shrink the archive and
// speed up first-launch extraction: type declarations, source maps, TS/C++
// sources, docs, debug symbols, and native binaries for platforms other than
// the current one.
const rmDir = (dir) => { rmSync(dir, { recursive: true, force: true }) }
const PRUNE_FILE = /(^|[\\/])(readme|changelog|notice)[^\\/]*\.(md|txt|rst|markdown)$|^(readme|changelog)[^.]*$/i
const PRUNE_EXT = /\.(d\.ts|ts|mts|cts|map|cc|h|hh|s|mk|gyp|gypi|inc|asm|def|c|lib|dtd|pdb|tsbuildinfo)$/i
const nodeModules = join(tmp, 'node_modules')
function pruneWalk(dir) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      pruneWalk(full)
      try { if (readdirSync(full).length === 0) rmSync(full, { recursive: true, force: true }) } catch { /* ignore */ }
    } else if (PRUNE_FILE.test(e.name) || PRUNE_EXT.test(e.name)) {
      try { rmSync(full, { force: true }) } catch { /* ignore */ }
    }
  }
}
pruneWalk(nodeModules)

// Native packages for platforms other than the running one (win32-x64 here)
if (process.platform === 'win32') {
  rmDir(join(nodeModules, 'node-pty', 'prebuilds', 'darwin-arm64'))
  rmDir(join(nodeModules, 'node-pty', 'prebuilds', 'darwin-x64'))
  rmDir(join(nodeModules, 'node-pty', 'prebuilds', 'win32-arm64'))
  const conptyRoot = join(nodeModules, 'node-pty', 'third_party', 'conpty')
  for (const ver of existsSync(conptyRoot) ? readdirSync(conptyRoot) : []) {
    rmDir(join(conptyRoot, ver, 'win10-arm64'))
  }
  const rg = join(nodeModules, '@vscode')
  for (const d of existsSync(rg) ? readdirSync(rg) : []) {
    if (/^ripgrep-win32-arm64|^ripgrep-darwin|^ripgrep-linux/.test(d)) rmDir(join(rg, d))
  }
}

console.log('[pack-server] creating ' + zip)
rmSync(zip, { force: true })
const tar = process.platform === 'win32' ? 'tar.exe' : 'tar'
execFileSync(tar, ['-a', '-cf', zip, '-C', tmp, 'node_modules'], { stdio: 'inherit' })
// NOTE: the archive keeps the 'node_modules' prefix, so extraction yields
// <dest>/node_modules/@deepseek-ai/dsh/... — Node's upward resolution from
// the dsh package then finds all deps in <dest>/node_modules.

rmSync(tmp, { recursive: true, force: true })
console.log('[pack-server] done: ' + zip + ' (' + (statSync(zip).size / 1048576).toFixed(0) + ' MB)')
