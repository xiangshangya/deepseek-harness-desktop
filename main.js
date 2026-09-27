'use strict'

/**
 * dsh-desktop — Electron shell for the DeepSeek Harness web server.
 *
 * The app starts the real `dsh web` server as a child Node process (the very
 * same runtime you would run from a terminal), waits for its readiness line
 * (`dsh web: http://127.0.0.1:<port>/?token=...`, emitted after the loader
 * tree settles), then opens the frontend in an Electron window. Recent dsh
 * versions require that bearer token, so the whole printed URL is loaded
 * verbatim; older versions print it without a token and keep working.
 * On quit the server process tree is torn down.
 *
 * Runtime resolution order for the server's Node:
 *   1. $DSH_NODE (explicit override)
 *   2. bundled Node at <resources>/node (drop-in, see resources/node/README.txt)
 *   3. system `node` on PATH (must satisfy DSH engines: ^22.19 || >=24)
 *   4. Electron's own Node via ELECTRON_RUN_AS_NODE (last resort)
 *
 * Server resolution order:
 *   1. $DSH_ROOT — a DeepSeek Harness source checkout (apps/cli/lib or src)
 *   2. the npm-installed @deepseek-ai/dsh dependency of this app
 *
 * Useful env vars:
 *   DSH_DESKTOP_PORT   pin a port (default 0 = let the OS pick one)
 *   DSH_DESKTOP_SMOKE_TIMEOUT_MS   boot timeout for --smoke mode
 *   DSH_ROOT           point at a local checkout to run modified source
 *   DSH_NODE           force a specific node binary
 */

const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron')
const { spawn, spawnSync, execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const http = require('node:http')
const https = require('node:https')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

const SMOKE = process.argv.includes('--smoke')
// --quit-after <ms>: automated-test hook that exits (with a clean server
// shutdown) after the given runtime, e.g. to exercise the full GUI path in CI.
function quitAfterMs() {
  const i = process.argv.indexOf('--quit-after')
  return i >= 0 ? Number(process.argv[i + 1]) || 0 : 0
}
const QUIT_AFTER = quitAfterMs()
const SMOKE_TIMEOUT_MS = Number(process.env.DSH_DESKTOP_SMOKE_TIMEOUT_MS || 120000)
const BOOT_TIMEOUT_MS = 90000
const HTTP_READY_TIMEOUT_MS = 15000

// DeepSeek Harness engines: ^22.19.0 || >=24.0.0
function nodeSatisfies(version) {
  if (!version) return false
  if (version.major >= 24) return true
  return version.major === 22 && version.minor >= 19
}

function queryNodeVersion(bin, env) {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true, env: env ? { ...process.env, ...env } : process.env })
    const m = /v?(\d+)\.(\d+)\.(\d+)/.exec((out || '').trim())
    if (!m) return { ok: false, error: 'unparseable version output: ' + out }
    return { ok: true, version: { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }, raw: out.trim() }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// Packaged builds store the app (node_modules included) inside app.asar.
// Only Electron's own Node (ELECTRON_RUN_AS_NODE) can read inside that
// archive — an external system/bundled Node would fail to resolve the server
// entry — so packaged+asar builds always run the server under Electron's Node.
function asarActive() {
  return app.isPackaged && !!process.resourcesPath
    && fs.existsSync(path.join(process.resourcesPath, 'app.asar'))
}

