#!/usr/bin/env bash
# CloudHand 云手 - 本地模式启动脚本 (macOS/Linux)
# Usage: bash start-local.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ''
echo '================================================'
echo '   CloudHand 云手 - 本地模式启动脚本'
echo '   Local Mode Bridge Starter'
echo '================================================'
echo ''

# ── 1. 检查 Node.js ──────────────────────────────
if ! command -v node &>/dev/null; then
    echo "[ERROR] Node.js 未安装，请先安装 Node.js 18+"
    echo "[错误]  未检测到 Node.js，请访问 https://nodejs.org 下载安装"
    exit 1
fi
echo "[OK] Node.js: $(node -v)"
echo ''

# ── 2. 检查 server.js ────────────────────────────
if [ ! -f "$SCRIPT_DIR/server.js" ]; then
    echo "[ERROR] server.js 不存在，请确保文件结构完整"
    exit 1
fi

# ── 3. 检查端口是否被占用 ────────────────────────
if command -v lsof &>/dev/null; then
    if lsof -i :9876 &>/dev/null; then
        echo "[WARN] 端口 9876 已被占用，请先关闭占用该端口的进程"
        echo "[警告]  Port 9876 is already in use. Please close the process using it."
        lsof -i :9876
        exit 1
    fi
elif command -v ss &>/dev/null; then
    if ss -tlnp | grep -q ':9876'; then
        echo "[WARN] 端口 9876 已被占用，请先关闭占用该端口的进程"
        exit 1
    fi
fi

# ── 4. 安装依赖（如果 node_modules 不存在）──────
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    echo "[INFO] 首次运行，安装 npm 依赖..."
    cd "$SCRIPT_DIR"
    npm install
    echo ''
fi

# ── 5. 启动 bridge ───────────────────────────────
echo '================================================'
echo '   正在启动本地 Bridge...'
echo '   Starting local bridge on 127.0.0.1:9876'
echo '================================================'
echo ''
echo '[INFO] 启动后请确保 Chrome 扩展已安装并运行'
echo '[INFO] 扩展将自动连接 127.0.0.1:9876（2秒超时）'
echo ''
echo '[提示] 按 Ctrl+C 可停止服务'
echo ''

cd "$SCRIPT_DIR"
exec node server.js --local
