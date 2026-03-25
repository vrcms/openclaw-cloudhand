// CloudHand Page Controller v2.4.0
// 运行在 ISOLATED world，通过 chrome.runtime.onMessage 接收指令
// 依赖 dom_tree.js 先加载（挂在 window.__domTree）

(function () {
  if (window.__chPageControllerLoaded) return;
  window.__chPageControllerLoaded = true;

  // index → DOM 元素映射（每次 get_browser_state 刷新）
  let selectorMap = new Map();

  function buildSimplifiedHTML(map) {
    const SKIP_TAGS = new Set(['html', 'body', 'head', 'script', 'style', 'meta', 'link']);
    let content = '';
    let idx = 1;
    selectorMap = new Map();

    for (const [id, nodeData] of Object.entries(map)) {
      if (!nodeData.isInteractive) continue;
      const el = nodeData.element;
      if (!el || !el.isConnected) continue;
      const tag = (el.tagName || 'div').toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;

      // 提取有意义的文本
      let text = '';
      if (el.placeholder) text = el.placeholder;
      else if (el.value && tag === 'input') text = el.value.slice(0, 30);
      else if (el.getAttribute && el.getAttribute('aria-label')) text = el.getAttribute('aria-label');
      else if (el.innerText) text = el.innerText.trim().slice(0, 50).replace(/\n/g, ' ');
      else if (el.title) text = el.title;

      if (!text) continue;

      // 属性补充
      const attrs = [];
      if (el.placeholder) attrs.push(`placeholder="${el.placeholder}"`);
      if (el.type && tag === 'input') attrs.push(`type="${el.type}"`);
      if (el.href) attrs.push(`href="${el.href.slice(0, 60)}"`);
      const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';

      selectorMap.set(idx, el);
      content += `[${idx}]<${tag}${attrStr}>${text}</${tag}>\n`;
      idx++;
    }

    return content;
  }

  function getBrowserState() {
    if (typeof window.__domTree !== 'function') {
      return { ok: false, error: 'dom_tree.js not loaded' };
    }

    try {
      const result = window.__domTree({
        doHighlightElements: false,
        viewportExpansion: -1,
        debugMode: false,
        interactiveBlacklist: [],
        interactiveWhitelist: [],
        highlightOpacity: 0.1,
        highlightLabelOpacity: 0.5
      });

      const content = buildSimplifiedHTML(result.map);
      const scrollAbove = window.scrollY;
      const scrollBelow = Math.max(0, document.body.scrollHeight - window.scrollY - window.innerHeight);

      return {
        ok: true,
        url: location.href,
        title: document.title,
        content,
        elementCount: selectorMap.size,
        scroll: { above: scrollAbove, below: scrollBelow }
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function clickElement(index) {
    const el = selectorMap.get(index);
    if (!el || !el.isConnected) return { ok: false, error: `element ${index} not found or disconnected` };
    try {
      el.focus();
      el.click();
      // 模拟真实点击事件
      ['mousedown', 'mouseup', 'click'].forEach(type => {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function inputText(index, text) {
    const el = selectorMap.get(index);
    if (!el || !el.isConnected) return { ok: false, error: `element ${index} not found` };
    try {
      el.focus();
      // 清空原有内容
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      // 逐字符输入（模拟真实输入）
      for (const char of text) {
        el.value += char;
        el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
        el.dispatchEvent(new InputEvent('input', { data: char, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type !== 'CH_PAGE_CONTROL') return;

    const { action, payload = {} } = msg;

    try {
      switch (action) {
        case 'get_browser_state':
          sendResponse(getBrowserState());
          break;

        case 'click_element':
          sendResponse(clickElement(payload.index));
          break;

        case 'input_text':
          sendResponse(inputText(payload.index, payload.text || ''));
          break;

        case 'ping':
          sendResponse({ ok: true, loaded: true, url: location.href });
          break;

        case 'debug_dom': {
          if (typeof window.__domTree !== 'function') {
            sendResponse({ ok: false, error: 'dom_tree not loaded' });
            break;
          }
          const r = window.__domTree({ doHighlightElements: false, viewportExpansion: -1, debugMode: false, interactiveBlacklist: [], interactiveWhitelist: [], highlightOpacity: 0.1, highlightLabelOpacity: 0.5 });
          const mapKeys = Object.keys(r.map || {});
          const sample = mapKeys.slice(0, 3).map(k => ({ key: k, isInteractive: r.map[k].isInteractive, hasEl: !!r.map[k].element, tag: r.map[k].element?.tagName }));
          sendResponse({ ok: true, rootId: r.rootId, mapSize: mapKeys.length, sample });
          break;
        }

        default:
          sendResponse({ ok: false, error: `unknown action: ${action}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }

    return true; // 保持 sendResponse 异步有效
  });

  console.log('[CloudHand] page_controller loaded on', location.href);
})();
