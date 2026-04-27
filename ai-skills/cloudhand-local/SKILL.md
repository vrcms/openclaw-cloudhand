---
name: cloudhand-local
description: AI 通过 CDP 协议直接操控本地浏览器，实现网页自动化任务。基于认知建模方法，AI 先理解页面结构再精确操作。
license: MIT
compatibility: CloudHand v2.7.0+ (CDP Edition)
metadata:
  author: CloudHand
  version: "2.7.0"
---

# CloudHand 本地浏览器操控技能 (CDP 多标签页版)

AI 通过标准 CDP 协议操控本地 Chrome 浏览器。所有操作在专属的 Agent 窗口中执行，不干扰用户的浏览环境。

---

## 前提条件

1. Bridge 服务正在运行：`node cloudhand-bridge/server.js --local`
2. Chrome 已加载 `extension/` 目录的扩展
3. 扩展自动连接 Bridge 后，Agent 专属窗口自动创建并就绪

验证方式：
```bash
node cloudhand-bridge/ch.js status
# 期望：connected: true, attachedTabs >= 1
```

---

## CLI 命令参考

所有命令均通过 `node cloudhand-bridge/ch.js <command>` 调用。

### 基础命令

| 命令 | 说明 | 示例 |
|------|------|------|
| `status` | 查看连接状态和已 attach 的 tab | `node ch.js status` |
| `ensure_tab` | 确保有 agent 专属 tab（无则自动创建窗口） | `node ch.js ensure_tab` |
| `navigate <url>` | 导航到 URL（自动 ensure_tab） | `node ch.js navigate https://example.com` |
| `page_info` | 获取当前页面 URL 和 Title | `node ch.js page_info` |
| `list_tabs` | 列出所有已知的浏览器 tab | `node ch.js list_tabs` |
| `switch_tab <targetId>` | 切换 agent 到指定 tab | `node ch.js switch_tab 12345` |
| `screenshot [file]` | 截图保存为 PNG 文件 | `node ch.js screenshot shot.png` |

### 交互命令（⭐ 首选 Playwright 通道）

| 命令 | 说明 | 示例 |
|------|------|------|
| `snapshot` | ⭐ 获取页面语义快照（Playwright ariaSnapshot，带 ref 编号） | `node ch.js snapshot` |
| `act <kind> <ref> [text]` | ⭐ 通过 ref 交互（click/type/press/hover/scroll/select 等） | `node ch.js act type e12 "query" --submit` |
| `eval <expression>` | 在页面上执行 JavaScript（兜底） | `node ch.js eval "document.title"` |

### 交互命令（降级：纯 CDP 通道）

以下命令绕过 Playwright，直接使用 CDP 原生协议。仅在 `snapshot` + `act` 失败时使用。

| 命令 | 说明 | 已知局限 |
|------|------|----------|
| `click --selector <sel>` | 通过 CSS 选择器点击（CDP） | `DOM.getBoxModel` 对不可见/异步元素返回 0 |
| `click --x <x> --y <y>` | 通过坐标点击 | 需要可靠的坐标来源 |
| `type --text <text> --selector <sel>` | 先 CDP 聚焦再输入 | `DOM.focus` 对 React 受控组件报 "not focusable" |
| `type --text <text>` | 纯键盘输入（无聚焦） | 依赖当前焦点状态 |

### 高级命令

| 命令 | 说明 | 示例 |
|------|------|------|
| `learn` | 纯 CDP 三重树融合，输出带坐标的交互元素表（补充手段） | `node ch.js learn` |
| `ax_tree` | 获取页面无障碍树（Accessibility Tree） | `node ch.js ax_tree` |
| `cdp <method> [params_json]` | 透传任意 CDP 命令 | `node ch.js cdp "DOM.getDocument" "{}"` |
| `batch "cmd1; cmd2"` | 批量执行多个命令 | `node ch.js batch "navigate https://x.com; learn"` |

---

## 操作流程