function resolveNodeRuntime() {
  // 0a. packaged + asar: only Electron's Node can read the archive
  if (asarActive()) {
    const q = queryNodeVersion(process.execPath, { ELECTRON_RUN_AS_NODE: '1' })
    if (q.ok && nodeSatisfies(q.version)) {
      return { bin: process.execPath, mode: 'electron-as-node (packaged asar)', version: q.raw, env: { ELECTRON_RUN_AS_NODE: '1' } }
    }
    return null
  }
  // 0. forced mode (testing): bypass resolution and use Electron's own Node
  if (process.env.DSH_DESKTOP_NODE_MODE === 'electron-as-node') {
    const q = queryNodeVersion(process.execPath, { ELECTRON_RUN_AS_NODE: '1' })
    if (q.ok && nodeSatisfies(q.version)) {
      return { bin: process.execPath, mode: 'electron-as-node (forced)', version: q.raw, env: { ELECTRON_RUN_AS_NODE: '1' } }
    }
    return null
  }
  // 1. explicit override
  if (process.env.DSH_NODE) {
    const q = queryNodeVersion(process.env.DSH_NODE)
    if (q.ok && nodeSatisfies(q.version)) return { bin: process.env.DSH_NODE, mode: 'DSH_NODE', version: q.raw }
    log('DSH_NODE is set but unusable, falling back (' + q.error + ')')
  }
  // 2. bundled node (<resources>/node)
  const resources = process.resourcesPath || ''
  const bundled = process.platform === 'win32'
    ? path.join(resources, 'node', 'node.exe')
    : path.join(resources, 'node', 'bin', 'node')
  if (bundled && fs.existsSync(bundled)) {
    const q = queryNodeVersion(bundled)
    if (q.ok && nodeSatisfies(q.version)) return { bin: bundled, mode: 'bundled', version: q.raw }
    log('bundled node is unusable, falling back (' + q.error + ')')
  }
  // 3. system node
  const sys = findSystemNode()
  if (sys) return sys
  // 4. Electron's own Node
  const q = queryNodeVersion(process.execPath, { ELECTRON_RUN_AS_NODE: '1' })
  if (q.ok && nodeSatisfies(q.version)) {
    return { bin: process.execPath, mode: 'electron-as-node', version: q.raw, env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  return null
}

function findSystemNode() {
  const candidates = []
  try {
    if (process.platform === 'win32') {
      const where = spawnSync('where.exe', ['node'], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
      if (where.status === 0) {
        for (const line of where.stdout.split(/\r?\n/)) {
          const p = line.trim()
          if (p && fs.existsSync(p)) candidates.push(p)
        }
      }
    } else {
      const which = spawnSync('which', ['node'], { encoding: 'utf8', timeout: 15000 })
      if (which.status === 0 && which.stdout.trim()) candidates.push(which.stdout.trim())
    }
  } catch { /* ignore */ }
  for (const c of candidates) {
    const q = queryNodeVersion(c)
    if (q.ok && nodeSatisfies(q.version)) return { bin: c, mode: 'system-node', version: q.raw }
  }
  return null
}

// app.getAppPath() points INSIDE app.asar when packaged — not a real
// directory, so child processes cannot use it as their cwd. Use the exe dir.
function appCwd() {
  return app.isPackaged ? path.dirname(process.execPath) : app.getAppPath()
}

// Version of the server bundle shipped inside resources/server.zip (kept in
// sync with scripts/pack-server.mjs). A mismatch triggers a re-extract.
const SERVER_VERSION = '0.1.7-rc.2'

function serverDir() {
  return path.join(app.getPath('userData'), 'server')
}

function setHint(text) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.webContents.executeJavaScript('document.getElementById("hint").textContent = ' + JSON.stringify(text))
  } catch { /* ignore */ }
}

/** Extract resources/server.zip to the per-user server dir (real files).
 * Async: extraction can take 10-20s on first launch and must NOT block the
 * main process — the loading window keeps painting and showing progress. */
function extractServerBundle(zip, dest) {
  log('extracting server bundle to ' + dest)
  const run = (cmd, args, timeoutMs) => new Promise((res) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    child.stdout.on('data', (c) => { buf += c })
    child.stderr.on('data', (c) => { buf += c })
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } res({ status: -1, out: buf }) }, timeoutMs)
    child.on('close', (code) => { clearTimeout(timer); res({ status: code, out: buf }) })
    child.on('error', (e) => { clearTimeout(timer); res({ status: -2, out: String(e && e.message || e) }) })
  })
  return (async () => {
    if (process.platform === 'win32') {
      const tar = await run('tar.exe', ['-xf', zip, '-C', dest], 600000)
      if (tar.status === 0) return true
      log('tar.exe extraction failed (' + tar.out.slice(0, 200) + '), trying Expand-Archive')
      const ps = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Expand-Archive -LiteralPath ' + JSON.stringify(zip) + ' -DestinationPath ' + JSON.stringify(dest) + ' -Force'], 900000)
      if (ps.status === 0) return true
      log('Expand-Archive failed: ' + ps.out.slice(0, 200))
      return false
    }
    const tar = await run('tar', ['-xf', zip, '-C', dest], 600000)
    return tar.status === 0
  })()
}

/**
 * Packaged builds ship the DSH server as one archive (fast install). On first
 * launch it is extracted to real directories — DSH's plugin loader creates
 * junctions to the install's node_modules, which cannot point inside asar, so
 * the server needs genuine on-disk packages.
 * @returns the extracted bin.js path, or null when unavailable/failed.
 */
async function ensureServerExtracted() {
  const dest = serverDir()
  const stamp = path.join(dest, '.server-version')
  const entry = path.join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const zip = path.join(process.resourcesPath || '', 'server.zip')
  if (fs.existsSync(entry) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === SERVER_VERSION) {
    return entry
  }
  if (!fs.existsSync(zip)) return null
  setHint('首次启动：正在准备服务器组件（约 10–20 秒）…')
  try { fs.rmSync(dest, { recursive: true, force: true }) } catch { /* ignore */ }
  try { fs.mkdirSync(dest, { recursive: true }) } catch { /* ignore */ }
  const startedAt = Date.now()
  const progress = setInterval(() => {
    setHint('首次启动：正在准备服务器组件 ' + Math.round((Date.now() - startedAt) / 1000) + 's …')
  }, 1000)
  const ok = await extractServerBundle(zip, dest)
  clearInterval(progress)
  if (!ok) { log('server bundle extraction FAILED'); return null }
  try { fs.writeFileSync(stamp, SERVER_VERSION) } catch { /* ignore */ }
  setHint('服务器组件就绪，正在启动…')
  log('server bundle extracted (' + SERVER_VERSION + ')')
  return entry
}

