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

// 如果没有 apiToken，自动生成一个并持久化
if (!config.apiToken) {
  config.apiToken = crypto.randomBytes(32).toString('hex');
  saveConfig(config);
  console.log('[Auth] Generated new apiToken');
}

// 内存中的 challenge（30秒有效，一次性）
let pendingChallenge = null; // { code, expiresAt }

const app = express();
app.use(express.json());

// CORS：只允许 Chrome 扩展和本地访问
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

// 免鉴权端点白名单
const PUBLIC_PATHS = new Set(['/status', '/config', '/pair/challenge', '/pair/revoke', '/token', '/download-ext']);

// Bearer Token 鉴权中间件
app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  const auth = req.headers['authorization'] || '';
  const qtoken = req.query.token || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : qtoken;
  if (token && token === config.apiToken) return next();
  res.status(401).json({ error: 'Unauthorized. Pass Authorization: Bearer <apiToken>' });
});
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

// 一次性下载 token { token -> expiresAt }
const dlTokens = new Map();

// 生成扩展下载链接（需要 Bearer Token，返回 60 秒有效的一次性链接）
app.post('/gen-download-link', (req, res) => {
  const pluginDir = path.join(process.env.HOME || '/root', '.openclaw/extensions/cloudhand');
  const zipPath = path.join(pluginDir, 'extension.zip');
  // zip 不存在时自动重新打包
  if (!fs.existsSync(zipPath)) {
    try {
      const extDir = path.join(pluginDir, 'extension');
      const os = require('os');
      const tmpDir = path.join(os.tmpdir(), 'cloudhand-ext-build');
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      for (const f of fs.readdirSync(extDir)) {
        fs.copyFileSync(path.join(extDir, f), path.join(tmpDir, f));
      }
      let publicIp2 = '127.0.0.1';
      try { publicIp2 = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).publicIp || publicIp2; } catch(e) {}
      const configJs = `// Auto-generated\nexport const CLOUDHAND_CONFIG = { wsUrl: 'ws://${publicIp2}:${PORT}/ws', port: ${PORT} };\n`;
      fs.writeFileSync(path.join(tmpDir, 'config.js'), configJs);
      require('child_process').execSync(`cd '${tmpDir}' && zip -r '${zipPath}' .`, { stdio: 'ignore' });
      console.log('[cloudhand] Extension zip rebuilt for download');
    } catch(e) {
      return res.status(500).json({ error: 'Failed to build extension zip: ' + e.message });
    }
  }
  const dlToken = crypto.randomBytes(24).toString('hex');
  dlTokens.set(dlToken, Date.now() + 60000);
  setTimeout(() => dlTokens.delete(dlToken), 60000);
  // 读取公网 IP
  let publicIp = '127.0.0.1';
  try {
    const bc = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    publicIp = bc.publicIp || publicIp;
  } catch(e) {}
  const url = `http://${publicIp}:${PORT}/download-ext?t=${dlToken}`;
  res.json({ url, expiresIn: 60 });
});

// 一次性下载端点（无需鉴权，但 dltoken 必须有效）
app.get('/download-ext', (req, res) => {
  const t = req.query.t || '';
  const expiresAt = dlTokens.get(t);
  if (!t || !expiresAt || Date.now() > expiresAt) {
    return res.status(401).json({ error: 'Invalid or expired download token.' });
  }
  dlTokens.delete(t);
  const pluginDir = path.join(process.env.HOME || '/root', '.openclaw/extensions/cloudhand');
  const zipPath = path.join(pluginDir, 'extension.zip');
  if (!fs.existsSync(zipPath)) {
    return res.status(404).json({ error: 'Extension zip not found.' });
  }
  res.download(zipPath, 'cloudhand-extension.zip', (err) => {
    if (!err) {
      try { fs.unlinkSync(zipPath); } catch(e) {}
      console.log('[cloudhand] Extension zip downloaded and deleted.');
    }
  });
});

// 获取 apiToken（仅限 127.0.0.1 本机访问）
app.get('/token', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || '';
  if (!ip.includes('127.0.0.1') && !ip.includes('::1')) {
    return res.status(403).json({ error: 'Local access only' });
  }
  res.json({ apiToken: config.apiToken });
});

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

// challenge 速率限制（每个 IP 每分钟最多 5 次）
const challengeRateLimit = new Map(); // ip -> { count, resetAt }
function checkChallengeRate(ip) {
  const now = Date.now();
  const entry = challengeRateLimit.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
  entry.count++;
  challengeRateLimit.set(ip, entry);
  return entry.count <= 5;
}

// 生成 challenge（OpenClaw 调用，返回6位码）
app.post('/pair/challenge', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!checkChallengeRate(ip)) {
    return res.status(429).json({ error: 'Too many requests. Max 5 per minute.' });
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  pendingChallenge = { code, expiresAt: Date.now() + 30000 };
  console.log(`[Pair] Challenge generated: ${code}`);
  res.json({ code, expiresAt: pendingChallenge.expiresAt });
});

