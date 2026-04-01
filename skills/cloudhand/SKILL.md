---
name: cloudhand
description: |
  控制用户本地 Chrome 浏览器。当用户要求打开网页、截图、点击、输入、操作浏览器时使用。
  Use when: (1) 用户要打开/访问某个网址，(2) 需要截图当前页面，(3) 需要在浏览器中点击/输入/操作，
  (4) 用户说「帮我连接浏览器」，(5) 需要在登录状态下访问网站（利用用户已有的 Cookie）。
  NOT for: 服务端抓取（用 web/firecrawl），不需要真实浏览器的场景。
---

# CloudHand - 控制本地 Chrome

## ⚠️ 重要前提：用户电脑必须在线

**CloudHand 不是 VPS 服务，必须用户本地电脑运行 Chrome 扩展才能工作：**

| 要求 | 说明 |
|------|------|
| ✅ **用户电脑开机** | 你的 Windows/Mac 必须开着 |
| ✅ **Chrome 运行** | Chrome 浏览器必须启动（可以后台运行） |
| ✅ **扩展已安装** | CloudHand Chrome 扩展已安装并启用 |
| ✅ **扩展已配对** | 扩展与 VPS bridge 完成配对（一次配对，长期有效） |

**如果用户电脑关机/扩展未运行：**
- 云手无法执行任何浏览器操作
- 所有端点返回 `extensionConnected: false`
- 必须告知用户「需要打开电脑并启动 Chrome」

**定时任务注意事项：**
- 定时任务（cron）通常**不使用云手**，因为用户电脑可能关机
- 定时任务应该用 `curl`/`requests` 直接抓取（服务端方式）
- 只有实时交互任务才用云手（用户在线时）

---

## ⚡ 第一步：检查连接状态（每次使用前必做）

**在执行任何浏览器操作之前**，必须先检查 bridge 是否已连接，扩展是否配对：

```python
import requests
status = requests.get('http://127.0.0.1:9876/status').json()
paired = status.get('paired', False)
connected = status.get('extensionConnected', False)
```

### 未连接时的处理流程

| 状态 | 原因 | 处理方式 |
|------|------|----------|
| `extensionConnected: false` | Chrome 扩展未安装或未连接 | 提示用户安装/重新配对 |
| `paired: false` | 扩展已连接但未配对 | 生成配对码，指引用户配对 |
| `paired: true` | ✅ 正常，可以操作 | 直接执行任务 |

**未连接时必须告知用户，不要静默失败：**

```python
if not connected:
    # 直接告诉用户
    print("⚠️ 尚未连接你的 Chrome 浏览器，还无法操作网页。")
    print("请先安装 CloudHand 扩展并配对：")
    print("1. 让我生成下载链接安装扩展")
    print("2. 输入配对码完成配对")
elif not paired:
    print("⚠️ 扩展已连接但未配对，请生成配对码完成配对。")
    # 自动生成配对码
    pair_r = requests.post('http://127.0.0.1:9876/pair/challenge').json()
    print(f"配对码：{pair_r.get('code')}（120秒有效）")
```

---

## 安装后步骤

安装完成并验证 bridge 正常运行后：

1. **生成一次性下载链接**（120秒有效），发给用户下载 Chrome 扩展：
   ```bash
   APITOKEN=$(curl -s http://127.0.0.1:9876/token | python3 -c "import sys,json; print(json.load(sys.stdin)['apiToken'])")
   curl -s -X POST -H "Authorization: Bearer $APITOKEN" http://127.0.0.1:9876/gen-download-link
   # 返回: {"url":"http://<ip>:9876/download-ext?t=xxx", "expiresIn":120}
   ```
   把返回的 url 发给用户，用户在 120 秒内下载，zip 下载后自动删除。

2. **通过当前对话渠道发送欢迎消息**，例如：
   > ☁️ CloudHand 云手已安装！Chrome 扩展下载链接（120秒有效）：<url>
   > 安装方式：Chrome 扩展管理页 → 开发者模式 → 加载解压缩扩展 → 选择解压后的文件夹

不要硬编码渠道或用户 ID，用当前会话的回复机制即可。

---

## 🧹 Tab 清理规则（必须遵守）

