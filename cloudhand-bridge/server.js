const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const PORT = process.env.PORT || 9876;
const LOCAL_MODE = process.argv.includes('--local');
const HOST = LOCAL_MODE ? '127.0.0.1' : (process.env.HOST || '0.0.0.0');
const CONFIG_FILE = path.join(process.env.HOME || process.env.USERPROFILE || '/root', '.openclaw/chrome-bridge/config.json');
const LOCAL_TOKEN = 'local-mode-token';

// 确保配置目录存在
fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });

// 加载/保存配置
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { sessionToken: null, sessionCreatedAt: null }; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();

// 本地模式初始化
if (LOCAL_MODE) {
  config.localToken = LOCAL_TOKEN;
  config.localMode = true;
  saveConfig(config);
  console.log('[Local] 本地模式已启用，绑定到 127.0.0.1');
  console.log(`[Local] Token: ${LOCAL_TOKEN}`);
}

// 自动生成 apiToken
if (!config.apiToken) {
  config.apiToken = crypto.randomBytes(32).toString('hex');
  saveConfig(config);
  console.log('[Auth] 已生成新的 apiToken');
}

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowed = origin.startsWith('chrome-extension://') || origin === '' || origin.includes('127.0.0.1') || origin.includes('localhost');
  if (allowed) {
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 免鉴权白名单
const PUBLIC_PATHS = new Set(['/status', '/config', '/token']);

// Bearer Token 鉴权
app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  const auth = req.headers['authorization'] || '';
  const qtoken = req.query.token || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : qtoken;
  if (LOCAL_MODE && token === LOCAL_TOKEN) return next();
  if (token && token === config.apiToken) return next();
  res.status(401).json({ error: 'Unauthorized. Pass Authorization: Bearer <apiToken>' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 }); // 1MB 防 DoS
const cdpWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const cdpClients = new Set(); // Playwright 等 CDP 客户端

// 路由 WebSocket 升级请求
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (pathname === '/cdp') {
    cdpWss.handleUpgrade(req, socket, head, (ws) => cdpWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ── CDP 协议状态 ──────────────────────────────────
let extensionSocket = null;
let pendingRequests = {};   // id -> { resolve, reject, timeout }
let nextCdpId = 1;

// 已 attach 的 tab 状态（由扩展通过 CDP 事件通知）
// sessionId -> { targetId, url, title }
const attachedSessions = new Map();
// 当前 agent 使用的 sessionId
let agentSessionId = null;

// 所有已知的浏览器 tab（不限于已 attach 的，由扩展 target 事件维护）
// targetId -> { tabId, url, title, type }
const knownTargets = new Map();

// ── WebSocket 连接处理（适配新 CDP 扩展） ──────────────
wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const token = params.get('token');

  // 验证 token
  if (!token || !(token === LOCAL_TOKEN || token === config.sessionToken || token === config.apiToken)) {
    ws.close(1008, 'Unauthorized');
    console.log('[WS] 拒绝未授权连接');
    return;
  }

  const remoteAddr = req.socket.remoteAddress || 'unknown';
  console.log(`[WS] 扩展已连接 (来源: ${remoteAddr})`);

  // 连接互斥：踢掉旧连接并通知原因
  if (extensionSocket && extensionSocket.readyState === extensionSocket.OPEN) {
    try {
      extensionSocket.send(JSON.stringify({
        type: 'event',
        event: 'connection.replaced',
        payload: { reason: '有新设备连接，当前连接已被替换', newIP: remoteAddr }
      }));
    } catch (e) { /* 旧连接可能已不可用 */ }
    extensionSocket.close(1000, 'Replaced by new connection');
    console.log('[WS] 旧扩展连接已断开（被新连接替换）');
  }
  extensionSocket = ws;

  // 发送 connect.challenge 事件触发扩展握手
  ws.send(JSON.stringify({
    type: 'event',
    event: 'connect.challenge',
    payload: { nonce: '' }
  }));

  setupSocket(ws);
});

function setupSocket(ws) {
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      // 处理扩展的 connect 握手请求
      if (msg.type === 'req' && msg.method === 'connect') {
        // 回复握手成功
        ws.send(JSON.stringify({
          type: 'res',
          id: msg.id,
          ok: true,
          result: { protocol: 3 }
        }));
        console.log('[WS] Gateway 握手完成');
        return;
      }

      // 处理 pong（keepalive 回复）
      if (msg.method === 'pong') {
        return;
      }

      // 处理 CDP 命令的响应（与 EasyClaw 一致：先判断有 id 且为数字）
      if (typeof msg.id === 'number') {
        const p = pendingRequests[msg.id];
        if (!p) return;
        delete pendingRequests[msg.id];
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)));
        else p.resolve(msg.result);
        return;
      }

      // 处理扩展推送的 CDP 事件
      if (msg.method === 'forwardCDPEvent' && msg.params) {
        handleCdpEvent(msg.params);
        return;
      }

      // 处理 target 发现/变化/销毁事件（扩展上行）
      if (msg.method === 'reportTargets') {
        knownTargets.clear();
        for (const t of (msg.targets || [])) {
          knownTargets.set(t.targetId, { tabId: t.tabId, url: t.url, title: t.title, type: t.type });
        }
        console.log(`[CDP] 初始化已知 targets: ${knownTargets.size} 个`);
        return;
      }
      if (msg.method === 'targetDiscovered') {
        knownTargets.set(msg.targetId, { tabId: msg.tabId, url: msg.url, title: msg.title, type: msg.type });
        broadcastToCdpClients({ method: 'Target.targetCreated', params: { targetInfo: { targetId: msg.targetId, type: msg.type || 'page', title: msg.title, url: msg.url, attached: false } } });
        console.log(`[CDP] 发现新 target: ${msg.targetId} (${msg.url})`);
        return;
      }
      if (msg.method === 'targetInfoChanged') {
        const existing = knownTargets.get(msg.targetId);
        knownTargets.set(msg.targetId, { ...existing, url: msg.url, title: msg.title });
        broadcastToCdpClients({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: msg.targetId, type: existing?.type || 'page', title: msg.title, url: msg.url, attached: false } } });
        return;
      }
      if (msg.method === 'targetDestroyed') {
        knownTargets.delete(msg.targetId);
        broadcastToCdpClients({ method: 'Target.targetDestroyed', params: { targetId: msg.targetId } });
        console.log(`[CDP] Target 已销毁: ${msg.targetId}`);
        return;
      }

    } catch (e) {
      console.error('[WS] 解析错误:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[WS] 扩展断开连接');
    if (extensionSocket === ws) {
      extensionSocket = null;
    }
    clearInterval(pingInterval);
    // 拒绝所有等待中的请求
    Object.values(pendingRequests).forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(new Error('Extension disconnected'));
    });
    pendingRequests = {};
  });

  ws.on('error', (e) => console.error('[WS] 错误:', e.message));

  // keepalive: 发送 ping 命令（新扩展用 JSON ping 而非 WS ping）
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify({ method: 'ping' }));
      } catch { /* ignore */ }
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);
}

