'use strict'

/**
 * dsh-desktop — Electron shell for the DeepSeek Harness web server.
 *
 * The app starts the real `dsh web` server as a child Node process (the very
 * same runtime you would run from a terminal), waits for its readiness line
 * (`dsh web: http://127.0.0.1:<port>`, emitted after the loader tree settles),
 * then opens the frontend in an Electron window. On quit the server process
 * tree is torn down.
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

const { app, BrowserWindow, dialog, Menu, shell } = require('electron')
const { spawn, spawnSync, execFileSync } = require('node:child_process')
const http = require('node:http')
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
const SERVER_VERSION = '0.1.0-rc.6'

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
    if (serverUrl && url.startsWith(serverUrl)) return
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
      const m = /dsh web: http:\/\/127\.0\.0\.1:(\d+)/.exec(buffer)
      if (m && !settled) {
        settled = true
        clearTimeout(timer)
        const url = 'http://127.0.0.1:' + m[1]
        resolve({ url, port: Number(m[1]) })
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

  try {
    const { url } = await startServer(runtime, server)
    serverUrl = url
    log('server ready: ' + url)
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
    if (!SMOKE) createWindow()
    boot()
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
