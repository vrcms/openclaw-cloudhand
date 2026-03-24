---
name: cloudhand
description: |
  控制用户本地 Chrome 浏览器。当用户要求打开网页、截图、点击、输入、操作浏览器时使用。
  Use when: (1) 用户要打开/访问某个网址，(2) 需要截图当前页面，(3) 需要在浏览器中点击/输入/操作，
  (4) 用户说「帮我连接浏览器」，(5) 需要在登录状态下访问网站（利用用户已有的 Cookie）。
  NOT for: 服务端抓取（用 web/firecrawl），不需要真实浏览器的场景。
---

# CloudHand - 控制本地 Chrome

## 执行前必读

1. **先检查连接状态**：调用 `cloudhand_status` 确认浏览器已连接
2. **未连接时配对**：调用 `cloudhand_pair` 获取验证码，通过当前渠道发给用户（不要硬编码飞书）
3. **开新窗口**：每次操作浏览器前，先调用 `cloudhand_new_window` 开一个新 Chrome 窗口，避免干扰用户现有页面
4. **截图处理**：`cloudhand_screenshot` 返回 `{ path, base64, sizeKB }`，根据当前渠道决定如何发送

## 标准操作流程

### 检查 + 配对
```
1. cloudhand_status → 检查 connected 字段
2. 如果 connected=false → cloudhand_pair → 把验证码告知用户
3. 用户输入验证码后 → 再次 cloudhand_status 确认
```

### 打开网页并截图
```
1. cloudhand_status（确认连接）
2. cloudhand_navigate(url)
3. 等待约 2-3 秒（页面加载）
4. cloudhand_screenshot → 获取图片
5. 根据渠道发送图片给用户
```

### 搜索操作
```
1. cloudhand_navigate(搜索引擎 URL)
2. cloudhand_find(搜索框 selector) → 确认存在
3. cloudhand_click(selector)
4. cloudhand_type(搜索词)
5. cloudhand_key('Enter')
6. cloudhand_screenshot → 截图结果
```

### 表单填写
```
1. cloudhand_navigate(URL)
2. cloudhand_click(input selector)
3. cloudhand_type(内容)
4. cloudhand_click(submit selector) 或 cloudhand_key('Enter')
```

## 工具速查

| 工具 | 用途 | 关键参数 |
|------|------|----------|
| cloudhand_status | 检查连接 | - |
| cloudhand_pair | 生成配对码 | - |
| cloudhand_tabs | 列出所有标签页 | - |
| cloudhand_navigate | 导航到 URL | url |
| cloudhand_screenshot | 截图 | tabId（可选）|
| cloudhand_click | 点击元素 | selector |
| cloudhand_type | 输入文字 | text |
| cloudhand_key | 按键 | key（Enter/Escape/Tab等）|
| cloudhand_find | 查找元素 | selector, limit |
| cloudhand_get_text | 获取页面文字 | - |
| cloudhand_scroll | 滚动页面 | direction（up/down）|
| cloudhand_go_back | 后退 | - |
| cloudhand_go_forward | 前进 | - |
| cloudhand_new_tab | 新开标签页 | url（可选）|
| cloudhand_page_info | 当前页面标题/URL | - |

## 截图发送（渠道无关）

`cloudhand_screenshot` 返回：
```json
{ "ok": true, "path": "/tmp/cloudhand_screenshot_xxx.png", "sizeKB": 340, "base64": "data:image/png;base64,..." }
```

- **飞书**：用 `feishu_im_bot_image` 工具发送，传 `path` 字段
- **其他渠道**：根据渠道能力选择合适方式
- **无图片工具**：告知用户截图已保存到 `path`，或直接描述页面内容

## 快速测试

当用户说「测试一下」、「测试 CloudHand」、「测试浏览器」时：

```
1. cloudhand_status（确认连接）
2. cloudhand_new_window（开新窗口，不干扰现有页面）
3. cloudhand_navigate(url="https://www.bing.com")
4. 等待 2 秒（页面加载）
5. cloudhand_click(selector="#sb_form_q")  ← bing 搜索框
6. cloudhand_type(text="www.dabeizi.com")
7. cloudhand_key(key="Enter")
8. 等待 2 秒（搜索结果加载）
9. cloudhand_screenshot → 截图
10. 通过当前渠道发送截图给用户
11. 报告：「已在 Bing 搜索 www.dabeizi.com，截图如上」
```

## 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| connected=false | 扩展未连接 | 调用 cloudhand_pair，让用户输入验证码 |
| 点击无效 | selector 错误 | 先用 cloudhand_find 确认元素存在 |
| 页面未加载 | 导航后太快截图 | navigate 后等 2-3 秒再操作 |
| 截图空白 | 页面加载中 | 重试一次 |
