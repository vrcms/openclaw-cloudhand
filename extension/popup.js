// CloudHand Popup - 连接状态管理
// 从 chrome.storage.local 读写配置，与 background.js 通过 storage 事件通信

const $ = (id) => document.getElementById(id)

// 读取并显示当前状态
async function refreshUI() {
  const stored = await chrome.storage.local.get([
    'localConnected',
    'remoteConnected',
    'remoteHost',
    'remotePort',
    'remoteToken',
  ])

  // 本地状态
  const localUp = !!stored.localConnected
  $('localDot').className = `dot ${localUp ? 'green' : 'red'}`
  $('localStatus').textContent = localUp ? '已连接' : '未连接'

  // 远程状态
  const remoteUp = !!stored.remoteConnected
  const host = stored.remoteHost || ''
  const port = stored.remotePort || ''
  $('remoteDot').className = `dot ${remoteUp ? 'green' : host ? 'red' : 'yellow'}`
  $('remoteStatus').textContent = remoteUp ? '已连接' : (host ? '未连接' : '未配置')
  $('remoteLabel').textContent = host ? `${host}${port ? ':' + port : ''}` : '未配置'

  // 填充输入框（仅当用户没有正在编辑时）
  if (document.activeElement !== $('remoteHost')) {
    $('remoteHost').value = host ? `${host}${port ? ':' + port : ''}` : ''
  }
  if (document.activeElement !== $('remoteToken')) {
    $('remoteToken').value = stored.remoteToken || ''
  }

  // 按钮状态
  $('btnConnect').disabled = remoteUp
  $('btnDisconnect').disabled = !remoteUp && !host
}

// 解析 host:port 输入
function parseHostPort(input) {
  const s = (input || '').trim()
  if (!s) return null
  // 去掉协议前缀
  const clean = s.replace(/^(wss?|https?):\/\//, '')
  const parts = clean.split(':')
  const host = parts[0]
  const port = parts.length > 1 ? parseInt(parts[1], 10) : 9876
  if (!host) return null
  return { host, port }
}

// 连接远程
$('btnConnect').addEventListener('click', async () => {
  const parsed = parseHostPort($('remoteHost').value)
  if (!parsed) {
    $('errorMsg').textContent = '请输入有效的远程地址'
    $('errorMsg').style.display = 'block'
    return
  }
  const token = $('remoteToken').value.trim()
  if (!token) {
    $('errorMsg').textContent = '请输入 Token'
    $('errorMsg').style.display = 'block'
    return
  }

  $('errorMsg').style.display = 'none'
  $('btnConnect').disabled = true
  $('btnConnect').textContent = '连接中...'

  // 写入配置，background.js 监听 storage 变化后自动连接
  await chrome.storage.local.set({
    remoteHost: parsed.host,
    remotePort: parsed.port,
    remoteToken: token,
    remoteAction: 'connect',
  })

  // 等待状态变化
  setTimeout(refreshUI, 1500)
  setTimeout(() => {
    $('btnConnect').textContent = '连接'
    refreshUI()
  }, 3000)
})

// 断开远程
$('btnDisconnect').addEventListener('click', async () => {
  $('errorMsg').style.display = 'none'
  await chrome.storage.local.set({
    remoteAction: 'disconnect',
  })
  setTimeout(refreshUI, 500)
})

// 监听 storage 变化实时刷新
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    refreshUI()
  }
})

// Attach/Detach 当前 Tab
$('btnAttach').addEventListener('click', async () => {
  // 通过 runtime message 通知 background.js
  chrome.runtime.sendMessage({ action: 'toggleAttach' })
  setTimeout(refreshUI, 500)
})

// 初始化
refreshUI()