async function resolveDshServer() {
  // 1. source checkout (works in dev and packaged; loose external files)
  if (process.env.DSH_ROOT) {
    const root = process.env.DSH_ROOT
    const lib = path.join(root, 'apps', 'cli', 'lib', 'bin.js')
    const src = path.join(root, 'apps', 'cli', 'src', 'bin.ts')
    if (fs.existsSync(lib)) return { entry: lib, cwd: root, note: 'DSH_ROOT built lib' }
    if (fs.existsSync(src)) {
      // needs tsx present in that checkout (pnpm install)
      return { entry: src, cwd: root, note: 'DSH_ROOT source (tsx)', loader: ['--import', 'tsx/esm'] }
    }
    log('DSH_ROOT set but no apps/cli/lib/bin.js or src/bin.ts found at ' + root)
  }
  // 2. packaged: extracted server bundle from resources/server.zip
  if (app.isPackaged) {
    const entry = await ensureServerExtracted()
    if (entry) return { entry, cwd: appCwd(), note: 'extracted server bundle' }
    // debugging fallback: loose server tree under resources/dsh-server
    const resBin = path.join(process.resourcesPath || '', 'dsh-server', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (fs.existsSync(resBin)) return { entry: resBin, cwd: appCwd(), note: 'resources loose server' }
    return null
  }
  // 3. dev: npm dependency of this app
  try {
    const pkgEntry = require.resolve('@deepseek-ai/dsh/package.json')
    const bin = path.join(path.dirname(pkgEntry), 'lib', 'bin.js')
    if (fs.existsSync(bin)) return { entry: bin, cwd: appCwd(), note: 'npm @deepseek-ai/dsh' }
  } catch { /* fall through */ }
  try {
    const bin = require.resolve('@deepseek-ai/dsh/lib/bin.js')
    if (fs.existsSync(bin)) return { entry: bin, cwd: appCwd(), note: 'npm @deepseek-ai/dsh' }
  } catch { /* fall through */ }
  return null
}

// EPIPE guard: when the packaged app is launched without a console (double-click
// from Explorer), process.stdout/stderr are broken pipe handles and any write
// throws EPIPE as an uncaught exception in the main process. Attach error
// listeners (so writes are dropped instead of crashing) and never throw from
// our own writes. Server output is also mirrored to a rotating file log under
// userData/logs so logs survive console-less launches.
process.stdout.on('error', () => { /* broken console; drop output */ })
process.stderr.on('error', () => { /* broken console; drop output */ })

let logStream = null
function ensureLogStream() {
  if (logStream) return logStream
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'dsh-server.log')
    try {
      const st = fs.statSync(file)
      if (st.size > 5 * 1024 * 1024) {
        fs.copyFileSync(file, file + '.old')
        fs.truncateSync(file, 0)
      }
    } catch { /* no existing log */ }
    logStream = fs.createWriteStream(file, { flags: 'a' })
    logStream.on('error', () => {})
  } catch { /* logging unavailable; keep going */ }
  return logStream
}

function writeLog(chunk) {
  const s = ensureLogStream()
  if (s) { try { s.write(chunk) } catch { /* ignore */ } }
}

function safeOut(chunk) {
  try { if (process.stdout.writable) process.stdout.write(chunk) } catch { /* ignore */ }
}

function safeErr(chunk) {
  try { if (process.stderr.writable) process.stderr.write(chunk) } catch { /* ignore */ }
}

function log(...args) {
  try { writeLog('[dsh-desktop] ' + args.join(' ') + '\n') } catch { /* ignore */ }
  try { if (process.stdout.writable) console.log('[dsh-desktop]', ...args) } catch { /* ignore */ }
}
function warn(...args) {
  try { writeLog('[dsh-desktop] ' + args.join(' ') + '\n') } catch { /* ignore */ }
  try { if (process.stderr.writable) console.error('[dsh-desktop]', ...args) } catch { /* ignore */ }
}

let mainWindow = null
let serverChild = null
let serverUrl = null
let quitting = false

