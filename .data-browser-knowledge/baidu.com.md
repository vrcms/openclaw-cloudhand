# Baidu.com 操作经验 (Updated: 2026-04-25 09:34)

## 页面骨架 (Regions)

### 首页 (www.baidu.com)
- **搜索框**: `textbox [ref=e15]`（placeholder 为当前热搜词，每次不同）
- **搜索按钮**: `button "百度一下" [ref=e16]`

### 搜索结果页 (www.baidu.com/s)
- **搜索框**: `textbox [ref=e2]`
- **频道标签**: 网页/图片/资讯/视频/笔记/地图/贴吧/文库/更多
- **搜索工具**: 纯 `<span>` 文本，无 ref，点击展开二级筛选面板
- **时间筛选**: 展开后显示"时间不限"（id=timeRlt），点击后弹出时间选项列表

## 核心地标 (Landmarks)

- **{搜索框}**: 首页 ref 动态变化，通常是 textbox
- **{百度一下}**: button，首页和结果页 ref 不同
- **{搜索工具}**: 纯 `<span class="s-tab-filter">`，**无 ref**
- **{时间不限}**: `<span id="timeRlt">`，有子元素（图标），children.length=1
- **{一天内}**: `<li class="time_li_3_ArK">`，展开后才出现

## 核心捷径 (Shortcuts)

- **"一天内"筛选 URL 参数法**（最稳）: 
  直接在搜索 URL 后拼接 `&gpc=stf%3D{dayAgoTimestamp}%2C{nowTimestamp}%7Cstftype%3D1`
  ```
  act evaluate --fn "(function(){var now=Math.floor(Date.now()/1000); var dayAgo=now-86400; var gpc='stf%3D'+dayAgo+'%2C'+now+'%7Cstftype%3D1'; var url=window.location.href; url+='&gpc='+gpc; window.location.href=url; return 'done'})()"
  ```

- **"一天内"筛选 UI 交互法**（备选，3步）:
  1. evaluate 点击"搜索工具" span
  2. evaluate 点击 `#timeRlt`（"时间不限"）
  3. evaluate 点击 `<li>` 中文本为"一天内"的选项

- **搜索提交**: `type ref "关键词" --submit`，百度同页跳转，不开新 Tab

## 操控心得 (Insights)

- **同页跳转**: 百度搜索不开新 Tab（与头条不同），省去 ensure_tab 切换
- **搜索工具无 ref**: 和头条的"只看头条"一样，需 evaluate JS 点击
- **时间不限有子元素**: `#timeRlt` 内嵌图标 span，`children.length===0` 匹配不到。直接用 `document.getElementById('timeRlt')` 最稳
- **时间选项是 `<li>`**: 展开后的选项列表为 `<li class="time_li_...">`，可按文本匹配
- **URL 参数优先**: gpc 参数法一步到位，避免操作动态菜单的不确定性
- **gpc 参数格式**: `stf={起始时间戳},{结束时间戳}|stftype=1`，URL 编码后为 `stf%3D...%2C...%7Cstftype%3D1`
