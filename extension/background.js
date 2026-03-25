// Chrome Bridge - Universal Browser Controller
// 支持 challenge 配对 + session token 自动重连

let ws = null;
let connected = false;
let sessionToken = null;
let serverUrl = null;
const agentWindows = new Set(); // 扩展内部追踪 agent 窗口

import { CLOUDHAND_CONFIG } from './config.js';
console.log('[CloudHand] CLOUDHAND_CONFIG:', typeof CLOUDHAND_CONFIG, JSON.stringify(CLOUDHAND_CONFIG));
const DEFAULT_SERVER = CLOUDHAND_CONFIG.wsUrl;
console.log('[CloudHand] DEFAULT_SERVER:', DEFAULT_SERVER);

// 启动时从 storage 读取配置并连接
async function init() {
  const data = await chrome.storage.local.get(['serverUrl', 'sessionToken']);
  serverUrl = data.serverUrl || DEFAULT_SERVER;
  sessionToken = data.sessionToken || null;
  if (sessionToken) {
    connect();
  } else {
    console.log('[Bridge] Not paired yet. Open options to pair.');
  }
}

function connect() {
  if (!sessionToken) return;
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

  const url = `${serverUrl}?token=${sessionToken}`;
  console.log('[Bridge] Connecting to', serverUrl);
  ws = new WebSocket(url);

  ws.onopen = () => {
    connected = true;
    console.log('[Bridge] Connected');
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      // 收到配对成功的 session token
      if (msg.type === 'paired') {
        sessionToken = msg.sessionToken;
        await chrome.storage.local.set({ sessionToken: msg.sessionToken });
        connected = true;
        console.log('[Bridge] Paired, session token saved');
        return;
      }
      // 收到服务端指令
      if (msg.requestId && msg.command) {
        try {
          const result = await handleCommand(msg.command, msg.params || {});
          ws.send(JSON.stringify({ requestId: msg.requestId, result }));
        } catch (e) {
          ws.send(JSON.stringify({ requestId: msg.requestId, error: e.message }));
        }
      }
    } catch (e) {
      console.error('[Bridge] Parse error', e);
    }
  };

  ws.onclose = (event) => {
    connected = false;
    console.log(`[Bridge] Disconnected (${event.code}), retrying in 5s...`);
    setTimeout(connect, 5000);
  };

  ws.onerror = (e) => {
    console.error('[Bridge] Error', e);
  };
}

// challenge 配对：用6位码连接，收到 session token 后保存
function pairWithChallenge(url, challenge) {
  return new Promise((resolve, reject) => {
    const pairWs = new WebSocket(`${url}?challenge=${challenge}`);
    const timer = setTimeout(() => {
      pairWs.close();
      reject(new Error('连接超时'));
    }, 15000);

    pairWs.onopen = () => console.log('[Bridge] Pair WS connected');

    pairWs.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'paired' && msg.sessionToken) {
          clearTimeout(timer);
          sessionToken = msg.sessionToken;
          serverUrl = url;
          await chrome.storage.local.set({ sessionToken, serverUrl });
          pairWs.close();
          // 用新 token 建立正式连接
          if (ws) ws.close();
          connect();
          resolve({ success: true, sessionToken });
        }
      } catch (e) { reject(e); }
    };

    pairWs.onclose = (event) => {
      clearTimeout(timer);
      if (event.code === 1008) reject(new Error('验证码错误或已过期'));
    };

    pairWs.onerror = () => {
      clearTimeout(timer);
      reject(new Error('连接服务器失败，请检查服务器地址'));
    };
  });
}

// 保活
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    if (sessionToken && (!ws || ws.readyState === WebSocket.CLOSED)) connect();
  }
});

// 处理来自 options 页的消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getStatus') {
    sendResponse({ connected, paired: !!sessionToken });
    return true;
  }
  if (msg.type === 'pair') {
    pairWithChallenge(msg.serverUrl || DEFAULT_SERVER, msg.challenge)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (msg.type === 'revoke') {
    sessionToken = null;
    if (ws) ws.close();
    chrome.storage.local.remove(['sessionToken', 'sessionCreatedAt']);
    sendResponse({ ok: true });
    return true;
  }
});

// 处理来自 popup 消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'command') {
    handleCommand(msg.command, msg.params || {})
      .then(r => sendResponse({ ok: true, result: r }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

init();

// ── 指令处理 ────────────────────────────────────────────

async function getTab(tabId) {
  if (!tabId) {
    // 铁律：禁止 fallback 到用户活动 tab，必须明确指定 tabId
    throw new Error('tabId is required: agent must always specify tabId to avoid operating on user windows');
  }
  try { return await chrome.tabs.get(tabId); } catch { return null; }
}

function runScript(tabId, fn, args = []) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: fn,
    args
  }).then(r => r[0]?.result);
}

