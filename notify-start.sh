#!/bin/bash
# CloudHand bridge 启动通知

CONFIG_FILE="$HOME/.openclaw/chrome-bridge/config.json"

# 读取配对状态
PAIRED=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print('已配对' if d.get('sessionToken') else '未配对，请发「帮我连接浏览器」')" 2>/dev/null || echo '未知')

MSG="CloudHand 云手已启动！端口: 9876 | 状态: $PAIRED | 直接对我说就可以操作你的 Chrome 了。"

openclaw message send \
  --channel feishu \
  --target ou_8e9f7214c4a8e290dc66ff1b9acce7ac \
  --message "$MSG" >> /tmp/cloudhand-notify.log 2>&1

echo "[cloudhand-notify] $(date): done" >> /tmp/cloudhand-notify.log