/** True when `url` addresses the local dsh server we booted (any path/token). */
function isServerOrigin(url) {
  if (!serverUrl) return false
  try {
    return new URL(url).origin === new URL(serverUrl).origin
  } catch {
    return false
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#0d1117',
    title: 'DeepSeek Harness',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  mainWindow.loadFile(path.join(__dirname, 'loading.html'))
  const showWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return
    mainWindow.show()
    mainWindow.focus()
    log('window shown')
  }
  mainWindow.once('ready-to-show', showWindow)
  // Safety net: never leave the user staring at a hidden window.
  setTimeout(showWindow, 3000).unref()
  mainWindow.webContents.on('did-finish-load', () => log('page loaded: ' + mainWindow.webContents.getURL()))
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (level >= 2) writeLog('[renderer] ' + message + ' (' + sourceId + ':' + line + ')\n')
  })
  mainWindow.webContents.on('did-fail-load', (event, code, desc, url) => warn('page FAILED: ' + url + ' (' + code + ' ' + desc + ')'))
  mainWindow.webContents.on('render-process-gone', (event, details) => warn('renderer gone: ' + JSON.stringify(details)))

  // Keep the window a pure viewer of the local server: open external links in
  // the system browser and never allow in-app navigation away from the server.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Match by origin: the SPA drops the one-time ?token= right after boot, so
    // a prefix comparison against the boot URL would misroute it to the OS
    // browser.
    if (isServerOrigin(url)) return
    if (/^https?:\/\//.test(url)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

function showFatal(title, detail) {
  warn(title + ': ' + detail)
  if (SMOKE) {
    console.error('DSH_DESKTOP_SMOKE_FAIL ' + title + ': ' + detail)
    app.exit(1)
    return
  }
  if (mainWindow) {
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<html><body style="background:#0d1117;color:#e6edf3;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
      '<div style="max-width:640px"><h2>' + escapeHtml(title) + '</h2><pre style="white-space:pre-wrap">' + escapeHtml(detail) + '</pre></div></body></html>'))
  } else {
    dialog.showErrorBox(title, detail)
  }
  // Keep the process alive so the user can read the error and close the window.
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const attempt = () => {
      if (Date.now() > deadline) return resolve(false)
      const req = http.get(url, (res) => {
        res.resume()
        res.on('end', () => resolve(true))
      })
      req.on('error', () => { req.destroy(); attempt() })
      req.setTimeout(2000, () => { req.destroy(); attempt() })
    }
    attempt()
  })
}

/** Start the server and resolve { url } once the readiness line appears. */
function startServer(runtime, server) {
  return new Promise((resolve, reject) => {
    const port = process.env.DSH_DESKTOP_PORT || '0'
    // --expose-internals: the DSH loader's HMR service needs Node internals.
    // Under plain Node this is also available through the bundled
    // node-addon-require-builtin addon, but that addon does not load inside
    // Electron's embedded Node (ELECTRON_RUN_AS_NODE); the flag keeps the
    // server healthy on every runtime path.
    const args = ['--expose-internals']
    if (server.loader) args.push(...server.loader)
    args.push(server.entry)
    if (server.loader) {
      // source checkout boots through --profile web
      args.push('--profile', 'web', '--port', port)
    } else {
      args.push('web', '--port', port)
    }
    // dsh >= 0.1.5 opens the Web UI in the default browser unless told
    // otherwise; this shell *is* the browser, so never spawn an external one.
    args.push('--no-open')
    log('spawning server: ' + runtime.bin + ' ' + args.join(' '))
    const child = spawn(runtime.bin, args, {
      cwd: server.cwd,
      env: { ...process.env, ...(runtime.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    serverChild = child

    let buffer = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new Error('timed out waiting for the server readiness line (is port ' + port + ' in use?)'))
      }
    }, BOOT_TIMEOUT_MS)

    child.stdout.on('data', (chunk) => {
      safeOut(chunk)
      writeLog(chunk)
      buffer += chunk.toString()
      // dsh >= 0.1.5 emits `dsh web: http://127.0.0.1:<port>/?token=<token>`
      // and rejects unauthenticated requests, so the tokenized URL is what the
      // window must load. Older builds print a bare URL; both match here.
      const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+(?:\/\S*)?)/.exec(buffer)
      if (m && !settled) {
        settled = true
        clearTimeout(timer)
        const url = m[1]
        let resolvedPort = 0
        try { resolvedPort = Number(new URL(url).port) } catch { /* keep 0 */ }
        resolve({ url, port: resolvedPort })
      }
    })
    child.stderr.on('data', (chunk) => {
      safeErr(chunk)
      writeLog(chunk)
    })
    child.on('exit', (code, signal) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error('server exited early (code=' + code + ', signal=' + signal + ')'))
      }
    })
    child.on('error', (e) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error('failed to spawn server: ' + e.message))
      }
    })
  })
}

let serverStopAnnounced = false
function killServerTree() {
  const child = serverChild
  if (!child || child.killed || child.exitCode !== null) return
  if (!serverStopAnnounced) {
    serverStopAnnounced = true
    log('stopping server (pid ' + child.pid + ')')
  }
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 })
    } catch { /* ignore */ }
  } else {
    child.kill('SIGTERM')
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 5000).unref()
  }
}

process.on('uncaughtException', (error) => {
  try { writeLog('UNCAUGHT EXCEPTION: ' + (error && error.stack || error) + '\n') } catch { /* ignore */ }
  warn('uncaught exception:', error)
})

