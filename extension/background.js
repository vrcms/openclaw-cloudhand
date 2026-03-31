// Chrome Bridge - Universal Browser Controller
// 支持 challenge 配对 + session token 自动重连

let ws = null;
let connected = false;
let sessionToken = null;
let serverUrl = null;

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

    case 'get_browser_state': {
      return sendPageControl(tabId, 'get_browser_state', {});
    }

    case 'debug_dom': {
      return sendPageControl(tabId, 'debug_dom', {});
    }

    case 'click_element': {
      if (!params.index) throw new Error('index is required');
      return sendPageControl(tabId, 'click_element', { index: params.index });
    }

    case 'input_text_element': {
      if (!params.index) throw new Error('index is required');
      if (params.text === undefined) throw new Error('text is required');
      return sendPageControl(tabId, 'input_text', { index: params.index, text: params.text });
    }

    case 'ping_page_controller': {
      return sendPageControl(tabId, 'ping', {});
    }

    // ── bb-browser 借鉴：Accessibility Tree（稳定 ref 版）────────────────
    case 'get_ax_tree': {
      // 获取完整 AX 语义树，ref 基于 role+name+backendDOMNodeId 稳定生成（参考 bb-browser ax-tree-formatter）
      const axDebuggee = { tabId };
      let axAttached = false;
      try {
        await chrome.debugger.attach(axDebuggee, '1.3');
        axAttached = true;
      } catch (e) {
        if (!String(e).includes('already')) throw e;
        axAttached = false;
      }
      try {
        const res = await chrome.debugger.sendCommand(axDebuggee, 'Accessibility.getFullAXTree', {});
        const nodes = res.nodes || [];

        const SKIP_ROLES = new Set(['none', 'InlineTextBox', 'LineBreak', 'ignored', 'Ignored', 'generic']);
        const INTERACTIVE_ROLES = new Set(['button','link','textbox','searchbox','combobox','listbox','checkbox','radio','slider','spinbutton','switch','tab','menuitem','menuitemcheckbox','menuitemradio','option','treeitem']);
        const CONTENT_ROLES_WITH_REF = new Set(['heading','img','cell','columnheader','rowheader']);

        // nodeId → node 快速查找
        const nodeMap = new Map();
        for (const n of nodes) nodeMap.set(n.nodeId, n);

        // role+name 计数器（用于 nth 去重）
        const roleNameCounts = new Map();
        const roleNameRefs = new Map();
        function rnKey(role, name) { return `${role}:${name ?? ''}`; }

        const refs = {};   // ref字符串 → { backendDOMNodeId, role, name, nth }
        const lines = [];

        // 第一遍：分配 ref
        for (const n of nodes) {
          if (n.ignored) continue;
          const role = n.role?.value;
          if (!role || SKIP_ROLES.has(role)) continue;

          const isInteractive = INTERACTIVE_ROLES.has(role);
          const isContent = CONTENT_ROLES_WITH_REF.has(role);
          if (!isInteractive && !isContent) continue;

          const name = n.name?.value || undefined;
          const key = rnKey(role, name);
          const idx = roleNameCounts.get(key) ?? 0;
          roleNameCounts.set(key, idx + 1);

          // ref 格式：role_name_nth（空格转_，最多20字符）
          const namePart = name ? '_' + name.replace(/\s+/g,'_').slice(0,20) : '';
          let ref = (role + namePart).replace(/[^\w]/g,'_').slice(0,32);
          if (idx > 0) ref = ref + '_' + idx;

          // 去重（极端情况）
          let finalRef = ref;
          let collision = 0;
          while (refs[finalRef] && collision < 99) { collision++; finalRef = ref + '_x' + collision; }

          refs[finalRef] = { backendDOMNodeId: n.backendDOMNodeId, role, name, nth: idx > 0 ? idx : undefined };
          if (!roleNameRefs.has(key)) roleNameRefs.set(key, []);
          roleNameRefs.get(key).push(finalRef);

          // 构建输出行
          const nameStr = name ? ` "${name}"` : '';
          const val = n.value?.value !== undefined ? ` = ${JSON.stringify(n.value.value)}` : '';
          const nthStr = idx > 0 ? ` [nth=${idx}]` : '';
          lines.push(`${role}${nameStr}${val}${nthStr} [ref=${finalRef}]`);
        }

        // 清理：只有1个的同 role+name，去掉 nth 标记
        const cleanLines = lines.map(line => {
          const m = line.match(/\[ref=(\S+)\]/);
          if (!m) return line;
          const refInfo = refs[m[1]];
          if (!refInfo) return line;
          const key = rnKey(refInfo.role, refInfo.name);
          if ((roleNameRefs.get(key) || []).length <= 1) {
            return line.replace(/\s*\[nth=\d+\]/, '');
          }
          return line;
        });

        return {
          tree: cleanLines.join('\n') || '(empty)',
          refs,
          count: cleanLines.length
        };
      } finally {
        if (axAttached) await chrome.debugger.detach(axDebuggee).catch(() => {});
      }
    }

    // ── bb-browser 借鉴：带登录态的 fetch ────────────────────────────────
    case 'fetch_with_cookies': {
      // 直接用当前页面的登录态发 HTTP 请求，比操作 DOM 快10倍
      const fetchUrl = params.url;
      if (!fetchUrl) throw new Error('url is required');
      const fetchMethod = params.method || 'GET';
      const fetchHeaders = params.headers || {};
      const fetchBody = params.body ? JSON.stringify(params.body) : undefined;
      const result = await runDebuggerEval(tabId, `
        (async () => {
          const resp = await fetch(${JSON.stringify(fetchUrl)}, {
            method: ${JSON.stringify(fetchMethod)},
            headers: { 'Content-Type': 'application/json', ...${JSON.stringify(fetchHeaders)} },
            body: ${fetchBody ? JSON.stringify(fetchBody) : 'undefined'},
            credentials: 'include'
          });
          const text = await resp.text();
          let data;
          try { data = JSON.parse(text); } catch(e) { data = text; }
          return { status: resp.status, ok: resp.ok, data };
        })()
      `);
      return result;
    }

    // ── CDP 真实鼠标点击（反检测，比 JS click 更像真人）──────────────────
    case 'cdp_click': {
      const clickDebuggee = { tabId };
      let clickAttached = false;
      try {
        await chrome.debugger.attach(clickDebuggee, '1.3');
        clickAttached = true;
      } catch(e) { if (!String(e).includes('already')) throw e; }
      try {
        // 用 selector 或 ref 找元素坐标
        const sel = params.selector;
        const expr = sel
          ? `JSON.stringify((function(){const el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})())`
          : `JSON.stringify((function(){const el=document.elementFromPoint(${params.x||0},${params.y||0});if(!el)return null;const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})())`;
        const evalRes = await chrome.debugger.sendCommand(clickDebuggee, 'Runtime.evaluate', { expression: expr, returnByValue: true });
        const pos = evalRes.result?.value ? JSON.parse(evalRes.result.value) : null;
        if (!pos) throw new Error('Element not found: ' + sel);
        const { x, y } = pos;
        // 发送真实鼠标事件序列
        for (const type of ['mouseMoved','mousePressed','mouseReleased']) {
          await chrome.debugger.sendCommand(clickDebuggee, 'Input.dispatchMouseEvent', {
            type, x, y, button: 'left', clickCount: type === 'mousePressed' ? 1 : 0,
            modifiers: 0, buttons: type === 'mousePressed' ? 1 : 0
          });
        }
        return { ok: true, x, y };
      } finally {
        if (clickAttached) await chrome.debugger.detach(clickDebuggee).catch(() => {});
      }
    }

    // ── CDP 真实键盘输入（逐键模拟，绕过反bot检测）──────────────────────
    case 'cdp_type': {
      const typeDebuggee = { tabId };
      let typeAttached = false;
      try {
        await chrome.debugger.attach(typeDebuggee, '1.3');
        typeAttached = true;
      } catch(e) { if (!String(e).includes('already')) throw e; }
      try {
        // 先 focus 元素
        if (params.selector) {
          await chrome.debugger.sendCommand(typeDebuggee, 'Runtime.evaluate', {
            expression: `document.querySelector(${JSON.stringify(params.selector)})?.focus()`
          });
        }
        const text = String(params.text || '');
        for (const char of text) {
          await chrome.debugger.sendCommand(typeDebuggee, 'Input.dispatchKeyEvent', {
            type: 'keyDown', text: char, unmodifiedText: char,
            key: char, windowsVirtualKeyCode: char.charCodeAt(0)
          });
          await chrome.debugger.sendCommand(typeDebuggee, 'Input.dispatchKeyEvent', {
            type: 'keyUp', text: char, unmodifiedText: char,
            key: char, windowsVirtualKeyCode: char.charCodeAt(0)
          });
          // 随机延迟 20-60ms，模拟真人打字
          await new Promise(r => setTimeout(r, 20 + Math.floor(Math.random() * 40)));
        }
        return { ok: true, chars: text.length };
      } finally {
        if (typeAttached) await chrome.debugger.detach(typeDebuggee).catch(() => {});
      }
    }

    // ── 网络流量抓取（一次性抓取，等待N毫秒后返回）────────────────────────
    case 'network_capture': {
      const netDebuggee = { tabId };
      let netAttached = false;
      const requests = [];
      try {
        await chrome.debugger.attach(netDebuggee, '1.3');
        netAttached = true;
        await chrome.debugger.sendCommand(netDebuggee, 'Network.enable', {});
        // 监听请求
        const listener = (source, method, params2) => {
          if (source.tabId !== tabId) return;
          if (method === 'Network.requestWillBeSent') {
            requests.push({
              id: params2.requestId,
              url: params2.request.url,
              method: params2.request.method,
              headers: params2.request.headers,
              postData: params2.request.postData,
              timestamp: params2.timestamp
            });
          }
        };
        chrome.debugger.onEvent.addListener(listener);
        // 等待指定时间（默认3秒）
        await new Promise(r => setTimeout(r, params.waitMs || 3000));
        chrome.debugger.onEvent.removeListener(listener);
        // 过滤：只返回 XHR/fetch 请求（排除图片/CSS/JS资源）
        const apiRequests = requests.filter(r => {
          const url = r.url;
          return !url.match(/\.(png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|css|js|map)([?#]|$)/i);
        });
        return { ok: true, count: apiRequests.length, requests: apiRequests.slice(0, 50) };
      } finally {
        if (netAttached) await chrome.debugger.detach(netDebuggee).catch(() => {});
      }
    }

    // ── Console 日志抓取 ─────────────────────────────────────────────────
    case 'console_capture': {
      const conDebuggee = { tabId };
      let conAttached = false;
      const logs = [];
      try {
        await chrome.debugger.attach(conDebuggee, '1.3');
        conAttached = true;
        await chrome.debugger.sendCommand(conDebuggee, 'Runtime.enable', {});
        const listener = (source, method, params2) => {
          if (source.tabId !== tabId) return;
          if (method === 'Runtime.consoleAPICalled') {
            logs.push({
              type: params2.type,
              args: (params2.args || []).map(a => a.value ?? a.description ?? String(a.type)),
              timestamp: params2.timestamp
            });
          } else if (method === 'Runtime.exceptionThrown') {
            logs.push({
              type: 'error',
              args: [params2.exceptionDetails?.exception?.description || params2.exceptionDetails?.text || 'Unknown error'],
              stack: params2.exceptionDetails?.stackTrace,
              timestamp: params2.timestamp
            });
          }
        };
        chrome.debugger.onEvent.addListener(listener);
        await new Promise(r => setTimeout(r, params.waitMs || 2000));
        chrome.debugger.onEvent.removeListener(listener);
        return { ok: true, count: logs.length, logs };
      } finally {
        if (conAttached) await chrome.debugger.detach(conDebuggee).catch(() => {});
      }
    }

    default:
      throw new Error('Unknown command: ' + command);
  }
}

// 向 content_script(ISOLATED world) 发送 CH_PAGE_CONTROL 消息
function sendPageControl(tabId, action, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'CH_PAGE_CONTROL', action, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ── Agent 窗口关闭感知 ──────────────────────────────────
// 当用户手动关闭窗口时，主动通知 server 从 agentWindows 里清掉
chrome.windows.onRemoved.addListener((windowId) => {
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

// ── 版本自动检查（方案一）──────────────────────────────────────────
const CURRENT_VERSION = '2.5.0';
const VERSION_CHECK_URL = 'http://149.13.91.10:9876/version';

async function checkForUpdates() {
  try {
    const resp = await fetch(VERSION_CHECK_URL);
    if (!resp.ok) return;
    const data = await resp.json();
    const latest = data.version;
    if (latest && latest !== CURRENT_VERSION) {
      // 存储更新信息，options 页会读取
      await chrome.storage.local.set({ 
        updateAvailable: true, 
        latestVersion: latest,
        currentVersion: CURRENT_VERSION
      });
      // 显示角标提醒
      chrome.action.setBadgeText({ text: 'NEW' });
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
      console.log(`[CloudHand] Update available: ${CURRENT_VERSION} → ${latest}`);
    } else {
      await chrome.storage.local.set({ updateAvailable: false });
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) {
    // 网络不通，静默忽略
  }
}

// 启动时检查一次，之后每30分钟检查一次
checkForUpdates();
setInterval(checkForUpdates, 30 * 60 * 1000);
