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
- **Expert APIs**: Native support for `ensure_tab`, `smart_locate`, and CDP-based trusted clicks.
- **Pairing-Free**: Auto-detection for local mode — no 6-digit codes required.

---

## 🛠️ Expert CLI Tool (ch.js)

CloudHand includes a powerful CLI tool `cloudhand-bridge/ch.js` to simplify AI interactions:

```bash
# 1. Semantic Batch Mode (Recommended: Handles TabIDs & Locating automatically)
node cloudhand-bridge/ch batch "ensure_tab; navigate google.com; type {search_box} openclaw\n"

# 2. Quick Search (Direct access with retries and summarization)
node cloudhand-bridge/ch quick_search "https://www.google.com/search?q=openclaw"

# 3. Cognitive Learning (Extract page skeleton for AI analysis & archiving)
node cloudhand-bridge/ch learn
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

1. **Get Download Link:**
   - **Remote Mode**: Ask your AI assistant: "Give me the download link". It will generate a 120s temporary link: `http://YOUR_VPS:9876/download-ext?t=xxx`.
   - **Local Mode**: Simply use the `extension/` folder in this repository.

2. **Load in Chrome:**
   - Open Chrome and navigate to `chrome://extensions/`.
   - Enable **"Developer mode"** in the top right corner.
   - Click **"Load unpacked"** in the top left.
   - Select the **`extension`** folder from this project.

3. **Pair with AI (Remote Mode only):**
   - Ask your AI: "Give me the pairing code". You will receive a **6-digit code** (valid for 120s).
   - Click the CloudHand icon in your Chrome toolbar.
   - Enter the code and click **"Pair & Connect"**.
   - ✅ When the status changes to **"Connected"**, you are ready.

> 💡 **Pro Tip**: Pairing info is stored locally. You don't need to re-pair unless you reinstall the extension. Local mode auto-detects `127.0.0.1` and requires no pairing code.

---

## Core APIs

| Endpoint | Method | Description |
|------|------|------|
| `/status` | GET | Check dual-mode connection status |
| `/token` | GET | Get local API Token (127.0.0.1 only) |
| `/ensure_tab` | POST | Get/Create a dedicated agent tab |
| `/smart_locate` | POST | Locate elements by intent (e.g., "search box") |
| `/navigate` | POST | Navigate to target URL |
| `/get_browser_state` | POST | Get interactive element tree and indices |
| `/click_element` | POST | Click by index (Semantic: `click {target}`) |
| `/input_text_element` | POST | Input by index (Semantic: `type {target} text\n`) |
| `/get_ax_tree` | POST | Get full Accessibility Tree |
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
