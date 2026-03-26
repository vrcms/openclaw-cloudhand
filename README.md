# CloudHand (云手)

> Control your local Chrome browser from a remote OpenClaw AI agent.

[![Version](https://img.shields.io/badge/version-2.4.6-blue.svg)](https://github.com/vrcms/openclaw-cloudhand)
[![OpenClaw Plugin](https://img.shields.io/badge/openclaw-plugin-orange.svg)](https://openclaw.ai)

English | **[中文文档](README.zh.md)**

## What is CloudHand?

CloudHand is an OpenClaw plugin that bridges your remote AI agent (running on a VPS) to your local Chrome browser. It lets the AI:

- Navigate to any URL
- Click elements, type text, press keys
- Execute arbitrary JavaScript (`eval`)
- Read page content with DOM tree (`get_browser_state`)
- **Smart element location** (`smart_locate`) — find elements by intent, no full DOM scan
- **Ensure usable tab** (`ensure_tab`) — safely get a workable tab without opening extra windows
- Control tabs, scroll, go back/forward

This is especially useful when you need the AI to access websites that require login, bypass anti-bot measures, or interact with complex web UIs.

## Architecture

```
┌─────────────────────┐         ┌──────────────────────────┐
│   VPS (OpenClaw)    │         │   Your Computer          │
│                     │         │                          │
│  AI Agent           │         │  Chrome Browser          │
│     ↓               │         │     ↑                    │
│  cloudhand_*        │ ←WS──→  │  CloudHand Extension     │
│  tools              │  9876   │  (Chrome Extension MV3)  │
│     ↓               │         │                          │
│  Bridge Server      │         └──────────────────────────┘
│  (server.js)        │
└─────────────────────┘
```

The Chrome extension **connects outbound** to your VPS — no port forwarding needed on your local machine.

## Installation

### VPS Side (one command)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/vrcms/openclaw-cloudhand/main/install.sh)
```

This will:
1. Install the plugin to `~/.openclaw/extensions/cloudhand/`
2. Install npm dependencies
3. Register the plugin with OpenClaw
4. Restart the Gateway

### Chrome Extension

1. **Get a secure download link from your AI agent:**

   Ask the agent: "给我云手的下载链接" ("Give me the CloudHand download link")

   The agent will generate a one-time link valid for **120 seconds**:
   ```
   http://YOUR_VPS_IP:9876/download-ext?t=<token>
   ```
   > ⚠️ The link expires in 120 seconds. Download immediately.

2. Unzip and load in Chrome:
   - Open `chrome://extensions/`
   - Enable **Developer mode**
   - Click **Load unpacked** → select the `extension/` folder
   - (The extension includes `config.js` with your VPS IP pre-configured)

3. **Pair with your AI agent:**

   Ask the agent: "给我云手的配对码" ("Give me the pairing code")

   A 6-digit code will appear, valid for **120 seconds**. Enter it in the extension popup.

## Key Features

### DOM Tree Navigation

Get a structured, interactive element tree of the current page:

```python
# Get browser state (interactive elements with indices)
state = requests.post('http://VPS:9876/get_browser_state', headers=H, json={'tabId': tid}).json()
# Returns: [1]<button>Search</button>  [2]<input placeholder="keyword">

# Click by index
requests.post('http://VPS:9876/click_element', headers=H, json={'tabId': tid, 'index': 2})

# Type by index
requests.post('http://VPS:9876/input_text_element', headers=H, json={'tabId': tid, 'index': 2, 'text': 'openclaw'})
```

### Smart Locate (v2.4.5+)

Find elements by natural language intent — no full DOM scan needed:

```python
# Find search box
r = requests.post('http://VPS:9876/smart_locate', headers=H, json={
    'tabId': tid,
    'intent': '搜索'  # or: 按钮 / 登录 / 输入 / 链接 / 内容 / '' (all key elements)
}).json()
idx = r['matches'][0]['browserStateIndex']  # Use directly with click_element
```

Supported intents: `搜索/search`, `按钮/button`, `登录/login`, `输入/input`, `链接/link`, `内容/content`, `''` (overview)

### Ensure Tab (v2.4.6+)

Safely get a usable agent tab — works with BitBrowser and other non-standard environments:

```python
# Always use this instead of new_tab/new_window
r = requests.post('http://VPS:9876/ensure_tab', headers=H, json={}).json()
tid = r['tabId']  # Guaranteed to be a usable tab
# If it's a browser internal page, navigate first then reuse this tid
```

Logic: reuse existing agent tab → open new tab in existing window → only create new window if no agent window exists.

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/status` | GET | Bridge status (paired, version, tabId) |
| `/pair/challenge` | POST | Generate 6-digit pairing code (120s) |
| `/agent_windows` | GET | List agent-owned window IDs |
| `/ensure_tab` | POST | Get/create a usable agent tab |
| `/tabs` | GET | List all open tabs |
| `/navigate` | POST | Navigate to URL |
| `/eval` | POST | Execute JavaScript |
| `/get_browser_state` | POST | Get DOM tree with interactive element indices |
| `/click_element` | POST | Click element by DOM index |
| `/input_text_element` | POST | Type into element by DOM index |
| `/smart_locate` | POST | Find elements by natural language intent |
| `/click` | POST | Click by CSS selector |
| `/type` | POST | Type text into element |
| `/scroll` | POST | Scroll page |
| `/go_back` | POST | Navigate back |
| `/go_forward` | POST | Navigate forward |
| `/page_info` | GET | Current page title and URL |
| `/focus_tab` | POST | Focus a specific tab |
| `/close_tab` | POST | Close a tab |
| `/new_tab` | POST | Open new tab in window |
| `/download-ext` | GET | One-time extension download (token required) |

## Security

- **Pairing codes** are 6-digit, expire in **120 seconds**, single-use, rate-limited
- **Download links** are one-time tokens, expire in **120 seconds**
- **Session tokens** are 128-bit random, stored in Chrome extension storage
- **Agent isolation**: the extension only tracks agent-created windows; user windows are never recorded
- Bearer token authentication on all API calls

## Development

```bash
# Clone
git clone https://github.com/vrcms/openclaw-cloudhand.git
cd openclaw-cloudhand

# Install deps
npm install

# Run bridge server directly
node server.js

# Load extension in Chrome (Developer mode → Load unpacked → extension/)
```

## License

MIT
