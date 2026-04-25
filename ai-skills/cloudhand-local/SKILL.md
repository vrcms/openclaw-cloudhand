---
name: cloudhand-local
description: AI 通过 CDP 协议直接操控本地浏览器，实现网页自动化任务。基于认知建模方法，AI 先理解页面结构再精确操作。
license: MIT
compatibility: CloudHand v2.7.0+ (CDP Edition)
metadata:
  author: CloudHand
  version: "2.9.0"
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

### 交互命令

| 命令 | 说明 | 示例 |
|------|------|------|
| `click --selector <sel>` | 通过 CSS 选择器点击元素（纯 CDP） | `node ch.js click --selector "button.submit"` |
| `click --x <x> --y <y>` | 通过坐标点击 | `node ch.js click --x 100 --y 200` |
| `type --text <text>` | 键盘输入文本 | `node ch.js type --text "hello"` |
| `type --text <text> --selector <sel>` | 先聚焦元素再输入（纯 CDP 聚焦） | `node ch.js type --selector "#search" --text "query"` |
| `eval <expression>` | 在页面上执行 JavaScript（保留兜底） | `node ch.js eval "document.title"` |

### 高级命令

| 命令 | 说明 | 示例 |
|------|------|------|
| `ax_tree` | 获取页面无障碍树（Accessibility Tree） | `node ch.js ax_tree` |
| `cdp <method> [params_json]` | 透传任意 CDP 命令 | `node ch.js cdp "DOM.getDocument" "{}"` |
| `learn` | 纯 CDP 三重树融合提取页面结构，输出带坐标的交互元素表 | `node ch.js learn` |
| `batch "cmd1; cmd2"` | 批量执行多个命令 | `node ch.js batch "navigate https://x.com; learn"` |

---

## 操作流程

### Step -1：锦囊优先 (Strategic Recall)

检查 `./.data-browser-knowledge/<domain>.md` 是否有该站点的认知模型。

- **已有建模**：直接按模型中的选择器和路径执行任务。
- **空白站点**：进入 Step 0（认知建模）。

### Step 0：认知建模 (Cognitive Mapping)

首次面对新站点，AI 必须先深度理解页面结构：

```bash
# 导航到目标页面
node cloudhand-bridge/ch.js navigate <url>

# 提取页面遥测数据（纯 CDP 三重树融合：DOMSnapshot + DOM + AX）
node cloudhand-bridge/ch.js learn
```

`learn` 输出说明：
- `[N] <tag> "文本" → href @(x,y WxH)` — 每个可交互元素的标签、文本、链接和**精确屏幕坐标**
- `[ACCESSIBILITY TREE] Total nodes: N` — 语义节点总数，用于判断页面复杂度

**AI 分析任务**：
1. **逻辑分区**：识别 header（导航区）、main（功能区）、footer（信息区）
2. **寻找地标**：核心搜索框、登录按钮、菜单入口的选择器和坐标
3. **异步特征**：判断页面是否有懒加载、SPA 路由等需要等待的场景
4. **存档锦囊**：将分析结论写入 `./.data-browser-knowledge/<domain>.md`

### Step 1：执行任务 (Precision Strike)

利用 CLI 命令和认知模型精确操作：

```bash
# 示例：在搜索框中输入关键词并搜索（纯 CDP 全程）
node cloudhand-bridge/ch.js click --selector "#search-input"
node cloudhand-bridge/ch.js type --selector "#search-input" --text "AI 编程"
node cloudhand-bridge/ch.js click --selector "#search-button"

# 等待页面加载后截图确认
node cloudhand-bridge/ch.js screenshot result.png
```

### Step 1.5：多标签页处理 (Multi-Tab Navigation)

当执行搜索或点击链接打开了新标签页时：

1. **查看所有标签页**：使用 `node ch.js list_tabs` 找到新页面的 `targetId` 或 `sessionId`。
2. **切换控制权**：使用 `node ch.js switch_tab <targetId>` 将 Agent session 切换到新页面。
3. 切换后，后续的 `click`、`type`、`learn` 等命令将全部在新页面上执行。

> [!IMPORTANT]
> **`eval` 使用限制**：`eval` 接口保留作为最终兜底，仅在上述 CDP 原生命令无法完成操作时才可使用。
> 严禁用 `eval` 替代 `click`、`type`、`page_info` 等已有的原生 CDP 命令。

```bash
# eval 合法用途示例（无对应 CDP 原生命令时）
node cloudhand-bridge/ch.js eval "document.querySelector('select#city').value = 'hangzhou'; document.querySelector('select#city').dispatchEvent(new Event('change'))"
```

### Step 2：复盘 (Post-Action Refinement)

操作完成后更新认知模型：
- 记录有效的选择器路径和精确坐标
- 标记需要等待的异步加载区域
- 记录发现的 API/URL 捷径

---

## 核心约束

1. **先理解后操作**：严禁在未分析页面结构的情况下盲目点击
2. **纯 CDP 优先**：所有操作必须使用 CDP 原生协议，禁止在内部路由中使用 `Runtime.evaluate` 注入 JS 替代已有的原生 CDP 命令
3. **经验持久化**：所有认知成果存入 `.data-browser-knowledge/`，一次学习终身复用
4. **专属窗口**：所有操作在 Agent 窗口中进行，不干扰用户。窗口被关闭后，下次操作时自动重建
5. **截图验证**：关键操作后截图确认结果，不要假设操作一定成功

---

## 底层 CDP 实现说明（v2.8.0）

| 接口 | 底层 CDP 实现 |
|------|--------------|
| `click --selector` | `DOM.getDocument` → `DOM.querySelectorAll` → `DOM.getBoxModel` → `Input.dispatchMouseEvent` (mouseMoved→mousePressed→mouseReleased) |
| `type --selector` | `DOM.getDocument` → `DOM.querySelector` → `DOM.focus` → `Input.dispatchKeyEvent` (keyDown→char→keyUp) |
| `page_info` | `Page.getNavigationHistory` |
| `learn` | `DOMSnapshot.captureSnapshot` + `DOM.getDocument` + `Accessibility.getFullAXTree` 三重树融合 |
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
