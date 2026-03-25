// CloudHand - 用户行为学习 content script
// 监听用户操作，定时上报给 background.js

(function() {
  if (window.__cloudhandWatcher) return; // 防重复注入

  // 先确认当前 tab 是否属于 agent 窗口，不是则静默退出
  // 加重试：background service worker 可能刚启动，storage 未恢复完
  function checkIsAgent(retries) {
    chrome.runtime.sendMessage({ type: 'is_agent_window' }, (resp) => {
      if (chrome.runtime.lastError) {
        // background 还没准备好，稍后重试
        if (retries > 0) setTimeout(() => checkIsAgent(retries - 1), 500);
        return;
      }
      if (resp && resp.isAgent) {
        startWatcher();
      } else if (retries > 0) {
        // storage 可能还在恢复，再等一下
        setTimeout(() => checkIsAgent(retries - 1), 500);
      }
    });
  }
  checkIsAgent(5); // 最多重试5次（共3秒）

  function startWatcher() {
  window.__cloudhandWatcher = true;

  const domain = location.hostname;
  const actions = [];

  function getSelector(el) {
    if (!el || el === document.body) return 'body';
    if (el.id) return '#' + el.id;
    const tag = el.tagName.toLowerCase();
    const text = el.innerText?.trim().slice(0, 20) || '';
    const cls = el.className?.toString().trim().split(/\s+/).slice(0, 2).join('.');
    return cls ? `${tag}.${cls}` : tag;
  }

  function getText(el) {
    return el?.innerText?.trim().slice(0, 40) || el?.placeholder || el?.title || '';
  }

  function record(action) {
    actions.push({ ts: Date.now(), domain, ...action });
  }

  // 点击
  document.addEventListener('click', (e) => {
    const el = e.target;
    record({
      type: 'click',
      selector: getSelector(el),
      text: getText(el),
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
