# Toutiao.com 操控经验 (Updated: 2026-04-16 09:45:29)

## 核心捷径 (Shortcut)
- **精准搜索 URL (推荐)**: 
  `https://so.toutiao.com/search?keyword={{keyword}}&filter_vendor=site&index_resource=site`
  (该参数可实现：只看头条 + 站内资源过滤)
- **“一天内”筛选**: 直接在搜索 URL 后拼接 `&search_time=1` 或 `&filter_period=day`。

## 常用元素
- **搜索框**: 首页大框通常为 `input[type="search"]`。

## 避坑指南
- 头条首页加载极慢且伴随重定向，`navigate` 容易超时。建议设置较大的超时时间或使用 `new_tab` 直接切入搜索结果页。
- 页面筛选菜单是动态渲染的，很难通过 `click` 稳定操控，**强烈建议优先使用 URL 参数法**。
