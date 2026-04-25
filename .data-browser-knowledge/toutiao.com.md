# toutiao.com 操作经验 (Updated: 2026-04-25 09:27)

## 页面骨架 (Regions)

### 首页 (www.toutiao.com)
- **搜索区**: `textbox "搜索" [ref=e12]` + `button "搜索" [ref=e13]`
- **用户信息区**: region "登录信息"，包含头像、获赞、粉丝等
- **热榜区**: heading "头条热榜"，10 条热搜链接
- **信息流**: 正文区域的新闻列表

### 搜索结果页 (so.toutiao.com)
- **搜索框**: `searchbox "输入关键词进行搜索" [ref=e3]`
- **频道标签**: 综合/资讯/视频/图片/用户/小视频/微头条/音乐（均为 link）
- **筛选栏**: 包含 `全网内容 / 只看头条 / 不限时间` 三个筛选器
- **时间下拉**: `combobox [ref=e25]`（React Select 组件）
- **结果列表**: 搜索结果链接
- **相关搜索**: 底部的相关关键词链接

## 核心地标 (Landmarks)

- **{搜索框}**: 首页 ref=e12（textbox），搜索页 ref=e3（searchbox）
- **{只看头条}**: 纯 `<span class="text-underline-hover">`，**无 ARIA role，snapshot 中无 ref**
- **{不限时间}**: `<div class="cs-select-pro__single-value">`，对应 snapshot 中的 `combobox [ref=e25]`
- **{频道-资讯}**: 搜索页 ref=e7（link）

## 核心捷径 (Shortcuts)

- **搜索提交**: 在首页搜索框 `type ref "关键词" --submit`，会自动打开新 Tab
- **只看头条**: 无法用 ref 点击，必须用 `evaluate` JS 点击：
  ```
  act evaluate --fn "(function(){var el=Array.from(document.querySelectorAll('span')).find(e=>e.textContent.trim()==='只看头条'); if(el){el.click(); return 'clicked'} return 'not found'})()"
  ```
- **时间筛选**: React Select 组件，需分步操作：
  1. `click combobox ref` 或 `evaluate focus+ArrowDown` 展开
  2. `evaluate` 查询 `[id*=listbox]` 获取选项列表
  3. `evaluate` 通过选项 ID 点击（如 `react-select-2-option-2` = "一天内"）
- **URL 参数**: 筛选条件反映在 URL 中，`filter_vendor=site`=只看头条，`filter_period=day`=一天内

## 操控心得 (Insights)

- **新 Tab 行为**: 首页搜索提交后会打开新 Tab（so.toutiao.com），act 返回的 snapshot 是原 Tab 的，必须 `ensure_tab so.toutiao.com` 切换
- **筛选栏无 ref**: "只看头条"和"全网内容"是纯 span 元素，Playwright ariaSnapshot 不分配 ref，只能用 evaluate JS 操作
- **React Select 焦点丢失**: Playwright click combobox 后，act 自动 snapshot 可能导致菜单关闭。备选方案：evaluate 内 focus() + KeyboardEvent('keydown', {key:'ArrowDown'})
- **React Select 选项 ID 动态**: ID 格式为 `react-select-{N}-option-{index}`，N 是动态的，不可硬编码。必须先查询 listbox 获取实际 ID
- **时间选项映射**: option-0=不限时间, option-1=一小时内, option-2=一天内, option-3=一周内, option-4=一个月内, option-5=一年内
