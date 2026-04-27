import {
  buildRelayWsUrl,
  buildRemoteWsUrl,
  isLastRemainingTab,
  isMissingTabError,
  isRetryableReconnectError,
  reconnectDelayMs,
} from './background-utils.js'

const DEFAULT_PORT = 9876

const BADGE = {
  on: { text: 'ON', color: '#FF5A36' },
  off: { text: '', color: '#000000' },
  connecting: { text: '…', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' },
}

// ── 本地连接状态 ──
/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null
let relayGatewayToken = ''
/** @type {string|null} */
let relayConnectRequestId = null

// ── 远程连接状态 ──
/** @type {WebSocket|null} */
let remoteWs = null
/** @type {Promise<void>|null} */
let remoteConnectPromise = null
let remoteGatewayToken = ''
/** @type {string|null} */
let remoteConnectRequestId = null
let remoteReconnectAttempt = 0
let remoteReconnectTimer = null

let nextSession = 1

/** @type {Map<number, {state:'connecting'|'connected', sessionId?:string, targetId?:string, attachOrder?:number}>} */
const tabs = new Map()
/** @type {Map<string, number>} */
const tabBySession = new Map()
/** @type {Map<string, number>} */
const childSessionToTab = new Map()

// 全局 target 发现映射（覆盖所有 tab，不限已 attach 的）
/** @type {Map<string, number>} targetId → tabId */
const targetIdToTab = new Map()
// 已上报的 target 去重表（避免重复事件）
/** @type {Map<string, {url: string, title: string}>} */
const reportedTargets = new Map()

/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const pending = new Map()
// 远程连接的 pending 请求
/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const remotePending = new Map()

// Per-tab operation locks prevent double-attach races.
/** @type {Set<number>} */
const tabOperationLocks = new Set()

// Tabs currently in a detach/re-attach cycle after navigation.
/** @type {Set<number>} */
const reattachPending = new Set()

// ── 互斥锁：防止本地和远程同时操作同一 Tab ──
// sessionId → { source: 'local'|'remote', lockedAt: timestamp }
const tabLocks = new Map()
const LOCK_TIMEOUT_MS = 10000

function acquireLock(sessionId, source) {
  const existing = tabLocks.get(sessionId)
  if (existing && existing.source !== source) {
    // 检查是否超时
    if (Date.now() - existing.lockedAt < LOCK_TIMEOUT_MS) {
      const label = existing.source === 'local' ? '本地' : '远程'
      throw new Error(`${label}智能体正在操作该 Tab，请稍后重试`)
    }
  }
  tabLocks.set(sessionId, { source, lockedAt: Date.now() })
}

function releaseLock(sessionId) {
  tabLocks.delete(sessionId)
}

// Reconnect state for exponential backoff.
let reconnectAttempt = 0
let reconnectTimer = null

const TAB_VALIDATION_ATTEMPTS = 2
const TAB_VALIDATION_RETRY_DELAY_MS = 1000

function nowStack() {
  try {
    return new Error().stack || ''
  } catch {
    return ''
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function validateAttachedTab(tabId) {
  try {
    await chrome.tabs.get(tabId)
  } catch {
    return false
  }

  for (let attempt = 0; attempt < TAB_VALIDATION_ATTEMPTS; attempt++) {
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: '1',
        returnByValue: true,
      })
      return true
    } catch (err) {
      if (isMissingTabError(err)) {
        return false
      }
      if (attempt < TAB_VALIDATION_ATTEMPTS - 1) {
        await sleep(TAB_VALIDATION_RETRY_DELAY_MS)
      }
    }
  }

  return false
}

async function getRelayPort() {
  const stored = await chrome.storage.local.get(['relayPort'])
  const raw = stored.relayPort
  const n = Number.parseInt(String(raw || ''), 10)
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return DEFAULT_PORT
  return n
}

async function getGatewayToken() {
  const stored = await chrome.storage.local.get(['gatewayToken'])
  const token = String(stored.gatewayToken || '').trim()
  // 本地模式：未配置时默认使用 local-mode-token（与 cloudhand-bridge 兼容）
  return token || 'local-mode-token'
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind]
  void chrome.action.setBadgeText({ tabId, text: cfg.text })
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color })
  void chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => {})
}

// Persist attached tab state to survive MV3 service worker restarts.
async function persistState() {
  try {
    const tabEntries = []
    for (const [tabId, tab] of tabs.entries()) {
      if (tab.state === 'connected' && tab.sessionId && tab.targetId) {
        tabEntries.push({ tabId, sessionId: tab.sessionId, targetId: tab.targetId, attachOrder: tab.attachOrder })
      }
    }
    await chrome.storage.session.set({
      persistedTabs: tabEntries,
      nextSession,
    })
  } catch {
    // chrome.storage.session may not be available in all contexts.
  }
}

