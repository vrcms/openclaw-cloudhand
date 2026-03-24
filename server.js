const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 9876;
const HOST = process.env.HOST || '0.0.0.0';
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
    // 重连成功，取消清空定时器
    if (agentWindows._clearTimer) {
      clearTimeout(agentWindows._clearTimer);
      agentWindows._clearTimer = null;
      console.log('[Agent] Browser reconnected, cancelled window clear timer');
    }
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
      const { requestId, result, error, type, windowId, tabId } = msg;
      // 处理扩展主动推送的事件
      if (type === 'window_removed' && windowId) {
        if (agentWindows.has(windowId)) {
          agentWindows.delete(windowId);
          console.log(`[Agent] Window ${windowId} closed by user, removed from tracking`);
        }
      } else if (type === 'tab_removed') {
        // tab 关闭时不需要特殊处理，window_removed 会处理窗口级别
      } else if (requestId && pendingRequests[requestId]) {
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
    if (extensionSocket === ws) {
      extensionSocket = null;
      // 延迟 60 秒再清空，给网络抖动留重连时间
      if (agentWindows._clearTimer) clearTimeout(agentWindows._clearTimer);
      agentWindows._clearTimer = setTimeout(() => {
        if (!extensionSocket) {
          agentWindows.clear();
          console.log('[Agent] Browser offline >60s, cleared all tracked windows');
        }
      }, 60000);
    }
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
// 返回 bridge 的连接配置，供扩展首次安装时自动填入
app.get('/config', (req, res) => {
  // 优先用环境变量 PUBLIC_IP，其次读配置文件，最后 fallback 到网卡 IP
  const os = require('os');
  const fs2 = require('fs');
  let publicIp = process.env.PUBLIC_IP || null;
  if (!publicIp) {
    try {
      const cfg = JSON.parse(fs2.readFileSync(CONFIG_FILE, 'utf8'));
      publicIp = cfg.publicIp || null;
    } catch {}
  }
  if (!publicIp) {
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          publicIp = addr.address;
          break;
        }
      }
      if (publicIp) break;
    }
  }
  res.json({
    wsUrl: `ws://${publicIp}:${PORT}/ws`,
    port: PORT
  });
});

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

// ── Agent 管理的窗口列表 ──────────────────────────────────
const agentWindows = new Set(); // 记录 agent 开的所有 windowId
let currentAgentTabId = null; // 当前 agent 操作的 tab

// ── 浏览器操作 API ──────────────────────────────────────
const route = (cmd, extract) => async (req, res) => {
  const params = req.method === 'GET' ? req.query : req.body || {};
  try {
    // 对需要 tab 的操作，自动注入 currentAgentTabId（如果没有指定 tabId）
    const TAB_CMDS = ['navigate','screenshot','get_html','get_text','click','type','key','scroll',
      'wait_for','hover','find_elements','set_value','go_back','go_forward','select','eval','page_info'];
    if (TAB_CMDS.includes(cmd) && !params.tabId && currentAgentTabId) {
      params.tabId = currentAgentTabId;
    }
    const result = await sendCommand(cmd, params);
    // 自动记录 agent 开的窗口和 tab
    if (cmd === 'new_window' && result && result.windowId) {
      agentWindows.add(result.windowId);
      currentAgentTabId = result.tabId || null;
      console.log(`[Agent] Tracking window ${result.windowId}, tab ${currentAgentTabId}`);
    }
    if (cmd === 'new_tab' && result && result.tabId) {
      currentAgentTabId = result.tabId;
      console.log(`[Agent] Current agent tab: ${currentAgentTabId}`);
    }
    res.json({ ok: true, result });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
};

// 查询 agent 管理的窗口
app.get('/agent_windows', async (req, res) => {
  try {
    // 浏览器未连接时，只有已触发超时清空才返回空（短暂抖动不清空）
    if (!extensionSocket || extensionSocket.readyState !== extensionSocket.OPEN) {
      // 如果定时器还在跑，说明是短暂断线，保留旧数据
      if (agentWindows._clearTimer) {
        return res.json({ ok: true, windowIds: Array.from(agentWindows), reconnecting: true });
      }
      agentWindows.clear();
      return res.json({ ok: true, windowIds: [] });
    }
    // 通过 tabs 列表验证窗口是否还存在，自动清理已关闭的
    const tabs = await sendCommand('tabs', {});
    const liveWindowIds = new Set(tabs.map(t => t.windowId));
    for (const wid of Array.from(agentWindows)) {
      if (!liveWindowIds.has(wid)) {
        agentWindows.delete(wid);
        console.log(`[Agent] Window ${wid} no longer exists, removed from tracking`);
      }
    }
  } catch (e) {
    // 出错时清空，宁可重建也不用死数据
    agentWindows.clear();
    console.log('[Agent] Error checking windows, cleared tracking:', e.message);
  }
  res.json({ ok: true, windowIds: Array.from(agentWindows) });
});

// 关闭所有 agent 管理的窗口
app.post('/agent_windows/close_all', async (req, res) => {
  const ids = Array.from(agentWindows);
  const results = [];
  for (const wid of ids) {
    try {
      await sendCommand('close_window', { windowId: wid });
      agentWindows.delete(wid);
      results.push({ windowId: wid, ok: true });
    } catch (e) {
      results.push({ windowId: wid, error: e.message });
    }
  }
  res.json({ ok: true, closed: results });
});

app.get('/tabs', async (req, res) => {
  try { res.json({ ok: true, tabs: await sendCommand('tabs', {}) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/page_info', route('page_info'));

['navigate','screenshot','get_html','get_text','click','type','key','scroll',
 'wait_for','get_cookies','new_tab','new_window','close_tab','focus_tab','hover','hotkey',
 'find_elements','set_value','go_back','go_forward','select','eval'].forEach(cmd => {
  app.post('/' + cmd, route(cmd));
});

// ── 启动 ────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  console.log(`Chrome Bridge Server running on http://${HOST}:${PORT}`);
  console.log(`WebSocket endpoint: ws://${HOST}:${PORT}/ws`);
  console.log(`Config: ${CONFIG_FILE}`);
  console.log(`Paired: ${!!config.sessionToken}`);
});
