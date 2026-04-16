---
name: cloudhand-local
description: Advanced Self-Learning skill for AI agents. AI analyzes raw page telemetry to build autonomous cognitive maps of web applications.
license: MIT
compatibility: CloudHand v2.6.0+ (Cognitive Edition)
metadata:
  author: CloudHand
  version: "2.6.0"
---

# CloudHand 本地浏览器控制专家技能 (深度认知版)

这是云手最顶级的控制规范。核心逻辑是 **“AI 认知建模”**：AI 通过分析原始页面遥测数据，自主理解网站的逻辑骨架，并将其沉淀为可复用的知识。

---

**Input**: 用户的网页任务指令。

**Steps**

-1. **锦囊优先 (Strategic Recall)**
   检查 `./.data-browser-knowledge/<domain>.md`。
   - **已有建模**: 遵循记录的“黄金 URL”和“地标语义”，直接执行任务。
   - **空白站点**: 进入 **Step 0 (认知建模模式)**。

0. **认知建模模式 (Cognitive Mapping)**
   首次面对新站点，AI 必须进行深度扫描并运用大脑进行逻辑建模：
   ```bash
   # 学习连招：开启新窗 -> 提取高保真遥测数据
   node ./cloudhand-bridge/ch batch "new_window --url <url>; learn"
   ```
   **AI 深度分析任务**:
   1. **逻辑分区**: 分析 [INTERACTIVE TREE]，识别 header（导航区）、main（功能区）、footer（信息区）。
   2. **寻找地标 (Landmarks)**: 找出核心搜索框、登录按钮、筛选入口。
   3. **预测性建模**: 分析页面是否有重度异步加载特征（如 Placeholder 文本），确定是否需要 `wait_for_text`。
   4. **存档锦囊**: 立即将上述大脑分析结论写进 `./.data-browser-knowledge/<domain>.md`。

1. **执行任务 (Precision Strike)**
   利用 `ch.js` 的 **batch** 和 **{语义定位}**，结合刚刚建立的认知模型进行操作。

2. **实战复盘 (Post-Action Refinement)**
   操作完成后，根据实战反馈修正认知模型：
   - 记录发现的 API/URL 捷径。
   - 标记容易导致超时的“雷区”。

**Output**

- 执行报告：重点说明本次 AI 是如何从 0 到 1 建立该站点的逻辑模型的。

**Guardrails**

- **大脑建模铁律**: 严禁在未分析页面结构的情况下盲目点击。AI 的优势是理解，而非暴力重试。
- **经验持久化**: 所有认知成果必须存档，实现“一次学习，终身受益”。
- **静默操作**: 始终使用专属窗口，不抢占焦点。