async function boot() {
  const runtime = resolveNodeRuntime()
  if (!runtime) {
    showFatal('Node.js runtime not found',
      'dsh-desktop needs a Node.js >= 22.19 (or >= 24) to run the DeepSeek Harness server.\n' +
      'Install Node.js from https://nodejs.org, or set DSH_NODE to a node binary, or drop a bundled node into resources/node.')
    return
  }
  log('node runtime: ' + runtime.mode + ' -> ' + runtime.bin + (runtime.version ? ' (' + runtime.version + ')' : ''))

  const server = await resolveDshServer()
  if (!server) {
    showFatal('DeepSeek Harness server not found',
      'Could not locate the @deepseek-ai/dsh server bundle. In dev, run \'npm install\' in the dsh-desktop directory; in the packaged app, resources/server.zip must be present and extractable (see %APPDATA%\\DeepSeek Harness Desktop\\logs). You can also set DSH_ROOT to a source checkout.')
    return
  }
  log('server entry: ' + server.note + ' -> ' + server.entry)
  // Remember what the profile's plugin updates must be driven with later.
  dshRuntime = { node: runtime.bin, entry: server.entry, env: runtime.env || null }

  try {
    const { url, port } = await startServer(runtime, server)
    serverUrl = url
    // Log the origin only: the URL carries a one-time bearer token.
    log('server ready on http://127.0.0.1:' + port)
    // Extra readiness: the SPA should answer 200 at the root before we load it.
    const ready = await waitForHttp(url, HTTP_READY_TIMEOUT_MS)
    if (!ready) warn('server answered its readiness line but HTTP did not respond in time; loading anyway')
    if (SMOKE) {
      console.log('DSH_DESKTOP_SMOKE_OK ' + url)
      await sleep(300)
      killServerTree()
      await sleep(500)
      app.exit(0)
      return
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(url)
      if (process.env.DSH_DESKTOP_DEBUG_SHOT === '1') {
        setTimeout(async () => {
          try {
            mainWindow.show()
            mainWindow.focus()
            try {
              const info = await mainWindow.webContents.executeJavaScript(
                'JSON.stringify({title: document.title, bodyLen: document.body ? document.body.innerHTML.length : -1, bg: document.body ? getComputedStyle(document.body).backgroundColor : null, text: (document.body ? document.body.innerText : \'\').slice(0, 200)})'
              )
              log('page info: ' + info)
            } catch (e) { warn('page info failed: ' + e.message) }
            const img = await mainWindow.webContents.capturePage()
            const shot = path.join(app.getPath('userData'), 'debug-shot.png')
            fs.writeFileSync(shot, img.toPNG())
            log('debug screenshot saved: ' + shot)
          } catch (err) { warn('screenshot failed: ' + err.message) }
        }, 15000).unref()
      }
    }
  } catch (e) {
    showFatal('Failed to start the DeepSeek Harness server', String(e && e.message || e))
    if (!SMOKE) killServerTree()
  }
}

// ---- app lifecycle ----------------------------------------------------------

if (SMOKE) app.disableHardwareAcceleration()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    ipcMain.handle('dsh-desktop:update-status', () => updateState)
    ipcMain.handle('dsh-desktop:update-open', () => openUpdateFlow())
    if (!SMOKE) createWindow()
    boot()
    if (!SMOKE) {
      // Look for a newer release shortly after launch and then rarely; the
      // client's indicator only appears once a candidate exists (background
      // checks stay silent, including failures).
      setTimeout(() => { checkForUpdate({ silent: true }) }, 5000).unref()
      updateCheckTimer = setInterval(() => { checkForUpdate({ silent: true }) }, UPDATE_CHECK_INTERVAL_MS)
      updateCheckTimer.unref()
    }
    if (QUIT_AFTER > 0) {
      log('--quit-after ' + QUIT_AFTER + 'ms armed')
      setTimeout(() => { log('--quit-after elapsed; quitting'); app.quit() }, QUIT_AFTER)
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => { killServerTree() })
  app.on('will-quit', () => { killServerTree() })
}
// ---- desktop update carrier -------------------------------------------------
// The web client renders its own update surface from `window.dshDesktop`
// (protocol 1, see preload.js) and maps these phases to copy:
//   idle | checking | available | downloading | verifying | installing | ready | error
// This shell owns everything behind it: look up the published release, stream
// the installer with progress, verify it, then quit and hand it to Windows.

const RELEASE_API_URL = process.env.DSH_DESKTOP_RELEASE_API
  || 'https://api.github.com/repos/xiangshangya/deepseek-harness-desktop/releases/latest'
const UPDATE_CHECK_INTERVAL_MS = Number(process.env.DSH_DESKTOP_UPDATE_INTERVAL_MS || 6 * 60 * 60 * 1000)
const UPDATE_FETCH_TIMEOUT_MS = 120000

let updateState = { phase: 'idle' }
let updateCandidate = null
let updateCheckTimer = null

function publishUpdateState(next) {
  // Log phase changes and 10% steps only: progress ticks every 250ms.
  const step = (value) => (typeof value === 'number' ? Math.floor(value / 10) : null)
  const noisy = next.phase === updateState.phase && step(next.percent) === step(updateState.percent)
  updateState = next
  if (!noisy) log('update: ' + JSON.stringify(next))
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dsh-desktop:update-state', updateState)
  }
}