// 用 chrome.debugger + Runtime.evaluate 执行任意 JS 字符串（绕过 CSP 限制）
async function runDebuggerEval(tabId, expression) {
  const debuggee = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(debuggee, '1.3');
    attached = true;
  } catch (e) {
    // 可能已经 attached，忽略
    if (!String(e).includes('already')) throw e;
  }
  try {
    const result = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'JS eval error');
    }
    return result.result?.value;
  } finally {
    if (attached) {
      await chrome.debugger.detach(debuggee).catch(() => {});
    }
  }
}

async function handleCommand(command, params) {
  // 不需要 tab 的指令
  if (command === 'tabs') {
    const tabs = await chrome.tabs.query({});
    return tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }));
  }
  if (command === 'new_tab') {
    // active: false 让新 tab 在后台打开，不抢焦点
    // windowId 必须是整数
    const windowId = params.windowId ? parseInt(params.windowId, 10) : undefined;
    console.log('[CloudHand] new_tab windowId:', windowId, typeof windowId);
    const tab = await chrome.tabs.create({ url: params.url || 'about:blank', active: false, windowId });
    return { tabId: tab.id, windowId: tab.windowId, url: tab.url };
  }
  if (command === 'focus_tab') {
    await chrome.tabs.update(params.tabId, { active: true });
    return { ok: true, tabId: params.tabId };
  }
  if (command === 'new_window') {
    const url = params.url || 'about:blank';
    const win = await chrome.windows.create({
      url,
      focused: false,
      type: 'normal',
      width: 1920,
      height: 1080,
      left: 0,
      top: 0
    });
    await chrome.windows.update(win.id, { state: 'minimized' });
    agentWindows.add(win.id); // 记录为 agent 窗口
    const newTab = win.tabs?.[0];
    return { windowId: win.id, tabId: newTab?.id, url: newTab?.url };
  }

  const tab = await getTab(params.tabId);
  if (!tab) throw new Error('No active tab found');
  const tabId = tab.id;

  switch (command) {
    case 'navigate': {
      // active: false 导航时不抢焦点，后台静默加载
      await chrome.tabs.update(tabId, { url: params.url, active: false });
      await new Promise((resolve) => {
        const listener = (id, info) => {
          if (id === tabId && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(resolve, 10000);
      });
      return { ok: true, url: params.url };
    }

    case 'screenshot': {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      return dataUrl;
    }

    case 'get_html': {
      const html = await runScript(tabId, () => document.documentElement.outerHTML);
      return { html };
    }

    case 'get_text': {
      const text = await runScript(tabId, () => document.body.innerText);
      return { text };
    }

    case 'click': {
      return runScript(tabId, (selector, text, x, y) => {
        let el = null;
        if (selector) el = document.querySelector(selector);
        else if (text) {
          const all = document.querySelectorAll('button,a,input[type=submit],[role=button]');
          for (const e of all) { if (e.textContent.trim().includes(text) || e.value?.includes(text)) { el = e; break; } }
        }
        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.click(); return 'clicked: ' + (el.textContent.trim().slice(0,50) || el.tagName); }
        else if (x !== null && y !== null) { document.elementFromPoint(x, y)?.click(); return `clicked at (${x},${y})`; }
        throw new Error('Element not found: ' + (selector || text));
      }, [params.selector || null, params.text || null, params.x ?? null, params.y ?? null]);
    }

    case 'type': {
      return runScript(tabId, (selector, text) => {
        let el = selector ? document.querySelector(selector) : document.activeElement;
        if (!el) throw new Error('Element not found: ' + selector);
        el.focus(); el.click();
        el.select?.();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        const nativeSetter = Object.getOwnPropertyDescriptor(
          el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value'
        );
        nativeSetter?.set?.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        if (!nativeSetter) { el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); }
        return 'typed: ' + text;
      }, [params.selector || null, params.text || '']);
    }

    case 'set_value': {
      return runScript(tabId, (selector, value) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error('Not found: ' + selector);
        const nativeSetter = Object.getOwnPropertyDescriptor(
          el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value'
        );
        nativeSetter?.set?.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'set value: ' + value;
      }, [params.selector, params.value]);
    }

    case 'key': {
      return runScript(tabId, (key) => {
        const el = document.activeElement;
        ['keydown','keypress','keyup'].forEach(type =>
          el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }))
        );
        if (key === 'Enter') {
          const form = el.closest('form');
          if (form) { const btn = form.querySelector('[type=submit]'); if (btn) btn.click(); else form.submit(); }
        }
        return 'pressed: ' + key;
      }, [params.key || 'Enter']);
    }

    case 'hotkey': {
      return runScript(tabId, (keys) => {
        const parts = keys.toLowerCase().split('+');
        const key = parts[parts.length - 1];
        const opts = {
          key, bubbles: true, cancelable: true,
          ctrlKey: parts.includes('ctrl'),
          shiftKey: parts.includes('shift'),
          altKey: parts.includes('alt'),
          metaKey: parts.includes('meta') || parts.includes('cmd')
        };
        const el = document.activeElement || document.body;
        ['keydown','keyup'].forEach(t => el.dispatchEvent(new KeyboardEvent(t, opts)));
        return 'hotkey: ' + keys;
      }, [params.keys || '']);
    }

    case 'scroll': {
      return runScript(tabId, (x, y, selector) => {
        if (selector) { document.querySelector(selector)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return 'scrolled to: ' + selector; }
        window.scrollBy({ left: x || 0, top: y || 500, behavior: 'smooth' });
        return `scrolled (${x||0}, ${y||500})`;
      }, [params.x || 0, params.y || 500, params.selector || null]);
    }

    case 'hover': {
      return runScript(tabId, (selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error('Not found: ' + selector);
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        return 'hovered: ' + selector;
      }, [params.selector || 'a']);
    }

    case 'select': {
      return runScript(tabId, (selector, value) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error('Not found: ' + selector);
        el.value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'selected: ' + value;
      }, [params.selector, params.value]);
    }

    case 'wait_for': {
      return runScript(tabId, (selector, timeout) => {
        return new Promise((resolve, reject) => {
          const start = Date.now();
          const check = () => {
            const el = document.querySelector(selector);
            if (el) return resolve('found: ' + selector);
            if (Date.now() - start > timeout) return reject(new Error('Timeout: ' + selector));
            setTimeout(check, 200);
          };
          check();
        });
      }, [params.selector, params.timeout || 10000]);
    }

    case 'get_cookies': {
      const cookies = await chrome.cookies.getAll({ url: tab.url });
      return { cookies: cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain })) };
    }



    case 'close_tab': {
      await chrome.tabs.remove(tabId);
      return true;
    }

    case 'go_back': {
      await chrome.tabs.goBack(tabId);
      return { ok: true };
    }

    case 'go_forward': {
      await chrome.tabs.goForward(tabId);
      return { ok: true };
    }

    case 'eval': {
      // 用 chrome.debugger Runtime.evaluate 执行任意 JS（绕过 CSP 限制）
      const expression = params.expression || params.code || '';
      if (!expression) throw new Error('expression is required');
      return runDebuggerEval(tabId, expression);
    }

    case 'find_elements': {
      return runScript(tabId, (selector) => {
        const els = Array.from(document.querySelectorAll(selector)).slice(0, 20);
        return els.map(el => ({ tag: el.tagName, text: el.textContent.trim().slice(0,80), id: el.id, class: el.className.slice?.(0,50) }));
      }, [params.selector || 'a']);
    }

    case 'page_info': {
      return runScript(tabId, () => ({
        url: location.href, title: document.title,
        links: Array.from(document.querySelectorAll('a[href]')).slice(0,20).map(a=>({text:a.textContent.trim().slice(0,50),href:a.href}))
      }));
    }

    default:
      throw new Error('Unknown command: ' + command);
  }
}

// ── 用户行为学习：接收 content_script 上报，转发给 server ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // content_script 启动时查询当前 tab 是否属于 agent 窗口
  if (msg.type === 'is_agent_window') {
    const windowId = sender.tab?.windowId;
    sendResponse({ isAgent: windowId != null && agentWindows.has(windowId) });
    return true;
  }
  if (msg.type !== 'user_actions') return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: 'user_actions',
    domain: msg.domain,
    actions: msg.actions,
    tabId: sender.tab?.id
  }));
});

// ── Agent 窗口关闭感知 ──────────────────────────────────
// 当用户手动关闭窗口时，主动通知 server 从 agentWindows 里清掉
chrome.windows.onRemoved.addListener((windowId) => {
  agentWindows.delete(windowId); // 从 agent 窗口集合中移除
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'window_removed', windowId }));
    console.log('[CloudHand] Window removed, notified server:', windowId);
  }
});

// 当用户手动关闭 tab 时，也通知 server
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'tab_removed', tabId, windowId: removeInfo.windowId, isWindowClosing: removeInfo.isWindowClosing }));
  }
});
