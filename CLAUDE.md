# CLAUDE.md — 开发约定

## 必读规则

- **改代码前必读 PLAN.md**（架构、里程碑、已知坑 §8）；每完成一个里程碑，更新 PLAN.md 对应复选框打勾并更新头部状态行
- 对话行为策略（何时追问/规划/汇报格式）维护在 **WORKFLOW.md**（活文档），改行为先改文档再改 prompt
- **API key 禁止硬编码**、禁止写入日志；key 从 chrome.storage.local 读取，日志出口统一脱敏（background/log.js）
- **`kimi-k3` 必须 `temperature: 1`**，写死在请求构造处（background/llm.js）

## 技术约定

- 纯 JS 无构建；background 用 ES modules（manifest `background.type="module"`）
- **content script 单文件**（MV3 content script 不支持静态 import），内部用注释分区组织
- LLM 调用一律走 background service worker（content script 直连有 CORS/CSP 问题）
- 状态持久化用 `chrome.storage.session`；SW 休眠恢复是基本假设，内存状态必须可重建
- 判断权归模型，代码只做安全保障（如 goto/new_tab 限制 http/https）

## 移植来源

练习版在 `D:\projects\browser-agent\`，DOM 提取、动作执行、look 管线、日志脱敏等模块已验证，可参考或移植，但**架构按 PLAN.md §3 重新组织**，不要整体照搬。

## 调试方式

- Edge/Chrome：`chrome://extensions` → 开发者模式 → 加载已解压扩展
- 侧边栏调试面板（设置页"开发者模式"开关控制显隐）：单测区、连接测试、日志导出、token 统计
- 里程碑验收标准见 PLAN.md §5，逐项验证后再打勾
