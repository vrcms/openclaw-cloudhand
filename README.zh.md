# CloudHand 云手

> 让远程 AI 控制你本地的 Chrome 浏览器。

[![版本](https://img.shields.io/badge/版本-2.1.0-blue.svg)](https://github.com/vrcms/openclaw-cloudhand)
[![OpenClaw 插件](https://img.shields.io/badge/openclaw-plugin-orange.svg)](https://openclaw.ai)

**[English](README.md)** | 中文

## 什么是云手？

云手是一个 OpenClaw 插件，将运行在 VPS 上的远程 AI 和你本地的 Chrome 浏览器连接起来。让 AI 能够：

- 导航到任意网址
- 截取页面截图
- 点击元素、输入文字、按键
- 执行任意 JavaScript（`eval` 工具）
- 读取页面内容、查找元素
- 控制标签页、滚动、前进/后退

**典型使用场景：**
- AI 需要访问需要登录的网站（利用你已有的 Cookie）
- 绕过反爬虫机制（真实浏览器行为）
- 操作复杂的 Web 应用界面
- 自动化日常网页任务

## 架构原理

```
┌─────────────────────┐         ┌──────────────────────────┐
│   VPS（OpenClaw）    │         │   你的电脑               │
│                     │         │                          │
│  AI 助理            │         │  Chrome 浏览器           │
│     ↓               │         │     ↑                    │
│  cloudhand_*        │ ←WS──→  │  CloudHand 扩展          │
│  工具调用           │  9876   │  （Chrome MV3 扩展）     │
│     ↓               │         │                          │
│  Bridge 服务端      │         └──────────────────────────┘
│  （server.js）      │
└─────────────────────┘
```

Chrome 扩展**主动连接** VPS——你的本地电脑不需要开放任何端口。

## 安装教程

### 第一步：VPS 端（一条命令）

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/vrcms/openclaw-cloudhand/main/install.sh)
```

该脚本会自动完成：
1. 安装插件到 `~/.openclaw/extensions/cloudhand/`
2. 安装 npm 依赖
3. 在 OpenClaw 配置中注册插件
4. 重启 Gateway

### 第二步：安装 Chrome 扩展

1. 从 VPS 下载扩展 ZIP：
   ```
   http://你的VPS地址:9876/extension.zip
   ```
   或从 [Releases](https://github.com/vrcms/openclaw-cloudhand/releases) 下载

2. 在 Chrome 中加载：
   - 打开 `chrome://extensions/`
   - 开启右上角**开发者模式**
   - 点击**加载已解压的扩展程序** → 选择解压后的 `extension/` 目录

3. 配置扩展：
   - 点击 CloudHand 扩展图标
   - 填入 VPS 地址（例如 `149.13.91.10:9876`）
   - 点击**连接**

4. 与 AI 配对：
   - 对 AI 说：「帮我连接浏览器」
   - AI 会生成一个 6 位验证码
   - 在扩展弹窗中输入验证码完成配对

## 可用的 AI 工具

| 工具 | 说明 |
|------|------|
| `cloudhand_status` | 检查连接状态 |
| `cloudhand_pair` | 生成配对验证码 |
| `cloudhand_tabs` | 列出所有打开的标签页 |
| `cloudhand_navigate` | 导航到指定 URL |
| `cloudhand_screenshot` | 截图（返回文件路径 + base64）|
| `cloudhand_click` | 点击元素（支持 CSS 选择器或文字匹配）|
| `cloudhand_type` | 在元素中输入文字 |
| `cloudhand_key` | 按键（Enter、Tab、Escape 等）|
| `cloudhand_find` | 通过 CSS 选择器查找元素 |
| `cloudhand_get_text` | 获取页面文字内容 |
| `cloudhand_scroll` | 滚动页面 |
| `cloudhand_eval` | 执行任意 JavaScript（使用 chrome.debugger，绕过 CSP 限制）|
| `cloudhand_go_back` | 后退 |
| `cloudhand_go_forward` | 前进 |
| `cloudhand_page_info` | 获取当前页面标题和 URL |

## 插件配置

在 OpenClaw 配置文件 `~/.openclaw/openclaw.json` 中：

```json
{
  "plugins": {
    "entries": {
      "cloudhand": {
        "enabled": true,
        "config": {
          "port": 9876,
          "autoStart": true
        }
      }
    }
  }
}
```

## 安全机制

- **配对验证码**：6 位数字，30 秒有效期，一次性使用
- **Session Token**：128 位随机 token，保存在扩展 storage 中
- **所有 WebSocket 连接**都需要有效的 session token
- Bridge 服务监听 `0.0.0.0:9876`，建议配置防火墙规则

## 快速测试

安装完成后，对 AI 说：

> 「测试云手」

AI 会自动打开 Bing，搜索 www.dabeizi.com，截图发给你，验证全链路是否正常。

## 开发

```bash
# 克隆仓库
git clone https://github.com/vrcms/openclaw-cloudhand.git
cd openclaw-cloudhand

# 安装依赖
npm install

# 直接运行 Bridge 服务
node server.js

# 在 Chrome 中加载扩展（开发者模式 → 加载已解压 → extension/ 目录）
```

## 开源协议

MIT
