# CloudHand 云手

> 让 AI 智能体（本地/远程）极速操控你的 Chrome 浏览器。

[![版本](https://img.shields.io/badge/版本-2.7.0-blue.svg)](https://github.com/vrcms/openclaw-cloudhand)
[![OpenClaw 插件](https://img.shields.io/badge/openclaw-plugin-orange.svg)](https://openclaw.ai)

**[English](README.md)** | 中文

## 什么是云手？

云手是一个连接 AI 智能体和 Chrome 浏览器的桥梁。它支持 **双路并行架构**：

1. **远程模式**：连接运行在 VPS 上的 OpenClaw AI 助理。
2. **本地模式 (New)**：连接运行在你本机的 AI 智能体（如 Claude Code, Gemini, Qwen）。

## 🌟 核心特性 (v2.7.0)

- **双路并行**：真正实现本地 AI 与远程 VPS AI 同时操控，无感切换。
- **命令行指挥官**：自带 `ch.js` 工具，支持语义连招（如 `type {搜索框} hello`）和自动批处理。
- **自学习经验库**：AI 操作后自动在 `./.data-browser-knowledge/` 沉淀站点经验，越用越快。
- **专家级交互**：内置确保专属窗口（`ensure_tab`）、基于 Playwright 的语义快照（`snapshot`）和统一操作接口（`act`）。
- **极简安全连接**：基于 Token 的直连机制，彻底告别繁琐的 6 位配对码。

---

## 🛠️ 专家级命令行工具 (ch.js)

本项目内置了一个强大的 CLI 工具 `cloudhand-bridge/ch.js`，让 AI 操作变得异常简单：

```bash
# 1. 获取页面语义快照 (Playwright ariaSnapshot)
node cloudhand-bridge/ch snapshot

# 2. 通过 ref 编号精确交互（输入并提交）
node cloudhand-bridge/ch act type e12 "openclaw" --submit

# 3. 带交互标签的页面截图
node cloudhand-bridge/ch screenshot_labels
```

---

## 📦 安装与配置

请根据你的使用场景选择：

### 场景 A：远程 VPS 模式 (针对 OpenClaw 用户)
1. **VPS 端一键安装**：
   ```bash
   bash <(curl -fsSL https://raw.githubusercontent.com/vrcms/openclaw-cloudhand/main/cloudhand-bridge/install.sh)
   ```
2. **完成配对**：按照下文“安装 Chrome 扩展”步骤操作。

### 场景 B：本地模式 (针对本地 AI 智能体)
1. **获取代码**：`git clone` 本仓库。
2. **启动 Bridge**：双击 `cloudhand-bridge/start-local.bat`。
3. **AI 配置**：将 `./ai-skills/cloudhand-local` 目录内容提供给你的 AI 智能体即可。

---

## 🧩 安装 Chrome 扩展 (通用步骤)

无论你使用哪种模式，都需要在你的 Chrome 浏览器中安装云手扩展。

1. **获取扩展：**
   - **远程模式**：安装完成后，会在 `~/.openclaw/extensions/cloudhand/extension.zip` 自动生成扩展包。
   - **本地模式**：直接使用项目源码中的 `extension/` 目录即可。

2. **在 Chrome 中加载：**
   - 打开 Chrome，进入 `chrome://extensions/`（扩展程序管理）。
   - 开启右上角的 **“开发者模式”** 开关。
   - 点击左上角的 **“加载已解压的扩展程序”**。
   - 选择解压后的 **`extension`** 文件夹。

3. **连接到 Bridge:**
   - 点击 Chrome 工具栏中的 CloudHand 图标。
   - 填入包含 Token 的 WebSocket URL（本地模式默认为 `ws://127.0.0.1:9876/ws?token=local-mode-token`，远程模式使用你的 Token）。
   - 点击 **“连接”**。图标下方的状态将变为 **“已连接”**。

> 💡 **提示**：扩展会自动保存连接地址。一旦连接成功，以后重启浏览器会自动重连。

---

## API 端点 (Core APIs)

| 端点 | 方法 | 说明 |
|------|------|------|
| `/status` | GET | 查看连接状态 |
| `/list_tabs` | GET | 列出所有已知的标签页 |
| `/ensure_tab` | POST | 铁律：获取/创建不干扰用户的专属 Tab |
| `/navigate` | POST | 导航至目标 URL |
| `/snapshot` | POST | ⭐ 获取带 ref 编号的语义快照 (Playwright) |
| `/act` | POST | ⭐ 通过 ref 编号执行动作 (click/type/scroll等) |
| `/screenshot_with_labels`| POST | 截图并框选标注交互元素 |
| `/get_page_info`| GET/POST | 获取当前页面 URL 和 Title |
| `/cdp` | POST | 透传任意 CDP 命令 |
| `/eval` | POST | 执行自定义 JavaScript |

## 开发与调试

```bash
# 安装环境
npm install

# 运行 Bridge 服务 (本地模式)
node cloudhand-bridge/server.js --local

# 使用 ch 工具测试指令
node cloudhand-bridge/ch help
```

## 开源协议
MIT