- **每次任务完成后，关闭所有我打开的非活跃 tab**，只保留最后一个
- **只关 agent 窗口（`/agent_windows` 返回的 windowId）下的 tab**，用户其他窗口绝对不动
- 关闭方法：`POST /close_tab {tabId: id}`
- 判断标准：`active: false` 且在 agent 窗口下 → 关闭

```python
# 任务结束时标准清理流程
agent_tabs = [t for t in all_tabs if t['windowId'] == AGENT_WIN]
to_close = [t['id'] for t in agent_tabs if not t['active']]
if len(to_close) >= len(agent_tabs):
    to_close = to_close[1:]  # 至少保留1个
for tab_id in to_close:
    requests.post('/close_tab', json={'tabId': tab_id})
```

---

## 🧠 站点经验库（执行网页任务必读）

### 任务前：读取经验
**每次执行网页任务前**，先检查是否有该站点的经验文件：

```bash
cat /root/.openclaw/workspace/browser-knowledge/<domain>.md 2>/dev/null || echo "无经验文件"
# 也看通用经验
cat /root/.openclaw/workspace/browser-knowledge/_common.md
```

经验文件目录：`/root/.openclaw/workspace/browser-knowledge/`
- **一个域名 = 一个文件**，文件名就是域名，如 `douyin.com.md`、`toutiao.com.md`、`bing.com.md`
- **严禁混合**：不同域名的经验绝对不能写在同一个文件里（例如：Bing 的经验不能写进 toutiao.com.md）
- `_common.md`：通用技巧，适用于所有网站（SPA 等待、懒加载、data-e2e 选择器优先级等）
- 写经验前先确认：「这条经验属于哪个域名？」然后写到对应文件

### 🆕 第一次访问新域名：必须建立完整经验文件

**判断条件**：`browser-knowledge/<domain>.md` 不存在，即为首次访问。

首次访问时，用 `get_browser_state` 读取 UI 树，观察元素列表，总结写入经验文件：

```python
# 1. navigate 后等页面加载
time.sleep(3)

# 2. 读取 UI 树，观察所有可交互元素
state = requests.post('http://127.0.0.1:9876/get_browser_state', headers=H, json={'tabId': tid}).json()
print('elementCount:', state['result']['elementCount'])
print(state['result']['content'])  # AI 观察并总结
```

**观察重点（从 UI 树中提取）：**
- **搜索框**：找 `<input placeholder="...">` 类元素，记录 placeholder 文字和索引规律
- **主要按钮**：登录/注册/筛选/排序按钮的文字
- **内容区元素**：内容型元素（`<a>`链接、文章标题）从第几个索引开始
- **元素总数**：正常加载后大约多少个元素（elementCount 为 0 说明需要更长等待时间）

**必须记录的四类信息：**

```markdown
# <domain> 经验

## **加载节奏**
- navigate 后需等 N 秒，get_browser_state 才返回有效元素（elementCount > 0）
- 是否需要滚动才能加载更多内容

## **关键功能入口**（UI树中的元素特征）
- 搜索框：placeholder="XXX"，通常在索引 [N] 附近
- 登录/主操作按钮：文字为「XXX」
- 内容列表：从索引 [N] 开始是文章/视频链接

## **click_element 注意事项**
- 哪些元素直接点击有效
- 哪些需要 eval 完整鼠标事件链（如 React Select 下拉）
- 哪些操作是二步骤（先展开再点子项，展开后需重新调 get_browser_state）

## **其他注意事项**
- 是否需要登录
- 是否懒加载（需滚动后再读 UI 树）
- 有无反爬/验证码
```

---

### ⚠️⚠️⚠️ 任务后：写入经验【强制，不可跳过】
**==每次云手任务完成，必须先写经验，再发汇报。不写经验 = 任务未完成。==**

哪怕只有一句话，也必须写：

```bash
# 追加经验到站点文件（没有就创建）
cat >> /root/.openclaw/workspace/browser-knowledge/<domain>.md << 'EOF'
## 更新 YYYY-MM-DD
- 有效选择器：xxx
- 需要等待：sleep(N秒)
- 踩坑：xxx
EOF
```

**必须记录的内容：**
- 有效的 CSS 选择器 / data-e2e 属性（这是最宝贵的）
- 需要等待的时间（sleep 多少秒才能看到内容）
- 懒加载触发方式（滚动几次、滚多少像素）
- 踩过的坑（错误选择器、跳转页、编码问题等）
- 登录要求（是否需要 Cookie、如何判断已登录）

