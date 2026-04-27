# CloudHand (云手)

> High-speed Chrome control for AI agents (Local/Remote).

[![Version](https://img.shields.io/badge/version-2.7.0-blue.svg)](https://github.com/vrcms/openclaw-cloudhand)
[![OpenClaw Plugin](https://img.shields.io/badge/openclaw-plugin-orange.svg)](https://openclaw.ai)

English | **[中文文档](README.zh.md)**

## What is CloudHand?

CloudHand is a bridge between AI agents and your Chrome browser. It features a **Dual-Mode Parallel Architecture**:

1. **Remote Mode**: Connects to a remote OpenClaw AI assistant on a VPS.
2. **Local Mode (New)**: Connects to local AI agents (e.g., Claude Code, Gemini, Qwen).

## 🌟 Key Features (v2.7.0)

- **Dual-Mode Parallel**: Simultaneous control from local and remote AI agents.
- **CLI Commander**: Built-in `ch.js` tool supporting semantic chaining (e.g., `type {search_box} hello`).
- **Self-Learning Knowledge Base**: Automatically builds site-specific landmarks in `./.data-browser-knowledge/`.
- **Expert APIs**: Native support for Playwright-powered `snapshot` and unified `act` interface.
- **Secure Connection**: Token-based authentication replacing the old 6-digit pairing code mechanism.

---

## 🛠️ Expert CLI Tool (ch.js)

CloudHand includes a powerful CLI tool `cloudhand-bridge/ch.js` to simplify AI interactions:

```bash
# 1. Get semantic snapshot (Playwright ariaSnapshot)
node cloudhand-bridge/ch snapshot

# 2. Interact via ref (e.g., type into search box and submit)
node cloudhand-bridge/ch act type e12 "openclaw" --submit

# 3. Take a screenshot with labeled interactive elements
node cloudhand-bridge/ch screenshot_labels
```

---

## 📦 Installation & Setup

Choose the scenario that fits your needs:

### Scenario A: Remote VPS Mode (For OpenClaw Users)
1. **One-click Install on VPS**:
   ```bash
   bash <(curl -fsSL https://raw.githubusercontent.com/vrcms/openclaw-cloudhand/main/cloudhand-bridge/install.sh)
   ```
2. **Setup**: Follow the "Chrome Extension Setup" section below.

### Scenario B: Local Mode (For Local AI Agents)
1. **Get Code**: `git clone` this repository.
2. **Start Bridge**: Double-click `cloudhand-bridge/start-local.bat`.
3. **AI Setup**: Provide the `./ai-skills/cloudhand-local` directory to your AI agent.

---

## 🧩 Chrome Extension Setup (Common Step)

The CloudHand extension is required for both operating modes.

1. **Get Extension:**
   - **Remote Mode**: The extension zip is automatically generated at `~/.openclaw/extensions/cloudhand/extension.zip` upon installation.
   - **Local Mode**: Use the `extension/` folder in this repository.

2. **Load in Chrome:**
   - Open Chrome and navigate to `chrome://extensions/`.
   - Enable **"Developer mode"** in the top right corner.
   - Click **"Load unpacked"** and select the unzipped `extension` folder.

3. **Connect to Bridge:**
   - Click the CloudHand icon in your Chrome toolbar.
   - Connect using your WebSocket URL with your token (e.g., `ws://127.0.0.1:9876/ws?token=local-mode-token` for local mode).
   - The status will change to **"Connected"**.

> 💡 **Pro Tip**: The extension automatically saves your connection URL. Local mode uses the built-in `local-mode-token`.

---

## Core APIs

| Endpoint | Method | Description |
|------|------|------|
| `/status` | GET | Check dual-mode connection status |
| `/list_tabs` | GET | List all known browser tabs |
| `/ensure_tab` | POST | Get/Create a dedicated agent tab |
| `/navigate` | POST | Navigate to target URL |
| `/snapshot` | POST | ⭐ Get Playwright ariaSnapshot with `ref` IDs |
| `/act` | POST | ⭐ Interact with elements via `ref` (click/type/etc) |
| `/screenshot_with_labels`| POST | Screenshot with interactive element borders |
| `/get_page_info` | GET/POST | Get current page URL and title |
| `/cdp` | POST | Passthrough arbitrary CDP commands |
| `/eval` | POST | Execute custom JavaScript |

## Development

```bash
# Install deps
npm install

# Run bridge (Local Mode)
node cloudhand-bridge/server.js --local

# Test commands
node cloudhand-bridge/ch help
```

## License
MIT
