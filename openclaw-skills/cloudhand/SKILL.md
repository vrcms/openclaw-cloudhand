---
name: cloudhand
description: |
  控制用户本地 Chrome 浏览器。当用户要求打开网页、截图、点击、输入、操作浏览器时使用。
  Use when: (1) 用户要打开/访问某个网址，(2) 需要截图当前页面，(3) 需要在浏览器中点击/输入/操作，
  (4) 用户说「帮我连接浏览器」，(5) 需要在登录状态下访问网站（利用用户已有的 Cookie）。
  NOT for: 服务端抓取（用 web/firecrawl），不需要真实浏览器的场景。
---

# CloudHand v2.7.0 — 控制本地 Chrome

通过 CDP 协议 + Playwright 操控用户本地 Chrome 浏览器。Bridge 运行在 `http://127.0.0.1:9876`，所有操作通过 HTTP REST 调用。

---

## ⚠️ 重要前提：用户电脑必须在线

| 要求 | 说明 |
|------|------|
| ✅ **用户电脑开机** | Windows/Mac 必须开着 |
| ✅ **Chrome 运行** | Chrome 浏览器必须启动（可后台运行） |
| ✅ **扩展已安装** | CloudHand Chrome 扩展已安装并启用 |
| ✅ **Bridge 已启动** | `node cloudhand-bridge/server.js` 正在运行 |

**如果用户电脑关机/扩展未运行：**
- 所有端点返回 `connected: false`
- 必须告知用户「需要打开电脑并启动 Chrome」

**定时任务注意事项：**
- 定时任务（cron）通常**不使用云手**，因为用户电脑可能关机
- 定时任务应该用 `curl`/`requests` 直接抓取（服务端方式）

---

## 双模式运行

| | 本地模式 | 远程模式 |
|---|---|---|
| **启动方式** | `node server.js --local` | `node server.js` |
| **绑定地址** | `127.0.0.1`（仅本机） | `0.0.0.0`（所有网卡） |
| **鉴权** | 固定 Token `local-mode-token`，免配对 | 随机 `apiToken` + 6位配对码 |
| **适用场景** | AI 运行在本机（Claude Code、Gemini 等） | AI 运行在远程 VPS（OpenClaw） |

---

## 鉴权

所有操作端点需要 Bearer Token（免鉴权端点除外）。

```python
import requests

# 获取 apiToken（仅限 127.0.0.1 调用）
TOKEN = requests.get('http://127.0.0.1:9876/token').json()['apiToken']
H = {'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'}

# 本地模式可直接使用固定 Token
# TOKEN = 'local-mode-token'
```

免鉴权端点：`/status`、`/token`（仅本机）。

---

## ⚡ 第一步：检查连接状态（每次使用前必做）

```python
status = requests.get('http://127.0.0.1:9876/status').json()
```

返回字段：

| 字段 | 说明 |
|------|------|
| `connected` | Chrome 扩展是否已连接（布尔值） |
| `mode` | `local` 或 `remote` |
| `attachedTabs` | 已 attach 的 tab 数量 |
| `agentSessionId` | 当前 agent 使用的 CDP session ID |

```python
if not status.get('connected'):
    print("⚠️ Chrome 扩展未连接，请启动 Chrome 并确认扩展已加载。")
elif status.get('mode') == 'local':
    print("🚀 本地直连模式，操作响应极快。")
else:
    print("🌐 远程模式已连接。")
```

---

## 端点参考（v2.7.0）

### 基础端点

| 端点 | 方法 | 鉴权 | 说明 |
|------|------|------|------|
| `/status` | GET | ❌ | 连接状态 |
| `/token` | GET | ❌ | 获取 apiToken（仅限 127.0.0.1） |
| `/list_tabs` | GET | ✅ | 列出所有已知 tab |
| `/get_page_info` | GET/POST | ✅ | 当前页面 URL 和 Title |

### 标签页管理

| 端点 | 方法 | 说明 |
|------|------|------|
| `/ensure_tab` | POST | 确保有 agent 专属 tab（无则创建） |
| `/switch_tab` | POST | 切换 agent 到指定 tab（`{targetId}` 或 `{sessionId}`） |
| `/navigate` | POST | 导航到 URL（`{url}`） |