**目的**：下次执行同类任务直接用已知经验，不重复调试，节省大量时间。

> **⛔ 禁止行为**：执行完任务直接发汇报，跳过写经验步骤。这是失职，不可接受。

### 通用规则（优先于特定站点经验）
- `data-e2e` 属性 > class 名（class 是哈希，随构建变化；data-e2e 是语义稳定属性）
- SPA 页面（React/Vue）：navigate 后必须 `sleep(3~5)` 等渲染
- 评论/内容懒加载：先滚动页面 2~3 次再提取
- 用 `/eval` 注入 JS 比截图快 90%，比解析 HTML 省 80%
- shell 变量为空时不要拼接 JSON（会生成 `{"key":}` 非法 JSON）→ 改用 Python requests

---

## 🚨 行为规范（必读，违反=出 bug）

1. **查「用户在看什么」→ 用 `/tabs`，绝不用截图**
   ```bash
   curl -s http://127.0.0.1:9876/tabs | python3 /tmp/list_tabs.py
   # list_tabs.py 内容：
   # import sys,json; d=json.load(sys.stdin); tabs=d.get('result',[])
   # for t in tabs: print('🟢' if t.get('active') else '⚪', t.get('id'), t.get('title','')[:40], t.get('url','')[:60])
   ```

2. **铁律：只能操作 agent 专属窗口，严禁操作用户窗口**
   - 每次操作前必须先 `curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9876/agent_windows` 检查
   - 如果 windowIds 为空 → 先用 `/new_window` 创建专属窗口（`focused:false` 后台创建）
   - 之后所有操作（navigate/click/type/scroll）都必须带上 `tabId` 参数，确保在专属窗口的 tab 内操作
   - **禁止**：不检查 agentWindows 就直接 navigate/click（会跑到用户活动 tab）
   - **禁止**：使用 `focused:true` 或 `active:true`（会抢用户焦点）

3. **bridge 重启后配对还在，不需要重新配对**
   - 重启命令：`lsof -ti:9876 | xargs kill -9; cd ~/.openclaw/extensions/cloudhand && nohup node server.js > /tmp/cloudhand.log 2>&1 &`
   - 重启后 agentWindows 清空，但 session token 持久化在 `~/.openclaw/chrome-bridge/config.json`

4. **禁止主动截图！除非用户明确说"截图"**
   - 优先用 `/eval` 直接执行 JS 提取内容（最灵活，覆盖所有 DOM）
   - 用 `/get_text` 获取纯文本，用 `/get_html` 获取完整 HTML
   - `/snapshot` 端点不稳定，不推荐用
   - 截图消耗大量 token，只有在用户明确说"截图""截个图看看"时才用

5. **操作顺序**：检查连接 → 确认/创建专属窗口 → 在专属窗口 navigate → 操作

---

## 鉴权

所有操作端点需要 Bearer Token。获取方式（仅限本机）：

```bash
# 获取 apiToken（只能从 127.0.0.1 调用）
APITOKEN=$(curl -s http://127.0.0.1:9876/token | python3 -c "import sys,json; print(json.load(sys.stdin)['apiToken'])")

# 所有操作请求加上 header
curl -s -H "Authorization: Bearer $APITOKEN" http://127.0.0.1:9876/tabs

# 或者用 query param
curl -s "http://127.0.0.1:9876/tabs?token=$APITOKEN"
```

token 存在 `~/.openclaw/chrome-bridge/config.json`，bridge 重启后不变。

免鉴权端点：`/status`、`/config`、`/pair/challenge`、`/pair/revoke`、`/token`（仅本机）。

---

## 重要：实际调用方式

CloudHand 通过 HTTP bridge 运行在 `http://127.0.0.1:9876`，**没有独立工具函数**。
所有操作都用 `exec` + `curl` 调用。SKILL.md 里的「工具名」只是概念描述，实际执行见下方。

