import { CLOUDHAND_CONFIG } from './config.js';
const DEFAULT_SERVER_URL = CLOUDHAND_CONFIG.wsUrl;

async function getStorage(keys) {
  return new Promise(r => chrome.storage.local.get(keys, r));
}
async function removeStorage(keys) {
  return new Promise(r => chrome.storage.local.remove(keys, r));
}

const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const connectedView = document.getElementById('connectedView');
const pairView = document.getElementById('pairView');
const serverUrlEl = document.getElementById('serverUrl');
const codeInput = document.getElementById('codeInput');
const pairBtn = document.getElementById('pairBtn');
const pairMsg = document.getElementById('pairMsg');

function showMsg(type, text) {
  pairMsg.className = 'msg ' + type;
  pairMsg.textContent = text;
}

async function init() {
  const data = await getStorage(['sessionToken', 'serverUrl']);

  // 获取实际连接状态
  chrome.runtime.sendMessage({ type: 'getStatus' }, (resp) => {
    const connected = resp?.connected;

    if (data.sessionToken) {
      // 已配对
      dot.className = 'dot ' + (connected ? 'connected' : 'disconnected');
      statusText.textContent = connected ? '已连接 ✓' : '已配对，连接中...';
      serverUrlEl.textContent = data.serverUrl || DEFAULT_SERVER_URL;
      connectedView.style.display = 'block';
      pairView.style.display = 'none';
    } else {
      // 未配对
      dot.className = 'dot disconnected';
      statusText.textContent = '未连接';
      connectedView.style.display = 'none';
      pairView.style.display = 'block';
      setTimeout(() => codeInput.focus(), 100);
    }
  });
}

// 配对
pairBtn.addEventListener('click', async () => {
  const code = codeInput.value.trim();
  if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) {
    codeInput.classList.add('error');
    showMsg('error', '请输入6位数字验证码');
    return;
  }
  codeInput.classList.remove('error');

  const data = await getStorage(['serverUrl']);
  const serverUrl = data.serverUrl || DEFAULT_SERVER_URL;

  pairBtn.disabled = true;
  pairBtn.textContent = '验证中...';
  showMsg('info', '正在连接服务器...');

  chrome.runtime.sendMessage({ type: 'pair', serverUrl, challenge: code }, async (resp) => {
    pairBtn.disabled = false;
    pairBtn.textContent = '配对连接';

    if (resp?.success) {
      await new Promise(r => chrome.storage.local.set({
        sessionToken: resp.sessionToken,
        serverUrl,
        sessionCreatedAt: new Date().toISOString()
      }, r));
      showMsg('success', '✅ 配对成功！');
      setTimeout(() => init(), 800);
    } else {
      showMsg('error', '❌ ' + (resp?.error || '验证码错误或已过期'));
      codeInput.select();
    }
  });
});

// 按 Enter 触发配对
codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') pairBtn.click();
});

// 断开连接
document.getElementById('revokeBtn').addEventListener('click', async () => {
  if (!confirm('确认断开连接？')) return;
  await removeStorage(['sessionToken', 'sessionCreatedAt']);
  chrome.runtime.sendMessage({ type: 'revoke' });
  init();
});

init();
