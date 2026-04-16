// Chrome Bridge - Universal Browser Controller v2.6.0
// 支持双路并行：本地直连 + 远程 VPS 模式

import { CLOUDHAND_CONFIG } from './config.js';

// 连接管理
const conns = {
  local: {
    ws: null,
    connected: false,
    url: 'ws://127.0.0.1:9876/ws',
    token: 'local-mode-token',
    label: '本地'
  },
  remote: {
    ws: null,
    connected: false,
    url: CLOUDHAND_CONFIG.wsUrl,
    token: null,
    label: '远程'
  }
};

// 启动初始化
async function init() {
  const data = await chrome.storage.local.get(['serverUrl', 'sessionToken']);
  if (data.serverUrl) conns.remote.url = data.serverUrl;
  if (data.sessionToken) conns.remote.token = data.sessionToken;

  console.log('[CloudHand] Initializing dual-mode connections...');
  startConnection('local');
  if (conns.remote.token) {
    startConnection('remote');
  }
}

// 建立/维护连接
function startConnection(type) {
  const c = conns[type];
  if (!c.url || (type === 'remote' && !c.token)) return;
  if (c.ws && (c.ws.readyState === WebSocket.CONNECTING || c.ws.readyState === WebSocket.OPEN)) return;

  const fullUrl = `${c.url}?token=${c.token}`;
  console.log(`[Bridge] ${c.label}连接中:`, c.url);
  
  c.ws = new WebSocket(fullUrl);

  c.ws.onopen = () => {
    c.connected = true;
    console.log(`[Bridge] ${c.label}连接成功`);
  };

  c.ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      // 处理配对成功后的 token 更新
      if (msg.type === 'paired' && msg.sessionToken) {
        c.token = msg.sessionToken;
        await chrome.storage.local.set({ sessionToken: msg.sessionToken });
        c.connected = true;
        return;
      }
      // 执行来自任一端的指令
      if (msg.requestId && msg.command) {
        try {
          const result = await handleCommand(msg.command, msg.params || {});
          c.ws.send(JSON.stringify({ requestId: msg.requestId, result }));
        } catch (e) {
          c.ws.send(JSON.stringify({ requestId: msg.requestId, error: e.message }));
        }
      }
    } catch (e) { console.error(`[Bridge] ${c.label}解析错误`, e); }
  };

  c.ws.onclose = () => {
    c.connected = false;
    console.log(`[Bridge] ${c.label}连接断开，5秒后重试...`);
    setTimeout(() => startConnection(type), 5000);
  };

  c.ws.onerror = (e) => {
    c.connected = false;
    // console.error(`[Bridge] ${c.label}连接错误`);
  };
}

// 消息转发中心
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 获取两路连接的实时状态
  if (msg.type === 'getStatus') {
    sendResponse({
      local: { connected: conns.local.connected, url: conns.local.url },
      remote: { connected: conns.remote.connected, url: conns.remote.url, paired: !!conns.remote.token }
    });
    return true;
  }

  // 远程配对请求
  if (msg.type === 'pair') {
    pairWithChallenge(msg.serverUrl, msg.challenge)
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // 断开远程
  if (msg.type === 'revoke') {
    if (conns.remote.ws) conns.remote.ws.close();
    conns.remote.token = null;
    chrome.storage.local.remove(['sessionToken', 'sessionCreatedAt']);
    sendResponse({ ok: true });
    return true;
  }

  // 调试用的直接指令
  if (msg.type === 'command') {
    handleCommand(msg.command, msg.params || {})
      .then(r => sendResponse({ ok: true, result: r }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

// 远程配对逻辑
function pairWithChallenge(url, challenge) {
  return new Promise((resolve, reject) => {
    const pairWs = new WebSocket(`${url}?challenge=${challenge}`);
    const timer = setTimeout(() => { pairWs.close(); reject(new Error('配对超时')); }, 15000);

    pairWs.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'paired' && msg.sessionToken) {
          clearTimeout(timer);
          conns.remote.token = msg.sessionToken;
          conns.remote.url = url;
          await chrome.storage.local.set({ sessionToken: msg.sessionToken, serverUrl: url });
          pairWs.close();
          startConnection('remote');
          resolve({ success: true, sessionToken: msg.sessionToken });
        }
      } catch (e) { reject(e); }
    };
    pairWs.onerror = () => { clearTimeout(timer); reject(new Error('无法连接服务器')); };
  });
}

// ── 以下是核心指令处理器（保持原样） ────────────────────────

async function getTab(tabId) {
  if (!tabId) throw new Error('tabId is required');
  try { return await chrome.tabs.get(tabId); } catch { return null; }
}

function runScript(tabId, fn, args = []) {
  return chrome.scripting.executeScript({ target: { tabId }, func: fn, args }).then(r => r[0]?.result);
}

async function runDebuggerEval(tabId, expression) {
  const debuggee = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(debuggee, '1.3');
    attached = true;
    const result = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'JS eval error');
    return result.result?.value;
  } finally {
    if (attached) await chrome.debugger.detach(debuggee).catch(() => {});
  }
}