## 支持的端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/status` | GET | 检查连接状态 |
| `/tabs` | GET | 列出所有标签页 |
| `/page_info` | GET | 当前页面标题/URL |
| `/snapshot` | GET | 页面快照JSON：url/title/interactive元素列表（含selector），**首选操作方式** |
| `/pair/challenge` | POST | 生成配对验证码 |
| `/navigate` | POST | 导航到 URL |
| `/screenshot` | POST | 截图（返回 base64）|
| `/click` | POST | 点击元素 |
| `/type` | POST | 输入文字 |
| `/key` | POST | 按键 |
| `/scroll` | POST | 滚动 |
| `/eval` | POST | 执行任意 JS |
| `/get_text` | POST | 获取页面文字 |
| `/get_html` | POST | 获取页面 HTML |
| `/find_elements` | POST | 查找元素 |
| `/go_back` | POST | 后退 |
| `/go_forward` | POST | 前进 |
| `/select` | POST | 下拉框选择 |
| `/set_value` | POST | 设置输入值 |
| `/get_browser_state` | POST | **🆕 读取页面所有可交互元素（UI树），返回带索引的元素列表** |
| `/click_element` | POST | **🆕 按UI树索引点击元素** |
| `/input_text_element` | POST | **🆕 按UI树索引输入文字** |
| `/ping_page_controller` | POST | 检查 page_controller 是否已注入 |
| `/debug_dom` | POST | 诊断 domTree 状态（调试用）|

---

## 🤖 UI树操作（推荐！像人一样操作页面）

**v2.4.4+ 新功能**：读取页面 DOM 树，获取所有可交互元素的索引，按索引点击/输入，无需 CSS 选择器。

### 标准流程

```python
import requests, time
APITOKEN = requests.get('http://127.0.0.1:9876/token').json()['apiToken']
H = {'Authorization': f'Bearer {APITOKEN}'}

# 1. 导航到页面
requests.post('http://127.0.0.1:9876/navigate', headers=H, json={'url': 'https://example.com', 'tabId': tid})
time.sleep(3)  # 等页面加载

# 2. 读取页面所有可交互元素
state = requests.post('http://127.0.0.1:9876/get_browser_state', headers=H, json={'tabId': tid}).json()
content = state['result']['content']  # 格式: [1]<input placeholder="搜索">  [2]<a>登录</a> ...
print(content)  # AI 看元素列表，决定点哪个

# 3. 点击某个元素（按索引）
requests.post('http://127.0.0.1:9876/click_element', headers=H, json={'tabId': tid, 'index': 2})

# 4. 输入文字（按索引）
requests.post('http://127.0.0.1:9876/input_text_element', headers=H, json={'tabId': tid, 'index': 1, 'text': '搜索关键词'})
```

### React Select / 复杂下拉框的点击方法

普通 click 无法展开 React Select，必须发完整鼠标事件链：

```python
# 展开并选择某选项（一气呵成，不切换 world）
script = """
(function(){
  var ctrl = document.querySelector('.cs-select-pro__control');  // 换成实际选择器
  ['mouseover','mouseenter','mousemove','mousedown','mouseup','click'].forEach(function(t){
    ctrl.dispatchEvent(new MouseEvent(t, {bubbles:true, cancelable:true, view:window}));
  });
  return new Promise(function(resolve){
    setTimeout(function(){
      var all = document.querySelectorAll('*');
      for(var el of all){
        if(el.children.length===0 && (el.innerText||'').trim()==='目标选项文字'){
          el.click(); resolve('clicked');
          return;
        }
      }
      resolve('not found');
    }, 150);
  });
})()
"""
requests.post('http://127.0.0.1:9876/eval', headers=H, json={'tabId': tid, 'expression': script})
```

### ⚠️ 注意事项
- `get_browser_state` 每次调用都会重新扫描 DOM，索引会变化，点击前必须重新获取
- 如果 `elementCount: 0`，说明 page_controller 未注入，用 `ping_page_controller` 检查
- **React Select 下拉**：必须用完整鼠标事件链展开（见上方代码），不要绕道 URL 参数
- **对话式操作**：读状态 → AI 决策 → 点击/输入 → 再读状态 → 循环，完全模拟人操作

---

## 🎯 smart_locate（语义定位，推荐优先使用）

**v2.4.5+ 新功能**：用自然语言描述意图，自动找到最匹配的元素并返回 browser_state 索引，无需扫描全部元素。