### Step -1：锦囊优先 (Strategic Recall)

检查 `./.data-browser-knowledge/<domain>.md` 是否有该站点的认知模型。

- **已有建模**：直接按模型中的选择器和路径执行任务。
- **空白站点**：进入 Step 0（认知建模）。

### Step 0：认知建模 (Cognitive Mapping)

首次面对新站点，AI 必须先深度理解页面结构。

**⭐ 首选方案：Playwright snapshot（语义快照 + 可操作 ref）**

```bash
# 导航到目标页面
node cloudhand-bridge/ch.js navigate <url>

# 获取语义快照（Playwright ariaSnapshot，输出带 ref 编号的语义树）
node cloudhand-bridge/ch.js snapshot
```

`snapshot` 输出说明：
- 语义树结构：`- role "name" [ref=eN]` — 带层级缩进的 ARIA 语义树
- 每个可交互元素自动分配 `[ref=eN]` 编号，可直接用于 `act` 命令
- 筛选栏折叠文本（如 `text: 全网内容 只看头条`）会自动拆分为独立的虚拟 ref

**降级方案：纯 CDP learn（仅当 snapshot 不可用时）**

```bash
# 纯 CDP 三重树融合（DOMSnapshot + DOM + AX）
node cloudhand-bridge/ch.js learn
```

`learn` 输出 `[N] <tag> "文本" @(x,y WxH)` 格式，**无 ref**，只能配合坐标或选择器操作。
已知局限：`DOMSnapshot.captureSnapshot` 对复杂 SPA 的 layout bounds 可能返回 `(0,0)`。

**AI 分析任务**：
1. **逻辑分区**：识别 header（导航区）、main（功能区）、footer（信息区）
2. **寻找地标**：核心搜索框、登录按钮、菜单入口的 ref 编号
3. **异步特征**：判断页面是否有懒加载、SPA 路由等需要等待的场景
4. **存档锦囊**：将分析结论写入 `./.data-browser-knowledge/<domain>.md`

### Step 1：执行任务 (Precision Strike)

**⭐ 首选方案：通过 snapshot ref 操作（Playwright 通道）**

```bash
# 示例：在搜索框中输入关键词并搜索
# 先 snapshot 获取 ref → 找到 textbox "搜索" [ref=e12] → 用 act 操作
node cloudhand-bridge/ch.js snapshot
node cloudhand-bridge/ch.js act type e12 "AI 编程" --submit

# 等待页面加载后截图确认
node cloudhand-bridge/ch.js screenshot result.png
```

`act` 支持的 kind：`click`、`type`、`press`、`hover`、`scroll`、`select`、`fill`、`wait`、`close` 等。
`--submit` 标志在输入后自动按 Enter。`--slowly` 标志模拟逐字输入（delay 75ms）。

**`act` 响应结构（重要）**：

每次 `act` 调用后，响应中自动包含操作后的页面状态：

| 字段 | 说明 | 用途 |
|------|------|------|
| `actionSummary` | 人类可读摘要，含新标签页提醒 | 判断操作结果和下一步动作 |
| `refs` | 操作后自动刷新的 ref 映射 | 直接用于下一次 `act`，**无需再调 `snapshot`** |
| `newTab` | 新打开的标签页信息（targetId/url） | 判断是否需要 `switch_tab` |
| `newTabSnapshot` | 新标签页的预加载 snapshot + refs | 切换后可直接操作，省一次 `snapshot` |

示例 `actionSummary`：
```
页面快照已获取 (69 个交互元素)；⚠️ 新标签页已打开: https://so.toutiao.com/search?... — 需 switch_tab 切换；新标签页快照已预加载
```

> **关键优化**：连续操作时，AI 应直接从 `act` 响应的 `refs` 中查找下一步目标 ref，而非每次都重新调用 `snapshot`。

**降级方案：纯 CDP 操作（仅当 act 失败时）**

