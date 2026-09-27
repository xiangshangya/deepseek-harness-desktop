# DeepSeek Harness Desktop（dsh-desktop）

> ### ⚠️ 非官方项目声明 / Disclaimer
>
> 本项目为**个人开发**的 DeepSeek Harness 桌面封装应用，**与 DeepSeek（深度求索）官方无任何关联**，
> 非官方发布，未获得官方授权、认可或支持。
>
> **DeepSeek Harness 官方项目地址：https://github.com/deepseek-ai/deepseek-harness**
>
> 上游项目基于 MIT License，本应用仅在其基础上做桌面化封装；使用中出现问题请优先查阅
> [官方文档](https://github.com/deepseek-ai/deepseek-harness)，本项目不提供官方技术支持。

把 DeepSeek Harness 的 **服务器（dsh web）** 和 **网页前端** 打包进一个 Electron 桌面应用。
启动应用 = 自动拉起服务器 + 打开前端窗口，关闭应用 = 自动停掉服务器。

## 工作原理

```
┌─────────────────────────── Electron 应用 ───────────────────────────┐
│ 主进程 (main.js)                                                     │
│   ├─ 解析 Node 运行时（见下）                                          │
│   ├─ spawn 子进程：node <dsh>/lib/bin.js web --port 0                │
│   │     └─ @deepseek-ai/dsh 服务器（含 @deepseek-ai/dsh-web-frontend │
│   │        构建好的前端 dist，一并作为依赖打包）                        │
│   ├─ 等待就绪行 "dsh web: http://127.0.0.1:<port>"                  │
│   ├─ HTTP 探测 200 后 → BrowserWindow 加载该 URL                     │
│   └─ 退出时 taskkill /T 清理服务器进程树                              │
└──────────────────────────────────────────────────────────────────────┘
```

- **服务器就是官方 dsh CLI**：同一个 npm 包、同一套 profile/数据目录（默认 ~/.dsh），
  不是重写或简化版。
- **端口**：默认 --port 0，由操作系统自动分配空闲端口，避免 3080 被占用时冲突；
  也可用环境变量 DSH_DESKTOP_PORT 固定端口。
- **前端**：@deepseek-ai/dsh 的依赖 @deepseek-ai/dsh-web-app 会在运行时通过
  require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html') 找到已构建的前端
  dist 并托管，因此应用内自带完整网页 UI，无需另外构建前端。

## 快速开始（开发模式）

要求：Node.js ≥ 22.19（或 ≥ 24）。本机已验证 Node v24.17.0。

```bash
cd dsh-desktop
npm install          # 安装 electron + @deepseek-ai/dsh（含全部运行时依赖）
npm start            # 启动应用
```

> 国内网络若 Electron 二进制下载慢/失败：已内置 .npmrc 指向 npmmirror 镜像，无需处理。

## 冒烟测试（无窗口，自动退出）

```bash
npm run start:smoke
# 输出 DSH_DESKTOP_SMOKE_OK http://127.0.0.1:<port> 即通过
```

## 打包成安装程序（Windows）

```bash
npm run dist        # 先构建 resources/server.zip，再产出 dist/DeepSeek Harness Desktop-0.1.1-setup.exe
```

产物为 NSIS 安装包，安装后可独立运行。**安装包内已包含 DSH 服务与前端，目标机器
无需安装 Node**（服务器可用系统 Node，或兜底用 Electron 内置 Node 24）。

### 两段式部署（安装快 + 插件系统兼容）

- 安装包只包含：应用外壳（main.js 等 3 个文件）+ Electron 运行时 + 一个
  `resources/server.zip`（118MB，由 `npm run server:pack` 把 @deepseek-ai/dsh
  全依赖树打成单文件归档）。安装时只需写少量文件，**安装速度远快于逐文件解压
  1.5 万个零散小文件**。
- 首次启动时，应用把 server.zip 解压到
  `%APPDATA%\DeepSeek Harness Desktop\server\`（真实文件目录）。解压是**异步**的，
  加载窗口立即出现并显示进度（约 10–20 秒），之后启动直接复用，约 6 秒打开。
- 为什么不用 asar 打包服务器？DSH 的插件加载器会在 profile 目录建立指向安装目录
  node_modules 的 junction（`healProfilesModuleFallback`），junction 必须指向
  磁盘上的真实目录——asar 归档内的虚拟路径在 OS 层不存在，导致所有
  `@deepseek-ai/*` 包解析失败、服务器启动即退出（`ERR_MODULE_NOT_FOUND`）。
  解压成真实文件后该机制正常工作。
- 版本升级：server.zip 内容版本（`SERVER_VERSION`，main.js 中）变化时自动重新解压。

## Node 运行时的解析顺序（给服务器子进程用）

**打包版（asar 已启用）**：应用内容（含 node_modules）在 app.asar 里，只有
Electron 自带 Node（ELECTRON_RUN_AS_NODE）能读取该归档，因此打包版**固定使用
Electron 内置 Node**（v43.4.0 内置 Node 24.18.1，满足 DSH 引擎要求）。

**开发版 / DSH_ROOT 源码模式**（松散文件，无 asar）依次尝试：
1. DSH_NODE 环境变量显式指定；
2. 应用内置 Node：把 node.exe 放到 resources/node/；
3. 系统 PATH 中的 node（必须满足 ^22.19 || >=24）；
4. 兜底：ELECTRON_RUN_AS_NODE=1 使用 Electron 自带 Node。

> node-pty 是 N-API 预编译，Node/Electron 通用，无需重编译；服务器启动参数统一
> 带 --expose-internals（HMR 服务需要，且避开原生插件在 Electron 下失效的问题）。

## 用本地源码代替 npm 包（改造 / 调试你的源码）

```bash
# 方式 A：源码已构建（pnpm install && pnpm run build 之后）
set DSH_ROOT=D:\<你的deepseek-harness源码目录>\deepseek-harness-master
npm start

# 方式 B：未构建的源码（该目录需先 pnpm install，用 tsx 直接跑 TS）
set DSH_ROOT=D:\<你的deepseek-harness源码目录>\deepseek-harness-master
set DSH_DESKTOP_PORT=3080
npm start
```

主进程会优先用 <DSH_ROOT>/apps/cli/lib/bin.js（已构建）或
<DSH_ROOT>/apps/cli/src/bin.ts（源码 + tsx）。

## 常用环境变量

| 变量 | 作用 |
| --- | --- |
| DSH_DESKTOP_PORT | 固定服务器端口（默认 0 = 自动） |
| DSH_ROOT | 指向 DSH 源码/安装目录，用本地代码启动 |
| DSH_NODE | 指定服务器使用的 node 可执行文件 |
| DSH_HOME | DSH 用户数据目录（默认 ~/.dsh），沿用 CLI 语义 |
| DSH_TELEMETRY_DISABLED | 关闭遥测（任意非空值） |

## 日志

- 控制台：npm start（从终端启动）时，服务器 stdout/stderr 直接透传到终端，
  可看到 dsh web: http://127.0.0.1:<port> 就绪行。
- 文件：无论从终端还是双击启动，日志都会写入
  %APPDATA%\DeepSeek Harness Desktop\logs\dsh-server.log（超过 5MB 自动轮转为 .old）。
  打包版从资源管理器双击启动时没有控制台，请从这里查看日志。

> 注意：双击启动的打包版没有控制台，Electron 主进程不会向已断开的 stdout 写入
> （已加 EPIPE 防护），因此不会有 "A JavaScript error occurred in the main process" 弹窗。

## 安全说明

- 渲染窗口 contextIsolation: true、nodeIntegration: false、sandbox: true，
  不注入 preload，窗口只是本地服务器的纯浏览器视图；
- 外部链接一律交给系统浏览器打开，禁止窗口内跳转到非本机地址；
- 服务器默认只绑定 127.0.0.1（DSH 官方默认，--host 0.0.0.0 被官方禁用）。

## 应用图标

- 图标源：build/icon.svg（DSH 官方鲸鱼标志，即网页 favicon.svg）；
- 已渲染为 build/icon.png（512x512，深色底 + 白色标志，任务栏/安装包/快捷方式均可见）；
- 修改图标：替换 build/icon.svg 后运行 `node scripts/make-icon.mjs`，再 `npm run dist`。

## 已知限制 / 后续可做
- Windows 上退出时用 taskkill /T /F 结束服务器进程树（SIGTERM 在 Windows 上无法
  触发 Node 信号处理），会话数据为增量写入，不影响持久化。
- 未做自动更新（可接入 electron-updater）。
- macOS/Linux 打包目标已在配置中预留，未在本机验证。
