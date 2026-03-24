#!/usr/bin/env bash
# CloudHand 云手 - OpenClaw 插件一键安装脚本
# 用法: bash install.sh

set -e

CLOUDHAND_DIR="$HOME/.openclaw/extensions/cloudhand"
OPENCLAW_JSON="$HOME/.openclaw/openclaw.json"

echo '================================================'
echo '   CloudHand 云手 - OpenClaw 插件安装程序'
echo '================================================'
echo ''

# 检查依赖
if ! command -v openclaw &>/dev/null; then
  echo '❌ 未检测到 OpenClaw，请先安装 OpenClaw'
  exit 1
fi
echo '✅ OpenClaw: '$(openclaw --version 2>/dev/null || echo 'OK')

if ! command -v node &>/dev/null; then
  echo '❌ 未检测到 Node.js，请先安装 Node.js 18+'
  exit 1
fi
echo '✅ Node.js: '$(node -v)

if ! command -v npm &>/dev/null; then
  echo '❌ 未检测到 npm'
  exit 1
fi

# 确认插件目录存在
if [ ! -f "$CLOUDHAND_DIR/index.js" ]; then
  echo '❌ 插件文件不存在: '$CLOUDHAND_DIR'/index.js'
  echo '   请先将 CloudHand 插件文件放到 ~/.openclaw/extensions/cloudhand/'
  exit 1
fi
echo '✅ 插件目录: '$CLOUDHAND_DIR

# 安装 npm 依赖
echo ''
echo '📦 安装 npm 依赖...'
cd "$CLOUDHAND_DIR"
if [ ! -d node_modules ]; then
  npm install --quiet 2>/dev/null
fi
echo '✅ 依赖就绪'

# 打包 Chrome 扩展
echo ''
echo '📦 打包 Chrome 扩展...'
cd "$CLOUDHAND_DIR"
python3 << 'EOF'
import zipfile, os
with zipfile.ZipFile('extension.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk('extension'):
        for f in files:
            fp = os.path.join(root, f)
            z.write(fp)
print('✅ extension.zip 打包完成')
EOF

# 更新 OpenClaw 配置
echo ''
echo '⚙️  配置 OpenClaw...'

python3 << EOF
import json, os, shutil

config_path = os.path.expanduser('~/.openclaw/openclaw.json')
cloudhand_path = os.path.expanduser('~/.openclaw/extensions/cloudhand')

with open(config_path, 'r') as f:
    d = json.load(f)

changed = False

# plugins.allow
d.setdefault('plugins', {}).setdefault('allow', [])
if 'cloudhand' not in d['plugins']['allow']:
    d['plugins']['allow'].append('cloudhand')
    changed = True

# plugins.load.paths
d['plugins'].setdefault('load', {}).setdefault('paths', [])
if cloudhand_path not in d['plugins']['load']['paths']:
    d['plugins']['load']['paths'].append(cloudhand_path)
    changed = True

# plugins.entries.cloudhand
d['plugins'].setdefault('entries', {}).setdefault('cloudhand', {})
if not d['plugins']['entries']['cloudhand'].get('enabled'):
    d['plugins']['entries']['cloudhand'] = {'enabled': True, 'config': {'port': 9876, 'autoStart': True}}
    changed = True

# tools.allow
d.setdefault('tools', {}).setdefault('allow', [])
if 'cloudhand' not in d['tools']['allow']:
    d['tools']['allow'].append('cloudhand')
    changed = True

if changed:
    shutil.copy(config_path, config_path + '.bak')
    with open(config_path, 'w') as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
    print('✅ 配置文件已更新')
else:
    print('✅ 配置文件无需更改')
EOF

# 重启 Gateway
echo ''
echo '🔄 重启 OpenClaw Gateway...'
if systemctl --user is-active openclaw-gateway.service &>/dev/null; then
  nohup bash -c 'sleep 2 && systemctl --user restart openclaw-gateway.service' > /tmp/cloudhand-install.log 2>&1 &
  echo '✅ Gateway 重启中（约 8 秒后生效）'
else
  echo '⚠️  Gateway 未运行，请手动启动: openclaw gateway start'
fi

# 完成
echo ''
echo '================================================'
echo '   ✅ CloudHand 安装完成！'
echo '================================================'
echo ''
echo '📌 下一步：安装 Chrome 扩展'
echo ''
echo '  1. 获取扩展文件：'
echo "     $CLOUDHAND_DIR/extension.zip"
echo ''
echo '  2. 解压 ZIP，然后：'
echo '     Chrome → chrome://extensions/ → 开发者模式'
echo '     → 「加载已解压的扩展程序」→ 选择 extension/ 目录'
echo ''
echo '  3. 点击扩展图标 → 填入 VPS 地址 → 输入配对码'
echo '     （对 AI 说「帮我连接浏览器」获取配对码）'
echo ''
echo '  4. 对 AI 说「测试云手」验证'
echo ''
echo '💡 查看日志：journalctl --user -u openclaw-gateway.service -f'
echo ''
