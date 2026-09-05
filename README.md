# Browser Agent Pro

多模态浏览器自主操作 Agent（Edge/Chrome 插件，Manifest V3）：用自然语言指挥浏览器完成任务——既能**操作**（搜索、点击、打开目标内容），也能**认知**（跨页面阅读、整合、输出分析报告）。交互形态为侧边栏统一对话流：任务、追问、执行过程、结果汇报都在一个对话里。

## 功能

- 统一多轮对话循环：意图不清会追问，复杂任务先给执行纲要，完成后对话式汇报
- 压缩 DOM 元素清单感知 + 按需多模态工具：`read`（读正文，分段）/ `look`（看截图，视觉模型）
- 站点知识包（`sites/*.json`）按域注入站点提示，已适配 B 站；通用引擎不依赖知识包
- 页面上被操作元素高亮描边、步骤时间线、token 统计、调试面板（开发者模式开关）
- 可靠性：步数上限、动作循环检测、MV3 service worker 休眠恢复、中断续跑

## 安装与配置

1. `chrome://extensions` → 打开**开发者模式** → **加载已解压的扩展程序** → 选择本目录
2. 点击工具栏图标打开侧边栏 → 右上角 ⚙ 打开设置页
3. 填写 **API Key**（Kimi，`https://api.moonshot.cn/v1`，模型 `kimi-k3`）→ 保存
   - key 仅存于本浏览器 `chrome.storage.local`，不会写入日志
4. （可选）设置页勾选**开发者模式**：侧边栏显示调试面板（单测区 / 日志导出 / token 统计）

## 使用

侧边栏输入自然语言即可，例如：

- 「在B站搜索影视飓风，打开UP主为影视飓风的最新视频」
- 「看看B站有没有最新的乒乓球比赛信息」
- 「打开这个视频，浏览评论区，为我总结舆论氛围」

执行中可点**停止**；Agent 追问时在对话中直接回答。

## Docker 演示

容器内 Chrome + Xvfb + Playwright 自动加载扩展并执行示例任务，日志输出到 stdout：

```bash
docker build -f docker/Dockerfile -t browser-agent-pro .
docker run --rm -e MOONSHOT_API_KEY=sk-你的key browser-agent-pro
# 自定义任务：-e DEMO_TASK="看看B站有没有最新的乒乓球比赛信息"
```

退出码 0 = 任务完成。**key 只经环境变量注入，不进镜像。**

## 文档

- `PLAN.md` — 架构、里程碑、延期清单、已知坑
- `WORKFLOW.md` — 对话循环行为策略（活文档）
- `CLAUDE.md` — 开发约定
