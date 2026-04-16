# CloudHand 云手

> 让远程 AI 控制你本地的 Chrome 浏览器。

[![版本](https://img.shields.io/badge/版本-2.6.0-blue.svg)](https://github.com/vrcms/openclaw-cloudhand)
[![OpenClaw 插件](https://img.shields.io/badge/openclaw-plugin-orange.svg)](https://openclaw.ai)

**[English](README.md)** | 中文

## 什么是云手？

云手是一个连接 AI 智能体和 Chrome 浏览器的桥梁。它支持两种模式：

1. **远程模式**：连接运行在 VPS 上的 OpenClaw AI 助理。
2. **本地模式 (New)**：连接运行在你本机的 AI 智能体（如 Claude Code, Qwen Code, Gemini CLI, Codex CLI）。

让 AI 能够：
- 导航到任意网址
- 点击元素、输入文字、按键
- 执行任意 JavaScript（`eval`）
- 读取 DOM 树结构（`get_browser_state`），获取可交互元素索引
- **智能元素定位**（`smart_locate`）：用自然语言找元素，无需扫描全页
- **安全获取 Tab**（`ensure_tab`）：自动处理各类浏览器环境，不乱开新窗口
- 控制标签页、滚动、前进/后退

## 架构原理 (v2.6.0+ 双路并行)

云手现在支持**本地与远程同时在线**。你可以让 VPS 上的 OpenClaw 处理长周期任务，同时让本机的 Claude Code 实时操作浏览器，互不干扰。

```
      【远程链路】                      【本地链路】
┌─────────────────────┐         ┌──────────────────────────┐
│   VPS (Remote AI)   │         │   你的电脑 (Local Host)    │
│                     │         │                          │
│  AI 助理 (OpenClaw) │         │  AI 智能体 (Local Agent)  │
│     ↓               │         │  (Claude / Gemini / Qwen)│
│  Bridge 服务端      │ ──WS──┐ │          ↓               │
│  (server.js)        │  9876 │ │  Chrome 浏览器 (Local)     │
└─────────────────────┘       │ │          ↑               │
                              └─┼─→ CloudHand 扩展 (v2.6)  │
                                │          ↑               │
                                │  Bridge 服务端 (Local)    │
                                │  (server.js --local)     │
                                └──────────────────────────┘
```

## 🌟 核心特性

- **双路并行**：真正实现本地 AI 与远程 VPS AI 同时操控，无感切换。
- **自包含技能**：AI 技能目录自带完整运行环境，即插即用。
- **零延迟控制**：本地链路响应速度可达毫秒级。
- **免配对体验**：本地模式自动感应，告别 6 位配对码。
- **专家级交互**：内置确保专属窗口、语义定位、真实点击等高级 API。

## 📦 安装与配置

云手支持两种运行模式，请根据你的使用场景选择：

---

### 场景 A：远程 VPS 模式 (针对 OpenClaw 用户)
**适用场景**：AI 运行在公网 VPS 上，需要控制你家里的本地 Chrome 浏览器。

1. **VPS 端一键安装**：
   ```bash
   bash <(curl -fsSL https://raw.githubusercontent.com/vrcms/openclaw-cloudhand/main/cloudhand-bridge/install.sh)
   ```
2. **本地端配置**：
   - 下载并安装 Chrome 扩展（参考下文“扩展下载”）。
   - 向 AI 获取 6 位配对码并完成配对。
3. **完成**：AI 助理即可在 VPS 上通过 WebSocket 控制你的浏览器。

---

### 场景 B：本地模式 (针对 Claude Code / Gemini / Qwen 用户)
**适用场景**：AI 直接运行在你本地电脑的命令行，需要极速控制当前 Chrome。

1. **获取代码**：
   ```bash
   git clone https://github.com/vrcms/openclaw-cloudhand.git
   cd openclaw-cloudhand
   ```
2. **启动本地 Bridge**：
   - **Windows**: 双击 `cloudhand-bridge/start-local.bat`。
   - **Mac/Linux**: 执行 `bash cloudhand-bridge/start-local.sh`。
3. **AI 智能体配置**：
   - 将项目中的 `ai-skills/cloudhand-local` 目录内容告知或提供给你的 AI 智能体。
   - 智能体会根据技能规范自动探测 `127.0.0.1:9876` 并获取 Token。
4. **完成**：本地 AI 将以零延迟控制你的浏览器，无需配对。

---

## 🧩 安装 Chrome 扩展 (通用步骤)

1. **向 AI 获取安全下载链接：**

   对 AI 说：「给我云手的下载链接」

   AI 会生成一个 **120 秒有效** 的一次性链接：
   ```
   http://你的VPS地址:9876/download-ext?t=<token>
   ```
   > ⚠️ 链接 120 秒后失效，请立即下载。

2. 在 Chrome 中加载：
   - 打开 `chrome://extensions/`
   - 开启右上角**开发者模式**
   - 点击**加载已解压的扩展程序** → 选择解压后的 `extension/` 目录
   - （扩展已预置 VPS IP，无需手动填写地址）

3. **与 AI 配对：**

   对 AI 说：「给我配对码」

   AI 会回复一个 **6 位验证码**，有效期 **120 秒**。

   - 点击 Chrome 工具栏中的 CloudHand 图标
   - 输入 6 位验证码
   - 点击**配对**

   ✅ 完成！AI 即可控制你的浏览器。

   > 💡 配对信息在浏览器重启后依然有效，只需配对一次（重新安装扩展除外）。

## 核心功能

### DOM 树导航

获取当前页面的结构化可交互元素列表：

```python
# 获取浏览器状态（带索引的可交互元素）
state = requests.post('http://VPS:9876/get_browser_state', headers=H, json={'tabId': tid}).json()
# 返回：[1]<button>搜索</button>  [2]<input placeholder="关键词">

# 按索引点击
requests.post('http://VPS:9876/click_element', headers=H, json={'tabId': tid, 'index': 2})

# 按索引输入
requests.post('http://VPS:9876/input_text_element', headers=H, json={'tabId': tid, 'index': 2, 'text': 'openclaw'})
```

### 智能定位 smart_locate（v2.4.5+）

用自然语言描述意图，直接拿到可用的元素索引，无需扫描全页500个元素：

```python
# 找搜索框
r = requests.post('http://VPS:9876/smart_locate', headers=H, json={
    'tabId': tid,
    'intent': '搜索'  # 支持：搜索/按钮/登录/输入/链接/内容/''（所有关键元素）
}).json()
idx = r['matches'][0]['browserStateIndex']  # 直接用于 click_element
```

### 安全 Tab 管理 ensure_tab（v2.4.6+）

适配比特浏览器等非标准环境，铁律：只开 tab，不乱开新窗口：

```python
# 总是用这个来获取可用 tab，不要直接 new_tab/new_window
r = requests.post('http://VPS:9876/ensure_tab', headers=H, json={}).json()
tid = r['tabId']  # 保证可用
# 如果是浏览器内部页，先 navigate，再复用这个 tid
```

逻辑：复用已有 agent tab → 在已有窗口开新 tab → 只有完全没有 agent 窗口时才开新窗口。

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/status` | GET | Bridge 状态（配对状态、版本、当前 tabId）|
| `/pair/challenge` | POST | 生成 6 位配对码（120 秒有效）|
| `/agent_windows` | GET | 列出 agent 专属窗口 ID |
| `/ensure_tab` | POST | 获取/创建可用 agent tab |
| `/tabs` | GET | 列出所有打开的标签页 |
| `/navigate` | POST | 导航到 URL |
| `/eval` | POST | 执行 JavaScript |
| `/get_browser_state` | POST | 获取 DOM 树及可交互元素索引 |
| `/click_element` | POST | 按 DOM 索引点击元素 |
| `/input_text_element` | POST | 按 DOM 索引输入文字 |
| `/smart_locate` | POST | 按自然语言意图定位元素 |
| `/click` | POST | 按 CSS 选择器点击 |
| `/type` | POST | 输入文字到元素 |
| `/scroll` | POST | 滚动页面 |
| `/go_back` | POST | 后退 |
| `/go_forward` | POST | 前进 |
| `/page_info` | GET | 当前页面标题和 URL |
| `/focus_tab` | POST | 聚焦指定标签页 |
| `/close_tab` | POST | 关闭标签页 |
| `/new_tab` | POST | 在窗口内开新标签页 |
| `/download-ext` | GET | 一次性扩展下载（需要 token）|

## 安全机制

- **配对验证码**：6 位数字，**120 秒**有效期，一次性使用，带速率限制
- **下载链接**：一次性 token，**120 秒**有效期
- **Session Token**：128 位随机 token，保存在扩展 storage 中，重启浏览器不失效
- **隐私隔离**：扩展只追踪 agent 创建的窗口，用户自己的窗口完全不记录
- 所有 API 调用需 Bearer token 鉴权

## 开发

```bash
# 克隆仓库
git clone https://github.com/vrcms/openclaw-cloudhand.git
cd openclaw-cloudhand

# 安装依赖
npm install

# 直接运行 Bridge 服务
node server.js

# 在 Chrome 中加载扩展（开发者模式 → 加载已解压 → extension/ 目录）
```

## 开源协议

MIT
