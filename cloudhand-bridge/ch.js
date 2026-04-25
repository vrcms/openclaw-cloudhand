#!/usr/bin/env node
/**
 * CloudHand CLI v5.0 (CDP 版)
 * 通过 REST API 调用 CDP Bridge 控制浏览器
 */

const http = require('http');

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd || cmd === 'help') {
  console.log('CloudHand CLI (CDP Mode)');
  console.log('Usage:');
  console.log('  node ch status                  - 查看连接状态');
  console.log('  node ch ensure_tab              - 确保有 agent 专属 tab');
  console.log('  node ch navigate <url>          - 导航到 URL');
  console.log('  node ch snapshot                - 获取页面快照（带 ref 编号）');
  console.log('  node ch act <kind> <ref> [text]  - Playwright 交互（click/type/press）');
  console.log('  node ch eval <expression>       - 执行 JavaScript');
  console.log('  node ch screenshot              - 截图');
  console.log('  node ch click --selector <sel>  - 点击元素（旧 CDP 方式）');
  console.log('  node ch type --text <text>      - 输入文本（旧 CDP 方式）');
  console.log('  node ch page_info               - 获取页面信息');
  console.log('  node ch list_tabs               - 列出所有已知的浏览器 tab');
  console.log('  node ch switch_tab <targetId>   - 切换 agent 到指定 tab');
  process.exit(0);
}

function execute(path, params, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(params);
    const isGet = !params || Object.keys(params).length === 0;
    const options = {
      hostname: '127.0.0.1', port: 9876,
      path: path.startsWith('/') ? path : `/${path}`,
      method: isGet ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': isGet ? 0 : Buffer.byteLength(data)
      },
      timeout: 30000
    };
    const req = http.request(options, (res) => {
      let d = ''; res.on('data', chunk => d += chunk);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); resolve({ error: 'Request timeout' }); });
    if (!isGet) req.write(data);
    req.end();
  });
}

