@echo off
chcp 65001 >nul 2>&1
echo.
echo ================================================
echo    CloudHand 云手 - 本地模式启动脚本
echo    Local Mode Bridge Starter
echo ================================================
echo.

REM ── 1. 检查 Node.js ──────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js 未安装，请先安装 Node.js 18+
    echo [错误]  未检测到 Node.js，请访问 https://nodejs.org 下载安装
    pause
    exit /b 1
)
echo [OK] Node.js: 
node -v
echo.

REM ── 2. 检查 server.js ────────────────────────────
set "SCRIPT_DIR=%~dp0"
if not exist "%SCRIPT_DIR%server.js" (
    echo [ERROR] server.js 不存在
    pause
    exit /b 1
)

REM ── 3. 检查端口是否被占用 ────────────────────────
netstat -ano | findstr ":9876" | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    echo [WARN] 端口 9876 已被占用，请先关闭占用该端口的进程
    echo [警告]  Port 9876 is already in use. Please close the process using it.
    netstat -ano | findstr ":9876" | findstr "LISTENING"
    pause
    exit /b 1
)

REM ── 4. 安装依赖（如果 node_modules 不存在）──────
if not exist "%SCRIPT_DIR%node_modules" (
    echo [INFO] 首次运行，安装 npm 依赖...
    cd /d "%SCRIPT_DIR%"
    call npm install
    echo.
)

REM ── 5. 启动 bridge ───────────────────────────────
echo ================================================
echo   正在启动本地 Bridge...
echo   Starting local bridge on 127.0.0.1:9876
echo ================================================
echo.
echo [INFO] 启动后请确保 Chrome 扩展已安装并运行
echo [INFO] 扩展将自动连接 127.0.0.1:9876（2秒超时）
echo.
echo [提示] 按 Ctrl+C 可停止服务
echo.

cd /d "%SCRIPT_DIR%"
node server.js --local
