#!/usr/bin/env bash
# CloudHand - OpenClaw Plugin Installer
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
echo '   CloudHand Chrome Bridge - Installer'
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

if ! command -v python3 &>/dev/null; then
  err "python3 not found." "未检测到 python3"
fi
ok "python3" "$(python3 --version)"

# ── 检查插件目录 / Check plugin directory ────────────
echo ''
if [ ! -f "$CLOUDHAND_DIR/index.js" ]; then
  err "Plugin files not found at: $CLOUDHAND_DIR" \
      "插件文件不存在: $CLOUDHAND_DIR"
fi
ok "Plugin directory found" "插件目录存在: $CLOUDHAND_DIR"

# ── 安装依赖 / Install npm dependencies ──────────────
echo ''
info "Installing npm dependencies..." "安装 npm 依赖..."
cd "$CLOUDHAND_DIR"
if [ ! -d node_modules ]; then
  npm install --quiet 2>/dev/null
fi
ok "Dependencies ready" "依赖安装完成"

# ── 打包 Chrome 扩展 / Package Chrome extension ──────
echo ''
info "Packaging Chrome extension..." "打包 Chrome 扩展..."
cd "$CLOUDHAND_DIR"
python3 << 'PYEOF'
import zipfile, os
with zipfile.ZipFile('extension.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk('extension'):
        for f in files:
            fp = os.path.join(root, f)
            z.write(fp)
print('  ✅ extension.zip | 扩展打包完成')
PYEOF

# ── 更新 OpenClaw 配置 / Update OpenClaw config ──────
echo ''
info "Configuring OpenClaw..." "配置 OpenClaw..."

python3 << PYEOF
import json, os, shutil

config_path = os.path.expanduser('~/.openclaw/openclaw.json')
cloudhand_path = os.path.expanduser('~/.openclaw/extensions/cloudhand')

with open(config_path, 'r') as f:
    d = json.load(f)

changed = False

d.setdefault('plugins', {}).setdefault('allow', [])
if 'cloudhand' not in d['plugins']['allow']:
    d['plugins']['allow'].append('cloudhand')
    changed = True

d['plugins'].setdefault('load', {}).setdefault('paths', [])
if cloudhand_path not in d['plugins']['load']['paths']:
    d['plugins']['load']['paths'].append(cloudhand_path)
    changed = True

d['plugins'].setdefault('entries', {}).setdefault('cloudhand', {})
if not d['plugins']['entries']['cloudhand'].get('enabled'):
    d['plugins']['entries']['cloudhand'] = {'enabled': True, 'config': {'port': 9876, 'autoStart': True}}
    changed = True

d.setdefault('tools', {}).setdefault('allow', [])
if 'cloudhand' not in d['tools']['allow']:
    d['tools']['allow'].append('cloudhand')
    changed = True

if changed:
    shutil.copy(config_path, config_path + '.bak')
    with open(config_path, 'w') as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
    print('  ✅ Config updated | 配置文件已更新')
else:
    print('  ✅ Config unchanged | 配置文件无需更改')
PYEOF

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
echo '  1. Get the Chrome extension ZIP | 获取 Chrome 扩展'
echo "     $CLOUDHAND_DIR/extension.zip"
echo ''
echo '  2. Load in Chrome | 在 Chrome 中加载'
echo '     chrome://extensions/ → Developer mode | 开发者模式'
echo '     → "Load unpacked" | 「加载已解压的扩展程序」'
echo '     → Select the extension/ folder | 选择 extension/ 目录'
echo ''
echo '  3. Connect | 连接配对'
echo '     Click the extension icon → Enter VPS address | 点击扩展图标 → 填入 VPS 地址'
echo '     Tell your AI: "pair browser" | 对 AI 说「帮我连接浏览器」'
echo ''
echo '  4. Test | 测试'
echo '     Tell your AI: "test cloudhand" | 对 AI 说「测试云手」'
echo ''
echo '  💡 Logs | 查看日志:'
echo '     journalctl --user -u openclaw-gateway.service -f'
echo ''