function executePost(path, params, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(params || {});
    const options = {
      hostname: '127.0.0.1', port: 9876,
      path: path.startsWith('/') ? path : `/${path}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 30000
    };
    const req = http.request(options, (res) => {
      let d = ''; res.on('data', chunk => d += chunk);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); resolve({ error: 'Request timeout' }); });
    req.write(data);
    req.end();
  });
}

async function getToken() {
  return new Promise((resolve) => {
    http.get('http://127.0.0.1:9876/token', (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).apiToken); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  const token = await getToken();
  if (!token) { console.error('Error: Bridge not running.'); process.exit(1); }

  if (cmd === 'status') {
    const res = await execute('status', {}, token);
    console.log(JSON.stringify(res, null, 2));

  } else if (cmd === 'list_tabs') {
    const res = await execute('list_tabs', {}, token);
    console.log(JSON.stringify(res, null, 2));

  } else if (cmd === 'switch_tab') {
    const targetId = args[1];
    if (!targetId) { console.error('Usage: node ch switch_tab <targetId>'); process.exit(1); }
    const res = await executePost('switch_tab', { targetId }, token);
    console.log(JSON.stringify(res, null, 2));

  } else if (cmd === 'snapshot') {
    const res = await executePost('snapshot', {}, token);
    if (res.ok) {
      console.log(`URL: ${res.url}`);
      console.log(`Title: ${res.title}`);
      console.log(`Refs: ${res.stats?.refs || 0}`);
      console.log('---');
      console.log(res.snapshot);
    } else {
      console.log(JSON.stringify(res, null, 2));
    }

  } else if (cmd === 'act') {
    // act <kind> [ref] [text] [--x N] [--y N] [--submit] [--slowly] [--autoSnapshot] ...
    const kind = args[1];
    if (!kind) { console.error('Usage: node ch act <kind> [ref] [text] [--x N] [--y N] [--submit] [--slowly]'); process.exit(1); }
    const params = { kind };
    // 布尔标志
    const boolFlags = new Set(['submit', 'slowly', 'doubleClick', 'autoSnapshot']);
    for (const flag of boolFlags) {
      if (args.includes(`--${flag}`)) params[flag] = true;
    }
    // 通用 --key value 参数解析（数字自动转 number）
    for (let i = 2; i < args.length; i++) {
      if (args[i].startsWith('--') && args[i + 1] && !args[i + 1].startsWith('--')) {
        const key = args[i].slice(2);
        if (boolFlags.has(key)) continue; // 布尔标志已处理
        const val = args[++i];
        params[key] = isNaN(val) ? val : parseFloat(val);
      }
    }
    // 兼容旧的位置参数：act <kind> <ref> [text]
    if (!params.ref && args[2] && !args[2].startsWith('--')) {
      params.ref = args[2];
    }
    if (!params.text && args[3] && !args[3].startsWith('--')) {
      params.text = args[3];
    }
    // press 特殊处理
    if (kind === 'press') { params.key = params.ref; delete params.ref; }
    const res = await executePost('act', params, token);
    console.log(JSON.stringify(res, null, 2));

  } else if (cmd === 'ensure_tab') {
    const res = await executePost('ensure_tab', {}, token);
    console.log(JSON.stringify(res, null, 2));

  } else if (cmd === 'navigate') {
    const url = args[1];
    if (!url) { console.error('Usage: node ch navigate <url>'); process.exit(1); }
    // 先确保有 tab
    await executePost('ensure_tab', {}, token);
    const res = await executePost('navigate', { url }, token);
    console.log(JSON.stringify(res, null, 2));

  } else if (cmd === 'eval') {
    const expression = args[1];
    if (!expression) { console.error('Usage: node ch eval <expression>'); process.exit(1); }
    const res = await executePost('eval', { expression }, token);
    console.log(JSON.stringify(res, null, 2));

  } else if (cmd === 'screenshot') {
    const res = await executePost('screenshot', {}, token);
    if (res.ok && res.data) {
      const fs = require('fs');
      const outPath = args[1] || `screenshot_${Date.now()}.png`;
      const base64 = res.data.split(',')[1];
      fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
      console.log(`Screenshot saved: ${outPath} (${Math.round(fs.statSync(outPath).size / 1024)}KB)`);
    } else {
      console.log(JSON.stringify(res, null, 2));
    }

  } else if (cmd === 'screenshot_labels') {
    // 带 ref 标签的截图
    const params = {};
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--maxLabels' && args[i + 1]) { params.maxLabels = parseInt(args[++i]); }
      if (args[i] === '--filterMode' && args[i + 1]) { params.filterMode = args[++i]; }
    }
    const res = await executePost('screenshot_with_labels', params, token);
    if (res.ok && res.data) {
      const fs = require('fs');
      const outPath = args.find(a => !a.startsWith('--') && a !== 'screenshot_labels') || `labeled_${Date.now()}.png`;
      const base64 = res.data.split(',')[1] || res.data;
      fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
      console.log(`Labeled screenshot saved: ${outPath} (${Math.round(fs.statSync(outPath).size / 1024)}KB)`);
      console.log(`Labels: ${res.labels}, Skipped: ${res.skipped}`);
      if (res.snapshot) {
        console.log('---');
        console.log(res.snapshot);
      }
    } else {
      console.log(JSON.stringify(res, null, 2));
    }

  } else if (cmd === 'click') {
    const params = {};
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--selector' && args[i + 1]) { params.selector = args[++i]; }
      if (args[i] === '--x' && args[i + 1]) { params.x = parseFloat(args[++i]); }
      if (args[i] === '--y' && args[i + 1]) { params.y = parseFloat(args[++i]); }
    }
    const res = await executePost('click', params, token);
    console.log(JSON.stringify(res, null, 2));

  } else if (cmd === 'type') {
    let text = '', selector = '';
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--text' && args[i + 1]) { text = args[++i].replace(/\\n/g, '\n'); }
      if (args[i] === '--selector' && args[i + 1]) { selector = args[++i]; }
    }
    if (!text) { console.error('Usage: node ch type --text <text> [--selector <sel>]'); process.exit(1); }
    const res = await executePost('type', { text, ...(selector ? { selector } : {}) }, token);
    console.log(JSON.stringify(res, null, 2));

  } else if (cmd === 'page_info') {
    const res = await execute('get_page_info', {}, token);
    console.log(JSON.stringify(res, null, 2));

  } else if (cmd === 'ax_tree') {
    const res = await executePost('get_ax_tree', {}, token);
    console.log(JSON.stringify(res, null, 2));

  } else if (cmd === 'cdp') {
    const method = args[1];
    if (!method) { console.error('Usage: node ch cdp <method> [params_json]'); process.exit(1); }
    const params = args[2] ? JSON.parse(args[2]) : {};
    const res = await executePost('cdp', { method, params }, token);
    console.log(JSON.stringify(res, null, 2));

  } else if (cmd === 'learn') {
    // 纯 CDP 三重树融合页面认知（借鉴 browser-use 架构）
    console.log('🧠 High-Fidelity Capture...');

    // 1. 页面信息（纯 CDP: Page.getNavigationHistory）
    const pageInfo = await executePost('get_page_info', {}, token);

    // 2. 无障碍树（纯 CDP: Accessibility.getFullAXTree）
    const axTree = await executePost('get_ax_tree', {}, token);

    // 3. DOM 快照（纯 CDP: DOMSnapshot.captureSnapshot）
    const snapshotRes = await executePost('cdp', {
      method: 'DOMSnapshot.captureSnapshot',
      params: {
        computedStyles: ['display', 'visibility', 'opacity', 'cursor', 'pointer-events'],
        includePaintOrder: true,
        includeDOMRects: true
      }
    }, token);

    // 4. DOM 树结构（纯 CDP: DOM.getDocument）
    const domTreeRes = await executePost('cdp', {
      method: 'DOM.getDocument',
      params: { depth: -1, pierce: true }
    }, token);

    console.log('\n--- SOURCE DATA FOR AI ANALYSIS ---');
    console.log(`URL: ${pageInfo.url}`);
    console.log(`TITLE: ${pageInfo.title}`);

    // 从 DOMSnapshot 构建 backendNodeId → 坐标/可见性 映射
    const snapshot = snapshotRes?.result;
    const interactiveElements = [];

    if (snapshot && snapshot.documents && snapshot.documents.length > 0) {
      const strings = snapshot.strings || [];
      const doc = snapshot.documents[0];
      const nodes = doc.nodes || {};
      const layout = doc.layout || {};

      // 构建 backendNodeId → snapshotIndex 映射
      const backendNodeIds = nodes.backendNodeId || [];
      const nodeNames = nodes.nodeName || [];
      const nodeTypes = nodes.nodeType || [];
      const nodeAttrs = nodes.attributes || [];

      // 构建 layout nodeIndex → layout idx 映射
      const layoutNodeIndex = layout.nodeIndex || [];
      const layoutBounds = layout.bounds || [];
      const layoutIndexMap = {};
      for (let i = 0; i < layoutNodeIndex.length; i++) {
        if (!(layoutNodeIndex[i] in layoutIndexMap)) {
          layoutIndexMap[layoutNodeIndex[i]] = i;
        }
      }

      // 可交互标签集合
      const interactiveTags = new Set([
        'A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'LABEL',
        'DETAILS', 'SUMMARY', 'OPTION'
      ]);

      // 遍历所有节点，找出可交互元素
      for (let snapIdx = 0; snapIdx < backendNodeIds.length; snapIdx++) {
        const nameIdx = nodeNames[snapIdx];
        const tagName = (nameIdx >= 0 && nameIdx < strings.length) ? strings[nameIdx] : '';
        const nodeType = nodeTypes[snapIdx];

        // 只处理元素节点
        if (nodeType !== 1) continue;

        // 判断是否可交互（通过标签名或 role 属性）
        const upperTag = tagName.toUpperCase();
        let isInteractive = interactiveTags.has(upperTag);

        // 解析属性
        const attrIndices = nodeAttrs[snapIdx] || [];
        const attrs = {};
        for (let a = 0; a < attrIndices.length; a += 2) {
          const key = strings[attrIndices[a]] || '';
          const val = strings[attrIndices[a + 1]] || '';
          attrs[key] = val;
        }

        // role=button/link/tab 也算可交互
        if (attrs.role && ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio'].includes(attrs.role)) {
          isInteractive = true;
        }

        if (!isInteractive) continue;

        // 获取坐标（从 layout bounds）
        let x = 0, y = 0, width = 0, height = 0;
        if (snapIdx in layoutIndexMap) {
          const layoutIdx = layoutIndexMap[snapIdx];
          if (layoutIdx < layoutBounds.length) {
            const b = layoutBounds[layoutIdx];
            if (b && b.length >= 4) {
              x = b[0]; y = b[1]; width = b[2]; height = b[3];
            }
          }
        }

        // 过滤不可见元素（宽高为 0）
        if (width <= 0 || height <= 0) continue;

        // 构建文本描述
        let text = attrs['aria-label'] || attrs.placeholder || attrs.value || attrs.title || attrs.alt || '';

        interactiveElements.push({
          idx: interactiveElements.length,
          tag: tagName.toLowerCase(),
          text: text.trim().slice(0, 60),
          href: attrs.href ? attrs.href.slice(0, 100) : undefined,
          type: attrs.type || undefined,
          backendNodeId: backendNodeIds[snapIdx],
          bounds: { x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }
        });
      }
    }

    // 从无障碍树补充文本信息
    if (axTree.nodes && interactiveElements.length > 0) {
      // 构建 backendNodeId → ax name 映射
      const axNameMap = {};
      for (const node of axTree.nodes) {
        if (node.backendDOMNodeId && node.name?.value) {
          axNameMap[node.backendDOMNodeId] = node.name.value;
        }
      }
      // 补充缺失的文本
      for (const el of interactiveElements) {
        if (!el.text && axNameMap[el.backendNodeId]) {
          el.text = axNameMap[el.backendNodeId].trim().slice(0, 60);
        }
      }
    }

    console.log('\n[INTERACTIVE ELEMENTS]');
    interactiveElements.forEach(e => {
      let line = `[${e.idx}] <${e.tag}>`;
      if (e.text) line += ` "${e.text}"`;
      if (e.href) line += ` → ${e.href}`;
      if (e.bounds) line += ` @(${e.bounds.x},${e.bounds.y} ${e.bounds.w}x${e.bounds.h})`;
      console.log(line);
    });

    console.log('\n[ACCESSIBILITY TREE]');
    if (axTree.nodes) {
      console.log(`Total nodes: ${axTree.nodes.length}`);
    }
    console.log('--- END OF SOURCE DATA ---');

  } else if (cmd === 'batch') {
    const batchStr = args[1];
    if (!batchStr) { console.error('Usage: node ch batch "cmd1; cmd2"'); process.exit(1); }
    const lines = batchStr.split(';').map(l => l.trim()).filter(l => l);

    for (const line of lines) {
      const parts = line.split(/\s+/);
      const subCmd = parts[0];

      if (subCmd === 'ensure_tab') {
        await executePost('ensure_tab', {}, token);
        console.log('✅ ensure_tab');
      } else if (subCmd === 'navigate') {
        const url = parts[1];
        await executePost('navigate', { url }, token);
        console.log(`✅ navigate ${url}`);
      } else if (subCmd === 'learn') {
        // 在 batch 中调用 learn 逻辑
        process.argv = [process.argv[0], process.argv[1], 'learn'];
        // 简化：直接获取 page_info
        const info = await executePost('get_page_info', {}, token);
        console.log(`📄 ${info.url} - ${info.title}`);
      } else if (subCmd === 'eval') {
        const expr = parts.slice(1).join(' ');
        const res = await executePost('eval', { expression: expr }, token);
        console.log(`✅ eval: ${JSON.stringify(res.result)}`);
      } else {
        console.log(`⚠️ Unknown batch command: ${subCmd}`);
      }
    }
    console.log('Batch execution complete.');

  } else {
    console.error(`Unknown command: ${cmd}. Run 'node ch help' for usage.`);
    process.exit(1);
  }
}

run().catch(e => { console.error('Error:', e.message); process.exit(1); });