```python
# 语义定位：找搜索框
r = requests.post('http://127.0.0.1:9876/smart_locate', headers=H, json={
    'tabId': tid,
    'intent': '搜索'  # 支持：搜索 / 按钮 / 登录 / 输入 / 链接 / 空字符串(返回所有关键元素)
}).json()

for m in r['matches']:
    idx = m.get('browserStateIndex')  # 可直接用于 click_element / input_text_element
    print(f"[{idx}] {m['type']} | {m.get('placeholder') or m.get('text') or m.get('id')}")

# 拿到索引直接点击/输入
requests.post('http://127.0.0.1:9876/input_text_element', headers=H,
    json={'tabId': tid, 'index': r['matches'][0]['browserStateIndex'], 'text': '关键词'})
```

**支持的 intent：**
- `搜索` / `search` → 找搜索框（input）
- `按钮` / `button` → 找主要按钮
- `登录` / `login` → 找登录相关元素
- `输入` / `input` → 找所有输入框
- `链接` / `link` → 找主要导航链接
- `内容` / `content` → 找主内容区域
- `''`（空字符串）→ 返回所有关键元素概览

**比 get_browser_state 快的原因：** 不返回 500 个元素，只返回最匹配的 5 个，AI 无需扫描。

---

## 标准流程（可直接复用的 curl 命令）

### 1. 检查连接
```bash
curl -s http://127.0.0.1:9876/status
# 返回: {"connected":true,"paired":true,...}
# connected=false 时需要配对
```

### 2. 配对（未连接时）
```bash
curl -s -X POST http://127.0.0.1:9876/pair/challenge
# 返回验证码，发给用户在 Chrome 扩展中输入
```

### 3. 导航到网页
```bash
curl -s -X POST http://127.0.0.1:9876/navigate \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.example.com"}'
```

### 4. 点击元素
```bash
curl -s -X POST http://127.0.0.1:9876/click \
  -H 'Content-Type: application/json' \
  -d '{"selector":"#button-id"}'
```

### 5. 输入文字
```bash
curl -s -X POST http://127.0.0.1:9876/type \
  -H 'Content-Type: application/json' \
  -d '{"text":"要输入的内容"}'
```

### 6. 按键
```bash
curl -s -X POST http://127.0.0.1:9876/key \
  -H 'Content-Type: application/json' \
  -d '{"key":"Enter"}'
```

### 7. 截图保存
```bash
# 截图保存到文件（⚠️ 只在用户明确说「截图」时才截！）
curl -s -X POST http://127.0.0.1:9876/screenshot \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $APITOKEN" \
  -d '{"tabId": <tabId>}' | python3 -c "
import sys, json, base64
obj = json.loads(sys.stdin.read())
b64 = obj['result'].split(',')[1]
with open('/tmp/cloudhand_shot.png','wb') as f:
    f.write(base64.b64decode(b64))
print('saved to /tmp/cloudhand_shot.png')
"
# 截图后通过 OpenClaw 当前对话渠道发给用户（不要硬编码渠道或用户ID）
```

### 8. 执行 JS（找不到元素时用）
```bash
curl -s -X POST http://127.0.0.1:9876/eval \
  -H 'Content-Type: application/json' \
  -d '{"expression":"document.title"}'

# 点击某个按钮
curl -s -X POST http://127.0.0.1:9876/eval \
  -H 'Content-Type: application/json' \
  -d '{"expression":"document.querySelector(\"#btn\").click()"}'
```

## 快速测试流程（完整示例）

当用户说「测试 CloudHand」、「测试浏览器」时，直接执行：

```bash
# 1. 检查连接
curl -s http://127.0.0.1:9876/status

# 2. 打开 Bing
curl -s -X POST http://127.0.0.1:9876/navigate \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.bing.com"}'

# 3. 点击搜索框
curl -s -X POST http://127.0.0.1:9876/click \
  -H 'Content-Type: application/json' \
  -d '{"selector":"#sb_form_q"}'

# 4. 输入搜索词
curl -s -X POST http://127.0.0.1:9876/type \
  -H 'Content-Type: application/json' \
  -d '{"text":"www.dabeizi.com"}'

# 5. 回车搜索
curl -s -X POST http://127.0.0.1:9876/key \
  -H 'Content-Type: application/json' \
  -d '{"key":"Enter"}'

# 6. 等待加载后截图
sleep 2
# 然后执行截图+发飞书（见第7步）
```

