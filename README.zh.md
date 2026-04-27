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
- **专家级交互**：内置确保专属窗口（`ensure_tab`）、语义定位、CDP 真实点击等高级 API。
- **免配对体验**：本地模式自动感应，告别 6 位配对码。

---

## 🛠️ 专家级命令行工具 (ch.js)

本项目内置了一个强大的 CLI 工具 `cloudhand-bridge/ch.js`，让 AI 操作变得异常简单：

```bash
# 1. 语义批处理连招 (最推荐：自动处理 TabID 和 语义定位)
node cloudhand-bridge/ch batch "ensure_tab; navigate baidu.com; type {搜索框} openclaw\n"

# 2. 一键直达搜索结果（带重试和摘要）
node cloudhand-bridge/ch quick_search "https://www.baidu.com/s?wd=openclaw"

# 3. 深度认知学习（提取页面骨架，供 AI 分析并存档经验）
node cloudhand-bridge/ch learn
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

1. **获取下载链接：**
   - **远程模式**：对 AI 说「给我云手的下载链接」，AI 会生成一个 120 秒有效的一次性链接：`http://你的VPS:9876/download-ext?t=xxx`。
   - **本地模式**：直接使用项目源码中的 `extension/` 目录即可。

2. **在 Chrome 中加载：**
   - 打开 Chrome，进入 `chrome://extensions/`（扩展程序管理）。
   - 开启右上角的 **“开发者模式”** 开关。
   - 点击左上角的 **“加载已解压的扩展程序”**。
   - 选择本项目（或解压后）的 **`extension`** 文件夹。

3. **与 AI 完成配对 (仅远程模式需要)：**
   - 对 AI 说：「给我配对码」，AI 会回复一个 **6 位验证码**（120 秒有效）。
   - 点击 Chrome 工具栏中的 CloudHand 图标。
   - 输入 6 位验证码并点击 **“配对连接”**。
   - ✅ 当图标下的状态变为 **“已连接”**，即表示配对成功。

> 💡 **提示**：配对信息会保存在本地，除非你卸载扩展，否则以后无需再次配对。本地模式会自动识别 `127.0.0.1`，无需输入配对码。

---

## API 端点 (Core APIs)

| 端点 | 方法 | 说明 |
|------|------|------|
| `/status` | GET | 查看本地/远程双路连接状态 |
| `/token` | GET | 获取本地 API Token (127.0.0.1 专用) |
| `/ensure_tab` | POST | 铁律：获取/创建不干扰用户的专属 Tab |
| `/smart_locate` | POST | 语义定位：输入“搜索框”即可返回索引 |
| `/navigate` | POST | 导航至目标 URL |
| `/get_browser_state` | POST | 获取 DOM 树及可交互元素索引 |
| `/click_element` | POST | 按索引点击 (语义版: `click {关键词}`) |
| `/input_text_element` | POST | 按索引输入 (语义版: `type {关键词} 文本\n`) |
| `/get_ax_tree` | POST | 获取无障碍树 (用于复杂 UI 探测) |
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
