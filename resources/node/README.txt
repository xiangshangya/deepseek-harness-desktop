Drop a Node.js runtime here to bundle it with the app:
  Windows: place node.exe at resources/node/node.exe
  macOS/Linux: place node at resources/node/bin/node
The app prefers this bundled Node over the system Node, and falls back to
Electron’s own Node (ELECTRON_RUN_AS_NODE) when neither is available.
Requirement: Node >= 22.19 or >= 24 (same as DeepSeek Harness).