```bash
# 通过 CSS 选择器操作
node cloudhand-bridge/ch.js click --selector "#search-button"
node cloudhand-bridge/ch.js type --selector "#search-input" --text "AI 编程"
# 通过坐标操作
node cloudhand-bridge/ch.js click --x 100 --y 200
```

### 新标签页处理

搜索/链接可能在新标签页中打开结果。`act` 响应中会自动检测并预加载新标签页的 snapshot。
处理流程：
1. `act` 响应中检查 `newTab` 字段或 `actionSummary` 提示
2. `list_tabs` 确认新标签页的 targetId
3. `switch_tab <targetId>` 切换到新标签页
4. 继续 `snapshot` + `act` 操作

### Step 2：复盘 (Post-Action Refinement)

操作完成后更新认知模型：
- 记录有效的选择器路径和精确坐标
- 标记需要等待的异步加载区域
- 记录发现的 API/URL 捷径

---

## 核心约束

1. **先理解后操作**：严禁在未分析页面结构的情况下盲目点击。必须先 `snapshot` 理解页面
2. **Playwright 优先**：操作优先使用 `snapshot` + `act`（Playwright 通道），内置 actionability 检查（可见性、可交互性、自动滚动、自动 focus）。纯 CDP 命令（`click --selector`、`type --selector`）仅作为降级兜底
3. **经验持久化**：所有认知成果存入 `.data-browser-knowledge/`，一次学习终身复用
4. **专属窗口**：所有操作在 Agent 窗口中进行，不干扰用户。窗口被关闭后，下次操作时自动重建
5. **截图验证**：关键操作后截图确认结果，不要假设操作一定成功
6. **新标签页策略**：搜索/链接可能打开新标签页。`act` 响应中会检测并预加载新标签页 snapshot。可靠做法是 `list_tabs` 确认 → `switch_tab` 切换
7. **React Select 下拉框**：React Select 等非原生 `<select>` 组件的 `role=combobox` 在不可见的虚拟 `<input>` 上，直接 `act click` 会超时。替代方案：点击虚拟 ref 文本标签（如"不限时间"）打开下拉菜单，然后 `act click` 目标选项的虚拟 ref
8. **禁止注入 JS 替代已有命令**：不使用 `Runtime.evaluate` 注入 JS 来做 DOM 操作，优先使用 `act` 或纯 CDP 命令

---

## 底层实现说明（v2.7.0）

### Playwright 通道（⭐ 首选）

| 接口 | 底层实现 |
|------|---------|
| `snapshot` | Playwright `page.locator('body').ariaSnapshot({ ref: true })` → `buildRoleSnapshot()` 生成带 ref 的语义树 |
| `act click eN` | `refLocator()` → Playwright `locator.click()`（内置 actionability 检查） |
| `act type eN text` | `refLocator()` → Playwright `locator.fill()` 或 `keyboard.type()`（自动处理 focus） |
| `navigate` | Playwright `page.goto()` |

### 纯 CDP 通道（降级兜底）

| 接口 | 底层 CDP 实现 |
|------|--------------|
| `click --selector` | `DOM.getDocument` → `DOM.querySelectorAll` → `DOM.getBoxModel` → `Input.dispatchMouseEvent` |
| `type --selector` | `DOM.getDocument` → `DOM.querySelector` → `DOM.focus` → `Input.dispatchKeyEvent` |
| `learn` | `DOMSnapshot.captureSnapshot` + `DOM.getDocument` + `Accessibility.getFullAXTree` 三重树融合 |
| `page_info` | `Page.getNavigationHistory` |
| `get_ax_tree` | `Accessibility.getFullAXTree` |

---

## 架构概览

```
AI Agent (CLI/run_command)
    │
    ▼
cloudhand-bridge/ch.js ──HTTP REST──▶ server.js:9876
                                          │
                                     WebSocket (CDP)
                                          │
                                          ▼
                                   Chrome Extension
                                   (chrome.debugger)
                                          │
                                          ▼
                                   Agent 专属窗口/Tab
```