### ⭐ 页面理解（首选 Playwright 通道）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/snapshot` | POST | ⭐ Playwright ariaSnapshot，返回带 `[ref=eN]` 的语义树 |
| `/act` | POST | ⭐ 通过 ref 交互（click/type/press/hover/scroll/select/fill/wait/close） |
| `/screenshot_with_labels` | POST | 截图 + 交互元素边框标签 |

### 纯 CDP 操作（降级兜底）

| 端点 | 方法 | 说明 | 已知局限 |
|------|------|------|----------|
| `/click` | POST | CSS 选择器或坐标点击 | `DOM.getBoxModel` 对不可见元素返回 0 |
| `/type` | POST | CDP 键盘输入（可选 selector 聚焦） | `DOM.focus` 对 React 受控组件可能失败 |
| `/eval` | POST | 执行 JavaScript | 兜底手段 |
| `/screenshot` | POST | CDP 截图（base64 PNG） | — |
| `/cdp` | POST | 万能 CDP 命令透传 | — |
| `/get_ax_tree` | POST | 获取 Accessibility Tree | 原始节点数组 |

---

## 操作流程

### Step -1：读取站点经验

```python
import os
domain = 'toutiao.com'
knowledge_path = f'/root/.openclaw/workspace/browser-knowledge/{domain}.md'
if os.path.exists(knowledge_path):
    with open(knowledge_path) as f:
        print(f.read())  # 已有经验，直接按经验操作
else:
    print("新站点，需要先认知建模")
```

### Step 0：认知建模（首次访问新站点）

```python
# 1. 确保有 agent tab
requests.post('http://127.0.0.1:9876/ensure_tab', headers=H).json()

# 2. 导航
requests.post('http://127.0.0.1:9876/navigate', headers=H,
    json={'url': 'https://www.toutiao.com'}).json()

# 3. ⭐ 获取语义快照（Playwright ariaSnapshot）
snap = requests.post('http://127.0.0.1:9876/snapshot', headers=H).json()
print(snap['snapshot'])  # 带 [ref=eN] 的语义树
# refs: snap['refs']  — ref 到 role/name 的映射
```

`/snapshot` 输出说明：
- 语义树结构：`- role "name" [ref=eN]` — 带层级缩进的 ARIA 语义树
- 每个可交互元素自动分配 `[ref=eN]` 编号，可直接用于 `/act` 端点
- 筛选栏折叠文本（如 `text: 全网内容 只看头条`）会自动拆分为独立的虚拟 ref（`virtual: true`）
- 返回字段：`snapshot`（文本）、`refs`（ref→role/name 映射）、`stats`（元素计数）、`url`、`title`

**AI 分析任务**：
1. **逻辑分区**：识别 header（导航区）、main（功能区）、footer（信息区）
2. **寻找地标**：核心搜索框、登录按钮、菜单入口的 ref 编号
3. **异步特征**：判断页面是否有懒加载、SPA 路由等需要等待的场景
4. **存档经验**：将分析结论写入站点经验文件

### Step 1：执行任务

**⭐ 首选：通过 /act + ref 操作（Playwright 通道）**

```python
# 从 snapshot 中找到 textbox "搜索" [ref=e12]
# 输入关键词并按回车
result = requests.post('http://127.0.0.1:9876/act', headers=H, json={
    'kind': 'type',
    'ref': 'e12',
    'text': 'AI 编程',
    'submit': True  # 自动按 Enter
}).json()

# 响应中自动包含操作后的页面状态
print(result['actionSummary'])  # 人类可读摘要
# result['refs'] — 操作后刷新的 ref 映射，可直接用于下一步
# result.get('newTab') — 如果有新标签页打开
# result.get('newTabSnapshot') — 新标签页的预加载 snapshot
```

**`/act` 响应结构（重要）**：

每次 `/act` 调用后，响应中自动包含操作后的页面状态：

| 字段 | 说明 | 用途 |
|------|------|------|
| `actionSummary` | 人类可读摘要，含新标签页提醒 | 判断操作结果和下一步动作 |
| `refs` | 操作后自动刷新的 ref 映射 | 直接用于下一次 `/act`，**无需再调 `/snapshot`** |
| `newTab` | 新打开的标签页信息（targetId/url） | 判断是否需要 `/switch_tab` |
| `newTabSnapshot` | 新标签页的预加载 snapshot + refs | 切换后可直接操作，省一次 `/snapshot` |

