const DEFAULT_SERVER = 'ws://149.13.91.10/chrome-bridge';

async function getStorage(keys) {
  return new Promise(r => chrome.storage.local.get(keys, r));
}
async function setStorage(data) {
  return new Promise(r => chrome.storage.local.set(data, r));
}
async function removeStorage(keys) {
  return new Promise(r => chrome.storage.local.remove(keys, r));
}

async function init() {
  const data = await getStorage(['serverUrl', 'sessionToken', 'sessionCreatedAt']);
  const serverUrl = data.serverUrl || DEFAULT_SERVER;
  document.getElementById('serverUrl').value = serverUrl;

  if (data.sessionToken) {
    showConnected(serverUrl, data.sessionCreatedAt);
  } else {
    showPairForm();
  }

  // 检查实际连接状态
  chrome.runtime.sendMessage({ type: 'getStatus' }, (resp) => {
    updateStatusDot(resp?.connected);
  });
}

function showConnected(url, createdAt) {
  document.getElementById('pairCard').style.display = 'none';
  document.getElementById('connectedCard').style.display = 'block';
  document.getElementById('connectedServer').textContent = '服务器：' + url;
  if (createdAt) {
    document.getElementById('sessionInfo').textContent =
      '配对时间：' + new Date(createdAt).toLocaleString('zh-CN');
  }
}

function showPairForm() {
  document.getElementById('pairCard').style.display = 'block';
  document.getElementById('connectedCard').style.display = 'none';
  document.getElementById('sessionInfo').textContent = '';
  updateStatusDot(false);
}

function updateStatusDot(connected) {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  dot.className = 'dot ' + (connected ? 'connected' : 'disconnected');
  text.textContent = connected ? '已连接' : '未连接';
}

function showMsg(id, type, text) {
  const el = document.getElementById(id);
  el.className = 'msg ' + type;
  el.textContent = text;
}

async function doPair() {
  const serverUrl = document.getElementById('serverUrl').value.trim() || DEFAULT_SERVER;
  const code = document.getElementById('challengeCode').value.trim();

  if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) {
    showMsg('pairMsg', 'error', '请输入6位数字验证码');
    document.getElementById('challengeCode').classList.add('error');
    return;
  }
  document.getElementById('challengeCode').classList.remove('error');

  const btn = document.getElementById('pairBtn');
  btn.disabled = true;
  btn.textContent = '连接中...';
  showMsg('pairMsg', 'info', '正在验证...');

  // 保存 serverUrl
  await setStorage({ serverUrl });

  // 发消息给 background 进行 challenge 配对
  chrome.runtime.sendMessage({ type: 'pair', serverUrl, challenge: code }, async (resp) => {
    btn.disabled = false;
    btn.textContent = '配对连接';
    if (resp?.success) {
      await setStorage({
        sessionToken: resp.sessionToken,
        sessionCreatedAt: new Date().toISOString()
      });
      showMsg('pairMsg', 'success', '✅ 配对成功！');
      setTimeout(() => showConnected(serverUrl, new Date().toISOString()), 800);
      updateStatusDot(true);
    } else {
      showMsg('pairMsg', 'error', '❌ ' + (resp?.error || '配对失败，验证码错误或已过期'));
    }
  });
}

async function doRevoke() {
  if (!confirm('确认断开连接？需要重新配对才能使用。')) return;
  await removeStorage(['sessionToken', 'sessionCreatedAt']);
  chrome.runtime.sendMessage({ type: 'revoke' });
  showPairForm();
  showMsg('pairMsg', 'info', '已断开连接，请重新配对');
}

document.addEventListener('DOMContentLoaded', init);

// 实时更新连接状态
setInterval(() => {
  chrome.runtime.sendMessage({ type: 'getStatus' }, (resp) => {
    updateStatusDot(resp?.connected);
  });
}, 3000);