/** Compare dotted versions; a prerelease ranks below its own release. */
function compareVersions(left, right) {
  const parse = (value) => {
    const [core, pre] = String(value).replace(/^v/i, '').split('-')
    return { core: core.split('.').map((part) => Number(part) || 0), pre: pre || null }
  }
  const a = parse(left)
  const b = parse(right)
  for (let i = 0; i < 3; i += 1) {
    const diff = (a.core[i] || 0) - (b.core[i] || 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  return a.pre > b.pre ? 1 : -1
}

/**
 * GET over Node's own TLS stack, following redirects. Deliberately not the
 * global `fetch`: inside Electron that goes through Chromium's network service,
 * which inherits the machine's proxy configuration and fails on GitHub's
 * release-asset redirects when the system proxy can't tunnel them.
 */
function httpGet(url, { headers = {}, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers }, (response) => {
      const location = response.headers.location
      if (response.statusCode >= 300 && response.statusCode < 400 && location && redirects > 0) {
        response.resume()
        resolve(httpGet(new URL(location, url).href, { headers, redirects: redirects - 1 }))
        return
      }
      resolve({ response, statusCode: response.statusCode, headers: response.headers })
    })
    request.on('error', (error) => reject(error))
    request.setTimeout(UPDATE_FETCH_TIMEOUT_MS, () => request.destroy(new Error('request timed out')))
  })
}

async function readAll(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/** Look up the newest published release, or throw (network flag for copy). */
async function fetchLatestRelease() {
  let result
  try {
    result = await httpGet(RELEASE_API_URL, {
      headers: { 'User-Agent': 'dsh-desktop', Accept: 'application/vnd.github+json' },
    })
  } catch (error) {
    error.network = true
    throw error
  }
  const body = await readAll(result.response)
  if (result.statusCode < 200 || result.statusCode >= 300) {
    const error = new Error('release lookup failed: HTTP ' + result.statusCode)
    error.network = true
    throw error
  }
  return JSON.parse(body.toString('utf8'))
}

/**
 * Publish available (with candidate) or fall back to idle.
 * @param silent - Background checks publish nothing until a candidate exists,
 *   so the client's indicator only ever appears when a newer release is real;
 *   a failed background check is logged instead of surfacing "重试更新".
 */
async function checkForUpdate({ silent = false } = {}) {
  if (!silent) publishUpdateState({ phase: 'checking' })
  try {
    const release = await fetchLatestRelease()
    const version = String(release.tag_name || release.name || '').replace(/^v/i, '')
    const assets = Array.isArray(release.assets) ? release.assets : []
    // Prefer the in-place package: it replaces this app's own files and
    // relaunches, so no installer runs, no UAC prompt, and no registry or
    // shortcut churn. Releases that only ship an installer still work.
    const updateAsset = assets.find((entry) => /-update\.zip$/i.test(entry.name || ''))
    const setupAsset = assets.find((entry) => /setup(\.[a-z0-9]+)?\.exe$/i.test(entry.name || ''))
    const asset = updateAsset || setupAsset || assets[0]
    const current = app.getVersion()
    if (!version || !asset || !asset.browser_download_url) {
      if (silent) warn('update check: release has no installer asset')
      else publishUpdateState({ phase: 'error', failure: 'check' })
      return null
    }
    if (compareVersions(version, current) > 0) {
      updateCandidate = {
        version,
        kind: updateAsset ? 'inplace' : 'installer',
        name: asset.name || `DeepSeek-Harness-Desktop-${version}-setup.exe`,
        url: asset.browser_download_url,
        size: Number(asset.size) || 0,
        digest: typeof asset.digest === 'string' ? asset.digest : null,
      }
      publishUpdateState({ phase: 'available', version })
      return updateCandidate
    }
    updateCandidate = null
    if (!silent) publishUpdateState({ phase: 'idle' })
    return null
  } catch (error) {
    warn('update check failed: ' + (error && error.message))
    if (!silent) publishUpdateState({ phase: 'error', failure: error && error.network ? 'check-network' : 'check' })
    return null
  }
}

function updateDownloadPath(candidate) {
  return path.join(app.getPath('userData'), 'updates', candidate.name)
}

/**
 * Direct GitHub plus China-friendly mirrors. Safety comes from the API digest:
 * whatever source streams the file, its SHA-256 must match the digest GitHub
 * published before the installer is allowed to run.
 */
function updateSourceUrls(url) {
  const configured = String(process.env.DSH_DESKTOP_UPDATE_MIRRORS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  // Measured from this network: gh-proxy.com ~4.4 MB/s, ghfast.top ~130 KB/s,
  // ghproxy.net ~14 KB/s, direct GitHub throttled to a few KB/s. All of them are
  // sampled at download time and the fastest wins, so the order only breaks ties.
  const mirrors = configured.length > 0 ? configured : [
    'https://gh-proxy.com/',
    'https://ghfast.top/',
    'https://ghproxy.net/',
  ]
  return [url, ...mirrors.map((prefix) => prefix.replace(/\/+$/, '') + '/' + url)]
}

/** Rough throughput of one source over a short sample, used to pick the mirror. */
async function measureSource(url, { sampleBytes = 2 * 1024 * 1024, sampleMs = 6000 } = {}) {
  const started = Date.now()
  let received = 0
  try {
    const { response, statusCode } = await httpGet(url, { headers: { 'User-Agent': 'dsh-desktop' } })
    if (statusCode < 200 || statusCode >= 300) {
      response.resume()
      return { url, ok: false, speed: 0 }
    }
    for await (const chunk of response) {
      received += chunk.length
      if (received >= sampleBytes || Date.now() - started > sampleMs) break
    }
    response.destroy()
    const seconds = Math.max(0.5, (Date.now() - started) / 1000)
    return { url, ok: true, speed: received / seconds }
  } catch (error) {
    return { url, ok: false, speed: 0, error }
  }
}

/** Stream the installer into userData/updates, publishing percent progress. */
async function downloadUpdate(candidate) {
  const file = updateDownloadPath(candidate)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const sources = updateSourceUrls(candidate.url)
  let chosen = candidate.url
  if (sources.length > 1) {
    publishUpdateState({ phase: 'downloading', version: candidate.version, percent: 0 })
    const measured = []
    for (const url of sources) measured.push(await measureSource(url))
    measured.sort((left, right) => right.speed - left.speed)
    const fastest = measured.find((entry) => entry.ok) || measured[0]
    if (fastest && fastest.ok) chosen = fastest.url
    log('update: sources ' + measured.map((entry) => `${entry.ok ? Math.round(entry.speed / 1024) + 'KB/s' : 'fail'} ${entry.url.slice(0, 48)}`).join(' | '))
  }
  let result
  try {
    result = await httpGet(chosen, { headers: { 'User-Agent': 'dsh-desktop' } })
  } catch (error) {
    error.network = true
    throw error
  }
  const { response, statusCode, headers } = result
  if (statusCode < 200 || statusCode >= 300) {
    response.resume()
    const error = new Error('download failed: HTTP ' + statusCode)
    error.network = true
    throw error
  }
  const total = Number(headers['content-length']) || candidate.size || 0
  const out = fs.createWriteStream(file)
  let received = 0
  let lastReport = 0
  for await (const chunk of response) {
    received += chunk.length
    out.write(chunk)
    const now = Date.now()
    if (now - lastReport > 250) {
      lastReport = now
      publishUpdateState({
        phase: 'downloading',
        version: candidate.version,
        percent: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : undefined,
      })
    }
  }
  await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())))
  publishUpdateState({ phase: 'verifying', version: candidate.version })
  const size = fs.statSync(file).size
  if (total > 0 && size !== total) throw new Error(`size mismatch: ${size} != ${total}`)
  if (candidate.digest && candidate.digest.startsWith('sha256:')) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    if (hash !== candidate.digest.slice(7)) throw new Error('sha256 mismatch')
  }
  return file
}

