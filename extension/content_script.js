// CloudHand - 用户行为学习 content script
// 监听用户操作，定时上报给 background.js

(function() {
  if (window.__cloudhandWatcher) return; // 防重复注入

  // 先确认当前 tab 是否属于 agent 窗口，不是则静默退出
  // 加重试：background service worker 可能刚启动，storage 未恢复完
  // 统一入口：轮询检查（最多40次×500ms=20秒），同时走 sendMessage
  // 方式1：window.__cloudhandIsAgent 由 background.injectWatcher 注入
  // 方式2：sendMessage 直接问 background
  let _started = false;
  function tryStart() {
    if (_started || window.__cloudhandWatcher) return;
    _started = true;
    startWatcher();
  }
  // 暴露给 injectWatcher 直接调用
  window.__cloudhandTryStart = tryStart;

  // 立即检查一次（injectWatcher 可能在 content_script 之前已注入）
  if (window.__cloudhandIsAgent) { tryStart(); return; }

  // 轮询 window.__cloudhandIsAgent（每500ms，共20秒）
  let _pollCount = 0;
  const _poll = setInterval(() => {
    if (window.__cloudhandIsAgent) { clearInterval(_poll); tryStart(); return; }
    if (++_pollCount >= 40) clearInterval(_poll);
  }, 500);

  // 同时用 sendMessage 问 background（最多10次×1秒）
  function checkIsAgent(retries) {
    chrome.runtime.sendMessage({ type: 'is_agent_window' }, (resp) => {
      if (chrome.runtime.lastError) {
        if (retries > 0) setTimeout(() => checkIsAgent(retries - 1), 1000);
        return;
      }
      if (resp && resp.isAgent) {
        clearInterval(_poll);
        tryStart();
      } else if (retries > 0) {
        setTimeout(() => checkIsAgent(retries - 1), 1000);
      }
    });
  }
  checkIsAgent(10);

  function startWatcher() {
  window.__cloudhandWatcher = true;

  const domain = location.hostname;
  const actions = [];

  // 无意义容器标签，点击时向上找有意义的祖先
  const SKIP_TAGS = new Set(['body', 'html', 'section', 'article', 'main', 'nav', 'header', 'footer', 'ul', 'li', 'i', 'em', 'svg', 'path']);
  // div/span 不在 SKIP_TAGS，但通过 innerText 长度限制过滤大容器

  function getMeaningfulEl(el) {
    let cur = el;
    for (let i = 0; i < 6 && cur && cur !== document.body; i++) {
      const tag = cur.tagName?.toLowerCase();
      // 有 id、aria-label、placeholder、role、可见文字，或者是交互元素
      if (
        cur.id ||
        cur.getAttribute('aria-label') ||
        cur.getAttribute('placeholder') ||
        cur.getAttribute('role') ||
        ['a', 'button', 'input', 'select', 'textarea', 'label'].includes(tag) ||
        (!SKIP_TAGS.has(tag) && cur.innerText?.trim().length > 0 && cur.innerText.trim().length < 80)
      ) return cur;
      cur = cur.parentElement;
    }
    return el; // fallback 原始元素
  }

  function getSelector(el) {
    if (!el || el === document.body) return 'body';
    const tag = el.tagName?.toLowerCase() || 'unknown';
    if (el.id) return `${tag}#${el.id}`;
    const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('role');
    if (label) return `${tag}[${label}]`;
    const cls = el.className?.toString().trim().split(/\s+/).filter(c => c && !/^[a-z0-9]{6,}$/i.test(c)).slice(0, 2).join('.');
    return cls ? `${tag}.${cls}` : tag;
  }

  function getText(el) {
    return (el?.innerText?.trim() || el?.getAttribute('aria-label') || el?.placeholder || el?.title || '').slice(0, 40);
  }

  function record(action) {
    actions.push({ ts: Date.now(), domain, ...action });
  }

  // 点击（向上找有意义的祖先元素，避免记录 i/span 等无意义标签）
  document.addEventListener('click', (e) => {
    const el = getMeaningfulEl(e.target);
    if (!el || el === document.body || el === document.documentElement) return; // 过滤顶层
    const text = getText(el);
    record({
      type: 'click',
      selector: getSelector(el),
      text: text,
      tag: el.tagName?.toLowerCase()
    });
  }, true);

  // 输入（排除密码框）
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.type === 'password') {
      record({ type: 'input', selector: getSelector(el), text: '[密码框，内容已隐藏]' });
      return;
    }
    const val = el.value?.slice(0, 15) || '';
    record({
      type: 'input',
      selector: getSelector(el),
      text: val ? `输入: ${val}` : '(空)',
      placeholder: el.placeholder?.slice(0, 30)
    });
  }, true);

  // URL 跳转
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      record({ type: 'navigate', from: lastUrl, to: location.href });
      lastUrl = location.href;
    }
  }).observe(document, { subtree: true, childList: true });

  // 滚动（节流，5秒记一次）
  let lastScroll = 0;
  window.addEventListener('scroll', () => {
    const now = Date.now();
    if (now - lastScroll > 5000) {
      lastScroll = now;
      record({ type: 'scroll', y: Math.round(window.scrollY) });
    }
  }, { passive: true });

  // 每10秒发送一次
  setInterval(() => {
    if (actions.length === 0) return;
    const batch = actions.splice(0, actions.length);
    chrome.runtime.sendMessage({ type: 'user_actions', domain, actions: batch });
  }, 10000);

  } // end startWatcher

})();