示例 `actionSummary`：
```
页面快照已获取 (69 个交互元素)；⚠️ 新标签页已打开: https://so.toutiao.com/search?... — 需 switch_tab 切换；新标签页快照已预加载
```

> **关键优化**：连续操作时，AI 应直接从 `/act` 响应的 `refs` 中查找下一步目标 ref，而非每次都重新调用 `/snapshot`。

**`/act` 支持的 kind：**

| kind | 必需参数 | 说明 |
|------|----------|------|
| `click` | `ref` | 点击元素 |
| `type` | `ref`, `text` | 输入文本（`submit=true` 自动回车，`slowly=true` 逐字输入） |
| `press` | `key` | 按键（如 `Enter`、`Tab`、`Escape`） |
| `hover` | `ref` | 悬停 |
| `select` | `ref`, `option` | 选择下拉选项 |
| `scroll` | `x`, `y` | 滚动（可选 `originX`/`originY` 指定锚点） |
| `scrollIntoView` | `ref` | 滚动到元素可见 |
| `fill` | `fields` | 批量填表（`[{ref, type, value}]`） |
| `wait` | 见下方 | 条件等待 |
| `clickAt` | `x`, `y` | 坐标点击 |
| `typeAt` | `x`, `y`, `text` | 坐标位置输入 |
| `drag` | `startRef`, `endRef` | ref 到 ref 拖拽 |
| `evaluate` | `fn` | 在页面上下文执行 JS |
| `close` | — | 关闭当前标签页 |

**`wait` kind 参数：**

| 参数 | 说明 |
|------|------|
| `timeMs` | 固定等待毫秒数 |
| `text` | 等待页面出现指定文本 |
| `textGone` | 等待指定文本消失 |
| `selector` | 等待 CSS 选择器出现 |
| `url` | 等待页面 URL 匹配 |

**降级方案：纯 CDP（仅当 /act 失败时）**

```python
# CSS 选择器点击
requests.post('http://127.0.0.1:9876/click', headers=H,
    json={'selector': '#search-button'}).json()

# 坐标点击
requests.post('http://127.0.0.1:9876/click', headers=H,
    json={'x': 100, 'y': 200}).json()

# CDP 键盘输入（可选先聚焦 selector）
requests.post('http://127.0.0.1:9876/type', headers=H,
    json={'text': 'hello', 'selector': '#search-input'}).json()
```

### 新标签页处理

搜索/链接可能在新标签页中打开结果：

```python
# 1. 从 /act 响应检查 newTab
if result.get('newTab'):
    new_target = result['newTab']['targetId']
    # 切换到新标签页
    requests.post('http://127.0.0.1:9876/switch_tab', headers=H,
        json={'targetId': new_target}).json()

# 2. 或手动查找
tabs = requests.get('http://127.0.0.1:9876/list_tabs', headers=H).json()
for tab in tabs['tabs']:
    if 'search' in tab.get('url', ''):
        requests.post('http://127.0.0.1:9876/switch_tab', headers=H,
            json={'targetId': tab['targetId']}).json()
        break
```

### 截图

```python
# 纯 CDP 截图（base64 PNG）
shot = requests.post('http://127.0.0.1:9876/screenshot', headers=H).json()
# shot['data'] = 'data:image/png;base64,...'

# 带标签截图（交互元素自动标注边框和编号）
labeled = requests.post('http://127.0.0.1:9876/screenshot_with_labels', headers=H,
    json={'filterMode': 'clickable', 'maxLabels': 100}).json()
# labeled['data'] = base64 PNG（带标签层）
# labeled['snapshot'] / labeled['refs'] — 语义快照和 ref 映射
```

### 执行 JavaScript（兜底）

```python
result = requests.post('http://127.0.0.1:9876/eval', headers=H,
    json={'expression': 'document.title'}).json()
print(result['result'])
```

### 万能 CDP 透传

```python
# 任意 CDP 命令
result = requests.post('http://127.0.0.1:9876/cdp', headers=H,
    json={'method': 'DOM.getDocument', 'params': {'depth': 0}}).json()
```

---

## Step 2：复盘与经验持久化

**⚠️ 每次任务完成后，必须写入站点经验，不可跳过。**

