const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 9876;
const HOST = process.env.HOST || '127.0.0.1';
const CONFIG_FILE = path.join(process.env.HOME || '/root', '.openclaw/chrome-bridge/config.json');

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

// 内存中的 challenge（30秒有效，一次性）
let pendingChallenge = null; // { code, expiresAt }

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

let extensionSocket = null;
let pendingRequests = {};

// ── WebSocket 连接处理 ──────────────────────────────────
wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const token = params.get('token');
  const challenge = params.get('challenge');

  // 方式1：challenge 配对（首次连接）
  if (challenge) {
    if (!pendingChallenge || Date.now() > pendingChallenge.expiresAt) {
      ws.close(1008, 'Challenge expired or not found');
      console.log('[WS] Rejected: challenge expired');
      return;
    }
    if (challenge !== pendingChallenge.code) {
      ws.close(1008, 'Invalid challenge');
      console.log('[WS] Rejected: invalid challenge');
      return;
    }
    // challenge 验证通过，生成 session token
    const sessionToken = crypto.randomBytes(64).toString('hex');
    config.sessionToken = sessionToken;
    config.sessionCreatedAt = new Date().toISOString();
    saveConfig(config);
    pendingChallenge = null; // 一次性，用完作废
    console.log('[WS] Challenge verified, session token generated');
    // 把 session token 发给扩展
    ws.send(JSON.stringify({ type: 'paired', sessionToken }));
    // 关闭旧连接
    if (extensionSocket && extensionSocket.readyState === extensionSocket.OPEN) {
      extensionSocket.close(1000, 'New connection replacing old');
    }
    extensionSocket = ws;
    setupSocket(ws);
    return;
  }

  // 方式2：session token（已配对，自动重连）
  if (token && token === config.sessionToken) {
    console.log('[WS] Chrome extension connected with session token');
    if (extensionSocket && extensionSocket.readyState === extensionSocket.OPEN) {
      extensionSocket.close(1000, 'New connection replacing old');
    }
    extensionSocket = ws;
    setupSocket(ws);
    return;
  }

  ws.close(1008, 'Unauthorized');
  console.log('[WS] Rejected unauthorized connection');
});

function setupSocket(ws) {
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      const { requestId, result, error } = msg;
      if (requestId && pendingRequests[requestId]) {
        const { resolve, reject, timeout } = pendingRequests[requestId];
        clearTimeout(timeout);
        delete pendingRequests[requestId];
        if (error) reject(new Error(error));
        else resolve(result);
      }
    } catch (e) {
      console.error('[WS] Parse error:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Extension disconnected');
    if (extensionSocket === ws) extensionSocket = null;
    clearInterval(pingInterval);
    Object.values(pendingRequests).forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(new Error('Extension disconnected'));
    });
    pendingRequests = {};
  });

  ws.on('error', (e) => console.error('[WS] Error:', e.message));

  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
    else clearInterval(pingInterval);
  }, 30000);
}

// ── 发送指令给扩展 ──────────────────────────────────────
function sendCommand(command, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== extensionSocket.OPEN) {
      return reject(new Error('Extension not connected'));
    }
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      delete pendingRequests[requestId];
      reject(new Error('Command timeout: ' + command));
    }, timeoutMs);
    pendingRequests[requestId] = { resolve, reject, timeout };
    extensionSocket.send(JSON.stringify({ requestId, command, params }));
  });
}

// ── REST API ────────────────────────────────────────────

// 状态
app.get('/status', (req, res) => {
  res.json({
    connected: extensionSocket?.readyState === extensionSocket?.OPEN,
    pendingRequests: Object.keys(pendingRequests).length,
    paired: !!config.sessionToken,
    sessionCreatedAt: config.sessionCreatedAt || null
  });
});

// ── 配对 API（供 OpenClaw 调用）──────────────────────────

// 生成 challenge（OpenClaw 调用，返回6位码）
app.post('/pair/challenge', (req, res) => {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  pendingChallenge = { code, expiresAt: Date.now() + 30000 };
  console.log(`[Pair] Challenge generated: ${code}`);
  res.json({ code, expiresAt: pendingChallenge.expiresAt });
});

// 吊销 session（断开连接）
app.post('/pair/revoke', (req, res) => {
  config.sessionToken = null;
  config.sessionCreatedAt = null;
  saveConfig(config);
  if (extensionSocket && extensionSocket.readyState === extensionSocket.OPEN) {
    extensionSocket.close(1000, 'Session revoked');
  }
  pendingChallenge = null;
  console.log('[Pair] Session revoked');
  res.json({ ok: true });
});

// ── 浏览器操作 API ──────────────────────────────────────
const route = (cmd, extract) => async (req, res) => {
  const params = req.method === 'GET' ? req.query : req.body || {};
  try { res.json({ ok: true, ...(extract ? { result: await sendCommand(cmd, params) } : { result: await sendCommand(cmd, params) }) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
};

app.get('/tabs', async (req, res) => {
  try { res.json({ ok: true, tabs: await sendCommand('tabs', {}) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/page_info', route('page_info'));

['navigate','screenshot','get_html','get_text','click','type','key','scroll',
 'wait_for','get_cookies','new_tab','close_tab','focus_tab','hover','hotkey',
 'find_elements','set_value','go_back','go_forward','select'].forEach(cmd => {
  app.post('/' + cmd, route(cmd));
});

// ── 启动 ────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  console.log(`Chrome Bridge Server running on http://${HOST}:${PORT}`);
  console.log(`WebSocket endpoint: ws://${HOST}:${PORT}/ws`);
  console.log(`Config: ${CONFIG_FILE}`);
  console.log(`Paired: ${!!config.sessionToken}`);
});
