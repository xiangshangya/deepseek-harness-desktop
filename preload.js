'use strict'

/**
 * Desktop carrier for the web client's update surface.
 *
 * The DSH client (`@deepseek-ai/dsh-client-ui-settings-general`) reads
 * `globalThis.dshDesktop` when it mounts, and — when `protocolVersion === 1` —
 * drives its own update indicator, download progress, and "安装并重启" affordance
 * from this bridge. The shell owns the whole flow; the page only renders state.
 */

const { contextBridge, ipcRenderer } = require('electron')

const listeners = new Set()

ipcRenderer.on('dsh-desktop:update-state', (_event, presentation) => {
  for (const listener of listeners) {
    try {
      listener(presentation)
    } catch {
      /* a subscriber throwing must not break the others */
    }
  }
})

contextBridge.exposeInMainWorld('dshDesktop', {
  protocolVersion: 1,

  updates: {
    /** Subscribe to carrier presentations; returns the unsubscribe function. */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    /** Current presentation, so a late subscriber still sees the state. */
    status() {
      return ipcRenderer.invoke('dsh-desktop:update-status')
    },

    /** User action: check, download, or install — whichever comes next. */
    open() {
      return ipcRenderer.invoke('dsh-desktop:update-open')
    },
  },
})