// 吊销 session（断开连接，需要 Bearer Token）
app.post('/pair/revoke', (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
  if (!token || token !== config.apiToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
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
// 注入 Agent 操作提示条（显示在页面右上角）
const INDICATOR_CMDS = ['navigate','click','type','key','scroll','set_value','go_back','go_forward','select','eval','hover'];

async function showAgentIndicator(tabId, action) {
  const label = {
    navigate: '🤖 导航中...', click: '🤖 点击中...', type: '🤖 输入中...',
    key: '🤖 按键中...', scroll: '🤖 滚动中...', set_value: '🤖 填值中...',
    go_back: '🤖 后退...', go_forward: '🤖 前进...', select: '🤖 选择中...',
    eval: '🤖 执行JS...', hover: '🤖 悬停中...'
  }[action] || '🤖 AI操作中...';
  const js = `
    (function(){
      var id='__agent_indicator__';
      var el=document.getElementById(id);
      if(!el){el=document.createElement('div');el.id=id;
        el.style.cssText='position:fixed;top:12px;right:12px;z-index:2147483647;background:rgba(30,30,30,0.92);color:#fff;padding:8px 16px;border-radius:8px;font-size:14px;font-family:sans-serif;box-shadow:0 2px 12px rgba(0,0,0,0.4);pointer-events:none;transition:opacity 0.3s;';
        document.body.appendChild(el);}
      el.textContent='${label}';
      el.style.opacity='1';
      clearTimeout(el._hideTimer);
    })();
  `;
  try { await sendCommand('eval', { tabId, expression: js }); } catch(e) {}
}

async function hideAgentIndicator(tabId) {
  const js = `
    (function(){
      var el=document.getElementById('__agent_indicator__');
      if(el){el.style.opacity='0';el._hideTimer=setTimeout(function(){el.remove();},400);}
    })();
  `;
  try { await sendCommand('eval', { tabId, expression: js }); } catch(e) {}
}

const route = (cmd, extract) => async (req, res) => {
  const params = req.method === 'GET' ? req.query : req.body || {};
  try {
    // 对需要 tab 的操作，自动注入 currentAgentTabId（如果没有指定 tabId）
    const TAB_CMDS = ['navigate','screenshot','get_html','get_text','click','type','key','scroll',
      'wait_for','hover','find_elements','set_value','go_back','go_forward','select','eval','page_info'];
    // 如果没有专属窗口且是 tab 操作，自动创建专属窗口，绝不操作用户自己的窗口
    if (TAB_CMDS.includes(cmd) && !params.tabId && !currentAgentTabId) {
      console.log('[Agent] No agent window, auto-creating one...');
      try {
        const winResult = await sendCommand('new_window', { url: 'about:blank', focused: false });
        if (winResult && winResult.windowId) {
          agentWindows.add(winResult.windowId);
          currentAgentTabId = winResult.tabId || null;
          console.log(`[Agent] Auto-created window ${winResult.windowId}, tab ${currentAgentTabId}`);
        }
      } catch(e) { console.log('[Agent] Failed to auto-create window:', e.message); }
    }
    if (TAB_CMDS.includes(cmd) && !params.tabId && currentAgentTabId) {
      params.tabId = currentAgentTabId;
    }
    // 操作前显示提示条
    const indicatorTabId = params.tabId || currentAgentTabId;
    if (INDICATOR_CMDS.includes(cmd) && indicatorTabId) {
      await showAgentIndicator(indicatorTabId, cmd);
    }
    const result = await sendCommand(cmd, params);
    // 操作完成后隐藏提示条（navigate 稍等页面加载后再隐藏）
    if (INDICATOR_CMDS.includes(cmd) && indicatorTabId) {
      if (cmd === 'navigate') {
        setTimeout(() => hideAgentIndicator(indicatorTabId), 1500);
      } else {
        await hideAgentIndicator(indicatorTabId);
      }
    }
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
    // navigate 完成后自动将 agent tab 置于专属窗口的前台（不影响东哥的窗口焦点）
    if (cmd === 'navigate' && currentAgentTabId) {
      try {
        await sendCommand('focus_tab', { tabId: currentAgentTabId });
      } catch(e) { /* ignore */ }
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

// 页面快照：返回紧凑 JSON（url/title/interactive元素列表），供 AI 直接读取操作
// 支持 GET /snapshot?tabId=xxx 或 POST /snapshot {tabId:xxx}
app.post('/snapshot', handleSnapshot);
app.get('/snapshot', handleSnapshot);
async function handleSnapshot(req, res) {
  try {
    const script = `(function() {
      function bestSelector(el) {
        if (el.id) return '#' + el.id;
        if (el.name) return el.tagName.toLowerCase() + '[name="' + el.name + '"]';
        if (el.getAttribute('data-testid')) return '[data-testid="' + el.getAttribute('data-testid') + '"]';
        const cls = [...el.classList].slice(0,2).join('.');
        return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
      }
      // 直接用 querySelectorAll('*') 遍历所有元素
      const all = [...document.querySelectorAll('*')];
      const result = [];
      const seen = new Set();
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.width < 5 || r.height < 5) continue;
        const text = (el.innerText || el.textContent || '').trim();
        if (!text && el.tagName !== 'IMG') continue;
        const key = el.tagName + '|' + text.slice(0,30);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({
          tag: el.tagName.toLowerCase(),
          text: text.slice(0, 100),
          href: el.href?.slice(0, 120) || undefined
        });
        if (result.length >= 200) break;
      }
      return JSON.stringify({ url: location.href, title: document.title, interactive: result });
    })()`;
    const tabId = req.query.tabId ? parseInt(req.query.tabId) : (req.body && req.body.tabId ? parseInt(req.body.tabId) : undefined);
    const result = await sendCommand('eval', { expression: script, ...(tabId ? { tabId } : {}) });
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    res.json({ ok: true, result: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

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