// Rehydrate tab state on service worker startup. Fast path — just restores
// maps and badges. Relay reconnect happens separately in background.
async function rehydrateState() {
  try {
    const stored = await chrome.storage.session.get(['persistedTabs', 'nextSession'])
    if (stored.nextSession) {
      nextSession = Math.max(nextSession, stored.nextSession)
    }
    const entries = stored.persistedTabs || []
    // Phase 1: optimistically restore state and badges.
    for (const entry of entries) {
      tabs.set(entry.tabId, {
        state: 'connected',
        sessionId: entry.sessionId,
        targetId: entry.targetId,
        attachOrder: entry.attachOrder,
      })
      tabBySession.set(entry.sessionId, entry.tabId)
      setBadge(entry.tabId, 'on')
    }
    // Retry once so transient busy/navigation states do not permanently drop
    // a still-attached tab after a service worker restart.
    for (const entry of entries) {
      const valid = await validateAttachedTab(entry.tabId)
      if (!valid) {
        tabs.delete(entry.tabId)
        tabBySession.delete(entry.sessionId)
        setBadge(entry.tabId, 'off')
      }
    }
  } catch {
    // Ignore rehydration errors.
  }
}

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
  if (relayConnectPromise) return await relayConnectPromise

  relayConnectPromise = (async () => {
    const port = await getRelayPort()
    const gatewayToken = await getGatewayToken()
    const httpBase = `http://127.0.0.1:${port}`
    const wsUrl = await buildRelayWsUrl('127.0.0.1', port, gatewayToken)

    // Fast preflight: is the relay server up?
    try {
      await fetch(`${httpBase}/`, { method: 'HEAD', signal: AbortSignal.timeout(2000) })
    } catch (err) {
      throw new Error(`Relay server not reachable at ${httpBase} (${String(err)})`)
    }

    const ws = new WebSocket(wsUrl)
    relayWs = ws
    relayGatewayToken = gatewayToken
    // Bind message handler before open so an immediate first frame (for example
    // gateway connect.challenge) cannot be missed.
    ws.onmessage = (event) => {
      if (ws !== relayWs) return
      void whenReady(() => onRelayMessage(String(event.data || '')))
    }

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000)
      ws.onopen = () => {
        clearTimeout(t)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(t)
        reject(new Error('WebSocket connect failed'))
      }
      ws.onclose = (ev) => {
        clearTimeout(t)
        reject(new Error(`WebSocket closed (${ev.code} ${ev.reason || 'no reason'})`))
      }
    })

    // Bind permanent handlers. Guard against stale socket: if this WS was
    // replaced before its close fires, the handler is a no-op.
    ws.onclose = () => {
      if (ws !== relayWs) return
      onRelayClosed('closed')
    }
    ws.onerror = () => {
      if (ws !== relayWs) return
      onRelayClosed('error')
    }
  })()

  try {
    await relayConnectPromise
    reconnectAttempt = 0
    // 更新 popup 状态
    updateConnectionStatus()
  } finally {
    relayConnectPromise = null
  }
}

// Relay closed — update badges, reject pending requests, auto-reconnect.
// Debugger sessions are kept alive so they survive transient WS drops.
function onRelayClosed(reason) {
  relayWs = null
  relayGatewayToken = ''
  updateConnectionStatus()
  relayConnectRequestId = null

  for (const [id, p] of pending.entries()) {
    pending.delete(id)
    p.reject(new Error(`Relay disconnected (${reason})`))
  }

  reattachPending.clear()

  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected') {
      setBadge(tabId, 'connecting')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay: relay reconnecting…',
      })
    }
  }

  scheduleReconnect()
}

function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const delay = reconnectDelayMs(reconnectAttempt)
  reconnectAttempt++

  console.log(`Scheduling reconnect attempt ${reconnectAttempt} in ${Math.round(delay)}ms`)

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    try {
      await ensureRelayConnection()
      reconnectAttempt = 0
      console.log('Reconnected successfully')
      await reannounceAttachedTabs()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`Reconnect attempt ${reconnectAttempt} failed: ${message}`)
      if (!isRetryableReconnectError(err)) {
        return
      }
      scheduleReconnect()
    }
  }, delay)
}

function cancelReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempt = 0
}

// Re-announce all attached tabs to the relay after reconnect.
async function reannounceAttachedTabs() {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state !== 'connected' || !tab.sessionId || !tab.targetId) continue

    // Retry once here as well; reconnect races can briefly make an otherwise
    // healthy tab look unavailable.
    const valid = await validateAttachedTab(tabId)
    if (!valid) {
      tabs.delete(tabId)
      if (tab.sessionId) tabBySession.delete(tab.sessionId)
      setBadge(tabId, 'off')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay (click to attach/detach)',
      })
      continue
    }

    // Send fresh attach event to relay.
    // Split into two try-catch blocks so debugger failures and relay send
    // failures are handled independently. Previously, a relay send failure
    // would fall into the outer catch and set the badge to 'on' even though
    // the relay had no record of the tab — causing every subsequent browser
    // tool call to fail with "no tab connected" until the next reconnect cycle.
    let targetInfo
    try {
      const info = /** @type {any} */ (
        await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
      )
      targetInfo = info?.targetInfo
    } catch {
      // Target.getTargetInfo failed. Preserve at least targetId from
      // cached tab state so relay receives a stable identifier.
      targetInfo = tab.targetId ? { targetId: tab.targetId } : undefined
    }

    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          params: {
            sessionId: tab.sessionId,
            targetInfo: { ...targetInfo, attached: true },
            waitingForDebugger: false,
          },
        },
      })

      setBadge(tabId, 'on')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay: attached (click to detach)',
      })
    } catch {
      // Relay send failed (e.g. WS closed in the gap between ensureRelayConnection
      // resolving and this loop executing). The tab is still valid — leave badge
      // as 'connecting' so the reconnect/keepalive cycle will retry rather than
      // showing a false-positive 'on' that hides the broken state from the user.
      setBadge(tabId, 'connecting')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay: relay reconnecting…',
      })
    }
  }

  await persistState()
}