/** Run a helper process and collect its output (used by both extraction paths). */
function runProcess(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { out += chunk })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      resolve({ status: -1, out })
    }, timeoutMs)
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, out }) })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ status: -2, out: String((error && error.message) || error) })
    })
  })
}

/**
 * Apply an update package over this app's own files and relaunch.
 * Nothing else is touched: no installer, no registry, no `~/.dsh`.
 */
async function applyInPlaceUpdate(candidate, file) {
  publishUpdateState({ phase: 'installing', version: candidate.version })
  killServerTree()
  const installDir = appCwd()
  log('update: applying ' + candidate.name + ' over ' + installDir)
  const result = await runProcess('tar.exe', ['-xf', file, '-C', installDir], 10 * 60 * 1000)
  if (result.status !== 0) {
    warn('update: extraction failed (' + result.status + '): ' + String(result.out).slice(-300))
    publishUpdateState({ phase: 'error', failure: 'install', version: candidate.version })
    return
  }
  log('update: applied; relaunching')
  app.relaunch()
  app.exit(0)
}

/** Quit the shell, then let Windows run the downloaded installer. */
function installDownloadedUpdate(candidate, file) {
  publishUpdateState({ phase: 'installing', version: candidate.version })
  killServerTree()
  // Launch once this process is on its way out: the installer refuses to touch a
  // running instance, and a detached child survives our exit. The assisted
  // installer reads the previous install location from the registry and upgrades
  // that folder in place.
  app.once('will-quit', () => {
    try {
      const child = spawn(file, [], { detached: true, stdio: 'ignore' })
      child.unref()
    } catch (error) {
      warn('could not launch installer: ' + (error && error.message))
    }
  })
  setTimeout(() => app.quit(), 800).unref()
}

/**
 * One click from the page does one step: check → download → apply.
 * The client's own label ("更新并重启") is the confirmation, so no extra dialog:
 * the first click downloads, the second applies and restarts.
 * @returns resolves when the step finishes; the page learns via presentations.
 */
