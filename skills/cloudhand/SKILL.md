---
name: cloudhand
description: |
  控制用户本地 Chrome 浏览器。当用户要求打开网页、截图、点击、输入、操作浏览器时使用。
  Use when: (1) 用户要打开/访问某个网址，(2) 需要截图当前页面，(3) 需要在浏览器中点击/输入/操作，
  (4) 用户说「帮我连接浏览器」，(5) 需要在登录状态下访问网站（利用用户已有的 Cookie）。
  NOT for: 服务端抓取（用 web/firecrawl），不需要真实浏览器的场景。
---

# CloudHand - 控制本地 Chrome

## 🚨 行为规范（必读，违反=出 bug）

1. **查「用户在看什么」→ 用 `/tabs`，绝不用截图**
   ```bash
   curl -s http://127.0.0.1:9876/tabs | python3 /tmp/list_tabs.py
   # list_tabs.py 内容：
   # import sys,json; d=json.load(sys.stdin); tabs=d.get('result',[])
   # for t in tabs: print('🟢' if t.get('active') else '⚪', t.get('id'), t.get('title','')[:40], t.get('url','')[:60])
   ```

2. **绝不操作用户自己的窗口**
   - bridge 启动后 agentWindows 为空时，navigate 等操作会自动创建专属窗口（server.js 已内置）
   - 每次操作前先 `curl -s http://127.0.0.1:9876/agent_windows` 确认有专属窗口
   - 没有专属窗口 → server.js 自动在后台创建 `about:blank` 窗口，不打扰用户

3. **bridge 重启后配对还在，不需要重新配对**
   - 重启命令：`lsof -ti:9876 | xargs kill -9; cd ~/.openclaw/extensions/cloudhand && nohup node server.js > /tmp/cloudhand.log 2>&1 &`
   - 重启后 agentWindows 清空，但 session token 持久化在 `~/.openclaw/chrome-bridge/config.json`

4. **截图只在用户明确要求「截图」时才用**
   - 读取页面内容用 `/get_text` 或 `/get_html`，更快更省
   - 截图会发送大量 base64 数据，消耗 token

5. **操作顺序**：检查连接 → 确认/创建专属窗口 → 在专属窗口 navigate → 操作

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

### 7. 截图并发送（飞书渠道）
```bash
# 截图保存到文件
curl -s -X POST http://127.0.0.1:9876/screenshot \
  -H 'Content-Type: application/json' \
  -d '{}' | python3 -c "
import sys, json, base64
obj = json.loads(sys.stdin.read())
b64 = obj['result'].split(',')[1]
with open('/tmp/cloudhand_shot.png','wb') as f:
    f.write(base64.b64decode(b64))
print('saved')
"

# 获取 tenant_access_token
APP_ID=$(cat ~/.openclaw/openclaw.json | python3 -c "import sys,json; print(json.load(sys.stdin)['channels']['feishu']['appId'])")
APP_SECRET=$(cat ~/.openclaw/openclaw.json | python3 -c "import sys,json; print(json.load(sys.stdin)['channels']['feishu']['appSecret'])")
TOKEN=$(curl -s -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
  -H 'Content-Type: application/json' \
  -d "{\"app_id\":\"$APP_ID\",\"app_secret\":\"$APP_SECRET\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['tenant_access_token'])")

# 上传图片
IMAGE_KEY=$(curl -s -X POST 'https://open.feishu.cn/open-apis/im/v1/images' \
  -H "Authorization: Bearer $TOKEN" \
  -F 'image_type=message' \
  -F 'image=@/tmp/cloudhand_shot.png' | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['image_key'])")

# 发送图片消息
curl -s -X POST 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"receive_id\":\"<用户 open_id>\",\"msg_type\":\"image\",\"content\":\"{\\\"image_key\\\":\\\"$IMAGE_KEY\\\"}\"}" 
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

## 窗口管理策略（重要）

**原则：我有一个专属窗口，所有任务在里面开新 tab，不新开窗口。**

```bash
# 查看我管理的窗口
curl -s http://127.0.0.1:9876/agent_windows

# 如果 windowIds 为空，先开一个专属窗口（只做一次）
curl -s -X POST http://127.0.0.1:9876/new_window -H 'Content-Type: application/json' -d '{}'
# 记录返回的 windowId 到 TOOLS.md

# 每次新任务：在专属窗口开新 tab（不要 new_window！）
AGENT_WINDOW_ID=$(curl -s http://127.0.0.1:9876/agent_windows | python3 -c "import sys,json; ids=json.load(sys.stdin)['windowIds']; print(ids[0] if ids else '')")
curl -s -X POST http://127.0.0.1:9876/new_tab \
  -H 'Content-Type: application/json' \
  -d "{\"windowId\":$AGENT_WINDOW_ID}"

# 关闭所有我的窗口（东哥要求时）
curl -s -X POST http://127.0.0.1:9876/agent_windows/close_all
```

**例外**：东哥明确说「开新窗口」时才用 `new_window`。

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
