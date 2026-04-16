#!/usr/bin/env node
/**
 * CloudHand Ultimate CLI Commander v4.0
 * 专为丝滑体验设计：支持一键搜索、自动重试、智能结果提取。
 */

const http = require('http');

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd || cmd === 'help') {
  console.log('Usage:');
  console.log('  node ch batch "指令1; 指令2"   - 语义连发模式');
  console.log('  node ch quick_search <url>     - 一键开启并获取结果（最流畅）');
  console.log('  node ch <api_name> [args...]   - 原生 API 调用');
  process.exit(0);
}

async function execute(path, params, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(params);
    const options = {
      hostname: '127.0.0.1', port: 9876, path: path.startsWith('/') ? path : `/${path}`, method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Content-Length': Buffer.byteLength(data)
      },
      timeout: 10000
    };
    const req = http.request(options, (res) => {
      let d = ''; res.on('data', chunk => d += chunk);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); resolve({ error: 'Request timeout' }); });
    req.write(data); req.end();
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

function parseParams(rawArgs) {
  const body = {};
  for (let i = 0; i < rawArgs.length; i++) {
    let k = rawArgs[i];
    if (k.startsWith('--')) {
      let v = rawArgs[i + 1];
      if (typeof v === 'string') v = v.replace(/\\n/g, '\n');
      if (/^\d+$/.test(v)) v = parseInt(v);
      body[k.slice(2)] = v; i++;
    } else if (k.includes('=')) {
      let [key, val] = k.split('=');
      if (typeof val === 'string') val = val.replace(/\\n/g, '\n');
      if (/^\d+$/.test(val)) val = parseInt(val);
      body[key] = val;
    } else if (i === 0) {
      body.url = k; body.intent = k;
    }
  }
  return body;
}

// 提取页面的前5条结果摘要
function summarize(result) {
  if (!result || !result.content) return 'No content found.';
  const lines = result.content.split('\n')
    .filter(l => l.includes('<a href=') && !l.includes('鐧惧害') && !l.includes('澶存潯'))
    .slice(0, 5)
    .map(l => l.replace(/\[\d+\]/, '').trim());
  return lines.length ? lines.join('\n') : 'No results parsed.';
}

async function run() {
  const token = await getToken();
  if (!token) { console.error('Error: Bridge not running.'); process.exit(1); }

  let sharedTabId = null;

  if (cmd === 'quick_search') {
    const url = args[1];
    console.log(`🚀 Starting Smooth Run for: ${url}`);
    
    // 1. 创建窗口
    const win = await execute('new_window', { url, focused: false }, token);
    const tabId = win?.result?.tabId;
    if (!tabId) { console.error('Failed to create window'); return; }
    
    console.log(`✅ Window created (Tab: ${tabId}), waiting for render...`);
    await new Promise(r => setTimeout(r, 6000));

    // 2. 获取结果（带重试）
    let state;
    for(let i=0; i<3; i++) {
      process.stdout.write(`📡 Fetching results (Attempt ${i+1})... `);
      state = await execute('get_browser_state', { tabId }, token);
      if (state.ok && state.result?.content) { console.log('Success.'); break; }
      console.log('Pending...');
      await new Promise(r => setTimeout(r, 2000));
    }

    if (state.ok) {
      console.log('\n--- Top 5 Results ---');
      console.log(summarize(state.result));
      console.log('---------------------\nDone.');
    } else {
      console.error('Failed to fetch state after 3 attempts.');
    }
  } else if (cmd === 'recon') {
    // 侦察模式：一键识别页面核心功能
    const tabId = args[1] ? parseInt(args[1]) : sharedTabId;
    const res = await execute('get_browser_state', { tabId }, token);
    if (res.ok) {
      console.log(`\n--- Recon Profile for ${new URL(res.result.url).hostname} ---`);
      const elements = res.result.content.split('\n').filter(l => l.trim());
      console.log(elements.slice(0, 20).join('\n'));
      console.log('--- End of Profile ---');
    }
  } else if (cmd === 'learn') {
    // 专家学习模式：提取高保真页面信息供 AI 深度分析
    const params = parseParams(args.slice(1));
    const tabId = params.tabId || sharedTabId;
    console.log(`🧠 High-Fidelity Capture started on Tab: ${tabId}...`);
    
    // 同时获取基础状态和无障碍树，给 AI 提供全方位视角
    const state = await execute('get_browser_state', { tabId }, token);
    const ax = await execute('get_ax_tree', { tabId }, token);
    
    console.log('\n--- SOURCE DATA FOR AI ANALYSIS ---');
    console.log(`URL: ${state.result?.url}`);
    console.log(`TITLE: ${state.result?.title}`);
    console.log('\n[INTERACTIVE TREE]');
    console.log(state.result?.content);
    console.log('\n[STRUCTURE METADATA]');
    console.log(`ElementCount: ${state.result?.elementCount}`);
    console.log(`Scroll: ${JSON.stringify(state.result?.scroll)}`);
    console.log('\n--- END OF SOURCE DATA ---');
    console.log('\nAction: AI, please analyze the patterns above and define the landmarks in .data-browser-knowledge/.');
  } else if (cmd === 'batch') {
    // ... 原有的 batch 逻辑 (已优化) ...
    const batchStr = args[1];
    const lines = batchStr.split(';').map(l => l.trim()).filter(l => l);
    let sharedTabId = null;
    for (const line of lines) {
      const parts = line.split(/\s+/);
      const subCmd = parts[0];
      const subParams = parseParams(parts.slice(1));
      if (sharedTabId && !subParams.tabId) subParams.tabId = sharedTabId;
      const semanticMatch = line.match(/\{(.+?)\}/);
      if (semanticMatch) {
        const intent = semanticMatch[1];
        const locateRes = await execute('smart_locate', { intent, tabId: subParams.tabId }, token);
        const index = locateRes?.matches?.[0]?.browserStateIndex;
        if (index !== undefined) {
          subParams.index = index;
          const finalCmd = subCmd === 'type' ? 'input_text_element' : (subCmd === 'click' ? 'click_element' : subCmd);
          await execute(finalCmd, subParams, token);
        }
      } else {
        const res = await execute(subCmd, subParams, token);
        if (res?.result?.tabId || res?.tabId) sharedTabId = res?.result?.tabId || res?.tabId;
      }
    }
    console.log('Batch execution complete.');
  } else {
    const res = await execute(cmd, parseParams(args.slice(1)), token);
    console.log(JSON.stringify(res, null, 2));
  }
}

run();
