// CloudHand Popup v2.7.0 - 连接状态管理
// 通过 chrome.storage.local 与 background.js 通信
// 远程连接：粘贴完整 URL（ws://ip:port/ws?token=xxx）一步到位

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
  const token = stored.remoteToken || ''
  $('remoteDot').className = `dot ${remoteUp ? 'green' : host ? 'red' : 'yellow'}`
  $('remoteStatus').textContent = remoteUp ? '已连接' : (host ? '未连接' : '未配置')
  $('remoteLabel').textContent = host ? `远程 (${host}${port ? ':' + port : ''})` : '远程'

  // 回填 URL 输入框（仅当用户没有正在编辑时）
  if (document.activeElement !== $('remoteUrl')) {
    if (host) {
      $('remoteUrl').value = `ws://${host}${port ? ':' + port : ':9876'}/ws?token=${token}`
    } else {
      $('remoteUrl').value = ''
    }
  }

  // 按钮状态
  $('btnConnect').disabled = remoteUp
  $('btnDisconnect').disabled = !remoteUp && !host

  // Tab 数量信息
  updateTabsInfo()
}

// 获取已 attach 的 tab 数量
async function updateTabsInfo() {
  try {
    const stored = await chrome.storage.session.get(['persistedTabs'])
    const count = (stored.persistedTabs || []).length
    $('tabsInfo').textContent = count > 0 ? `已 Attach ${count} 个 Tab` : ''
  } catch {
    $('tabsInfo').textContent = ''
  }
}

// 解析完整 WebSocket URL: ws://host:port/ws?token=xxx
function parseWsUrl(input) {
  const s = (input || '').trim()
  if (!s) return null

  try {
    // 标准化：补全协议头
    let url = s
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      url = 'ws://' + url
    }
    // 用 URL 解析（ws:// 替换为 http:// 以便 URL 构造器识别）
    const parsed = new URL(url.replace(/^ws/, 'http'))
    const host = parsed.hostname
    const port = parseInt(parsed.port, 10) || 9876
    const token = parsed.searchParams.get('token') || ''
    if (!host) return null
    return { host, port, token }
  } catch {
    // URL 解析失败，尝试简单的 host:port 格式
    const clean = s.replace(/^(wss?|https?):\/\//, '').replace(/\/.*$/, '')
    const parts = clean.split(':')
    const host = parts[0]
    const port = parts.length > 1 ? parseInt(parts[1], 10) : 9876
    if (!host) return null
    return { host, port, token: '' }
  }
}

// 连接远程
$('btnConnect').addEventListener('click', async () => {
  const parsed = parseWsUrl($('remoteUrl').value)
  if (!parsed || !parsed.host) {
    $('errorMsg').textContent = '请输入有效的连接地址'
    $('errorMsg').style.display = 'block'
    return
  }
  if (!parsed.token) {
    $('errorMsg').textContent = 'URL 中缺少 token 参数'
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
    remoteToken: parsed.token,
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
  chrome.runtime.sendMessage({ action: 'toggleAttach' })
  setTimeout(refreshUI, 500)
})

// 初始化
refreshUI()