## 常见问题

| 问题 | 解决 |
|------|------|
| `connected=false` | 执行 `/pair/challenge` → 把验证码发给用户在扩展输入 |
| 点击无效 | 改用 `/eval` 直接执行 JS click |
| 页面未加载完 | `sleep 2` 后再操作 |
| 截图空白 | 重试一次 |
| `Unknown command` | 检查端点名是否正确，参考上方端点表 |

## 🛡️ 窗口管理铁律（必须遵守）

**原则：我有一个专属窗口，所有任务在里面开新 tab，不新开窗口。**

```bash
# 查看我管理的窗口
curl -s -H "Authorization: Bearer $APITOKEN" http://127.0.0.1:9876/agent_windows

# 如果 windowIds 为空，先开一个专属窗口（只做一次）
curl -s -X POST http://127.0.0.1:9876/new_window \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $APITOKEN" \
  -d '{"url":"about:blank","focused":false}'
# 记录返回的 windowId 到 TOOLS.md

# 每次新任务：在专属窗口开新 tab（不要 new_window！）
AGENT_WINDOW_ID=$(curl -s -H "Authorization: Bearer $APITOKEN" http://127.0.0.1:9876/agent_windows | python3 -c "import sys,json; ids=json.load(sys.stdin)['windowIds']; print(ids[0] if ids else '')")
curl -s -X POST http://127.0.0.1:9876/new_tab \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $APITOKEN" \
  -d "{\"windowId\":$AGENT_WINDOW_ID}"

# 关闭所有我的窗口（用户要求时）
curl -s -X POST http://127.0.0.1:9876/agent_windows/close_all
```

**例外**：用户明确说「开新窗口」时才用 `new_window`。

## 标准操作前置脚本（必用，替代硬编码 windowId）

每次操作浏览器前，先用这段脚本动态获取/创建专属窗口，再在里面开 tab：

```bash
# 获取 agent 专属窗口（没有则自动新开）
AGENT_WIN=$(curl -s http://127.0.0.1:9876/agent_windows | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(d['windowIds'][0] if d['windowIds'] else '')
")

if [ -z "$AGENT_WIN" ]; then
  AGENT_WIN=$(curl -s -X POST http://127.0.0.1:9876/new_window \
    -H 'Content-Type: application/json' -d '{"url":"about:blank"}' | \
    python3 -c "import sys,json; print(json.load(sys.stdin)['result']['windowId'])")
fi

# 在专属窗口开新 tab
TAB_ID=$(curl -s -X POST http://127.0.0.1:9876/new_tab \
  -H 'Content-Type: application/json' \
  -d "{\"windowId\":$AGENT_WIN}" | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['result']['tabId'])")

# 然后正常 navigate
curl -s -X POST http://127.0.0.1:9876/navigate \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'
```

**禁止硬编码 windowId！永远用上面的动态脚本。**

---

## 🚀 新增高效 API（v1.1.0）

### 1. `/snapshot_ai` — AI优化快照（推荐替代 get_browser_state）

返回**稳定 ref + 纯文本树**，token 消耗比 `get_browser_state` 少 80%。

```bash
curl -s -X POST http://127.0.0.1:9876/snapshot_ai \
  -H "Authorization: Bearer $APITOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"tabId\":$TAB_ID}"
```

返回格式：
```json
{
  "ok": true,
  "result": {
    "url": "https://...",
    "title": "页面标题",
    "text": "[e1] button: 搜索\n[e2] textbox: 关键词 (placeholder: 请输入)\n[e3] link: 最新资讯",
    "refs": [
      {"ref": "e1", "role": "button", "name": "搜索", "selector": "#su"},
      {"ref": "e2", "role": "textbox", "placeholder": "请输入", "selector": "#kw"}
    ]
  }
}
```

**使用方式：**
1. 调 `/snapshot_ai` 读取页面，AI 从 `text` 里找目标元素的 `ref`（如 `e2`）
2. 用 ref 对应的 `selector` 调 `click_element` 或 `input_text_element`

**ref 生成优先级：** `data-e2e` → `data-testid` → `id` → `name` → `aria-label` → `placeholder` → 位置哈希

---

### 2. `/fill_batch` — 批量填表单（减少 66% 请求数）

