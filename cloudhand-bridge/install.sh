#!/usr/bin/env bash
# CloudHand v2.7.0 - OpenClaw Plugin Installer
# CloudHand 云手 - OpenClaw 插件一键安装脚本
# Usage / 用法: bash install.sh

set -e

CLOUDHAND_DIR="$HOME/.openclaw/extensions/cloudhand"
OPENCLAW_JSON="$HOME/.openclaw/openclaw.json"

# 双语输出函数 / Bilingual output
info()  { echo "  $1 | $2"; }
ok()    { echo "  ✅ $1 | $2"; }
err()   { echo "  ❌ $1 | $2"; exit 1; }
warn()  { echo "  ⚠️  $1 | $2"; }

echo ''
echo '================================================'
echo '   CloudHand v2.7.0 - Installer'
echo '   CloudHand 云手 - 安装程序'
echo '================================================'
echo ''

# ── 检查依赖 / Check dependencies ────────────────────
info "Checking dependencies..." "检查依赖..."
echo ''

if ! command -v openclaw &>/dev/null; then
  err "OpenClaw not found. Please install OpenClaw first." \
      "未检测到 OpenClaw，请先安装 OpenClaw"
fi
ok "OpenClaw" "$(openclaw --version 2>/dev/null || echo 'OK')"

if ! command -v node &>/dev/null; then
  err "Node.js not found. Please install Node.js 18+." \
      "未检测到 Node.js，请先安装 Node.js 18+"
fi
ok "Node.js" "$(node -v)"

if ! command -v npm &>/dev/null; then
  err "npm not found." "未检测到 npm"
fi
ok "npm" "$(npm -v)"

# ── 检查插件目录 / Check plugin directory ────────────
echo ''
if [ ! -f "$CLOUDHAND_DIR/cloudhand-bridge/index.js" ]; then
  err "Plugin files not found at: $CLOUDHAND_DIR" \
      "插件文件不存在: $CLOUDHAND_DIR"
fi
ok "Plugin directory found" "插件目录存在: $CLOUDHAND_DIR"

# ── 安装依赖 / Install npm dependencies ──────────────
echo ''
info "Installing npm dependencies..." "安装 npm 依赖..."

# 依赖声明在 cloudhand-bridge/package.json 中
if [ -f "$CLOUDHAND_DIR/cloudhand-bridge/package.json" ]; then
  cd "$CLOUDHAND_DIR/cloudhand-bridge"
  if [ ! -d node_modules ]; then
    npm install --quiet 2>/dev/null
  fi
  ok "Bridge dependencies ready" "Bridge 依赖安装完成"
fi

# 根目录也有 package.json（express + ws）
if [ -f "$CLOUDHAND_DIR/package.json" ]; then
  cd "$CLOUDHAND_DIR"
  if [ ! -d node_modules ]; then
    npm install --quiet 2>/dev/null
  fi
  ok "Root dependencies ready" "根目录依赖安装完成"
fi

# ── 打包 Chrome 扩展 / Package Chrome extension ──────
echo ''
info "Packaging Chrome extension..." "打包 Chrome 扩展..."
cd "$CLOUDHAND_DIR"

if command -v zip &>/dev/null && [ -d "extension" ]; then
  cd extension && zip -r ../cloudhand-bridge/extension.zip . -q && cd ..
  ok "extension.zip created" "扩展打包完成"
elif command -v node &>/dev/null && [ -d "extension" ]; then
  # 用 Node.js 打包（无 zip 命令时的降级方案）
  node -e "
    const fs = require('fs');
    const path = require('path');
    const { execSync } = require('child_process');
    const extDir = path.join('extension');
    const files = fs.readdirSync(extDir);
    // tar 打包后让用户手动解压
    console.log('  ⚠️  zip not available, skipping | zip 命令不可用，跳过打包');
  "
else
  warn "Cannot package extension (no zip command)" "无法打包扩展（缺少 zip 命令）"
fi

# ── 更新 OpenClaw 配置 / Update OpenClaw config ──────
echo ''
info "Configuring OpenClaw..." "配置 OpenClaw..."

node -e "
  const fs = require('fs');
  const path = require('path');

  const configPath = path.join(process.env.HOME, '.openclaw', 'openclaw.json');
  const cloudhandPath = path.join(process.env.HOME, '.openclaw', 'extensions', 'cloudhand');

  let d;
  try { d = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch { console.log('  ⚠️  openclaw.json not found, skipping | 配置文件不存在，跳过'); process.exit(0); }

  let changed = false;

  if (!d.plugins) d.plugins = {};
  if (!d.plugins.allow) d.plugins.allow = [];
  if (!d.plugins.allow.includes('cloudhand')) { d.plugins.allow.push('cloudhand'); changed = true; }

  if (!d.plugins.load) d.plugins.load = {};
  if (!d.plugins.load.paths) d.plugins.load.paths = [];
  if (!d.plugins.load.paths.includes(cloudhandPath)) { d.plugins.load.paths.push(cloudhandPath); changed = true; }

  if (!d.plugins.entries) d.plugins.entries = {};
  if (!d.plugins.entries.cloudhand || !d.plugins.entries.cloudhand.enabled) {
    d.plugins.entries.cloudhand = { enabled: true, config: { port: 9876, autoStart: true } };
    changed = true;
  }

  if (!d.tools) d.tools = {};
  if (!d.tools.allow) d.tools.allow = [];
  if (!d.tools.allow.includes('cloudhand')) { d.tools.allow.push('cloudhand'); changed = true; }

  if (changed) {
    fs.copyFileSync(configPath, configPath + '.bak');
    fs.writeFileSync(configPath, JSON.stringify(d, null, 2));
    console.log('  ✅ Config updated | 配置文件已更新');
  } else {
    console.log('  ✅ Config unchanged | 配置文件无需更改');
  }
"

# ── 重启 Gateway / Restart Gateway ───────────────────
echo ''
info "Restarting OpenClaw Gateway..." "重启 Gateway..."
if systemctl --user is-active openclaw-gateway.service &>/dev/null; then
  nohup bash -c 'sleep 2 && systemctl --user restart openclaw-gateway.service' > /tmp/cloudhand-install.log 2>&1 &
  ok "Gateway restarting (ready in ~8s)" "Gateway 重启中（约 8 秒后生效）"
else
  warn "Gateway not running. Start it with: openclaw gateway start" \
       "Gateway 未运行，请手动启动: openclaw gateway start"
fi

# ── 完成 / Done ───────────────────────────────────────
echo ''
echo '================================================'
echo '   ✅ Installation complete! | 安装完成！'
echo '================================================'
echo ''
echo '  📌 Next steps | 下一步'
echo ''
echo '  1. Download Chrome extension | 下载 Chrome 扩展'
echo '     Ask your AI: "generate extension download link"'
echo '     对 AI 说「生成扩展下载链接」'
echo ''
echo '  2. Install in Chrome | 在 Chrome 中安装'
echo '     chrome://extensions/ → Developer mode | 开发者模式'
echo '     → "Load unpacked" | 「加载已解压的扩展程序」'
echo '     → Select the unzipped folder | 选择解压后的目录'
echo ''
echo '  3. Pair | 配对连接'
echo '     Tell your AI: "pair browser" | 对 AI 说「帮我连接浏览器」'
echo '     Enter the 6-digit code in the extension | 在扩展中输入 6 位配对码'
echo ''
echo '  4. Test | 测试'
echo '     Tell your AI: "test cloudhand" | 对 AI 说「测试云手」'
echo ''
echo '  💡 Logs | 查看日志:'
echo '     journalctl --user -u openclaw-gateway.service -f'
echo ''
