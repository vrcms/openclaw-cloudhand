'use strict';

/**
 * CloudHand Plugin for OpenClaw v2.7.0
 * 注册 agent tools，通过 CDP Bridge 控制本地 Chrome 浏览器。
 * 
 * 核心交互通道：/snapshot（语义快照）+ /act（ref 交互）
 * 降级通道：/click（CDP selector/坐标）+ /type（CDP 键盘）
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');

const BRIDGE_PORT = 9876;
const BRIDGE_HOST = '127.0.0.1';
const BASE_URL = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;

let bridgeProcess = null;
let cachedToken = null;

// 检查 Bridge 是否运行
function isBridgeRunning() {
  try {
    execSync(`curl -sf ${BASE_URL}/status --max-time 2`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// 启动 Bridge 服务
function startBridge() {
  if (isBridgeRunning()) {
    console.log('[cloudhand] Bridge already running');
    return;
  }
  const serverPath = path.join(__dirname, 'server.js');
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

// 获取 API Token（缓存，仅首次请求）
async function getToken() {
  if (cachedToken) return cachedToken;
  try {
    const r = await httpCall('GET', '/token', null, false);
    cachedToken = r.apiToken;
    return cachedToken;
  } catch {
    return null;
  }
}

// HTTP 调用 Bridge（带可选鉴权）
function httpCall(method, urlPath, body, auth = true) {
  return new Promise(async (resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) {
      const token = await getToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: BRIDGE_HOST,
      port: BRIDGE_PORT,
      path: urlPath,
      method,
      headers,
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
  return JSON.stringify(r);
}

// ── Tool 定义（与 server.js v2.7.0 端点一一对应） ──────────────

const TOOLS = [
  // ── 基础 ──
  {
    name: 'cloudhand_status',
    description: '检查 CloudHand Bridge 连接状态。返回 connected（扩展是否连接）、mode（local/remote）、attachedTabs 等。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const r = await httpCall('GET', '/status', null, false);
      return formatResult(r);
    }
  },

  // ── 标签页管理 ──
  {
    name: 'cloudhand_ensure_tab',
    description: '确保有 agent 专属标签页。无则自动创建，有则复用。所有操作前应先调用此端点。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const r = await httpCall('POST', '/ensure_tab');
      return formatResult(r);
    }
  },
  {
    name: 'cloudhand_list_tabs',
    description: '列出所有已知的浏览器标签页，包含 targetId、url、title、sessionId 等信息。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const r = await httpCall('GET', '/list_tabs');
      return formatResult(r);
    }
  },
  {
    name: 'cloudhand_switch_tab',
    description: '切换 agent 到指定标签页。通过 targetId 或 sessionId 指定。',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: '目标 tab 的 targetId' },
        sessionId: { type: 'string', description: '目标 tab 的 sessionId（可选，与 targetId 二选一）' }
      },
      additionalProperties: false
    },
    handler: async ({ targetId, sessionId }) => {
      const r = await httpCall('POST', '/switch_tab', { targetId, sessionId });
      return formatResult(r);
    }
  },
  {
    name: 'cloudhand_navigate',
    description: '导航到指定 URL。自动使用当前 agent tab。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要导航到的 URL' }
      },
      required: ['url'],
      additionalProperties: false
    },
    handler: async ({ url }) => {
      const r = await httpCall('POST', '/navigate', { url });
      return formatResult(r);
    }
  },
  {
    name: 'cloudhand_page_info',
    description: '获取当前页面的 URL 和 Title。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const r = await httpCall('GET', '/get_page_info');
      return formatResult(r);
    }
  },

  // ── ⭐ 核心交互（Playwright 通道） ──
  {
    name: 'cloudhand_snapshot',
    description: '⭐ 获取页面语义快照（Playwright ariaSnapshot）。返回带 [ref=eN] 编号的 ARIA 语义树，每个可交互元素都有唯一 ref，可直接用于 cloudhand_act 操作。这是理解页面内容的首选方式。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const r = await httpCall('POST', '/snapshot');
      return formatResult(r);
    }
  },
  {
    name: 'cloudhand_act',
    description: '⭐ 通过 ref 编号执行页面交互操作。支持 click/type/press/hover/scroll/select/fill/wait/close 等。响应包含 actionSummary（操作摘要）、refs（刷新后的 ref 映射，无需再调 snapshot）、newTab（新标签页信息）。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: '操作类型: click, type, press, hover, scroll, scrollIntoView, select, fill, wait, clickAt, typeAt, drag, evaluate, close',
          enum: ['click', 'type', 'press', 'hover', 'scroll', 'scrollIntoView', 'select', 'fill', 'wait', 'clickAt', 'typeAt', 'drag', 'evaluate', 'close']
        },
        ref: { type: 'string', description: 'ref 编号（如 e12），从 snapshot 中获取' },
        text: { type: 'string', description: '输入文本（kind=type 时必需）' },
        key: { type: 'string', description: '按键名称（kind=press 时必需，如 Enter, Tab, Escape）' },
        option: { type: 'string', description: '下拉选项文本（kind=select 时）' },
        submit: { type: 'boolean', description: '输入后自动按 Enter（kind=type 时）' },
        slowly: { type: 'boolean', description: '逐字输入模拟人类（kind=type 时）' },
        x: { type: 'number', description: '滚动 X 像素（kind=scroll）或坐标 X（kind=clickAt/typeAt）' },
        y: { type: 'number', description: '滚动 Y 像素（kind=scroll）或坐标 Y（kind=clickAt/typeAt）' },
        fn: { type: 'string', description: 'JavaScript 函数体（kind=evaluate 时）' },
        fields: {
          type: 'array',
          description: '批量填表字段（kind=fill 时）',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string' },
              type: { type: 'string' },
              value: { type: 'string' }
            }
          }
        },
        timeMs: { type: 'number', description: '固定等待毫秒数（kind=wait 时）' },
        waitText: { type: 'string', description: '等待页面出现指定文本（kind=wait 时，对应 text 参数）' },
        startRef: { type: 'string', description: '拖拽起点 ref（kind=drag 时）' },
        endRef: { type: 'string', description: '拖拽终点 ref（kind=drag 时）' }
      },
      required: ['kind'],
      additionalProperties: false
    },
    handler: async (params) => {
      // 构建请求体，映射参数名
      const body = { kind: params.kind };
      if (params.ref) body.ref = params.ref;
      if (params.text) body.text = params.text;
      if (params.key) body.key = params.key;
      if (params.option) body.option = params.option;
      if (params.submit) body.submit = params.submit;
      if (params.slowly) body.slowly = params.slowly;
      if (params.x !== undefined) body.x = params.x;
      if (params.y !== undefined) body.y = params.y;
      if (params.fn) body.fn = params.fn;
      if (params.fields) body.fields = params.fields;
      if (params.timeMs) body.timeMs = params.timeMs;
      if (params.waitText) body.text = params.waitText;
      if (params.startRef) body.startRef = params.startRef;
      if (params.endRef) body.endRef = params.endRef;
      const r = await httpCall('POST', '/act', body);
      return formatResult(r);
    }
  },

  // ── 截图 ──
  {
    name: 'cloudhand_screenshot',
    description: '截取当前页面截图，返回 base64 PNG。仅在用户明确要求截图时使用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const r = await httpCall('POST', '/screenshot');
      if (r.ok && r.data) {
        const tmpPath = `/tmp/cloudhand_screenshot_${Date.now()}.png`;
        const base64 = r.data.split(',')[1];
        fs.writeFileSync(tmpPath, Buffer.from(base64, 'base64'));
        const sizeKB = Math.round(fs.statSync(tmpPath).size / 1024);
        return JSON.stringify({ ok: true, path: tmpPath, sizeKB, base64: r.data });
      }
      return formatResult(r);
    }
  },
  {
    name: 'cloudhand_screenshot_labels',
    description: '截取带标签的截图，交互元素自动标注边框和编号。同时返回语义快照和 ref 映射。',
    inputSchema: {
      type: 'object',
      properties: {
        filterMode: { type: 'string', description: '过滤模式: clickable（仅可点击）, all（全部）', enum: ['clickable', 'all'] },
        maxLabels: { type: 'number', description: '最大标签数量（默认 100）' }
      },
      additionalProperties: false
    },
    handler: async ({ filterMode, maxLabels } = {}) => {
      const body = {};
      if (filterMode) body.filterMode = filterMode;
      if (maxLabels) body.maxLabels = maxLabels;
      const r = await httpCall('POST', '/screenshot_with_labels', body);
      return formatResult(r);
    }
  },

  // ── 降级操作（纯 CDP） ──
  {
    name: 'cloudhand_click',
    description: '通过 CSS 选择器或坐标点击元素（纯 CDP）。优先使用 cloudhand_act click。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器' },
        x: { type: 'number', description: 'X 坐标（与 selector 二选一）' },
        y: { type: 'number', description: 'Y 坐标（与 selector 二选一）' }
      },
      additionalProperties: false
    },
    handler: async ({ selector, x, y }) => {
      const body = {};
      if (selector) body.selector = selector;
      if (x !== undefined) body.x = x;
      if (y !== undefined) body.y = y;
      const r = await httpCall('POST', '/click', body);
      return formatResult(r);
    }
  },
  {
    name: 'cloudhand_type',
    description: 'CDP 键盘输入。可选先通过 selector 聚焦元素。优先使用 cloudhand_act type。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要输入的文本' },
        selector: { type: 'string', description: '先聚焦此 CSS 选择器（可选）' }
      },
      required: ['text'],
      additionalProperties: false
    },
    handler: async ({ text, selector }) => {
      const body = { text };
      if (selector) body.selector = selector;
      const r = await httpCall('POST', '/type', body);
      return formatResult(r);
    }
  },
  {
    name: 'cloudhand_eval',
    description: '在当前页面执行 JavaScript 表达式并返回结果。兜底手段，优先使用 snapshot + act。',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript 表达式' }
      },
      required: ['expression'],
      additionalProperties: false
    },
    handler: async ({ expression }) => {
      const r = await httpCall('POST', '/eval', { expression });
      return formatResult(r);
    }
  },
  {
    name: 'cloudhand_cdp',
    description: '万能 CDP 命令透传。直接发送任意 Chrome DevTools Protocol 命令。',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'CDP 方法名（如 DOM.getDocument, Page.captureScreenshot）' },
        params: { type: 'object', description: 'CDP 参数对象' }
      },
      required: ['method'],
      additionalProperties: false
    },
    handler: async ({ method, params }) => {
      const r = await httpCall('POST', '/cdp', { method, params: params || {} });
      return formatResult(r);
    }
  },
  {
    name: 'cloudhand_ax_tree',
    description: '获取页面无障碍树（Accessibility Tree）。返回原始 AX 节点数组。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const r = await httpCall('POST', '/get_ax_tree');
      return formatResult(r);
    }
  }
];

// ── OpenClaw 插件注册 ──────────────────────────────────

function register(api) {
  const config = api.config || {};
  const autoStart = config.autoStart !== false;

  // 启动 Bridge 服务
  if (autoStart) {
    try {
      startBridge();
    } catch (e) {
      console.error('[cloudhand] Failed to start bridge:', e.message);
    }
  }

  // 自动生成带 VPS IP 的 extension.zip
  try {
    const bridgeConfigPath = path.join(require('os').homedir(), '.openclaw', 'chrome-bridge', 'config.json');
    let publicIp = process.env.PUBLIC_IP || null;
    if (!publicIp && fs.existsSync(bridgeConfigPath)) {
      const bridgeCfg = JSON.parse(fs.readFileSync(bridgeConfigPath, 'utf8'));
      publicIp = bridgeCfg.publicIp || null;
    }
    if (publicIp) {
      const extDir = path.join(__dirname, '..', 'extension');
      const zipPath = path.join(__dirname, 'extension.zip');
      const tmpDir = path.join(require('os').tmpdir(), 'cloudhand-ext-build');
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      // 复制扩展文件
      for (const f of fs.readdirSync(extDir)) {
        const src = path.join(extDir, f);
        if (fs.statSync(src).isFile()) {
          fs.copyFileSync(src, path.join(tmpDir, f));
        }
      }
      // 生成 config.js（运行时配置，含真实 IP）
      const bridgePort = config.port || BRIDGE_PORT;
      const configJs = `// Auto-generated by CloudHand plugin on ${new Date().toISOString()}\nexport const CLOUDHAND_CONFIG = {\n  wsUrl: 'ws://${publicIp}:${bridgePort}/ws',\n  port: ${bridgePort}\n};\n`;
      fs.writeFileSync(path.join(tmpDir, 'config.js'), configJs);
      // 打包 zip
      execSync(`cd '${tmpDir}' && zip -r '${zipPath}' .`, { stdio: 'ignore' });
      console.log(`[cloudhand] Extension zip built with IP: ${publicIp}`);
    }
  } catch (e) {
    console.error('[cloudhand] Failed to build extension zip:', e.message);
  }

  // 注册 tools
  for (const tool of TOOLS) {
    api.registerTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(_toolCallId, params) {
        try {
          const result = await tool.handler(params || {});
          const text = typeof result === 'string' ? result : JSON.stringify(result);
          return { content: [{ type: 'text', text }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
        }
      }
    });
  }

  // 关闭时清理
  if (api.onShutdown) {
    api.onShutdown(() => {
      if (bridgeProcess) {
        bridgeProcess.kill();
        console.log('[cloudhand] Bridge stopped');
      }
    });
  }

  console.log('[cloudhand] CloudHand plugin v2.7.0 loaded');
}

module.exports = { register };
