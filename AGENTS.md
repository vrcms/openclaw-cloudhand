# CloudHand - AGENTS.md

## 项目定位

AI 智能体 ↔ Chrome 浏览器的 WebSocket/CDP 桥接层。核心是 `cloudhand-bridge/server.js`，通过 Chrome 扩展（`extension/`，Manifest V3）的 `chrome.debugger` API 透传 CDP 指令。

## 架构速览

```
cloudhand-bridge/server.js  ← 主桥接服务 (Express + WebSocket + Playwright)
cloudhand-bridge/ch.js      ← CLI 工具（REST 调用 bridge）
cloudhand-bridge/index.js   ← OpenClaw 插件入口（注册 tool 定义）
extension/                  ← Chrome 扩展（chrome.debugger + WebSocket 中继）
ai-skills/cloudhand-local/  ← 本地 AI 智能体 skill 文件
openclaw-skills/cloudhand/  ← OpenClaw 插件 skill 文件
```

## 关键命令

```bash
# 启动桥接服务（本地模式，绑定 127.0.0.1，免配对）
node cloudhand-bridge/server.js --local

# CLI 工具
node cloudhand-bridge/ch help           # 查看所有子命令
node cloudhand-bridge/ch status         # 连接状态
node cloudhand-bridge/ch snapshot       # 页面 ARIA 快照（带 ref 编号）
node cloudhand-bridge/ch act click e1   # Playwright 点击 ref 元素
node cloudhand-bridge/ch navigate <url> # 导航

# 一键启动脚本（自动检测 Node.js + 端口 + 安装依赖）
cloudhand-bridge/start-local.bat        # Windows
cloudhand-bridge/start-local.sh         # macOS/Linux

# 安装依赖
npm install                             # 在 cloudhand-bridge/ 目录下
```

## 配置与环境

- **默认端口**: 9876（可通过 `PORT` 环境变量覆盖）
- **本地模式**: `--local` 参数绑定到 127.0.0.1，跳过配对码
- **远程模式**: 绑定到 0.0.0.0，通过 `/pair/challenge` 生成 6 位配对码
- **认证**: Bearer Token。配置文件存储在 `~/.openclaw/chrome-bridge/config.json`
- **本地 Token**（免鉴权）: `local-mode-token`

## 核心 API 端点

| 端点 | 说明 |
|---|---|
| `GET /status` | 双路连接状态 |
| `POST /ensure_tab` | 创建/获取 agent 专属 Tab（铁律：不动用户窗口） |
| `POST /snapshot` | Playwright ariaSnapshot + ref 编号（推荐用于页面理解） |
| `POST /act` | 统一交互接口（click/type/press/hover/scroll/drag/fill 等） |
| `POST /screenshot_with_labels` | 截图 + 交互元素边框标签 |
| `POST /cdp` | 万能 CDP 指令透传 |
| `POST /eval` | 执行 JavaScript |
| `POST /navigate` | 导航 |
| `GET /json/version`, `/json/list` | DevTools 协议端点（Playwright connectOverCDP 用） |

## WebSocket 端点

- `/ws` — Chrome 扩展连接端点（携带 token 参数）
- `/cdp` — Playwright/CDP 客户端连接端点（供 Playwright connectOverCDP）

## 重要约定

- **无测试框架、无 linter/formatter/typecheck 配置** — 无需运行 lint/test 步骤
- **无构建步骤** — 纯 Node.js，直接运行 `node`，无需 transpile/bundle
- **依赖安装位置**: `npm install` 应在 `cloudhand-bridge/` 目录下执行（`playwright-core` 等依赖声明在 `cloudhand-bridge/package.json`）
- **根目录 `package.json`** 只有 express + ws（旧版），`cloudhand-bridge/package.json` 才是真入口（含 playwright-core）
- **扩展 ZIP 打包**: OpenClaw 插件启动时自动在 `cloudhand-bridge/extension.zip` 生成（含运行时 `config.js`）
- **自学习知识库**: AI 操作后自动沉淀在 `./.data-browser-knowledge/`
- **不直接注入 JS 进行 DOM 操作** — 优先使用纯 CDP 命令（DOM.querySelector、DOM.getBoxModel 等）或 Playwright 快照/交互
