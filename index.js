'use strict';

/**
 * CloudHand Plugin for OpenClaw
 * Registers agent tools to control local Chrome via WebSocket bridge.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');

const BRIDGE_PORT = 9876;
const BRIDGE_HOST = '127.0.0.1';
const BASE_URL = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;

let bridgeProcess = null;

function isBridgeRunning() {
  try {
    const res = execSync(`curl -sf ${BASE_URL}/status --max-time 2`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function startBridge(pluginDir) {
  if (isBridgeRunning()) {
    console.log('[cloudhand] Bridge already running');
    return;
  }
  const serverPath = path.join(pluginDir, 'server.js');
  bridgeProcess = spawn('node', [serverPath], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(BRIDGE_PORT) }
  });
  bridgeProcess.stdout.on('data', d => console.log('[cloudhand]', d.toString().trim()));
  bridgeProcess.stderr.on('data', d => console.error('[cloudhand]', d.toString().trim()));
  bridgeProcess.on('exit', code => console.log(`[cloudhand] Bridge exited: ${code}`));
  console.log(`[cloudhand] Bridge started (pid=${bridgeProcess.pid})`);
}

// HTTP helper to call bridge
function bridgeCall(method, path_, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: BRIDGE_HOST,
      port: BRIDGE_PORT,
      path: path_,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve({ raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function formatResult(r) {
  if (!r) return 'no response';
  if (r.result !== undefined) return typeof r.result === 'object' ? JSON.stringify(r.result) : String(r.result);
  return JSON.stringify(r);
}

// Tool definitions
const TOOLS = [
  {
    name: 'cloudhand_status',
    description: 'Check if CloudHand Chrome bridge is connected. Returns connection status and pairing info.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const r = await bridgeCall('GET', '/status');
      return JSON.stringify(r);
    }
  },
  {
    name: 'cloudhand_pair',
    description: 'Generate a 6-digit pairing code for the user to enter in the Chrome extension. Code expires in 30 seconds.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const r = await bridgeCall('POST', '/pair/challenge');
      return `Pairing code: ${r.code} (expires in 30 seconds). Ask the user to click the Chrome extension icon and enter this code.`;
    }
  },
  {
    name: 'cloudhand_tabs',
    description: 'List all open tabs in the connected Chrome browser.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const r = await bridgeCall('GET', '/tabs');
      const tabs = r.tabs || [];
      return tabs.map(t => `[${t.id}] ${t.title} - ${t.url}`).join('\n');
    }
  },
  {
    name: 'cloudhand_screenshot',
    description: 'Take a screenshot of the current tab. Returns base64 PNG image data.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID to screenshot (optional, defaults to active tab)' }
      },
      additionalProperties: false
    },
    handler: async ({ tabId } = {}) => {
      const body = tabId ? { tabId } : {};
      const r = await bridgeCall('POST', '/screenshot', body);
      const data = r.result || '';
      if (!data || !data.startsWith('data:image')) return 'Screenshot failed: ' + JSON.stringify(r);
      // Save to temp file
      const tmpPath = `/tmp/cloudhand_screenshot_${Date.now()}.png`;
      const base64 = data.split(',')[1];
      fs.writeFileSync(tmpPath, Buffer.from(base64, 'base64'));
      const sizeKB = Math.round(fs.statSync(tmpPath).size / 1024);
      return JSON.stringify({ ok: true, path: tmpPath, sizeKB, base64: data });
    }
  },
  {
    name: 'cloudhand_navigate',
    description: 'Navigate the current tab to a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        tabId: { type: 'number', description: 'Tab ID (optional)' }
      },
      required: ['url'],
      additionalProperties: false
    },
    handler: async ({ url, tabId }) => {
      const r = await bridgeCall('POST', '/navigate', { url, tabId });
      return formatResult(r);
    }
  },
  {
    name: 'cloudhand_click',
    description: 'Click an element on the page by CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of element to click' },
        tabId: { type: 'number' }
      },
      required: ['selector'],
      additionalProperties: false
    },
    handler: async ({ selector, tabId }) => {
      const r = await bridgeCall('POST', '/click', { selector, tabId });
      return formatResult(r);
    }
  },
  {
    name: 'cloudhand_type',
    description: 'Type text into the currently focused element.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type' },
        tabId: { type: 'number' }
      },
      required: ['text'],
      additionalProperties: false
    },
    handler: async ({ text, tabId }) => {
      const r = await bridgeCall('POST', '/type', { text, tabId });
      return formatResult(r);
    }
  },
  {
    name: 'cloudhand_get_text',
    description: 'Get all visible text content from the current page.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' } },
      additionalProperties: false
    },
    handler: async ({ tabId } = {}) => {
      const r = await bridgeCall('POST', '/get_text', { tabId });
      const text = r.result || '';
      return typeof text === 'string' ? text.slice(0, 8000) : JSON.stringify(r);
    }
  },
  {
    name: 'cloudhand_find',
    description: 'Find elements on the page matching a CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        tabId: { type: 'number' }
      },
      required: ['selector'],
      additionalProperties: false
    },
    handler: async ({ selector, limit = 20, tabId }) => {
      const r = await bridgeCall('POST', '/find_elements', { selector, limit, tabId });
      return formatResult(r);
    }
  },
  {
    name: 'cloudhand_scroll',
    description: 'Scroll the page up or down.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
        tabId: { type: 'number' }
      },
      required: ['direction'],
      additionalProperties: false
    },
    handler: async ({ direction, tabId }) => {
      const action = direction === 'up' ? 'scroll_up' : 'scroll_down';
      const r = await bridgeCall('POST', `/${action}`, { tabId });
      return formatResult(r);
    }
  },
  {
    name: 'cloudhand_key',
    description: 'Press a keyboard key (e.g. Enter, Escape, Tab).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name, e.g. Enter, Escape, Tab, ArrowDown' },
        tabId: { type: 'number' }
      },
      required: ['key'],
      additionalProperties: false
    },
    handler: async ({ key, tabId }) => {
      const r = await bridgeCall('POST', '/key', { key, tabId });
      return formatResult(r);
    }
  },
  {
    name: 'cloudhand_go_back',
    description: 'Navigate back in browser history.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, additionalProperties: false },
    handler: async ({ tabId } = {}) => {
      const r = await bridgeCall('POST', '/go_back', { tabId });
      return formatResult(r);
    }
  },
  {
    name: 'cloudhand_go_forward',
    description: 'Navigate forward in browser history.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, additionalProperties: false },
    handler: async ({ tabId } = {}) => {
      const r = await bridgeCall('POST', '/go_forward', { tabId });
      return formatResult(r);
    }
  },
  {
    name: 'cloudhand_new_window',
    description: 'Open a new Chrome window (not a tab). Use this BEFORE any browser operation to avoid interfering with the user\'s existing tabs. Returns the new windowId and tabId.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to open in the new window (optional, defaults to about:blank)' } },
      additionalProperties: false
    },
    handler: async ({ url } = {}) => {
      const r = await bridgeCall('POST', '/new_window', { url });
      return JSON.stringify(r);
    }
  },
  {
    name: 'cloudhand_new_tab',
    description: 'Open a new tab, optionally with a URL.',

    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      additionalProperties: false
    },
    handler: async ({ url } = {}) => {
      const r = await bridgeCall('POST', '/new_tab', { url });
      return formatResult(r);
    }
  },
  {
    name: 'cloudhand_page_info',
    description: 'Get current page title and URL.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, additionalProperties: false },
    handler: async ({ tabId } = {}) => {
      const r = await bridgeCall('GET', '/page_info');
      return JSON.stringify(r);
    }
  },
  {
    name: 'cloudhand_eval',
    description: 'Execute arbitrary JavaScript in the current tab and return the result. Use this when other tools cannot find elements or when you need complex DOM operations.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate in the page context' },
        tabId: { type: 'number', description: 'Tab ID (optional)' }
      },
      required: ['expression'],
      additionalProperties: false
    },
    handler: async ({ expression, tabId } = {}) => {
      const r = await bridgeCall('POST', '/eval', { expression, tabId });
      return JSON.stringify(r);
    }
  },
  {
    name: 'cloudhand_ax_tree',
    description: 'Get the Accessibility Tree of the current page. Returns a compact text snapshot with stable [ref=N] identifiers for interactive elements (buttons, links, inputs, etc). Use this instead of get_browser_state for faster AI page understanding. Then use cloudhand_click_ref or cloudhand_type_ref to interact with elements by ref number.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID (optional)' },
        interactive: { type: 'boolean', description: 'Only return interactive elements (default: false)' },
        compact: { type: 'boolean', description: 'Remove empty structural nodes (default: true)' },
        maxDepth: { type: 'number', description: 'Max tree depth (optional)' }
      },
      additionalProperties: false
    },
    handler: async ({ tabId, interactive, compact, maxDepth } = {}) => {
      const r = await bridgeCall('POST', '/get_ax_tree', { tabId, interactive, compact: compact !== false, maxDepth });
      return JSON.stringify(r);
    }
  },
  {
    name: 'cloudhand_fetch',
    description: 'Fetch a URL using the current browser tab login session (cookies included). Much faster than DOM manipulation for reading data from sites you are already logged into. Returns { status, ok, data }.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        method: { type: 'string', description: 'HTTP method (default: GET)', enum: ['GET','POST','PUT','DELETE','PATCH'] },
        headers: { type: 'object', description: 'Additional headers (optional)' },
        body: { type: 'object', description: 'Request body for POST/PUT (optional)' },
        tabId: { type: 'number', description: 'Tab ID to use login session from (optional)' }
      },
      required: ['url'],
      additionalProperties: false
    },
    handler: async ({ url, method, headers, body, tabId } = {}) => {
      const r = await bridgeCall('POST', '/fetch_with_cookies', { url, method, headers, body, tabId });
      return JSON.stringify(r);
    }
  },
  {
    name: 'cloudhand_cdp_click',
    description: 'Click an element using real CDP mouse events (Input.dispatchMouseEvent). More reliable than JS click, bypasses anti-bot detection. Provide selector (CSS) to click a specific element.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of element to click' },
        tabId: { type: 'number', description: 'Tab ID (optional)' }
      },
      required: ['selector'],
      additionalProperties: false
    },
    handler: async ({ selector, tabId } = {}) => {
      const r = await bridgeCall('POST', '/cdp_click', { selector, tabId });
      return JSON.stringify(r);
    }
  },
  {
    name: 'cloudhand_cdp_type',
    description: 'Type text using real CDP keyboard events (Input.dispatchKeyEvent), simulating human keystroke timing. Use this instead of cloudhand_type when sites have anti-bot protection.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type' },
        selector: { type: 'string', description: 'CSS selector to focus before typing (optional)' },
        tabId: { type: 'number', description: 'Tab ID (optional)' }
      },
      required: ['text'],
      additionalProperties: false
    },
    handler: async ({ text, selector, tabId } = {}) => {
      const r = await bridgeCall('POST', '/cdp_type', { text, selector, tabId });
      return JSON.stringify(r);
    }
  },
  {
    name: 'cloudhand_network_capture',
    description: 'Capture network requests (XHR/fetch) from the current tab for a specified duration. Useful for reverse-engineering APIs. Returns up to 50 non-static requests.',
    inputSchema: {
      type: 'object',
      properties: {
        waitMs: { type: 'number', description: 'How long to capture in milliseconds (default: 3000)' },
        tabId: { type: 'number', description: 'Tab ID (optional)' }
      },
      additionalProperties: false
    },
    handler: async ({ waitMs, tabId } = {}) => {
      const r = await bridgeCall('POST', '/network_capture', { waitMs, tabId });
      return JSON.stringify(r);
    }
  },
  {
    name: 'cloudhand_console',
    description: 'Capture browser console logs and JavaScript errors from the current tab for a specified duration. Useful for debugging page issues.',
    inputSchema: {
      type: 'object',
      properties: {
        waitMs: { type: 'number', description: 'How long to capture in milliseconds (default: 2000)' },
        tabId: { type: 'number', description: 'Tab ID (optional)' }
      },
      additionalProperties: false
    },
    handler: async ({ waitMs, tabId } = {}) => {
      const r = await bridgeCall('POST', '/console_capture', { waitMs, tabId });
      return JSON.stringify(r);
    }
  }
];
// OpenClaw plugin register function
function register(api) {
  const pluginDir = __dirname;
  const config = api.config || {};
  const autoStart = config.autoStart !== false;

  // Start bridge server
  if (autoStart) {
    try {
      startBridge(pluginDir);
    } catch (e) {
      console.error('[cloudhand] Failed to start bridge:', e.message);
    }
  }

  // 自动生成带正确 VPS IP 的 extension.zip
  try {
    const bridgeConfigPath = path.join(require('os').homedir(), '.openclaw', 'chrome-bridge', 'config.json');
    let publicIp = process.env.PUBLIC_IP || null;
    if (!publicIp && fs.existsSync(bridgeConfigPath)) {
      const bridgeCfg = JSON.parse(fs.readFileSync(bridgeConfigPath, 'utf8'));
      publicIp = bridgeCfg.publicIp || null;
    }
    if (publicIp) {
      const extDir = path.join(pluginDir, 'extension');
      const zipPath = path.join(pluginDir, 'extension.zip');
      const bgPath = path.join(extDir, 'background.js');
      // 写入临时目录打包（每次清空，避免旧文件残留）
      const tmpDir = path.join(require('os').tmpdir(), 'cloudhand-ext-build');
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      // 复制所有扩展文件到临时目录
      for (const f of fs.readdirSync(extDir)) {
        fs.copyFileSync(path.join(extDir, f), path.join(tmpDir, f));
      }
      // 生成 config.js（运行时配置，含真实 IP）写入 tmpDir，不写入 extDir
      const bridgePort = config.port || BRIDGE_PORT;
      const configJs = `// Auto-generated by CloudHand skill on ${new Date().toISOString()}\n// Do not edit manually. Re-generated on each plugin startup.\nexport const CLOUDHAND_CONFIG = {\n  wsUrl: 'ws://${publicIp}:${bridgePort}/ws',\n  port: ${bridgePort}\n};\n`;
      fs.writeFileSync(path.join(tmpDir, 'config.js'), configJs);
      // background.js 直接复制（用 import config.js，不需要 patch）
      fs.copyFileSync(bgPath, path.join(tmpDir, 'background.js'));
      // 打包 zip
      execSync(`cd '${tmpDir}' && zip -r '${zipPath}' .`, { stdio: 'ignore' });
      console.log(`[cloudhand] Extension zip + config.js built with IP: ${publicIp}`);
    }
  } catch (e) {
    console.error('[cloudhand] Failed to build extension zip:', e.message);
  }

  // Register tools
  for (const tool of TOOLS) {
    api.registerTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(_toolCallId, params) {
        try {
          const result = await tool.handler(params);
          const text = typeof result === 'string' ? result : JSON.stringify(result);
          return { content: [{ type: 'text', text }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
        }
      }
    });
  }

  // 下载端点已移至 server.js（9876端口），api.route 在 openclaw 插件 API 中不可用

  // Cleanup on shutdown
  if (api.onShutdown) {
    api.onShutdown(() => {
      if (bridgeProcess) {
        bridgeProcess.kill();
        console.log('[cloudhand] Bridge stopped');
      }
    });
  }

  console.log('[cloudhand] CloudHand plugin loaded');
}

module.exports = { register };