一次请求填多个字段，适合登录页、注册页、搜索表单。

```bash
curl -s -X POST http://127.0.0.1:9876/fill_batch \
  -H "Authorization: Bearer $APITOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "tabId": 123,
    "fields": [
      {"selector": "#username", "value": "user@example.com"},
      {"selector": "#password", "value": "secret123"},
      {"selector": "input[name=remember]", "checked": true}
    ]
  }'
```

- 支持 `value`（文本输入）和 `checked`（checkbox/radio）
- 返回每个字段的操作结果

---

### 3. `/wait_for_text` — 条件等待（替代 sleep）

等待页面出现特定文字，比固定 `sleep` 节省 30-50% 等待时间。

```bash
curl -s -X POST http://127.0.0.1:9876/wait_for_text \
  -H "Authorization: Bearer $APITOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tabId": 123, "text": "加载完成", "timeout": 10000}'
```

- `timeout`：最长等待毫秒数（默认 10000ms）
- 页面出现该文字后立即返回 `{ok: true, elapsed: 1234}`
- 超时返回 `{ok: false, error: "timeout"}`

---

---

### 4. `get_ax_tree` — Accessibility Tree（AI语义理解，v2.4.6新增）

获取页面无障碍树，比 HTML DOM 节省 70% token，AI 理解更精准。

```bash
curl -s -X POST http://127.0.0.1:9876/command \
  -H "Authorization: Bearer $APITOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tabId": 123, "command": "get_ax_tree", "params": {"compact": true}}'
```

返回紧凑文本格式（compact=true，默认）：
```
heading "知乎 - 与世界分享你的知识"
@1 searchbox "搜索"
@2 button "搜索"
link "首页"
@3 button "提问"
...
```

- `@N` 前缀 = 可交互元素，可直接用 `click` 的 ref
- `compact: false` 返回原始 JSON 节点数组
- 适合：页面结构分析、找按钮/输入框、理解页面内容

---

### 5. `fetch_with_cookies` — 带登录态HTTP请求（v2.4.6新增）

直接用当前 tab 的登录 cookie 发 HTTP 请求，比操作 DOM 快10倍，适合调用网站内部 API。

```bash
curl -s -X POST http://127.0.0.1:9876/command \
  -H "Authorization: Bearer $APITOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "tabId": 123,
    "command": "fetch_with_cookies",
    "params": {
      "url": "https://www.zhihu.com/api/v4/questions/123/answers",
      "method": "GET",
      "headers": {"Accept": "application/json"}
    }
  }'
```

- 自动带上当前 tab 域名的所有 cookie（登录态）
- 支持 GET/POST/PUT，支持自定义 headers 和 body
- 返回 `{status, headers, body, bodyText}`
- **最佳场景**：知乎/B站/微博等已登录网站的数据抓取，无需模拟点击

---

## 📋 推荐操作流程（v1.1.0 最佳实践）

```
1. 获取/创建 agent 窗口
2. new_tab → navigate → wait_for_text（等页面关键词出现）
3. snapshot_ai → AI 读 text 字段，选目标 ref → 取 selector
4. click / fill_batch（用 selector 操作）
5. 任务完成 → 清理 tab
```

**旧流程（仍然有效但较慢）：**
```
navigate → sleep(3) → get_browser_state → AI 选索引 → click_element
```

---

## 🆕 v2.5.0 新增功能

### 6. `cdp_click` — CDP 真实鼠标点击（绕过反bot检测）

用 Chrome DevTools Protocol 模拟真实鼠标事件序列（mouseMoved → mousePressed → mouseReleased），绕过检测 `isTrusted` 的反机器人防护。

```bash
curl -s -X POST http://127.0.0.1:9876/command \
  -H "Authorization: Bearer $APITOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tabId": 123, "command": "cdp_click", "params": {"selector": "#submit-btn"}}'
```

参数：
- `selector`：CSS 选择器（优先）
- `x` / `y`：坐标（selector 找不到时用坐标）

返回：`{ok: true, x: 123, y: 456}`

**适用场景**：微博/抖音/知乎等检测 `isTrusted` 的按钮点击，普通 `click` 失效时换这个。

---

### 7. `cdp_type` — CDP 真实键盘输入（逐键模拟）

逐字符模拟真实键盘 keyDown/char/keyUp 事件，绕过反机器人输入检测。