async function openUpdateFlow() {
  if (updateState.phase === 'installing') return
  try {
    if (updateState.phase === 'ready' && updateCandidate) {
      const file = updateDownloadPath(updateCandidate)
      if (updateCandidate.kind === 'inplace') await applyInPlaceUpdate(updateCandidate, file)
      else installDownloadedUpdate(updateCandidate, file)
      return
    }
    // Always re-check before downloading: the boot-time candidate may already be
    // superseded, and the lookup is one cheap request.
    updateCandidate = null
    const candidate = await checkForUpdate()
    if (!candidate) return
    const file = await downloadUpdate(candidate)
    // Plugins live in the DSH profile, not in this app: bring them along so one
    // update click leaves the whole install current. Best effort — a plugin
    // registry that is slow or offline must not block the app update.
    try {
      await updateProfilePlugins()
    } catch (error) {
      warn('plugin update skipped: ' + (error && error.message))
    }
    publishUpdateState({ phase: 'ready', version: candidate.version })
    log('update ready: ' + file)
  } catch (error) {
    warn('update failed: ' + (error && error.message))
    publishUpdateState({
      phase: 'error',
      failure: updateState.phase === 'downloading' || updateState.phase === 'verifying' ? 'download-network' : 'install',
      version: updateCandidate ? updateCandidate.version : undefined,
    })
  }
}

// ---- profile plugin updates -------------------------------------------------
// The profile (`~/.dsh/profiles/web`) owns the third-party plugins; they are
// updated through the same CLI path the plugin manager uses (`dsh plugin add`),
// which keeps package.json, the lockfile, and the loader insert rows in sync.

/** Node runtime + server entry resolved at boot, used to drive `dsh plugin`. */
let dshRuntime = null

function webProfileDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'profiles', 'web')
}

/** Registry the profile's pnpm resolves against, so lookups match installs. */
function profileRegistryUrl() {
  try {
    const npmrc = fs.readFileSync(path.join(webProfileDir(), '.npmrc'), 'utf8')
    const match = /^\s*registry\s*=\s*(\S+)/m.exec(npmrc)
    if (match) return match[1]
  } catch {
    /* no profile .npmrc */
  }
  return 'https://registry.npmjs.org'
}

function readProfileDependencies() {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(webProfileDir(), 'package.json'), 'utf8'))
    return json.dependencies || {}
  } catch {
    return {}
  }
}

function readInstalledVersion(name) {
  try {
    const file = path.join(webProfileDir(), 'node_modules', name, 'package.json')
    return JSON.parse(fs.readFileSync(file, 'utf8')).version || null
  } catch {
    return null
  }
}

async function readLatestVersion(name, registry) {
  const base = registry.replace(/\/+$/, '')
  const url = base + '/' + name.replace('/', '%2f') + '/latest'
  const { response, statusCode } = await httpGet(url, {
    headers: { 'User-Agent': 'dsh-desktop', Accept: 'application/json' },
  })
  const body = await readAll(response)
  if (statusCode < 200 || statusCode >= 300) return null
  return JSON.parse(body.toString('utf8')).version || null
}

/** Every profile dependency whose registry version is ahead of the installed one. */
async function outdatedProfilePlugins() {
  const registry = profileRegistryUrl()
  const dependencies = readProfileDependencies()
  const outdated = []
  for (const name of Object.keys(dependencies)) {
    const current = readInstalledVersion(name)
    if (!current) continue
    let latest = null
    try {
      latest = await readLatestVersion(name, registry)
    } catch (error) {
      warn('plugin lookup failed for ' + name + ': ' + (error && error.message))
      continue
    }
    if (latest && compareVersions(latest, current) > 0) outdated.push({ name, current, latest })
  }
  return outdated
}

/** Update the outdated profile plugins through the DSH CLI; logs, never throws. */
async function updateProfilePlugins() {
  if (!dshRuntime) {
    warn('plugins: dsh runtime unknown, skipping plugin update')
    return []
  }
  const outdated = await outdatedProfilePlugins()
  if (outdated.length === 0) {
    log('plugins: already up to date')
    return []
  }
  const specs = outdated.map((entry) => `${entry.name}@${entry.latest}`)
  log('plugins: updating ' + specs.join(', '))
  await new Promise((resolve) => {
    const child = spawn(dshRuntime.node, [dshRuntime.entry, 'plugin', '--profile', 'web', 'add', ...specs], {
      cwd: appCwd(),
      env: { ...process.env, ...(dshRuntime.env || {}) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
    }, 10 * 60 * 1000)
    timer.unref()
    child.on('close', (code) => {
      clearTimeout(timer)
      log('plugins: update finished (exit ' + code + ')' + (code === 0 ? '' : ' :: ' + output.slice(-300)))
      resolve()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      warn('plugins: update failed: ' + (error && error.message))
      resolve()
    })
  })
  return outdated
}

// ---- app lifecycle ----------------------------------------------------------
