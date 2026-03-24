# CloudHand (云手)

> Control your local Chrome browser from a remote OpenClaw AI agent.

[![Version](https://img.shields.io/badge/version-2.1.0-blue.svg)](https://github.com/vrcms/openclaw-cloudhand)
[![OpenClaw Plugin](https://img.shields.io/badge/openclaw-plugin-orange.svg)](https://openclaw.ai)

## What is CloudHand?

CloudHand is an OpenClaw plugin that bridges your remote AI agent (running on a VPS) to your local Chrome browser. It lets the AI:

- Navigate to any URL
- Take screenshots
- Click elements, type text, press keys
- Execute arbitrary JavaScript (`eval`)
- Read page content and find elements
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

1. Download the extension ZIP from your VPS:
   ```
   http://YOUR_VPS_IP:9876/extension.zip
   ```
   Or from: [Releases](https://github.com/vrcms/openclaw-cloudhand/releases)

2. Unzip and load in Chrome:
   - Open `chrome://extensions/`
   - Enable **Developer mode**
   - Click **Load unpacked** → select the `extension/` folder

3. Configure the extension:
   - Click the CloudHand icon
   - Enter your VPS address (e.g. `149.13.91.10:9876`)
   - Click **Connect**

4. Pair with the AI:
   - Tell your AI: "帮我连接浏览器" (or "pair cloudhand")
   - The AI will generate a 6-digit code
   - Enter the code in the extension popup

## Available AI Tools

| Tool | Description |
|------|-------------|
| `cloudhand_status` | Check connection status |
| `cloudhand_pair` | Generate pairing code |
| `cloudhand_tabs` | List all open tabs |
| `cloudhand_navigate` | Navigate to a URL |
| `cloudhand_screenshot` | Take a screenshot (returns file path + base64) |
| `cloudhand_click` | Click an element (by selector or text) |
| `cloudhand_type` | Type text into an element |
| `cloudhand_key` | Press a key (Enter, Tab, Escape, etc.) |
| `cloudhand_find` | Find elements by CSS selector |
| `cloudhand_get_text` | Get page text content |
| `cloudhand_scroll` | Scroll the page |
| `cloudhand_eval` | Execute arbitrary JavaScript (uses chrome.debugger, bypasses CSP) |
| `cloudhand_go_back` | Navigate back |
| `cloudhand_go_forward` | Navigate forward |
| `cloudhand_page_info` | Get current page title and URL |

## Plugin Config

In your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "entries": {
      "cloudhand": {
        "enabled": true,
        "config": {
          "port": 9876,
          "autoStart": true
        }
      }
    }
  }
}
```

## Security

- **Pairing codes** are 6-digit, expire in 30 seconds, single-use
- **Session tokens** are 128-bit random, stored in Chrome extension storage
- **All WebSocket connections** require a valid session token
- The bridge server listens on `0.0.0.0:9876` — consider firewall rules if needed

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
