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

  // Register extension download route
  if (api.route) {
    api.route('GET', '/cloudhand/extension.zip', (req, res) => {
      const zipPath = path.join(pluginDir, 'extension.zip');
      if (fs.existsSync(zipPath)) {
        res.sendFile(zipPath);
      } else {
        res.status(404).json({ error: 'Extension zip not found' });
      }
    });
  }

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