```bash
curl -s -X POST http://127.0.0.1:9876/command \
  -H "Authorization: Bearer $APITOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tabId": 123, "command": "cdp_type", "params": {"selector": "input[name=search]", "text": "hello world", "delay": 50}}'
```

参数：
- `selector`：先 focus 该元素再输入
- `text`：要输入的文字
- `delay`：每个字符间隔毫秒（默认 30ms，模拟人工输入速度）

**适用场景**：搜索框、登录表单等有输入防检测的站点。

---

### 8. `network_capture` — 抓取网络请求

监听页面指定时间段内的所有网络请求（URL + 状态码 + 响应体）。

```bash
curl -s -X POST http://127.0.0.1:9876/command \
  -H "Authorization: Bearer $APITOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tabId": 123, "command": "network_capture", "params": {"waitMs": 3000, "filter": "api"}}'
```

参数：
- `waitMs`：监听时长（毫秒，默认 3000，最大 15000）
- `filter`：URL 过滤关键词（可选，如 `"api"` 只捕获含 api 的请求）

返回：`{ok: true, count: 5, requests: [{url, method, status, body}...]}`

**适用场景**：
- 发现网站内部 API 端点（配合 `fetch_with_cookies` 直接调用）
- 调试页面加载问题
- 抓取 XHR/Fetch 请求的响应数据

---

### 9. `console_capture` — 捕获 Console 日志和 JS 错误

监听页面指定时间段内的所有 console 输出和 JS 异常。

```bash
curl -s -X POST http://127.0.0.1:9876/command \
  -H "Authorization: Bearer $APITOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tabId": 123, "command": "console_capture", "params": {"waitMs": 2000}}'
```

参数：
- `waitMs`：监听时长（毫秒，默认 2000）

返回：`{ok: true, count: 3, logs: [{type: "log"|"error"|"warn", args: [...], timestamp}...]}`

**适用场景**：
- 调试页面 JS 错误
- 捕获网站通过 console 输出的数据
- 验证操作是否触发了预期的 JS 逻辑

---

### 10. `/version` — 版本检查端点

```bash
curl -s http://127.0.0.1:9876/version
# 返回: {"version": "2.5.0", "ok": true}
```

扩展也会定期调用此端点检查是否有新版本可用，options 页右下角显示版本号，点击可触发版本检查。

---

## 📊 v2.5.0 完整命令速查表

| 命令 | 说明 | 版本 |
|------|------|------|
| `navigate` | 导航到 URL | v1.0 |
| `screenshot` | 截图（base64） | v1.0 |
| `get_html` | 获取页面 HTML | v1.0 |
| `get_text` | 获取页面文本 | v1.0 |
| `click` | JS 点击（selector/index） | v1.0 |
| `type` | JS 输入文字 | v1.0 |
| `set_value` | 直接设置 input value | v1.0 |
| `key` | 发送按键（Enter/Tab等） | v1.0 |
| `hotkey` | 发送组合键 | v1.0 |
| `scroll` | 滚动页面 | v1.0 |
| `hover` | 鼠标悬停 | v1.0 |
| `select` | 选择 select 元素 | v1.0 |
| `wait_for` | 等待元素出现 | v1.0 |
| `get_cookies` | 获取 Cookie | v1.0 |
| `close_tab` | 关闭 tab | v1.0 |
| `go_back` / `go_forward` | 前进/后退 | v1.0 |
| `eval` | 执行 JS 表达式 | v1.0 |
| `find_elements` | 查找元素列表 | v1.0 |
| `page_info` | 页面基本信息 | v1.0 |
| `get_browser_state` | 浏览器状态（旧版） | v1.0 |
| `click_element` | 点击元素（旧版） | v1.0 |
| `input_text_element` | 输入文字（旧版） | v1.0 |
| `get_ax_tree` | Accessibility Tree | v2.4.6 |
| `fetch_with_cookies` | 带登录态 HTTP 请求 | v2.4.6 |
| `cdp_click` | CDP 真实鼠标点击 | v2.5.0 |
| `cdp_type` | CDP 真实键盘输入 | v2.5.0 |
| `network_capture` | 抓取网络请求 | v2.5.0 |
| `console_capture` | 捕获 Console 日志 | v2.5.0 |
