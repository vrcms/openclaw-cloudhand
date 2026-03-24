#!/bin/bash
# CloudHand bridge 启动通知

APP_ID="cli_a93eacc9c7781bc3"
APP_SECRET="TuAQqJkNNtnqrpuObI95DbUI5o5s4wxR"
USER_OPEN_ID="ou_8e9f7214c4a8e290dc66ff1b9acce7ac"

# 读取公网 IP
CONFIG_FILE="$HOME/.openclaw/chrome-bridge/config.json"
PUBLIC_IP=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('publicIp','149.13.91.10'))" 2>/dev/null || echo '149.13.91.10')

# 获取 tenant_access_token
TOKEN=$(curl -s -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
  -H 'Content-Type: application/json' \
  -d "{\"app_id\": \"$APP_ID\", \"app_secret\": \"$APP_SECRET\"}" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tenant_access_token',''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  exit 0
fi

# 判断是否已配对
PAIRED=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print('已配对' if d.get('sessionToken') else '未配对，需要配对码')" 2>/dev/null || echo '未知')

MSG="☁️ CloudHand 云手已启动！\n\nIP: ${PUBLIC_IP}\n端口: 9876\n状态: ${PAIRED}\n\n直接对我说就可以操作你的 Chrome 了。\n如需重新配对：发送「帮我连接浏览器」"

curl -s -X POST 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"receive_id\": \"$USER_OPEN_ID\", \"msg_type\": \"text\", \"content\": \"{\\\"text\\\":\\\"$MSG\\\"}\"}"
