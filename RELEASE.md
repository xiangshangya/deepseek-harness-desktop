# DeepSeek Harness Desktop v0.1.1 发行说明

> 发布日期：2026-09-27 ｜ 安装包：DeepSeek Harness Desktop-0.1.1-setup.exe（约 198 MB） ｜ Windows x64

## 本版更新

| 项目 | 变化 |
| --- | --- |
| 内置 DeepSeek Harness | `0.1.5-rc.2` → **`0.1.7-rc.2`**（同步上游最新发布） |
| 界面启动方式 | 适配 0.1.7：Web 服务带一次性 token，窗口直接加载带 token 的地址；显式传 `--no-open`，不再额外拉起系统浏览器 |
| 安装包体积 | 约 118 MB → 约 198 MB（上游 0.1.7 新增 LibreOffice 文档引擎 `libreoffice-kit` 与 `sherpa-onnx` 推理运行时，属官方依赖树变化） |
| 首次启动耗时 | 解压内容由约 101 MB 增至约 330 MB，首次启动会比上一版更久，之后就绪速度不变 |
| 版本一致性 | 修正上一版"版本号已更新、服务端归档仍是旧版"的问题，`SERVER_VERSION` 与实际打包版本现已一致 |

## 简介

DeepSeek Harness Desktop 是把 **DeepSeek Harness（dsh web 服务器 + 网页前端）** 打包成桌面应用的一键式方案：

- 打开应用 = 自动启动服务器 + 打开前端窗口；
- 关闭应用 = 自动停止服务器、清理进程；
- 服务器、前端、运行时全部随安装包分发，**目标机器无需安装 Node.js、无需任何配置**。

## 功能特性

| 特性 | 说明 |
| --- | --- |
| 一键启动 | 启动即拉起 dsh web 服务器并打开界面，退出即清理 |
| 自带运行时 | 无系统 Node 时自动使用 Electron 内置 Node（v24）运行服务器，系统 Node 存在时优先使用 |
| 自动端口 | 默认自动分配空闲端口，避免冲突；可用环境变量 `DSH_DESKTOP_PORT` 固定端口 |
| 数据与 CLI 共用 | 会话、配置存放于 `~/.dsh`，与命令行版完全一致，可无缝切换 |
| 快速启动 | 首次启动需解压服务器组件（界面实时显示进度），之后约 6 秒打开 |
| 官方图标 | 使用 DSH 官方鲸鱼标志 |
| 调试友好 | 支持 `DSH_ROOT` 指向源码目录运行改造后的代码；`--smoke` 冒烟测试 |
| 安全设计 | 渲染层 sandbox + contextIsolation，服务器仅监听 127.0.0.1 |

## 运行环境

- 系统：Windows 10 / 11，x64
- 无需预装 Node.js（可选：系统 Node ≥ 22.19 或 ≥ 24 会被优先使用）
- 磁盘空间：安装后约 900 MB（含首次启动解压的服务端组件）

## 安装步骤

1. 运行 `DeepSeek Harness Desktop-0.1.1-setup.exe`，按向导完成安装（可自选安装目录）；
2. 从桌面快捷方式或开始菜单启动 **DeepSeek Harness Desktop**；
3. 首次启动会显示"正在准备服务器组件…"，完成后自动进入主界面。

> 升级说明：已安装 v0.1.0 的用户可直接运行本安装包覆盖升级；如安装向导选择的目录与原目录不同，建议先卸载旧版再安装本版。若升级后界面仍是旧版，删除 `%APPDATA%\DeepSeek Harness Desktop\server\` 后重新启动，应用会重新解压新版服务端。

## 使用说明

- 主界面即 DeepSeek Harness 官方 Web UI：新建会话、选择工作区、模型设置、插件管理等；
- 服务器运行在本地随机端口（仅本机可访问），关闭应用即停止；
- 日志位置：`%APPDATA%\DeepSeek Harness Desktop\logs\dsh-server.log`。

## 常见问题

**1. 安装/首次运行出现 SmartScreen 提示？**
安装包尚未进行代码签名，Windows 会提示"未知发布者"。点击"更多信息 → 仍要运行"即可；源码见下方仓库，可自行审计。

**2. 安装包为什么比上一版大了 80 MB？**
上游 dsh 0.1.7 新增了 LibreOffice 文档引擎（单个可执行文件约 178 MB）和 `sherpa-onnx` 推理运行时，桌面版按官方依赖树原样打包，因此体积随之增加。

**3. 首次启动为什么比之后慢？**
首次启动需将随包分发的服务器组件解压到用户目录（真实文件，保证 DSH 插件系统正常工作），耗时取决于磁盘速度；之后启动直接复用。

**4. 能自定义端口吗？**
设置环境变量 `DSH_DESKTOP_PORT=3080` 等固定端口；不设置则自动分配。

**5. 用命令行版还是桌面版？**
数据完全互通（`~/.dsh`），可随时切换，互不影响。

## 已知限制

- 应用尚未代码签名（SmartScreen 提示属正常现象，计划后续接入）；
- 仅提供 Windows x64 安装包，macOS / Linux 构建在规划中；
- 会话导出等下载类操作遵循系统默认下载设置。

## 相关链接

- 源码仓库：https://github.com/xiangshangya/deepseek-harness-desktop
- 上游项目：https://github.com/deepseek-ai/deepseek-harness （MIT License）

---

*本应用为 DeepSeek Harness 的桌面封装，所有版权归各自所有者。*
