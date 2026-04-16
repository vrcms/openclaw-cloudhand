// CloudHand Popup v2.6.0
import { CLOUDHAND_CONFIG } from './config.js';

const localDot = document.getElementById('localDot');
const localText = document.getElementById('localText');
const remoteDot = document.getElementById('remoteDot');
const remoteText = document.getElementById('remoteText');
const remoteUrl = document.getElementById('remoteUrl');
const remotePairView = document.getElementById('remotePairView');
const remoteConnectedView = document.getElementById('remoteConnectedView');
const codeInput = document.getElementById('codeInput');
const pairBtn = document.getElementById('pairBtn');
const pairMsg = document.getElementById('pairMsg');
const revokeBtn = document.getElementById('revokeBtn');

function updateStatus() {
  chrome.runtime.sendMessage({ type: 'getStatus' }, (status) => {
    if (!status) return;

    // 更新本地状态
    localDot.className = 'dot ' + (status.local.connected ? 'connected' : 'disconnected');
    localText.textContent = status.local.connected ? '已就绪 ✓' : '未运行';

    // 更新远程状态
    remoteDot.className = 'dot ' + (status.remote.connected ? 'connected' : 'disconnected');
    remoteText.textContent = status.remote.connected ? '已连接 ✓' : (status.remote.paired ? '连接中...' : '未配对');
    remoteUrl.textContent = status.remote.url || CLOUDHAND_CONFIG.wsUrl;

    // 切换界面
    if (status.remote.paired) {
      remotePairView.style.display = 'none';
      remoteConnectedView.style.display = 'block';
    } else {
      remotePairView.style.display = 'block';
      remoteConnectedView.style.display = 'none';
    }
  });
}

// 初始更新
updateStatus();
// 每3秒刷新一次界面状态
setInterval(updateStatus, 3000);

// 处理远程配对
pairBtn.addEventListener('click', () => {
  const code = codeInput.value.trim();
  if (code.length !== 6) {
    pairMsg.textContent = '请输入6位验证码';
    pairMsg.className = 'msg error';
    return;
  }

  pairBtn.disabled = true;
  pairBtn.textContent = '验证中...';
  
  chrome.runtime.sendMessage({ 
    type: 'pair', 
    serverUrl: remoteUrl.textContent, 
    challenge: code 
  }, (resp) => {
    pairBtn.disabled = false;
    pairBtn.textContent = '配对连接';
    
    if (resp?.success) {
      pairMsg.textContent = '配对成功！';
      pairMsg.className = 'msg success';
      setTimeout(updateStatus, 1000);
    } else {
      pairMsg.textContent = resp?.error || '配对失败';
      pairMsg.className = 'msg error';
    }
  });
});

// 断开远程
revokeBtn.addEventListener('click', () => {
  if (!confirm('确认断开远程 VPS 连接？')) return;
  chrome.runtime.sendMessage({ type: 'revoke' }, () => {
    updateStatus();
  });
});