```python
# 追加经验到站点文件
domain = 'toutiao.com'
knowledge_path = f'/root/.openclaw/workspace/browser-knowledge/{domain}.md'
os.makedirs(os.path.dirname(knowledge_path), exist_ok=True)
with open(knowledge_path, 'a') as f:
    f.write(f"""
## 更新 {datetime.now().strftime('%Y-%m-%d')}
- 搜索框 ref: textbox "搜索" [ref=e12]
- 筛选栏虚拟 ref: "只看头条" [ref=e68]、"不限时间" [ref=e69]
- 时间下拉菜单: 点击"不限时间"后展开，选项自动生成新的虚拟 ref
- 搜索结果在新标签页打开，需要 switch_tab
""")
```

**必须记录的四类信息：**

1. **加载节奏**：navigate 后需等多久，是否需要 wait
2. **关键元素 ref**：搜索框、按钮、筛选栏的 ref 编号
3. **操作注意事项**：哪些元素是虚拟 ref、哪些需要先展开再点击
4. **踩坑记录**：失败的操作路径和原因

---

## 核心约束

1. **先理解后操作**：必须先 `/snapshot` 理解页面，严禁盲目操作
2. **Playwright 优先**：操作优先用 `/snapshot` + `/act`（内置 actionability 检查），`/click` + `/type`（纯 CDP）仅作降级兜底
3. **经验持久化**：所有认知成果存入 `browser-knowledge/`，一次学习终身复用
4. **专属标签页**：所有操作在 agent 专属 tab 中进行（`/ensure_tab` 自动管理），不干扰用户
5. **截图验证**：关键操作后截图确认结果，不假设操作成功
6. **新标签页策略**：`/act` 响应中自动检测新标签页并预加载 snapshot。可靠做法是 `/list_tabs` 确认 → `/switch_tab` 切换
7. **React Select 下拉框**：非原生 `<select>` 的 `role=combobox` 在不可见的 `<input>` 上，直接 `/act click` 会超时。替代方案：点击虚拟 ref 文本标签打开下拉菜单，然后 `/act click` 目标选项
8. **禁止 JS 替代已有命令**：不用 `/eval` 注入 JS 做 DOM 操作，优先用 `/act` 或纯 CDP 命令
9. **未连接时必须告知用户**：不要静默失败

---

## 底层实现说明（v2.7.0）

### Playwright 通道（⭐ 首选）

| 端点 | 底层实现 |
|------|---------|
| `/snapshot` | Playwright `page.locator('body').ariaSnapshot({ ref: true })` → `buildRoleSnapshot()` 生成带 ref 的语义树 |
| `/act click eN` | `refLocator()` → Playwright `locator.click()`（内置 actionability 检查） |
| `/act type eN text` | `refLocator()` → Playwright `locator.fill()` 或 `keyboard.type()`（自动处理 focus） |
| `/navigate` | Playwright `page.goto()` |

### 纯 CDP 通道（降级兜底）

| 端点 | 底层 CDP 实现 |
|------|-------------|
| `/click --selector` | `DOM.getDocument` → `DOM.querySelectorAll` → `DOM.getBoxModel` → `Input.dispatchMouseEvent` |
| `/type --selector` | `DOM.getDocument` → `DOM.querySelector` → `DOM.focus` → `Input.dispatchKeyEvent` |
| `/screenshot` | `Page.captureScreenshot` |
| `/eval` | `Runtime.evaluate` |
| `/get_ax_tree` | `Accessibility.getFullAXTree` |

---

## 架构概览

```
远程 AI (OpenClaw VPS)          本地 AI (Claude Code / Gemini)
    │                                │
    ▼ HTTP REST (Bearer Token)       ▼ HTTP REST (local-mode-token)
              server.js:9876
                   │
              WebSocket /ws
                   │
                   ▼
            Chrome Extension
            (chrome.debugger)
                   │
                   ▼
            Agent 专属 Tab
```

### WebSocket 端点

| 路径 | 用途 |
|------|------|
| `/ws` | Chrome 扩展连接（CDP 命令中继） |
| `/cdp` | Playwright `connectOverCDP` 连接（服务端内部使用） |

### CDP HTTP 端点（Playwright 内部用）

| 路径 | 用途 |
|------|------|
| `/json/version` | CDP 协议版本信息 |
| `/json/list` | CDP target 列表 |