// 处理扩展推送的 CDP 事件
function handleCdpEvent(params) {
  const { method, params: eventParams, sessionId } = params;

  // 广播给所有 /cdp 客户端（Playwright 需要这些事件）
  broadcastToCdpClients({ method, params: eventParams, ...(sessionId ? { sessionId } : {}) });

  if (method === 'Target.attachedToTarget') {
    const sid = eventParams?.sessionId;
    const targetInfo = eventParams?.targetInfo;
    if (sid && targetInfo) {
      attachedSessions.set(sid, {
        targetId: targetInfo.targetId,
        url: targetInfo.url || '',
        title: targetInfo.title || '',
        type: targetInfo.type || 'page'
      });
      console.log(`[CDP] Tab 已 attach: sessionId=${sid}, targetId=${targetInfo.targetId}`);
      agentSessionId = sid;
      console.log(`[CDP] 自动切换 agent session: ${sid}`);
    }
  }

  if (method === 'Target.detachedFromTarget') {
    const sid = eventParams?.sessionId;
    if (sid) {
      attachedSessions.delete(sid);
      if (agentSessionId === sid) {
        agentSessionId = attachedSessions.size > 0 ? attachedSessions.keys().next().value : null;
        console.log(`[CDP] Agent session 已切换: ${agentSessionId || 'null'}`);
      }
      console.log(`[CDP] Tab 已 detach: sessionId=${sid}`);
    }
  }
}

// 广播 CDP 事件给所有 /cdp WebSocket 客户端
function broadcastToCdpClients(evt) {
  const msg = JSON.stringify(evt);
  for (const ws of cdpClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// ── 发送 CDP 命令给扩展（与 EasyClaw 一致：30 秒超时） ──────────────────────────────
function sendCdpCommand(method, params = {}, sessionId = null) {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== extensionSocket.OPEN) {
      return reject(new Error('Extension not connected'));
    }
    const id = nextCdpId++;
    const timer = setTimeout(() => {
      pendingRequests[id] && delete pendingRequests[id];
      reject(new Error(`extension request timeout: ${method}`));
    }, 30_000);
    pendingRequests[id] = { resolve, reject, timer };

    const msg = {
      id,
      method: 'forwardCDPCommand',
      params: {
        method,
        params,
        ...(sessionId ? { sessionId } : {})
      }
    };
    extensionSocket.send(JSON.stringify(msg));
  });
}

// ── /cdp WebSocket 端点（供 Playwright connectOverCDP 连接） ──────────
cdpWss.on('connection', (ws) => {
  console.log('[CDP-WS] Playwright/CDP 客户端已连接');
  cdpClients.add(ws);

  ws.on('message', async (data) => {
    let cmd;
    try { cmd = JSON.parse(data); } catch { return; }
    const id = cmd.id;
    const method = cmd.method || '';
    const params = cmd.params || {};
    const sessionId = cmd.sessionId;

    try {
      const result = await routeCdpCommand(method, params, sessionId);
      ws.send(JSON.stringify({ id, ...(sessionId ? { sessionId } : {}), result: result || {} }));

      // Target.setAutoAttach 响应后，补发所有已 attach 的 target（Playwright 靠此创建 Page）
      if (method === 'Target.setAutoAttach' && params.autoAttach && !sessionId) {
        for (const [sid, info] of attachedSessions.entries()) {
          ws.send(JSON.stringify({
            method: 'Target.attachedToTarget',
            params: {
              sessionId: sid,
              targetInfo: { targetId: info.targetId, type: info.type || 'page', title: info.title, url: info.url, attached: true, browserContextId: 'default' },
              waitingForDebugger: false
            }
          }));
        }
      }
    } catch (err) {
      ws.send(JSON.stringify({ id, ...(sessionId ? { sessionId } : {}), error: { message: err.message } }));
    }
  });

  ws.on('close', () => {
    cdpClients.delete(ws);
    console.log('[CDP-WS] CDP 客户端已断开');
  });

});

// CDP 命令路由：本地处理 Browser/Target 命令，其余转发给扩展
async function routeCdpCommand(method, params, sessionId) {
  switch (method) {
    case 'Browser.getVersion':
      return { protocolVersion: '1.3', product: 'Chrome/CloudHand-Extension-Relay', revision: '0', userAgent: 'CloudHand-Extension-Relay', jsVersion: 'V8' };
    case 'Browser.setDownloadBehavior':
      return {};
    case 'Target.setAutoAttach':
    case 'Target.setDiscoverTargets':
      return {};
    case 'Target.getTargets':
      return { targetInfos: Array.from(attachedSessions.entries()).map(([sid, t]) => ({ targetId: t.targetId, type: t.type || 'page', title: t.title, url: t.url, attached: true })) };
    case 'Target.getTargetInfo': {
      const tid = params?.targetId;
      if (tid) {
        for (const t of attachedSessions.values()) {
          if (t.targetId === tid) return { targetInfo: { targetId: tid, type: t.type || 'page', title: t.title, url: t.url, attached: true } };
        }
      }
      if (sessionId && attachedSessions.has(sessionId)) {
        const t = attachedSessions.get(sessionId);
        return { targetInfo: { targetId: t.targetId, type: t.type || 'page', title: t.title, url: t.url, attached: true } };
      }
      const first = attachedSessions.values().next().value;
      return { targetInfo: first ? { targetId: first.targetId, type: first.type || 'page', title: first.title, url: first.url, attached: true } : {} };
    }
    case 'Target.attachToTarget':
    case 'Target.detachFromTarget':
    case 'Target.createTarget':
    case 'Target.closeTarget':
    case 'Target.activateTarget':
      return await sendCdpCommand(method, params);
    default:
      return await sendCdpCommand(method, params, sessionId);
  }
}

// ── CDP HTTP 端点（Playwright connectOverCDP 需要） ──────────
app.get('/json/version', (req, res) => {
  res.json({
    Browser: 'CloudHand/extension-relay',
    'Protocol-Version': '1.3',
    webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/cdp`
  });
});

app.get('/json/list', (req, res) => {
  const list = Array.from(knownTargets.entries()).map(([targetId, info]) => ({
    id: targetId, type: info.type || 'page', title: info.title || '', url: info.url || '',
    webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/cdp`
  }));
  res.json(list);
});
app.get('/json', (req, res) => res.redirect('/json/list'));