async function handleCommand(command, params) {
  if (command === 'tabs') {
    const tabs = await chrome.tabs.query({});
    return tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }));
  }
  if (command === 'new_window') {
    const win = await chrome.windows.create({ url: params.url || 'about:blank', focused: false });
    return { windowId: win.id, tabId: win.tabs[0].id };
  }
  if (command === 'new_tab') {
    const tab = await chrome.tabs.create({ url: params.url || 'about:blank', active: false });
    return { tabId: tab.id };
  }
  if (command === 'ensure_tab') {
    const windows = await chrome.windows.getAll({ populate: true });
    return { tabId: windows[0].tabs[0].id };
  }

  const tabId = params.tabId;
  const tab = await getTab(tabId);
  if (!tab) throw new Error('Tab not found');

  switch (command) {
    case 'navigate':
      await chrome.tabs.update(tabId, { url: params.url });
      return new Promise(r => {
        const listener = (tid, changeInfo) => {
          if (tid === tabId && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            r({ ok: true });
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
    case 'get_browser_state': return await sendPageControl(tabId, 'get_browser_state');
    case 'click_element': return await sendPageControl(tabId, 'click_element', { index: params.index });
    case 'input_text_element': return await sendPageControl(tabId, 'input_text_element', { index: params.index, text: params.text });
    case 'scroll_down': return await runScript(tabId, () => window.scrollBy(0, 500));
    case 'scroll_up': return await runScript(tabId, () => window.scrollBy(0, -500));
    case 'go_back': await chrome.tabs.goBack(tabId); return { ok: true };
    case 'go_forward': await chrome.tabs.goForward(tabId); return { ok: true };
    case 'screenshot':
      await chrome.windows.update(tab.windowId, { drawAttention: true });
      return { ok: true, result: await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }) };
    case 'eval': return await runDebuggerEval(tabId, params.expression);
    case 'get_ax_tree': {
      const debuggee = { tabId };
      let attached = false;
      try {
        await chrome.debugger.attach(debuggee, '1.3');
        attached = true;
        const result = await chrome.debugger.sendCommand(debuggee, 'Accessibility.getFullAXTree', {});
        return { ok: true, nodes: result.nodes };
      } finally {
        if (attached) await chrome.debugger.detach(debuggee).catch(() => {});
      }
    }
    case 'cdp_click': {
      const { selector } = params;
      const rect = await runScript(tabId, (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, [selector]);
      if (!rect) throw new Error('Element not found');
      const debuggee = { tabId };
      let attached = false;
      try {
        await chrome.debugger.attach(debuggee, '1.3');
        attached = true;
        await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
        await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
        return { ok: true };
      } finally {
        if (attached) await chrome.debugger.detach(debuggee).catch(() => {});
      }
    }
    default: throw new Error('Unknown command: ' + command);
  }
}

function sendPageControl(tabId, action, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'CH_PAGE_CONTROL', action, payload }, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

// 广播给所有活跃服务器
function broadcast(payload) {
  const data = JSON.stringify(payload);
  if (conns.local.connected) conns.local.ws.send(data);
  if (conns.remote.connected) conns.remote.ws.send(data);
}

chrome.windows.onRemoved.addListener(windowId => broadcast({ type: 'window_removed', windowId }));
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => broadcast({ type: 'tab_removed', tabId, windowId: removeInfo.windowId }));

// 保活
chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => {
  startConnection('local');
  startConnection('remote');
});

init();