function sendToRelay(payload) {
  const msg = JSON.stringify(payload)
  let sent = false
  // 向本地连接发送
  if (relayWs && relayWs.readyState === WebSocket.OPEN) {
    relayWs.send(msg)
    sent = true
  }
  // 向远程连接发送
  if (remoteWs && remoteWs.readyState === WebSocket.OPEN) {
    remoteWs.send(msg)
    sent = true
  }
  if (!sent) {
    throw new Error('Relay not connected')
  }
}

// 仅向本地发送
function sendToLocal(payload) {
  const ws = relayWs
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Local relay not connected')
  }
  ws.send(JSON.stringify(payload))
}

// 仅向远程发送
function sendToRemote(payload) {
  const ws = remoteWs
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Remote relay not connected')
  }
  ws.send(JSON.stringify(payload))
}

function ensureGatewayHandshakeStarted(payload) {
  if (relayConnectRequestId) return
  const nonce = typeof payload?.nonce === 'string' ? payload.nonce.trim() : ''
  relayConnectRequestId = `ext-connect-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  sendToRelay({
    type: 'req',
    id: relayConnectRequestId,
    method: 'connect',
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'chrome-relay-extension',
        version: '1.0.0',
        platform: 'chrome-extension',
        mode: 'webchat',
      },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      caps: [],
      commands: [],
      nonce: nonce || undefined,
      auth: relayGatewayToken ? { token: relayGatewayToken } : undefined,
    },
  })
}



function requestFromRelay(command) {
  const id = command.id
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Relay request timeout (30s)'))
    }, 30000)
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
    try {
      sendToRelay(command)
    } catch (err) {
      clearTimeout(timer)
      pending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

async function onRelayMessage(text) {
  /** @type {any} */
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return
  }

  if (msg && msg.type === 'event' && msg.event === 'connect.challenge') {
    try {
      ensureGatewayHandshakeStarted(msg.payload)
    } catch (err) {
      console.warn('gateway connect handshake start failed', err instanceof Error ? err.message : String(err))
      relayConnectRequestId = null
      const ws = relayWs
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1008, 'gateway connect failed')
      }
    }
    return
  }

  if (msg && msg.type === 'res' && relayConnectRequestId && msg.id === relayConnectRequestId) {
    relayConnectRequestId = null
    if (!msg.ok) {
      const detail = msg?.error?.message || msg?.error || 'gateway connect failed'
      console.warn('gateway connect handshake rejected', String(detail))
      const ws = relayWs
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1008, 'gateway connect failed')
      }
    } else {
      // 握手成功后批量发现所有 tab 并上报
      console.log('[CloudHand] Gateway 握手成功，开始发现现有 tab...')
      void discoverExistingTabs()
    }
    return
  }

  if (msg && msg.method === 'ping') {
    try {
      sendToRelay({ method: 'pong' })
    } catch {
      // ignore
    }
    return
  }

  if (msg && typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(String(msg.error)))
    else p.resolve(msg.result)
    return
  }

  if (msg && typeof msg.id === 'number' && msg.method === 'forwardCDPCommand') {
    const sessionId = msg?.params?.sessionId
    try {
      acquireLock(sessionId || '__global__', 'local')
      const result = await handleForwardCdpCommand(msg)
      sendToLocal({ id: msg.id, result })
    } catch (err) {
      sendToLocal({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
    } finally {
      releaseLock(sessionId || '__global__')
    }
  }
}

function getTabBySessionId(sessionId) {
  const direct = tabBySession.get(sessionId)
  if (direct) return { tabId: direct, kind: 'main' }
  const child = childSessionToTab.get(sessionId)
  if (child) return { tabId: child, kind: 'child' }
  return null
}

function getTabByTargetId(targetId) {
  // 优先：全局映射表（覆盖所有 tab）
  const mapped = targetIdToTab.get(targetId)
  if (mapped !== undefined) return mapped

  // Fallback 1：已 attach 的 tabs
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.targetId === targetId) return tabId
  }

  // Fallback 2：tab-{tabId} 格式解析
  if (typeof targetId === 'string' && targetId.startsWith('tab-')) {
    const n = Number.parseInt(targetId.substring(4), 10)
    if (Number.isFinite(n)) return n
  }
  return null
}

// 发现单个 tab 的 targetId 并建立映射
async function discoverSingleTab(tabId) {
  if (!tabId || typeof tabId !== 'number') return null
  try {
    const targets = await chrome.debugger.getTargets()
    const target = targets.find(t => t.tabId === tabId)
    if (!target) return null
    targetIdToTab.set(target.id, tabId)
    return { targetId: target.id, url: target.url || '', title: target.title || '', type: target.type || 'page' }
  } catch (err) {
    console.warn(`[CloudHand] discoverSingleTab(${tabId}) failed:`, err.message || err)
    return null
  }
}

// 批量发现所有现存 tab 并上报给 Server
async function discoverExistingTabs() {
  try {
    const [allTabs, allTargets] = await Promise.all([
      chrome.tabs.query({}),
      chrome.debugger.getTargets()
    ])
    if (!allTabs || allTabs.length === 0) {
      if (relayWs && relayWs.readyState === WebSocket.OPEN) {
        sendToRelay({ method: 'reportTargets', targets: [] })
      }
      return
    }
    // 建立 tabId→target 映射
    const targetMap = new Map()
    if (allTargets) {
      for (const t of allTargets) {
        if (t.tabId) targetMap.set(t.tabId, t)
      }
    }
    const discoveredList = []
    for (const tab of allTabs) {
      if (!tab.id) continue
      const target = targetMap.get(tab.id)
      if (target) {
        targetIdToTab.set(target.id, tab.id)
        discoveredList.push({
          targetId: target.id, tabId: tab.id,
          url: target.url || '', title: target.title || '', type: target.type || 'page'
        })
      }
    }
    console.log(`[CloudHand] 发现 ${discoveredList.length}/${allTabs.length} 个 tab 的 target`)
    // 向所有已连接的 relay 发送
    const msg = { method: 'reportTargets', targets: discoveredList }
    try { sendToRelay(msg) } catch { /* 没有连接时忽略 */ }
  } catch (err) {
    console.error('[CloudHand] discoverExistingTabs failed:', err)
  }
}

async function attachTab(tabId, opts = {}) {
  const debuggee = { tabId }
  await chrome.debugger.attach(debuggee, '1.3')
  await chrome.debugger.sendCommand(debuggee, 'Page.enable').catch(() => {})

  const info = /** @type {any} */ (await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo'))
  const targetInfo = info?.targetInfo
  const targetId = String(targetInfo?.targetId || '').trim()
  if (!targetId) {
    throw new Error('Target.getTargetInfo returned no targetId')
  }

  const sid = nextSession++
  const sessionId = `cb-tab-${sid}`
  const attachOrder = sid

  tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder })
  tabBySession.set(sessionId, tabId)
  targetIdToTab.set(targetId, tabId)
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay: attached (click to detach)',
  })

  if (!opts.skipAttachedEvent) {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false,
        },
      },
    })
  }

  setBadge(tabId, 'on')
  await persistState()

  return { sessionId, targetId }
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId)

  // Send detach events for child sessions first.
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) {
      try {
        sendToRelay({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.detachedFromTarget',
            params: { sessionId: childSessionId, reason: 'parent_detached' },
          },
        })
      } catch {
        // Relay may be down.
      }
      childSessionToTab.delete(childSessionId)
    }
  }

  // Send detach event for main session.
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason },
        },
      })
    } catch {
      // Relay may be down.
    }
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)

  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // May already be detached.
  }

  setBadge(tabId, 'off')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay (click to attach/detach)',
  })

  await persistState()
}

async function connectOrToggleForActiveTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = active?.id
  if (!tabId) return

  // Prevent concurrent operations on the same tab.
  if (tabOperationLocks.has(tabId)) return
  tabOperationLocks.add(tabId)

  try {
    if (reattachPending.has(tabId)) {
      reattachPending.delete(tabId)
      setBadge(tabId, 'off')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay (click to attach/detach)',
      })
      return
    }

    const existing = tabs.get(tabId)
    if (existing?.state === 'connected') {
      await detachTab(tabId, 'toggle')
      return
    }

    // User is manually connecting — cancel any pending reconnect.
    cancelReconnect()

    tabs.set(tabId, { state: 'connecting' })
    setBadge(tabId, 'connecting')
    void chrome.action.setTitle({
      tabId,
      title: 'OpenClaw Browser Relay: connecting to local relay…',
    })

    try {
      await ensureRelayConnection()
      await attachTab(tabId)
    } catch (err) {
      tabs.delete(tabId)
      setBadge(tabId, 'error')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay: relay not running (open options for setup)',
      })

      const message = err instanceof Error ? err.message : String(err)
      console.warn('attach failed', message, nowStack())
    }
  } finally {
    tabOperationLocks.delete(tabId)
  }
}

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined

  const bySession = sessionId ? getTabBySessionId(sessionId) : null
  const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined
  const tabId =
    bySession?.tabId ||
    (targetId ? getTabByTargetId(targetId) : null) ||
    (() => {
      for (const [id, tab] of tabs.entries()) {
        if (tab.state === 'connected') return id
      }
      return null
    })()

  // Target.createTarget：始终在 agent 专属窗口内创建 tab，不污染用户窗口
  if (method === 'Target.createTarget') {
    const url = typeof params?.url === 'string' ? params.url : 'about:blank'

    // 检查 agent 窗口是否有效
    let validAgentWindow = false
    if (agentWindowId !== null) {
      try {
        await chrome.windows.get(agentWindowId)
        validAgentWindow = true
      } catch {
        // 窗口已被用户关闭
        agentWindowId = null
      }
    }

    // agent 窗口不存在时先创建
    if (!validAgentWindow) {
      console.log('[CloudHand] Agent 窗口不存在，正在重建...')
      const win = await chrome.windows.create({ url: 'about:blank', state: 'normal', focused: false })
      agentWindowId = win.id
      // 把第一个 tab 也顺带 attach 上
      const firstTab = win.tabs && win.tabs[0]
      if (firstTab && firstTab.id) {
        await sleep(300)
        await attachTab(firstTab.id)
        // 如果请求的 url 就是 about:blank，直接复用这个 tab
        if (url === 'about:blank') {
          const tabInfo = tabs.get(firstTab.id)
          return { targetId: tabInfo?.targetId || '' }
        }
        // 否则在这个 tab 上导航，而不是再开新 tab
        await chrome.tabs.update(firstTab.id, { url })
        const tabInfo = tabs.get(firstTab.id)
        return { targetId: tabInfo?.targetId || '' }
      }
    }

    // agent 窗口已存在，在其中创建新 tab
    const tab = await chrome.tabs.create({ url, windowId: agentWindowId, active: false })
    if (!tab.id) throw new Error('Failed to create tab')
    await sleep(100)
    const attached = await attachTab(tab.id)
    return { targetId: attached.targetId }
  }

  // Target.getTargets — 用 Extension API 代替 CDP（CDP 会返回 Not allowed）
  if (method === 'Target.getTargets') {
    const targets = await chrome.debugger.getTargets()
    return { targetInfos: targets }
  }

  // Target.attachToTarget — 从全局映射查找 tab 并 attach
  if (method === 'Target.attachToTarget') {
    const tid = typeof params?.targetId === 'string' ? params.targetId : ''
    if (!tid) throw new Error('targetId required')
    const foundTabId = getTabByTargetId(tid)
    if (!foundTabId) throw new Error(`Target not found: ${tid}`)
    // 已 attach 直接返回
    if (tabs.has(foundTabId) && tabs.get(foundTabId).state === 'connected') {
      return { sessionId: tabs.get(foundTabId).sessionId }
    }
    const attached = await attachTab(foundTabId)
    return { sessionId: attached.sessionId }
  }

  // Target.detachFromTarget — 查找并 detach
  if (method === 'Target.detachFromTarget') {
    const detachSid = typeof params?.sessionId === 'string' ? params.sessionId : ''
    if (!detachSid) throw new Error('sessionId required')
    const foundTabId = tabBySession.get(detachSid)
    if (!foundTabId) throw new Error(`Session not found: ${detachSid}`)
    await detachTab(foundTabId, 'client request')
    return {}
  }

  if (!tabId) throw new Error(`No attached tab for method ${method}`)

  /** @type {chrome.debugger.DebuggerSession} */
  const debuggee = { tabId }

  if (method === 'Runtime.enable') {
    try {
      await chrome.debugger.sendCommand(debuggee, 'Runtime.disable')
      await new Promise((r) => setTimeout(r, 50))
    } catch {
      // ignore
    }
    return await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params)
  }

  if (method === 'Target.closeTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toClose = target ? getTabByTargetId(target) : tabId
    if (!toClose) return { success: false }
    try {
      const allTabs = await chrome.tabs.query({})
      if (isLastRemainingTab(allTabs, toClose)) {
        console.warn('Refusing to close the last tab: this would kill the browser process')
        return { success: false, error: 'Cannot close the last tab' }
      }
      await chrome.tabs.remove(toClose)
    } catch {
      return { success: false }
    }
    return { success: true }
  }

  if (method === 'Target.activateTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toActivate = target ? getTabByTargetId(target) : tabId
    if (!toActivate) return {}
    const tab = await chrome.tabs.get(toActivate).catch(() => null)
    if (!tab) return {}
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    }
    await chrome.tabs.update(toActivate, { active: true }).catch(() => {})
    return {}
  }

  const tabState = tabs.get(tabId)
  const mainSessionId = tabState?.sessionId
  const debuggerSession =
    sessionId && mainSessionId && sessionId !== mainSessionId
      ? { ...debuggee, sessionId }
      : debuggee

  return await chrome.debugger.sendCommand(debuggerSession, method, params)
}

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId
  if (!tabId) return
  const tab = tabs.get(tabId)
  if (!tab?.sessionId) return

  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId)
  }

  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId))
  }

  try {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    })
  } catch {
    // Relay may be down.
  }
}

async function onDebuggerDetach(source, reason) {
  const tabId = source.tabId
  if (!tabId) return
  if (!tabs.has(tabId)) return

  // User explicitly cancelled or DevTools replaced the connection — respect their intent
  if (reason === 'canceled_by_user' || reason === 'replaced_with_devtools') {
    void detachTab(tabId, reason)
    return
  }

  // Check if tab still exists — distinguishes navigation from tab close
  let tabInfo
  try {
    tabInfo = await chrome.tabs.get(tabId)
  } catch {
    // Tab is gone (closed) — normal cleanup
    void detachTab(tabId, reason)
    return
  }

  if (tabInfo.url?.startsWith('chrome://') || tabInfo.url?.startsWith('chrome-extension://')) {
    void detachTab(tabId, reason)
    return
  }

  if (reattachPending.has(tabId)) return

  const oldTab = tabs.get(tabId)
  const oldSessionId = oldTab?.sessionId
  const oldTargetId = oldTab?.targetId

  if (oldSessionId) tabBySession.delete(oldSessionId)
  tabs.delete(tabId)
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }

  if (oldSessionId && oldTargetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: oldSessionId, targetId: oldTargetId, reason: 'navigation-reattach' },
        },
      })
    } catch {
      // Relay may be down.
    }
  }

  reattachPending.add(tabId)
  setBadge(tabId, 'connecting')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay: re-attaching after navigation…',
  })

  // Extend re-attach window from 2.5 s to ~7.7 s (5 attempts).
  // SPAs and pages with heavy JS can take >2.5 s before the Chrome debugger
  // is attachable, causing all three original attempts to fail and leaving
  // the badge permanently off after every navigation.
  const delays = [200, 500, 1000, 2000, 4000]
  for (let attempt = 0; attempt < delays.length; attempt++) {
    await new Promise((r) => setTimeout(r, delays[attempt]))

    if (!reattachPending.has(tabId)) return

    try {
      await chrome.tabs.get(tabId)
    } catch {
      reattachPending.delete(tabId)
      setBadge(tabId, 'off')
      return
    }

    const relayUp = relayWs && relayWs.readyState === WebSocket.OPEN

    try {
      // When relay is down, still attach the debugger but skip sending the
      // relay event. reannounceAttachedTabs() will notify the relay once it
      // reconnects, so the tab stays tracked across transient relay drops.
      await attachTab(tabId, { skipAttachedEvent: !relayUp })
      reattachPending.delete(tabId)
      if (!relayUp) {
        setBadge(tabId, 'connecting')
        void chrome.action.setTitle({
          tabId,
          title: 'OpenClaw Browser Relay: attached, waiting for relay reconnect…',
        })
      }
      return
    } catch {
      // continue retries
    }
  }

  reattachPending.delete(tabId)
  setBadge(tabId, 'off')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay: re-attach failed (click to retry)',
  })
}

// Tab lifecycle listeners — clean up stale entries.
chrome.tabs.onRemoved.addListener((tabId) => void whenReady(() => {
  reattachPending.delete(tabId)

  // 清理 targetIdToTab 映射并通知 Server
  for (const [targetId, mappedTabId] of targetIdToTab.entries()) {
    if (mappedTabId === tabId) {
      targetIdToTab.delete(targetId)
      reportedTargets.delete(targetId)
      try {
        sendToRelay({ method: 'targetDestroyed', targetId })
      } catch { /* relay down */ }
      break
    }
  }

  if (!tabs.has(tabId)) return
  const tab = tabs.get(tabId)
  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason: 'tab_closed' },
        },
      })
    } catch {
      // Relay may be down.
    }
  }
  void persistState()
}))

// agent 窗口内新开的 tab 自动 attach
chrome.tabs.onCreated.addListener((tab) => void whenReady(async () => {
  if (agentWindowId !== null && tab.windowId === agentWindowId && tab.id) {
    console.log(`[CloudHand] Agent 窗口新开 Tab (tabId=${tab.id}), 准备自动 attach...`);
    // 等待一小段时间让 tab 初始化完成
    await sleep(300);
    try {
      await attachTab(tab.id);
      console.log(`[CloudHand] 自动 attach 成功 (tabId=${tab.id})`);
    } catch (err) {
      console.warn('[CloudHand] 自动 attach 失败:', err instanceof Error ? err.message : String(err));
    }
  }
}))

// 追踪 tab 的 URL/title 变化，上报 targetDiscovered/targetInfoChanged
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => void whenReady(async () => {
  // 只在有实际变化时处理
  if (!changeInfo.url && !changeInfo.title && changeInfo.status !== 'complete') return

  const url = tab.url || ''
  // 过滤系统页面
  if (!url || url === 'about:blank' || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('edge://')) return

  const targetInfo = await discoverSingleTab(tabId)
  if (!targetInfo) return

  // 去重检查
  const reported = reportedTargets.get(targetInfo.targetId)
  const isNew = !reported
  const changed = reported && (reported.url !== targetInfo.url || reported.title !== targetInfo.title)
  if (!isNew && !changed) return

  reportedTargets.set(targetInfo.targetId, { url: targetInfo.url, title: targetInfo.title })

  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return

  sendToRelay({
    method: isNew ? 'targetDiscovered' : 'targetInfoChanged',
    targetId: targetInfo.targetId,
    tabId,
    url: targetInfo.url,
    title: targetInfo.title,
    type: targetInfo.type
  })
}))

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => void whenReady(() => {
  const tab = tabs.get(removedTabId)
  if (!tab) return
  tabs.delete(removedTabId)
  tabs.set(addedTabId, tab)
  if (tab.sessionId) {
    tabBySession.set(tab.sessionId, addedTabId)
  }
  // 更新 targetIdToTab 映射
  if (tab.targetId) {
    targetIdToTab.set(tab.targetId, addedTabId)
  }
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === removedTabId) {
      childSessionToTab.set(childSessionId, addedTabId)
    }
  }
  setBadge(addedTabId, 'on')
  void persistState()
}))

// Register debugger listeners at module scope so detach/event handling works
// even when the relay WebSocket is down.
chrome.debugger.onEvent.addListener((...args) => void whenReady(() => onDebuggerEvent(...args)))
chrome.debugger.onDetach.addListener((...args) => void whenReady(() => onDebuggerDetach(...args)))

// 有 popup 时 action.onClicked 不触发，通过 runtime.onMessage 接收 popup 的请求
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.action === 'toggleAttach') {
    void whenReady(() => connectOrToggleForActiveTab())
    sendResponse({ ok: true })
  }
  return false
})

// Refresh badge after navigation completes — service worker may have restarted
// during navigation, losing ephemeral badge state.
chrome.webNavigation.onCompleted.addListener(({ tabId, frameId }) => void whenReady(() => {
  if (frameId !== 0) return
  const tab = tabs.get(tabId)
  if (tab?.state === 'connected') {
    setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? 'on' : 'connecting')
  }
}))

// Refresh badge when user switches to an attached tab.
chrome.tabs.onActivated.addListener(({ tabId }) => void whenReady(() => {
  const tab = tabs.get(tabId)
  if (tab?.state === 'connected') {
    setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? 'on' : 'connecting')
  }
}))



// MV3 keepalive via chrome.alarms — more reliable than setInterval across
// service worker restarts. Checks relay health and refreshes badges.
chrome.alarms.create('relay-keepalive', { periodInMinutes: 0.5 })

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'relay-keepalive') return
  await initPromise
  // Refresh badges (ephemeral in MV3).
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected') {
      setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? 'on' : 'connecting')
    }
  }

  // keepalive: bridge 不在线时触发重连（无论是否有 tab）
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
    if (!relayConnectPromise && !reconnectTimer) {
      console.log('Keepalive: WebSocket unhealthy, triggering reconnect')
      await ensureRelayConnection().then(() => {
        reconnectAttempt = 0
        return ensureAgentWindow()
      }).catch(() => {
        if (!reconnectTimer) scheduleReconnect()
      })
    }
  }
})

// agent 窗口状态（只记录一个 windowId）
let agentWindowId = null

// 确保有且只有一个 agent 窗口
async function ensureAgentWindow() {
  // 如果已有 agent 窗口且 tab 已 attach，直接返回
  if (agentWindowId !== null) {
    try {
      const win = await chrome.windows.get(agentWindowId, { populate: true })
      if (win && win.tabs && win.tabs.length > 0) {
        // 窗口仍然存在，检查是否有 attached tab
        const hasAttached = win.tabs.some(t => tabs.has(t.id))
        if (hasAttached) {
          console.log(`[CloudHand] Agent 窗口已存在 (windowId=${agentWindowId})`)
          return
        }
      }
    } catch {
      // 窗口不存在了，继续创建
      agentWindowId = null
    }
  }

  // 创建新的 agent 窗口（独立窗口，不影响用户）
  console.log('[CloudHand] 正在创建 Agent 专属窗口...')
  try {
    const win = await chrome.windows.create({
      url: 'about:blank',
      state: 'normal',
      focused: false,
    })
    agentWindowId = win.id
    const tab = win.tabs && win.tabs[0]
    if (!tab || !tab.id) {
      console.warn('[CloudHand] Agent 窗口创建成功但无 tab')
      return
    }
    // 等待 tab 加载完成
    await sleep(300)
    // Attach debugger
    await attachTab(tab.id)
    console.log(`[CloudHand] Agent 窗口已就绪: windowId=${win.id}, tabId=${tab.id}`)
  } catch (err) {
    console.warn('[CloudHand] 创建 Agent 窗口失败:', err instanceof Error ? err.message : String(err))
    agentWindowId = null
  }
}

// agent 窗口关闭时清理状态
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === agentWindowId) {
    console.log('[CloudHand] Agent 窗口已关闭，将在下次 keepalive 时重建')
    agentWindowId = null
  }
})

// Rehydrate state on service worker startup. Split: rehydration is the gate
// (fast), relay reconnect runs in background (slow, non-blocking).
const initPromise = rehydrateState()

initPromise.then(() => {
  // 启动时无条件尝试连接本地 bridge（不要求已有 tab）
  ensureRelayConnection().then(() => {
    reconnectAttempt = 0
    if (tabs.size > 0) {
      return reannounceAttachedTabs().then(() => ensureAgentWindow())
    }
    return ensureAgentWindow()
  }).catch(() => {
    scheduleReconnect()
  })

  // 启动时检查是否有已配置的远程连接
  ensureRemoteConnection().catch(() => {
    // 远程连接可选，失败不重试
  })
})

// Shared gate: all state-dependent handlers await this before accessing maps.
async function whenReady(fn) {
  await initPromise
  return fn()
}

// ── 远程连接管理 ──

async function ensureRemoteConnection() {
  if (remoteWs && remoteWs.readyState === WebSocket.OPEN) return
  if (remoteConnectPromise) return await remoteConnectPromise

  const stored = await chrome.storage.local.get(['remoteHost', 'remotePort', 'remoteToken'])
  const host = (stored.remoteHost || '').trim()
  const port = stored.remotePort || 9876
  const token = (stored.remoteToken || '').trim()
  if (!host || !token) return // 未配置，跳过

  remoteConnectPromise = (async () => {
    const wsUrl = buildRemoteWsUrl(host, port, token)

    const ws = new WebSocket(wsUrl)
    remoteWs = ws
    remoteGatewayToken = token

    // 绑定消息处理
    ws.onmessage = (event) => {
      if (ws !== remoteWs) return
      void whenReady(() => onRemoteMessage(String(event.data || '')))
    }

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Remote WebSocket connect timeout')), 8000)
      ws.onopen = () => { clearTimeout(t); resolve() }
      ws.onerror = () => { clearTimeout(t); reject(new Error('Remote WebSocket connect failed')) }
      ws.onclose = (ev) => { clearTimeout(t); reject(new Error(`Remote WebSocket closed (${ev.code})`)) }
    })

    ws.onclose = () => {
      if (ws !== remoteWs) return
      onRemoteClosed('closed')
    }
    ws.onerror = () => {
      if (ws !== remoteWs) return
      onRemoteClosed('error')
    }
  })()

  try {
    await remoteConnectPromise
    remoteReconnectAttempt = 0
    console.log('[CloudHand] 远程连接成功')
    updateConnectionStatus()
    // 远程连接成功后也上报 tab 列表
    void discoverExistingTabs()
  } finally {
    remoteConnectPromise = null
  }
}

function onRemoteClosed(reason) {
  remoteWs = null
  remoteGatewayToken = ''
  remoteConnectRequestId = null
  updateConnectionStatus()

  for (const [id, p] of remotePending.entries()) {
    remotePending.delete(id)
    p.reject(new Error(`Remote disconnected (${reason})`))
  }

  scheduleRemoteReconnect()
}

function scheduleRemoteReconnect() {
  if (remoteReconnectTimer) {
    clearTimeout(remoteReconnectTimer)
    remoteReconnectTimer = null
  }
  const delay = reconnectDelayMs(remoteReconnectAttempt)
  remoteReconnectAttempt++
  console.log(`[Remote] 重连 #${remoteReconnectAttempt} in ${Math.round(delay)}ms`)
  remoteReconnectTimer = setTimeout(async () => {
    remoteReconnectTimer = null
    try {
      await ensureRemoteConnection()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[Remote] 重连失败: ${message}`)
      if (isRetryableReconnectError(err)) {
        scheduleRemoteReconnect()
      }
    }
  }, delay)
}

function disconnectRemote() {
  if (remoteReconnectTimer) {
    clearTimeout(remoteReconnectTimer)
    remoteReconnectTimer = null
  }
  remoteReconnectAttempt = 0
  if (remoteWs) {
    try { remoteWs.close(1000, 'user disconnect') } catch {}
    remoteWs = null
  }
  remoteGatewayToken = ''
  remoteConnectRequestId = null
  updateConnectionStatus()
  console.log('[CloudHand] 远程连接已断开')
}

// 远程消息处理（与本地 onRelayMessage 类似）
async function onRemoteMessage(text) {
  let msg
  try { msg = JSON.parse(text) } catch { return }

  // 握手挑战
  if (msg && msg.type === 'event' && msg.event === 'connect.challenge') {
    try {
      ensureRemoteHandshake(msg.payload)
    } catch (err) {
      console.warn('[Remote] 握手失败', err instanceof Error ? err.message : String(err))
      remoteConnectRequestId = null
      if (remoteWs && remoteWs.readyState === WebSocket.OPEN) {
        remoteWs.close(1008, 'gateway connect failed')
      }
    }
    return
  }

  // 握手响应
  if (msg && msg.type === 'res' && remoteConnectRequestId && msg.id === remoteConnectRequestId) {
    remoteConnectRequestId = null
    if (!msg.ok) {
      console.warn('[Remote] 握手被拒绝', msg?.error || '')
      if (remoteWs && remoteWs.readyState === WebSocket.OPEN) {
        remoteWs.close(1008, 'gateway connect failed')
      }
    } else {
      console.log('[Remote] Gateway 握手成功')
      void discoverExistingTabs()
    }
    return
  }

  // ping
  if (msg && msg.method === 'ping') {
    try { sendToRemote({ method: 'pong' }) } catch {}
    return
  }

  // 响应（远程 pending）
  if (msg && typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
    const p = remotePending.get(msg.id)
    if (!p) return
    remotePending.delete(msg.id)
    if (msg.error) p.reject(new Error(String(msg.error)))
    else p.resolve(msg.result)
    return
  }

  // 远程 CDP 命令（核心：带互斥锁）
  if (msg && typeof msg.id === 'number' && msg.method === 'forwardCDPCommand') {
    const sessionId = msg?.params?.sessionId
    try {
      acquireLock(sessionId || '__global__', 'remote')
      const result = await handleForwardCdpCommand(msg)
      sendToRemote({ id: msg.id, result })
    } catch (err) {
      sendToRemote({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
    } finally {
      releaseLock(sessionId || '__global__')
    }
  }
}

function ensureRemoteHandshake(payload) {
  if (remoteConnectRequestId) return
  const nonce = typeof payload?.nonce === 'string' ? payload.nonce.trim() : ''
  remoteConnectRequestId = `ext-remote-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  sendToRemote({
    type: 'req',
    id: remoteConnectRequestId,
    method: 'connect',
    params: {
      minProtocol: 3, maxProtocol: 3,
      client: { id: 'chrome-relay-extension', version: '1.0.0', platform: 'chrome-extension', mode: 'remote' },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      caps: [], commands: [],
      nonce: nonce || undefined,
      auth: remoteGatewayToken ? { token: remoteGatewayToken } : undefined,
    },
  })
}

// ── 连接状态广播（供 popup 读取） ──
function updateConnectionStatus() {
  chrome.storage.local.set({
    localConnected: !!(relayWs && relayWs.readyState === WebSocket.OPEN),
    remoteConnected: !!(remoteWs && remoteWs.readyState === WebSocket.OPEN),
  }).catch(() => {})
}

// ── 监听 storage 变化处理远程连接/断开 ──
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (changes.remoteAction) {
    const action = changes.remoteAction.newValue
    if (action === 'connect') {
      // 清除 action 标记
      chrome.storage.local.remove('remoteAction').catch(() => {})
      void whenReady(async () => {
        try {
          await ensureRemoteConnection()
        } catch (err) {
          console.warn('[Remote] 连接失败:', err instanceof Error ? err.message : String(err))
          scheduleRemoteReconnect()
        }
      })
    } else if (action === 'disconnect') {
      chrome.storage.local.remove('remoteAction').catch(() => {})
      void whenReady(() => disconnectRemote())
    }
  }
})