// ── REST API ────────────────────────────────────────────

// 获取 apiToken（仅限 127.0.0.1 本机访问，使用 socket 级 IP 防 X-Forwarded-For 伪造）
app.get('/token', (req, res) => {
  const ip = req.socket.remoteAddress || '';
  if (!ip.includes('127.0.0.1') && !ip.includes('::1')) {
    return res.status(403).json({ error: 'Local access only' });
  }
  res.json({ apiToken: config.apiToken });
});

app.get('/status', (req, res) => {
  res.json({
    connected: !!(extensionSocket && extensionSocket.readyState === 1),
    pendingRequests: Object.keys(pendingRequests).length,
    mode: LOCAL_MODE ? 'local' : 'remote',
    attachedTabs: attachedSessions.size,
    agentSessionId,
    sessions: Array.from(attachedSessions.entries()).map(([sid, info]) => ({
      sessionId: sid,
      targetId: info.targetId,
      isAgent: sid === agentSessionId
    }))
  });
});

// 列出所有已知的浏览器 tab（不限于已 attach 的）
app.get('/list_tabs', (req, res) => {
  const result = [];
  for (const [targetId, info] of knownTargets.entries()) {
    // 查找是否已 attach（有 sessionId）
    let sessionId = null;
    for (const [sid, sess] of attachedSessions.entries()) {
      if (sess.targetId === targetId) { sessionId = sid; break; }
    }
    result.push({
      targetId, ...info, sessionId,
      isAgent: sessionId === agentSessionId
    });
  }
  res.json({ ok: true, tabs: result, total: result.length });
});

