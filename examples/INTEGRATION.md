# 本地 AI 智能体集成指南 (Local Agent Integration)

云手 (CloudHand) 的本地模式允许本地运行的 AI 直接控制你的 Chrome 浏览器。以下是集成示例。

## 1. 基础流程

1. 启动本地 bridge：双击 `cloudhand-bridge/start-local.bat`。
2. 确保 Chrome 扩展已连接（图标显示为蓝色）。
3. 在你的代码中通过 HTTP API 调用 `127.0.0.1:9876`。

## 2. Python 示例

使用 `requests` 库调用：

```python
import requests
import time

# 1. 获取本地 API Token (仅限 127.0.0.1 调用)
resp = requests.get('http://127.0.0.1:9876/token')
token = resp.json()['apiToken']
headers = {'Authorization': f'Bearer {token}'}

# 2. 检查状态
status = requests.get('http://127.0.0.1:9876/status').json()
if status.get('mode') == 'local' and status.get('extensionConnected'):
    print("✅ 本地模式已就绪")

# 3. 打开网页
requests.post('http://127.0.0.1:9876/navigate', headers=headers, json={
    'url': 'https://www.bing.com'
})
time.sleep(2)

# 4. 截图并保存
shot_resp = requests.post('http://127.0.0.1:9876/screenshot', headers=headers).json()
if shot_resp.get('ok'):
    import base64
    img_data = base64.b64decode(shot_resp['result'].split(',')[1])
    with open('screenshot.png', 'wb') as f:
        f.write(img_data)
    print("📸 截图已保存为 screenshot.png")
```

## 3. JavaScript / Node.js 示例

```javascript
const axios = require('axios');

async function main() {
  // 1. 获取 Token
  const { data: { apiToken } } = await axios.get('http://127.0.0.1:9876/token');
  const client = axios.create({
    baseURL: 'http://127.0.0.1:9876',
    headers: { Authorization: `Bearer ${apiToken}` }
  });

  // 2. 导航
  await client.post('/navigate', { url: 'https://github.com' });
  console.log('已导航到 GitHub');

  // 3. 获取页面标题
  const { data: { result } } = await client.get('/page_info');
  console.log('页面标题:', result.title);
}

main().catch(console.error);
```

## 4. 智能体集成 (Claude Code / Qwen Code / Gemini CLI)

在这些智能体中，你可以通过执行 shell 命令的方式来间接控制浏览器。

### Gemini CLI 调用示例

如果你正在使用 Gemini CLI，可以让它通过 `run_shell_command` 来执行以下指令：

```bash
# 1. 检查连接状态
curl.exe -s http://127.0.0.1:9876/status

# 2. 导航到目标页面
curl.exe -s -X POST http://127.0.0.1:9876/navigate -H "Content-Type: application/json" -d "{\"url\":\"https://google.com\"}"

# 3. 截取屏幕并自动处理（结合 Python）
curl.exe -s -X POST http://127.0.0.1:9876/screenshot | python3 -c "import sys,json,base64; d=json.load(sys.stdin); print(d['result'].split(',')[1])" > shot.b64
```

### Claude / Qwen Code 调用示例

```bash
# 在终端直接执行
curl -s -X POST http://127.0.0.1:9876/navigate -d '{"url":"https://example.com"}'
```

由于本地模式免配对，你只需要确保 `server.js --local` 正在运行即可。