// 切换 agent 到指定 tab（通过 targetId 或 sessionId）
app.post('/switch_tab', async (req, res) => {
  try {
    const { targetId, sessionId } = req.body;
    // 方式 1：通过 sessionId 直接切换
    if (sessionId && attachedSessions.has(sessionId)) {
      agentSessionId = sessionId;
      return res.json({ ok: true, agentSessionId });
    }
    // 方式 2：通过 targetId
    if (targetId) {
      // 检查是否已 attach
      for (const [sid, sess] of attachedSessions.entries()) {
        if (sess.targetId === targetId) {
          agentSessionId = sid;
          return res.json({ ok: true, agentSessionId });
        }
      }
      // 未 attach，发送 Target.attachToTarget
      const result = await sendCdpCommand('Target.attachToTarget', { targetId, flatten: true });
      if (result?.sessionId) {
        // 等待 attach 事件到达
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 100));
          if (attachedSessions.has(result.sessionId)) {
            agentSessionId = result.sessionId;
            return res.json({ ok: true, agentSessionId });
          }
        }
        // attach 事件未到达但有 sessionId，也尝试设置
        agentSessionId = result.sessionId;
        return res.json({ ok: true, agentSessionId, warning: 'attach event not received' });
      }
      return res.status(500).json({ error: 'Target.attachToTarget failed' });
    }
    res.status(400).json({ error: 'targetId or sessionId required' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 确保有一个 agent 专属 tab（核心：不动用户窗口）
app.post('/ensure_tab', async (req, res) => {
  try {
    // 检查是否已有可用的 agent session
    if (agentSessionId && attachedSessions.has(agentSessionId)) {
      const info = attachedSessions.get(agentSessionId);
      return res.json({
        ok: true,
        sessionId: agentSessionId,
        targetId: info.targetId,
        reused: true
      });
    }

    // 通过 CDP 创建新 tab（扩展内部会自动 attach 并推送 Target.attachedToTarget 事件）
    const result = await sendCdpCommand('Target.createTarget', {
      url: 'about:blank'
    });

    // 等待 attach 事件到来（扩展 attachTab 后会发 forwardCDPEvent）
    // 最多等 3 秒
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (agentSessionId && attachedSessions.has(agentSessionId)) {
        const info = attachedSessions.get(agentSessionId);
        return res.json({
          ok: true,
          sessionId: agentSessionId,
          targetId: info.targetId,
          reused: false
        });
      }
    }

    res.json({ ok: true, result, note: 'Tab created, waiting for attach' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 导航
app.post('/navigate', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    const sid = req.body.sessionId || agentSessionId;
    if (!sid) return res.status(400).json({ error: 'No attached tab. Call /ensure_tab first.' });

    const targetId = req.body.targetId || attachedSessions.get(sid)?.targetId;
    const page = await getPlaywrightPage(targetId);
    await page.goto(url, { timeout: 20000 });
    if (targetId) pageRefs.delete(targetId);

    res.json({ ok: true, url: page.url() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 截图
app.post('/screenshot', async (req, res) => {
  try {
    const sid = req.body.sessionId || agentSessionId;
    if (!sid) return res.status(400).json({ error: 'No attached tab' });

    const result = await sendCdpCommand('Page.captureScreenshot', {
      format: 'png',
      quality: 80
    }, sid);

    res.json({ ok: true, data: result?.data ? `data:image/png;base64,${result.data}` : null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 执行 JavaScript
app.post('/eval', async (req, res) => {
  try {
    const { expression } = req.body;
    if (!expression) return res.status(400).json({ error: 'expression is required' });

    const sid = req.body.sessionId || agentSessionId;
    if (!sid) return res.status(400).json({ error: 'No attached tab' });

    const result = await sendCdpCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    }, sid);

    if (result?.exceptionDetails) {
      return res.status(500).json({ error: result.exceptionDetails.text || 'JS eval error' });
    }

    res.json({ ok: true, result: result?.result?.value });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// CDP 点击（通过坐标或 selector）
app.post('/click', async (req, res) => {
  try {
    const sid = req.body.sessionId || agentSessionId;
    if (!sid) return res.status(400).json({ error: 'No attached tab' });

    let x, y;

    if (req.body.x !== undefined && req.body.y !== undefined) {
      // 直接坐标点击
      x = req.body.x;
      y = req.body.y;
    } else if (req.body.selector) {
      // 通过纯 CDP 协议查找元素坐标，不再注入任何 JS (eval)
      const doc = await sendCdpCommand('DOM.getDocument', { depth: 0 }, sid);
      if (!doc || !doc.root) throw new Error('Failed to get DOM document');
      const rootNodeId = doc.root.nodeId;

      const queryRes = await sendCdpCommand('DOM.querySelectorAll', { nodeId: rootNodeId, selector: req.body.selector }, sid);
      const nodeIds = queryRes?.nodeIds || [];

      let foundBox = false;
      for (const nodeId of nodeIds) {
        try {
          const boxRes = await sendCdpCommand('DOM.getBoxModel', { nodeId }, sid);
          const model = boxRes?.model;
          if (model && model.width > 0 && model.height > 0) {
            x = model.content[0] + model.width / 2;
            y = model.content[1] + model.height / 2;
            foundBox = true;
            break;
          }
        } catch (e) {
          // 忽略获取失败的不可见节点
        }
      }

      if (!foundBox) {
        return res.status(404).json({ error: `Visible element not found: ${req.body.selector}` });
      }
    } else {
      return res.status(400).json({ error: 'x/y or selector required' });
    }

    // CDP 鼠标点击事件序列（mouseMoved → mousePressed → 50ms → mouseReleased）
    await sendCdpCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y
    }, sid);
    await sendCdpCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1
    }, sid);
    await new Promise(r => setTimeout(r, 50));
    await sendCdpCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1
    }, sid);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// CDP 键盘输入
app.post('/type', async (req, res) => {
  try {
    const { text, selector } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });

    const sid = req.body.sessionId || agentSessionId;
    if (!sid) return res.status(400).json({ error: 'No attached tab' });

    // 如果提供了 selector，用纯 CDP 聚焦（不注入 JS）
    if (selector) {
      const doc = await sendCdpCommand('DOM.getDocument', { depth: 0 }, sid);
      const queryRes = await sendCdpCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector }, sid);
      if (queryRes?.nodeId) {
        await sendCdpCommand('DOM.focus', { nodeId: queryRes.nodeId }, sid);
      }
      await new Promise(r => setTimeout(r, 100));
    }

    // 逐字符发送键盘事件
    for (const char of text) {
      if (char === '\n') {
        await sendCdpCommand('Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13
        }, sid);
        await sendCdpCommand('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13
        }, sid);
      } else {
        // 三段式键盘事件：keyDown → char → keyUp（与 browser-use 一致）
        await sendCdpCommand('Input.dispatchKeyEvent', {
          type: 'keyDown', key: char, code: `Key${char.toUpperCase()}`
        }, sid);
        await sendCdpCommand('Input.dispatchKeyEvent', {
          type: 'char', text: char, key: char
        }, sid);
        await sendCdpCommand('Input.dispatchKeyEvent', {
          type: 'keyUp', key: char, code: `Key${char.toUpperCase()}`
        }, sid);
      }
      // 模拟人类输入延迟（18ms，与 browser-use 一致）
      await new Promise(r => setTimeout(r, 18));
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 获取页面信息（纯 CDP，使用 Page.getNavigationHistory 而非 Runtime.evaluate）
async function getPageInfoPureCDP(sid) {
  let url = '', title = '';
  // 优先从缓存的 session 信息获取
  const session = attachedSessions.get(sid);
  if (session) {
    url = session.url || '';
    title = session.title || '';
  }
  // 用 Page.getNavigationHistory 获取最新值（纯 CDP，无 JS 注入）
  try {
    const navHistory = await sendCdpCommand('Page.getNavigationHistory', {}, sid);
    if (navHistory?.entries?.length) {
      const current = navHistory.entries[navHistory.currentIndex];
      url = current.url;
      title = current.title;
    }
  } catch (e) { /* 使用缓存值 */ }
  return { url, title };
}

app.post('/get_page_info', async (req, res) => {
  try {
    const sid = req.body.sessionId || agentSessionId;
    if (!sid) return res.status(400).json({ error: 'No attached tab' });
    const info = await getPageInfoPureCDP(sid);
    res.json({ ok: true, ...info });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/get_page_info', async (req, res) => {
  try {
    const sid = agentSessionId;
    if (!sid) return res.status(400).json({ error: 'No attached tab' });
    const info = await getPageInfoPureCDP(sid);
    res.json({ ok: true, ...info });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 万能 CDP 透传接口
app.post('/cdp', async (req, res) => {
  try {
    const { method, params } = req.body;
    if (!method) return res.status(400).json({ error: 'method is required' });

    const sid = req.body.sessionId || agentSessionId;
    const result = await sendCdpCommand(method, params || {}, sid);

    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 获取无障碍树
app.post('/get_ax_tree', async (req, res) => {
  try {
    const sid = req.body.sessionId || agentSessionId;
    if (!sid) return res.status(400).json({ error: 'No attached tab' });

    const result = await sendCdpCommand('Accessibility.getFullAXTree', {}, sid);
    res.json({ ok: true, nodes: result?.nodes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Playwright 连接管理（通过 /cdp 端点连接自身） ──────────────
let pwBrowser = null;
let pwConnecting = null;

async function ensurePlaywright() {
  if (pwBrowser?.isConnected()) return pwBrowser;
  if (pwConnecting) return await pwConnecting;
  pwConnecting = (async () => {
    try {
      const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${PORT}/cdp`, { timeout: 5000 });
      pwBrowser = browser;
      browser.on('disconnected', () => { if (pwBrowser === browser) pwBrowser = null; });
      console.log('[Playwright] 已连接到 /cdp 端点');
      return browser;
    } finally {
      pwConnecting = null;
    }
  })();
  return await pwConnecting;
}

// 获取 Playwright Page（通过 targetId 查找，与 EasyClaw findPageByTargetId 一致）
async function getPlaywrightPage(targetId) {
  const browser = await ensurePlaywright();
  const pages = browser.contexts().flatMap(c => c.pages());
  if (!pages.length) throw new Error('No pages available');
  if (!targetId) return pages[0];

  // 第一层：通过 CDP session 匹配 targetId
  for (const page of pages) {
    try {
      const session = await page.context().newCDPSession(page);
      const info = await session.send('Target.getTargetInfo');
      await session.detach().catch(() => { });
      if (info?.targetInfo?.targetId === targetId) return page;
    } catch { /* 扩展桥接模式下 Target.attachToBrowserTarget 会被拦截，继续 fallback */ }
  }

  // 第二层：通过 /json/list + URL 匹配（与 EasyClaw 一致）
  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/json/list`, {
      headers: { Authorization: `Bearer ${LOCAL_MODE ? LOCAL_TOKEN : config.apiToken}` }
    });
    if (resp.ok) {
      const targets = await resp.json();
      const target = targets.find(t => t.id === targetId);
      if (target) {
        const urlMatch = pages.filter(p => p.url() === target.url);
        if (urlMatch.length === 1) return urlMatch[0];
        // 多个相同 URL 的 page，按索引匹配
        if (urlMatch.length > 1) {
          const sameUrlTargets = targets.filter(t => t.url === target.url);
          if (sameUrlTargets.length === urlMatch.length) {
            const idx = sameUrlTargets.findIndex(t => t.id === targetId);
            if (idx >= 0 && idx < urlMatch.length) return urlMatch[idx];
          }
        }
      }
    }
  } catch { /* fetch 失败，继续 fallback */ }

  // 最终 fallback：只有一个 page 时直接返回
  if (pages.length === 1) return pages[0];
  throw new Error(`Tab not found: ${targetId}`);
}

// ── Playwright Snapshot 路由 ──────────────────────────
// 抄 EasyClaw 的 aria snapshot：用 Playwright ariaSnapshot 生成带 ref 的快照
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'searchbox',
  'slider', 'spinbutton', 'switch', 'tab', 'treeitem'
]);

function buildRoleSnapshot(ariaSnapshot) {
  const lines = ariaSnapshot.split('\n');
  const refs = {};
  const result = [];
  let counter = 0;
  const counts = new Map();

  for (const line of lines) {
    const match = line.match(/^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/);
    if (!match) { result.push(line); continue; }
    const [, prefix, roleRaw, name, suffix] = match;
    const role = roleRaw.toLowerCase();
    const isInteractive = INTERACTIVE_ROLES.has(role);
    const isContent = ['heading', 'cell', 'gridcell', 'columnheader', 'rowheader', 'listitem'].includes(role);
    if (!isInteractive && !(isContent && name)) { result.push(line); continue; }

    counter++;
    const ref = `e${counter}`;
    const key = `${role}:${name || ''}`;
    const nth = counts.get(key) || 0;
    counts.set(key, nth + 1);
    refs[ref] = { role, ...(name ? { name } : {}), nth };

    let enhanced = `${prefix}${roleRaw}`;
    if (name) enhanced += ` "${name}"`;
    enhanced += ` [ref=${ref}]`;
    if (nth > 0) enhanced += ` [nth=${nth}]`;
    if (suffix) enhanced += suffix;
    result.push(enhanced);
  }

  // ── 筛选栏文本拆分：将折叠的纯文本选项拆为独立 ref ──
  // 场景：header 中的筛选按钮 (<span> 元素) 缺少 ARIA role，
  // Playwright 把它们折叠成一行 "text: 全网内容 只看头条 不限时间"
  // 检测：2-5 个短词（2-6 字），含中文，不含纯数字
  const textReplacements = [];
  for (let i = 0; i < result.length; i++) {
    const line = result[i];
    const textMatch = line.match(/^(\s*)-\s*text:\s*(.+)$/);
    if (!textMatch) continue;
    const [, indent, textContent] = textMatch;
    const parts = textContent.trim().split(/\s+/);
    if (parts.length < 2) continue;
    if (!parts.every(p => p.length >= 1 && p.length <= 6)) continue;
    if (!parts.every(p => /[\u4e00-\u9fff]/.test(p))) continue;
    if (parts.some(p => /\d/.test(p))) continue;

    const enhancedLines = [];
    for (const part of parts) {
      counter++;
      const ref = `e${counter}`;
      refs[ref] = { role: 'button', name: part, nth: 0, virtual: true };
      enhancedLines.push(`${indent}- button "${part}" [ref=${ref}]`);
    }
    textReplacements.push({ index: i, replacement: enhancedLines });
  }
  for (const item of textReplacements.reverse()) {
    result.splice(item.index, 1, ...item.replacement);
  }

  return { snapshot: result.join('\n') || '(empty)', refs };
}

// 页面级 ref 缓存
const pageRefs = new Map(); // targetId -> refs

app.post('/snapshot', async (req, res) => {
  try {
    const targetId = req.body.targetId || (agentSessionId ? attachedSessions.get(agentSessionId)?.targetId : null);
    const page = await getPlaywrightPage(targetId);

    // 使用 Playwright 的 ariaSnapshot
    const ariaText = await page.locator('body').ariaSnapshot({ ref: true });
    const { snapshot, refs } = buildRoleSnapshot(ariaText);

    // 缓存 refs
    if (targetId) pageRefs.set(targetId, { refs, page });

    const url = page.url();
    const title = await page.title().catch(() => '');

    res.json({
      ok: true, snapshot, refs,
      stats: { lines: snapshot.split('\n').length, chars: snapshot.length, refs: Object.keys(refs).length },
      url, title, targetId
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Playwright Act 路由（统一交互接口） ──────────────
function refLocator(page, ref, refs) {
  const normalized = ref.startsWith('@') ? ref.slice(1) : ref.startsWith('ref=') ? ref.slice(4) : ref;
  if (/^e\d+$/.test(normalized) && refs?.[normalized]) {
    const info = refs[normalized];
    // 虚拟 ref（从文本拆分的筛选栏按钮）：原元素是 <span> 无 ARIA role，
    // getByRole 会失败，改用精确文本匹配
    if (info.virtual && info.name) {
      const textLoc = page.getByText(info.name, { exact: true });
      // 使用 last() 优先匹配下拉框选项（通常 append 在 body 末尾）
      return info.nth > 0 ? textLoc.nth(info.nth) : textLoc.last();
    }
    const locator = info.name
      ? page.getByRole(info.role, { name: info.name, exact: true })
      : page.getByRole(info.role);
    return info.nth > 0 ? locator.nth(info.nth) : locator;
  }
  return page.locator(normalized);
}

app.post('/act', async (req, res) => {
  try {
    const { kind, ref, text, key, submit, slowly, targetId: reqTargetId } = req.body;
    const targetId = reqTargetId || (agentSessionId ? attachedSessions.get(agentSessionId)?.targetId : null);
    const page = await getPlaywrightPage(targetId);
    const cachedRefs = targetId ? pageRefs.get(targetId)?.refs : null;
    const timeout = Math.max(500, Math.min(60000, req.body.timeoutMs || 5000));

    // ── 坐标归一化处理（千分位 → 绝对像素） ──
    if (req.body.coordType === 'normalized') {
      const viewport = page.viewportSize();
      if (!viewport) throw new Error('Cannot get viewport size for coordinate normalization');
      const normalize = (v, max) => Math.round(v * max / 1000);
      for (const k of ['x', 'y', 'originX', 'originY', 'startX', 'startY', 'endX', 'endY']) {
        if (typeof req.body[k] === 'number') {
          const isX = k.toLowerCase().includes('x');
          req.body[k] = normalize(req.body[k], isX ? viewport.width : viewport.height);
        }
      }
    }

    // ── 确保 refs 缓存（首次 act 或 navigate 后自动加载） ──
    if (!cachedRefs) {
      try {
        const ariaText = await page.locator('body').ariaSnapshot({ ref: true });
        const built = buildRoleSnapshot(ariaText);
        if (targetId) pageRefs.set(targetId, { refs: built.refs, page });
        cachedRefs = built.refs;
      } catch {}
    }

    // ── 记录操作前的 Tab 列表和页面 URL ──
    const urlBefore = page.url();
    let pagesBefore = [];
    let urlsBefore = new Set();
    try {
      const pwBrowser = await ensurePlaywright();
      pagesBefore = pwBrowser.contexts().flatMap(c => c.pages());
      urlsBefore = new Set(pagesBefore.map(p => p.url()));
    } catch (e) {
      // Playwright 不可用时降级到 knownTargets
      urlsBefore = new Set(Array.from(knownTargets.values()).map(t => t.url || ''));
    }

    switch (kind) {
      case 'click': {
        if (!ref) return res.status(400).json({ error: 'ref required' });
        const loc = refLocator(page, ref, cachedRefs);
        if (req.body.doubleClick) await loc.dblclick({ timeout });
        else await loc.click({ timeout });
        break;
      }
      case 'type': {
        if (!ref) return res.status(400).json({ error: 'ref required' });
        const loc = refLocator(page, ref, cachedRefs);
        if (slowly) {
          await loc.click({ timeout });
          await page.keyboard.type(text || '', { delay: 75 });
        } else {
          await loc.fill(text || '', { timeout });
        }
        if (submit) await loc.press('Enter', { timeout });
        break;
      }
      case 'press': {
        if (!key) return res.status(400).json({ error: 'key required' });
        await page.keyboard.press(key);
        break;
      }
      case 'hover': {
        if (!ref) return res.status(400).json({ error: 'ref required' });
        await refLocator(page, ref, cachedRefs).hover({ timeout });
        break;
      }
      case 'select': {
        if (!ref) return res.status(400).json({ error: 'ref required' });
        if (req.body.option) {
          // 复合选择：点击下拉框 → 等待 → 按文本选中选项
          const loc = refLocator(page, ref, cachedRefs);
          try {
            await loc.click({ timeout });
          } catch {
            // React Select 的 combobox role 在不可见的 <input> 上，
            // 通过 evaluate 派发 mousedown 触发下拉菜单
            await loc.evaluate(el => {
              el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
              el.focus();
            });
          }
          await page.waitForTimeout(300);
          await page.getByText(req.body.option, { exact: true }).first().click();
        } else {
          await refLocator(page, ref, cachedRefs).selectOption(req.body.values || [], { timeout });
        }
        break;
      }
      case 'scrollIntoView': {
        if (!ref) return res.status(400).json({ error: 'ref required' });
        await refLocator(page, ref, cachedRefs).scrollIntoViewIfNeeded({ timeout });
        break;
      }

      // ── 坐标操作类（与 EasyClaw 对齐） ──────────────────

      case 'clickAt': {
        // 基于像素坐标点击（坐标由调用方负责归一化转换）
        const x = req.body.x;
        const y = req.body.y;
        if (typeof x !== 'number' || typeof y !== 'number') {
          return res.status(400).json({ error: 'x and y are required (numbers)' });
        }
        const button = req.body.button || 'left';
        const doubleClick = req.body.doubleClick || false;
        // 移动鼠标到目标位置
        await page.mouse.move(Math.floor(x), Math.floor(y));
        if (doubleClick) {
          await page.mouse.dblclick(Math.floor(x), Math.floor(y), { button });
        } else {
          await page.mouse.click(Math.floor(x), Math.floor(y), { button });
        }
        break;
      }
      case 'hoverAt': {
        // 基于像素坐标悬停（触发 CSS :hover 和 mouseover 事件）
        const x = req.body.x;
        const y = req.body.y;
        if (typeof x !== 'number' || typeof y !== 'number') {
          return res.status(400).json({ error: 'x and y are required (numbers)' });
        }
        await page.mouse.move(Math.floor(x), Math.floor(y));
        break;
      }
      case 'scroll': {
        // 基于坐标滚动（先移动鼠标到指定位置，再滚动）
        const dx = req.body.x || 0;
        const dy = req.body.y || 0;
        // 可选：先移动到指定的滚动锚点位置
        if (req.body.originX !== undefined && req.body.originY !== undefined) {
          await page.mouse.move(Math.floor(req.body.originX), Math.floor(req.body.originY));
        }
        await page.mouse.wheel(dx, dy);
        break;
      }
      case 'dragAt': {
        // 基于坐标拖拽
        const startX = req.body.startX;
        const startY = req.body.startY;
        const endX = req.body.endX;
        const endY = req.body.endY;
        if ([startX, startY, endX, endY].some(v => typeof v !== 'number')) {
          return res.status(400).json({ error: 'startX, startY, endX, endY are required (numbers)' });
        }
        await page.mouse.move(Math.floor(startX), Math.floor(startY));
        await page.mouse.down();
        await page.mouse.move(Math.floor(endX), Math.floor(endY));
        await page.mouse.up();
        break;
      }
      case 'typeAt': {
        // 在坐标位置点击后输入文字
        const x = req.body.x;
        const y = req.body.y;
        if (typeof x !== 'number' || typeof y !== 'number') {
          return res.status(400).json({ error: 'x and y are required (numbers)' });
        }
        if (!text) return res.status(400).json({ error: 'text required' });
        await page.mouse.click(Math.floor(x), Math.floor(y));
        await page.keyboard.type(text, { delay: slowly ? 75 : 0 });
        if (submit) await page.keyboard.press('Enter');
        break;
      }

      // ── 语义 Ref 操作类（补齐） ──────────────────────────

      case 'drag': {
        // ref 到 ref 拖拽
        const startRef = req.body.startRef || ref;
        const endRef = req.body.endRef;
        if (!startRef || !endRef) {
          return res.status(400).json({ error: 'startRef and endRef are required' });
        }
        await refLocator(page, startRef, cachedRefs).dragTo(
          refLocator(page, endRef, cachedRefs),
          { timeout }
        );
        break;
      }
      case 'fill': {
        // 批量填表：fields = [{ ref, type, value }, ...]
        const fields = req.body.fields;
        if (!Array.isArray(fields) || !fields.length) {
          return res.status(400).json({ error: 'fields array is required' });
        }
        for (const field of fields) {
          if (!field.ref || !field.type) continue;
          const loc = refLocator(page, field.ref, cachedRefs);
          switch (field.type) {
            case 'text':
              await loc.fill(String(field.value ?? ''), { timeout });
              break;
            case 'checkbox':
              if (field.value) await loc.check({ timeout });
              else await loc.uncheck({ timeout });
              break;
            case 'radio':
              await loc.check({ timeout });
              break;
            case 'select':
              await loc.selectOption(String(field.value ?? ''), { timeout });
              break;
            default:
              await loc.fill(String(field.value ?? ''), { timeout });
          }
        }
        break;
      }
      case 'evaluate': {
        // 在页面上下文执行 JS（与 /eval 端点逻辑一致，但统一到 /act 路由）
        const fn = req.body.fn || text;
        if (!fn) return res.status(400).json({ error: 'fn (JavaScript expression) required' });
        let evalResult;
        if (ref) {
          // 在指定元素上下文中执行
          evalResult = await refLocator(page, ref, cachedRefs).evaluate(
            new Function('el', fn)
          );
        } else {
          evalResult = await page.evaluate(fn);
        }
        return res.json({ ok: true, targetId, url: page.url(), result: evalResult });
      }

      // ── 全局操作类（补齐） ──────────────────────────────

      case 'typev': {
        // 系统粘贴（降级为 insertText，效果等价于 Ctrl+V）
        if (!text) return res.status(400).json({ error: 'text required' });
        await page.keyboard.insertText(text);
        if (submit) await page.keyboard.press('Enter');
        break;
      }
      case 'resize': {
        // 改变视口尺寸
        const width = req.body.width;
        const height = req.body.height;
        if (typeof width !== 'number' || typeof height !== 'number') {
          return res.status(400).json({ error: 'width and height are required (numbers)' });
        }
        await page.setViewportSize({ width: Math.floor(width), height: Math.floor(height) });
        break;
      }
      case 'wait': {
        // 等待条件满足
        const timeMs = req.body.timeMs;
        const waitText = req.body.text || text;
        const textGone = req.body.textGone;
        const selector = req.body.selector;
        const url = req.body.url;
        const waitTimeout = req.body.timeoutMs || 30000;

        if (timeMs) {
          await page.waitForTimeout(timeMs);
        }
        if (waitText) {
          await page.waitForSelector(`text=${waitText}`, { timeout: waitTimeout });
        }
        if (textGone) {
          await page.waitForSelector(`text=${textGone}`, { state: 'hidden', timeout: waitTimeout });
        }
        if (selector) {
          await page.waitForSelector(selector, { timeout: waitTimeout });
        }
        if (url) {
          await page.waitForURL(url, { timeout: waitTimeout });
        }
        break;
      }
      case 'close': {
        // 关闭当前标签页
        await page.close();
        break;
      }

      default:
        return res.status(400).json({ error: `Unknown kind: ${kind}` });
    }

    // ── 检查页面是否导航了（用 URL 变化检测，非盲等） ──
    try {
      const urlAfter = page.url();
      if (urlAfter !== urlBefore) {
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      }
    } catch {}

    // ── 获取当前 Tab 的 snapshot ──
    let snapshot = null, refs = null;
    try {
      const ariaText = await page.locator('body').ariaSnapshot({ ref: true });
      const built = buildRoleSnapshot(ariaText);
      snapshot = built.snapshot;
      refs = built.refs;
      if (targetId) pageRefs.set(targetId, { refs, page });
    } catch (snapErr) {
      console.log(`[act] snapshot 静默降级: ${snapErr.message}`);
    }

    // ── 检测新 Tab（用 Playwright page 身份对比，不依赖 URL） ──
    let newTab = null;
    try {
      const pwBrowser = await ensurePlaywright();
      let pagesAfter = pwBrowser.contexts().flatMap(c => c.pages());
      let newPage = pagesAfter.find(p => !pagesBefore.includes(p));
      // Playwright 创建 Page 对象是异步的，等一会再试（最长 2s）
      if (!newPage) {
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 200));
          pagesAfter = pwBrowser.contexts().flatMap(c => c.pages());
          newPage = pagesAfter.find(p => !pagesBefore.includes(p));
          if (newPage) break;
        }
      }
      if (newPage) {
        let matchTargetId = null;
        for (const [tid, info] of knownTargets.entries()) {
          if (info.url === newPage.url()) { matchTargetId = tid; break; }
        }
        if (!matchTargetId) matchTargetId = '___new_tab___';
        newTab = { targetId: matchTargetId, url: newPage.url(), title: await newPage.title().catch(() => '') };
      }
    } catch (e) {
      // Playwright 不可用时降级到 knownTargets
      for (const [tid, info] of knownTargets.entries()) {
        if (!urlsBefore.has(info.url) && (info.type === 'page' || !info.type)) {
          newTab = { targetId: tid, url: info.url || '', title: info.title || '' };
          break;
        }
      }
    }

    // ── 如果有新 Tab，尝试获取新 Tab 的 snapshot ──
    let newTabSnapshot = null;
    if (newTab) {
      try {
        const newPage = await getPlaywrightPage(newTab.targetId);
        // 等待新页面基本加载
        await newPage.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
        const newAriaText = await newPage.locator('body').ariaSnapshot({ ref: true });
        const newBuilt = buildRoleSnapshot(newAriaText);
        newTabSnapshot = { snapshot: newBuilt.snapshot, refs: newBuilt.refs, url: newPage.url() };
        pageRefs.set(newTab.targetId, { refs: newBuilt.refs, page: newPage });
      } catch (e) {
        console.log(`[act] 新 Tab snapshot 失败: ${e.message}`);
      }
    }

    // ── 构造统一返回 ──
    const result = { ok: true, targetId, url: page.url() };
    if (snapshot) {
      if (!req.body.compact) result.snapshot = snapshot;
      result.refs = refs;
      result.stats = { refs: Object.keys(refs).length };
    }
    if (newTab) { result.newTab = newTab; }
    if (newTabSnapshot) { result.newTabSnapshot = newTabSnapshot; }

    // 人类可读摘要
    const parts = [];
    if (snapshot) parts.push(`页面快照已获取 (${Object.keys(refs).length} 个交互元素)`);
    if (newTab) parts.push(`⚠️ 新标签页已打开: ${newTab.url || newTab.title || newTab.targetId} — 需 switch_tab 切换`);
    if (newTabSnapshot) parts.push(`新标签页快照已预加载`);
    result.actionSummary = parts.join('；') || '操作已完成';
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 带标签的截图（照搬 EasyClaw screenshotWithLabels） ──────────────
app.post('/screenshot_with_labels', async (req, res) => {
  try {
    const targetId = req.body.targetId || (agentSessionId ? attachedSessions.get(agentSessionId)?.targetId : null);
    const page = await getPlaywrightPage(targetId);
    const maxLabels = typeof req.body.maxLabels === 'number' ? Math.max(1, req.body.maxLabels) : 500;
    const filterMode = req.body.filterMode || 'clickable'; // clickable | viewport | none

    // 1. 获取 snapshot 和 refs
    const ariaText = await page.locator('body').ariaSnapshot({ ref: true });
    const { snapshot, refs } = buildRoleSnapshot(ariaText);
    if (targetId) pageRefs.set(targetId, { refs, page });

    // 2. 获取 viewport 信息
    const viewport = await page.evaluate(() => ({
      scrollX: window.scrollX || 0, scrollY: window.scrollY || 0,
      width: window.innerWidth || 0, height: window.innerHeight || 0,
    }));

    // 3. 遍历 refs，获取可见元素的边界框
    const refKeys = Object.keys(refs);
    const boxes = [];
    let skipped = 0;

    for (const ref of refKeys) {
      if (boxes.length >= maxLabels) { skipped++; continue; }
      try {
        const loc = refLocator(page, ref, refs);
        if (filterMode === 'clickable') {
          // 合并检测：可见性 + 遮挡 + 边界框
          const result = await loc.evaluate((el) => {
            const style = getComputedStyle(el);
            if (style.visibility === 'hidden') return { skip: true };
            if (style.display === 'none') return { skip: true };
            if (parseFloat(style.opacity) === 0) return { skip: true };
            if (style.pointerEvents === 'none') return { skip: true };
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return { skip: true };
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const topEl = document.elementFromPoint(cx, cy);
            if (topEl !== el && !el.contains(topEl)) return { skip: true };
            return { skip: false, box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
          });
          if (result.skip) { skipped++; continue; }
          const box = result.box;
          // 视口裁剪
          if (box.x + box.width < 0 || box.x > viewport.width || box.y + box.height < 0 || box.y > viewport.height) {
            skipped++; continue;
          }
          boxes.push({ ref, x: box.x, y: box.y, w: Math.max(1, box.width), h: Math.max(1, box.height) });
        } else if (filterMode === 'viewport') {
          const box = await loc.boundingBox();
          if (!box) { skipped++; continue; }
          if (box.x + box.width < 0 || box.x > viewport.width || box.y + box.height < 0 || box.y > viewport.height) {
            skipped++; continue;
          }
          boxes.push({ ref, x: box.x - viewport.scrollX, y: box.y - viewport.scrollY, w: Math.max(1, box.width), h: Math.max(1, box.height) });
        } else {
          const box = await loc.boundingBox();
          if (!box) { skipped++; continue; }
          boxes.push({ ref, x: box.x - viewport.scrollX, y: box.y - viewport.scrollY, w: Math.max(1, box.width), h: Math.max(1, box.height) });
        }
      } catch { skipped++; }
    }

    // 4. 注入标签层
    if (boxes.length > 0) {
      await page.evaluate((labels) => {
        const existing = document.querySelectorAll('[data-cloudhand-labels]');
        existing.forEach(el => el.remove());
        const root = document.createElement('div');
        root.setAttribute('data-cloudhand-labels', '1');
        root.style.position = 'fixed';
        root.style.left = '0'; root.style.top = '0';
        root.style.zIndex = '2147483647';
        root.style.pointerEvents = 'none';
        root.style.fontFamily = 'monospace';
        for (const label of labels) {
          // 边框
          const box = document.createElement('div');
          box.setAttribute('data-cloudhand-labels', '1');
          box.style.position = 'absolute';
          box.style.left = label.x + 'px'; box.style.top = label.y + 'px';
          box.style.width = label.w + 'px'; box.style.height = label.h + 'px';
          box.style.border = '2px solid #ffb020'; box.style.boxSizing = 'border-box';
          // 标签文字
          const tag = document.createElement('div');
          tag.setAttribute('data-cloudhand-labels', '1');
          tag.textContent = label.ref;
          tag.style.position = 'absolute';
          tag.style.left = label.x + 'px';
          tag.style.top = Math.max(0, label.y - 18) + 'px';
          tag.style.background = '#ffb020'; tag.style.color = '#1a1a1a';
          tag.style.fontSize = '12px'; tag.style.lineHeight = '14px';
          tag.style.padding = '1px 4px'; tag.style.borderRadius = '3px';
          tag.style.boxShadow = '0 1px 2px rgba(0,0,0,0.35)';
          tag.style.whiteSpace = 'nowrap';
          root.appendChild(box); root.appendChild(tag);
        }
        document.documentElement.appendChild(root);
      }, boxes);
    }

    // 5. 截图（带超时防护，绕过字体加载卡死）
    let buffer;
    try {
      // 先停止页面加载，防止 Playwright 死等字体
      await page.evaluate(() => { try { window.stop(); } catch {} }).catch(() => {});
      buffer = await Promise.race([
        page.screenshot({ type: 'png' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Screenshot timeout 15s')), 15000))
      ]);
    } catch (screenshotErr) {
      // 截图失败，清除标签层后降级返回纯文本 snapshot
      await page.evaluate(() => {
        const existing = document.querySelectorAll('[data-cloudhand-labels]');
        existing.forEach(el => el.remove());
      }).catch(() => {});
      return res.json({
        ok: true, data: null,
        snapshot, refs, labels: boxes.length, skipped,
        stats: { refs: Object.keys(refs).length },
        url: page.url(), targetId,
        screenshotError: screenshotErr.message
      });
    }

    // 6. 清除标签层
    await page.evaluate(() => {
      const existing = document.querySelectorAll('[data-cloudhand-labels]');
      existing.forEach(el => el.remove());
    }).catch(() => {});

    const base64 = buffer.toString('base64');
    res.json({
      ok: true,
      data: `data:image/png;base64,${base64}`,
      snapshot, refs, labels: boxes.length, skipped,
      stats: { refs: Object.keys(refs).length },
      url: page.url(), targetId
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 配对码已移除（v2.7.0）。远程模式使用 Token 直连：ws://ip:port/ws?token=xxx

// ── 启动服务器 ──────────────────────────────────────────
server.listen(PORT, HOST, () => {
  console.log(`[CloudHand] CDP Bridge v2.7.0 已启动: http://${HOST}:${PORT}`);
  console.log(`[CloudHand] 模式: ${LOCAL_MODE ? '本地' : '远程'}`);
  console.log(`[CloudHand] /cdp WebSocket 端点已就绪（供 Playwright 连接）`);
  console.log(`[CloudHand] 等待 Chrome 扩展连接...`);
});

