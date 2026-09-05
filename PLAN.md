# PLAN.md — 多模态浏览器自主操作 Agent（正式版）

> 最后更新：2026-09-05　状态：M0/M1/M2 代码完成待浏览器验收；M3 知识包提前完成；M4 基础版完成；M5 Docker 待实测
> 开发周期：1 天（2026-09-05 下午 → 2026-09-06 中午）。M0/M1 移植为主，M2 核心必须完整，M3/M4/M5 精简，来不及的列入 §7 延期清单。

## 1. 项目目标

Edge/Chrome 插件（MV3）形态的多模态浏览器自主操作 Agent：根据自然语言指令自主操作浏览器完成任务。覆盖两类场景（**不预设硬分类，由模型在对话中自主决定策略**）：

1. 操作型：如"在B站搜索影视飓风，打开UP主为影视飓风的最新视频"
2. 认知型：如"看看B站有没有最新的乒乓球比赛信息"、"打开这个视频，浏览评论区，为我总结舆论氛围"

要求通用网页操作能力；B站任务为测试与演示重点。

**交互范式**：统一多轮对话循环（侧边栏）。任务、追问、澄清、执行过程、结果汇报全部在一个对话流里。历史即对话本身，超长时摘要压缩。行为策略见 WORKFLOW.md（活文档）。

## 2. 硬约束

- 开发周期 1 天；纯 JS 无构建（MV3 原生），Edge/Chrome 加载解压扩展即可调试
- LLM：OpenAI 兼容 Chat Completions，默认 Kimi `kimi-k3`（`https://api.moonshot.cn/v1`）；**`kimi-k3` 的 `temperature` 必须为 1，否则 API 400**
- API URL、模型名、API key 由用户在设置页填写存入 `chrome.storage.local`；**key 禁止硬编码、禁止进日志**
- Docker 交付：容器内 Chrome + 加载扩展 + 自动执行示例任务，stdout 输出日志；key 经环境变量注入；**不做 noVNC**
- 对话存 `chrome.storage.session`（浏览器关闭即清）；不处理登录/验证码/弹窗
- 已确认决策（2026-09-05）：plan 输出纲要后**不等待确认直接执行**，用户可随时叫停；认知报告用**自由 markdown**；不可逆动作执行前必须 ask_user 确认（WORKFLOW §4）

## 3. 架构

### 3.1 总体：对话驱动的单 Agent 循环

```
用户消息（侧边栏） → background 对话循环 → content script 执行动作
        ↑                   │  LLM 决策            │
        └── reply/ask_user ─┴── 观察页面（压缩DOM/read/look）──┘
```

练习版 ReAct 内核保留，三个扩展：

1. **话语权动作**：`reply`（说话并结束回合，统一任务汇报与问答）、`ask_user`（追问，**无超时挂起**）、`plan`（输出纲要后直接执行）。终止不用 done/fail 对用户说话，统一 reply。
2. **对话历史进上下文**：历史即对话，超长压缩（M2 规则压缩；LLM 摘要为延期项）。
3. **挂起态**：awaiting_user 无活跃循环，SW 可休眠；用户回答经 port 唤醒，从 storage.session 恢复续跑。

### 3.2 状态组织（三层）

- **对话层**（chrome.storage.session）：messages[]（用户/Agent 消息）、runs{}（每回合步骤记录，供 UI 时间线，不喂 LLM）、digest（旧对话压缩摘要）
- **执行层 RunState**（每步 checkpoint 到 storage.session）：step / actionHistory(最近5步) / memory 便签 / look 额度 / status(running | awaiting_user)
- **UI 层**：port 长连接 + 事件总线（postLog → 脱敏 → 缓冲 → 广播；重连回放）

状态机：`idle → running ⇄ awaiting_user → idle`

**记忆持久化保证（2026-09-05 确认）**：`chrome.storage.session` 语义=跨窗口共享、
SW 休眠/被杀可恢复、仅浏览器完全关闭才清空——正好满足"只要没关浏览器就持有全部记忆"。
已落 session 的状态：对话（conversation.js）、RunState（每步 checkpoint）、token 统计、
事件日志缓冲。内存态仅剩无碍项（站点包缓存可重载、port 引用、AbortController）。

**对话历史归档（2026-09-05 新增，同日改为实时同步）**：活跃对话首条消息时分配稳定 id，
之后每次 appendMessage 都按 id upsert 到 `storage.local.conversationArchive`
（上限 20 条，含消息 steps；同 id 覆盖并置顶，不会重复归档）——归档与"新对话"按钮
无关，新对话仅清 session。侧边栏"🕘 历史"可查看/重新载入/删除。载入历史即替换当前
活跃对话并带回原 id，续聊仍更新同一条归档；删除当前活跃对话的归档会置
archiveSuppressed 抑制复活。页面刷新/变化不影响续聊：每轮观察、标签页快照、元素编号
均实时重建，旧对话只提供语义上下文（旧页面引用失效时模型依据新快照自行导航）。
**thought 持久化**：每步 thought/action/result 存进消息的 steps 字段（不进 LLM 上下文），
重开对话时渲染为可折叠"执行过程"时间线。

**SW 存活保证（2026-09-05 加固）**：等待型 await（ask_user 等回答、sleep、长 LLM 响应）
不算 SW 活动，30s 空闲即被 Chrome 回收、任务死在中途。对策：运行期间创建
`agent-watchdog` 周期闹钟（30s）——闹钟事件既重置空闲计时保活，又能在 SW 已被杀时
唤醒并自动 `recoverInterruptedRun` 续跑；ask 挂起状态（askId/question 在 checkpoint 里）
恢复后重新挂起等同一 askId，用户作答无缝续跑。任务结束清除闹钟。

### 3.3 每轮上下文组装（每决策轮重建 messages = [system, user]）

system：基础规则 + 输出契约 + WORKFLOW 策略蒸馏。
user（按序）：对话摘要+最近N轮原文 → 站点知识包（按当前 URL host 匹配命中时）→ memory 便签 → 最近 5 步动作历史 → look/read 笔记 → 标签页快照 → 当前页面观察。

**输出契约**（每轮严格 JSON，解析失败重试 1 次）：

```json
{"thought": "分析与打算（UI 展示）", "memory": "跨轮工作记忆 ≤500字，每轮重写，可省略", "action": {...}}
```

memory 便签是认知任务的架构支点：read 正文只进当轮，跨轮要点靠模型蒸馏进 memory。

### 3.4 动作集

| 动作 | 说明 |
|---|---|
| `click(id)` | 点击编号元素（先高亮描边） |
| `input_text(id, text)` | native setter + 原生事件（React 受控组件） |
| `goto(url)` | 跳转**确定可靠**的 URL（官网首页、知识包直链）；搜索默认页面内输入+点按钮（WORKFLOW §5） |
| `scroll(direction)` | 滚动一屏 up/down |
| `wait(seconds)` | 1~5 秒 |
| `read(id\|"main", offset?, limit?)` | **新增**：提取元素子树正文，无状态切片返回 {text, offset, totalChars, hasMore}；默认 limit 3000，上限 5000；懒加载场景 scroll 后再 read |
| `look(target, question)` | 视觉观察（元素裁剪截图 ×DPR 或 viewport），每任务限 3 次 |
| `switch_tab / new_tab / close_tab` | 标签页管理 |
| `reply(text)` | 话语权动作：对用户说话（markdown），结束回合 |
| `ask_user(question)` | 追问挂起，无超时 |
| `plan(steps)` | 输出纲要（3~8 条），**不等待确认直接执行** |
| `fail(reason)` | 确认无法完成（内部终止，对用户仍转为 reply 说明） |

### 3.5 感知（沿用练习版压缩 DOM 清单）

可见可交互元素编号清单：交互选择器 ∪ 最外层 cursor:pointer（B站 div+React onClick 按钮靠此捕获），文本截断 30 字，无文本用 class 兜底，附 placeholder/href/type，封顶 120，按视口位置排序。附 URL/标题/滚动位置/正文摘要（12000 字）。

### 3.6 站点知识包

`sites/*.json`：`{name, hosts[], prompt, selectors?}`，打包进扩展，SW 启动加载。**每轮**组装上下文时按当前 URL host 后缀匹配，命中即在 user message 注入"## 站点提示"。纯提示词层，通用引擎不依赖知识包（去包对照为延期项）。先行适配 B站（搜索直链 `search.bilibili.com/all?keyword=<URL编码>`、UP主空间 `space.bilibili.com/<mid>`、评论区结构）。

### 3.7 可靠性（沿用练习版）

单回合步数上限 25 / 动作签名循环检测 / 动作后重观察 + 等页面稳定 8s / JSON 解析失败重试 1 次 / look 每任务 3 次 / content script 未就绪自动补注入 / 冷启动合成观察（主页等场景不硬失败，模型自行 new_tab）/ target=_blank 新标签页 adopt。

### 3.8 Docker（精简版）

Chrome(headful) + Xvfb + Playwright persistent context（`--load-extension`）。驱动脚本：开 options 页用 evaluate 把 `MOONSHOT_API_KEY` 环境变量写入 chrome.storage → 打开 sidepanel 页面注入示例任务 → 事件流经 console 转发 stdout → done/fail 定退出码。

### 3.9 状态飘窗：桌宠模式 + 页内模式（2026-09-05 两版迭代）

侧边栏是窗口级 UI，Agent 跨窗口操作时用户看不到进度。两版方案并存：

**桌宠模式（默认，当前主方案）**：`chrome.windows.create(type:'popup')` 加载扩展页
`bubble/bubble.html` 的独立小窗——窄长条、OS 原生可拖动、`focused:false` 不抢焦点。
独立于页面，天然跨窗口、覆盖浏览器主页等不可注入页面，也不进页面截图（look 无需防污染）。
background/bubble.js 管理窗口生命周期；桌宠经 port('bubble') 接收状态推送，断连自动重连，
重连即重推当前状态。生命周期：`petMode=run`（默认）任务运行时才出现、结束 5 秒后自动关窗；
`always` 常驻（空闲显示"空闲"）；`off` 关闭。点击桌宠唤出侧边栏（定位到 Agent 操作窗口）。

**页内模式（旧方案保留，默认关，`bubbleEnabled` 开关）**：closed shadow DOM 气泡注入
Agent 操作的页面（不可注入页面无法显示是其固有局限）；与侧边栏互斥（port 连接数）；
look 截图前临时隐藏。

共用：状态流同为 `updateBubble(tabId, text, phase)` / `finishBubble`（agent-loop 调用点不变）；
文案=当轮 thought，图标随 phase；唤出侧边栏优先 `chrome.sidePanel.open`（需用户手势透传，
探针验证中），失败回退 `chrome.windows.create` popup 打开 sidepanel.html。
后续 logo 美化：替换图片 + manifest 登记 web_accessible_resources（shadow/扩展页引用扩展资源须登记）。

## 4. 目录结构

```
browser-agent-pro/
├── PLAN.md / CLAUDE.md / WORKFLOW.md
├── manifest.json             # MV3, background.type="module"
├── background/
│   ├── service-worker.js     # 入口：port 管理、消息路由
│   ├── log.js                # 日志级别/脱敏/事件总线/导出（移植）
│   ├── llm.js                # Kimi 客户端、temperature=1、token 统计
│   ├── conversation.js       # M2 对话存储/压缩/持久化
│   ├── agent-loop.js         # M2 统一对话决策循环
│   ├── context.js            # M2 上下文组装
│   ├── actions.js            # M2 动作分发/标签页管理
│   ├── vision.js             # M1 look 管线（移植）
│   ├── bubble.js             # 状态飘窗：桌宠窗口管理 + 页内气泡（默认关）
│   └── sites.js              # M2/M3 知识包加载/匹配
├── content/
│   └── content.js            # 单文件（MV3 content script 不支持 ES module import）：
│                             #   DOM 提取 + 动作执行 + read + 高亮（M1）
├── sidepanel/                # 对话流 UI + 时间线 + 调试面板（开发者模式开关）
├── bubble/                   # 桌宠小窗页面（html/css/js）
├── options/                  # 设置页：API URL/模型/key/开发者模式/桌宠模式/页内飘窗
├── sites/bilibili.json       # M3 B站知识包
└── docker/                   # M5 Dockerfile + 驱动脚本
```

## 5. 里程碑与验收标准（一天重排版）

### M0 骨架与调试基建（今天下午，移植为主）
- [x] manifest + options（key/模型/API URL/开发者模式开关）
- [x] background：log.js（脱敏/事件总线/导出）+ llm.js（连接测试、token 统计）+ service-worker.js（port/消息路由）
- [x] sidepanel 骨架：对话区占位 + 状态栏 + 调试面板（连接测试/日志导出/token 显示），开发者模式控制显隐
- **验收**（待用户浏览器冒烟）：加载扩展→存 key→连接测试显示 Kimi 回复（验证 temperature=1）；导出日志全文无明文 key；开关切换调试面板显隐

### M1 感知与执行层（今天下午，移植为主，不接 LLM 对话）
- [x] content.js：DOM 提取 + 全部页面动作 + read（分段+上限）+ 操作高亮描边 + look 准备
- [x] background：动作分发、look 管线（vision.js）、补注入重试
- [x] 调试面板单测区：提取/点击/输入/goto/read/look 按钮
- **验收**（待用户浏览器冒烟）：B 站首页/视频页逐动作单测通过；input_text 写入受控搜索框；read 读视频简介/评论区分段正确（≤3000字/段，offset 衔接）；点击可见高亮

### M2 对话循环核心（今晚 + 明早，**核心里程碑必须完整**）
- [x] conversation.js：对话存储、规则压缩、storage.session 持久化、SW 重启恢复
- [x] agent-loop.js：统一循环（reply/ask_user/plan + 全部浏览器动作）、RunState checkpoint、挂起/唤醒续跑
- [x] context.js：上下文组装（digest+近N轮+知识包+memory+历史+笔记+快照+观察）
- [x] sites.js：知识包加载与按域注入（bilibili.json 已随 M3 提前填入）
- [x] 侧边栏对话流 UI（基础版）：消息渲染、ask_user 内联作答、运行中停止按钮
- **验收**（待用户浏览器冒烟）：多轮对话完成"在B站搜索影视飓风，打开UP主为影视飓风的最新视频"无干预；模糊指令触发追问且回答后继续；强制终止 SW 后发消息无损恢复；plan 直接执行可被叫停

### M3 认知任务 + B站知识包（明早，精简）
- [x] sites/bilibili.json（搜索直链/UP空间规律/评论区结构）——提前完成
- [x] read shadow DOM 穿透（bili-comments 评论区 web component）+ selector 目标形式
- **验收**（待浏览器实测）："总结评论区舆论氛围"任务产出结论先行、要点带来源的 markdown 报告

### M4 演示 UI（穿插进行，精简）
- [x] 深色现代主题、步骤进度（绿✓/红✗/进行中呼吸动画）、状态栏（步数/token）、报告卡片（极简 markdown 渲染）、操作元素高亮描边
- [ ] （延期）thought 流式渲染

### M5 Docker 交付（明天中午前，精简）
- [x] docker/Dockerfile + 驱动脚本（env 注入 key、stdout 日志、退出码）
- [x] README：安装、配置、Docker 运行
- **验收**（待 docker 环境实测）：`docker build && docker run -e MOONSHOT_API_KEY=...` 复现示例任务成功日志

## 6. 砍功能清单（明确不做）

Planner/Executor 双 Agent / 多会话管理 / 执行中插话改向（仅停止按钮）/ noVNC / WebArena adapter（HAR、bridge 不移植）/ 登录验证码弹窗处理 / 多模型路由 / RAG 记忆 / 移动端 / 英文界面 / 任务回放录屏导出。

## 7. 延期清单（一天周期内来不及则移交）

- [ ] LLM 对话摘要压缩（M2 用规则压缩替代）
- [ ] 去包对照实验（验证通用引擎不依赖知识包）
- [ ] thought 流式渲染（决策调用 stream + 增量提取 thought）
- [ ] 完整演示录屏
- [ ] "乒乓球比赛信息"等更多认知示例任务回归
- [x] ~~ask_user 等待期间 SW 死亡的回答恢复~~（2026-09-05 看门狗加固时已修：checkpoint 存有 askId，恢复后重挂等待）

## 8. 已知坑（练习版实测，施工时注意）

1. B站搜索框 React 受控：input 需 native setter + `dispatchEvent(new Event('input', {bubbles:true}))`
2. 合成键盘事件 isTrusted=false 被忽略 → 搜索用 goto 直链
3. MV3 SW 休眠：状态存 chrome.storage.session + port 长连接保活
4. B站链接多 target=_blank：动作后 adopt 新激活标签页
5. CSP connect-src 需含 data:（或像练习版用 dataUrlToBlob 绕开 fetch(dataURL)）
6. 启动不硬检查"当前页面可操作"：合成观察，判断权归模型
7. 截图裁剪坐标 ×devicePixelRatio；SW 内裁剪用 OffscreenCanvas + 分块 btoa
8. div+React onClick 元素：cursor:pointer 收敛到最外层；无文本用 class 兜底
9. `captureVisibleTab` 必须 `<all_urls>` host 权限；频率配额 ≈2 次/秒
10. content script 不支持 ES module 静态 import → 单文件组织
11. SW 休眠回收会清空内存事件缓冲 → 缓冲镜像到 storage.session（防抖写入、超长字段截断），重启恢复；goto 用 background `chrome.tabs.update` 实现，不依赖 content script（主页等不可注入页面也能跳转）
12. 模型会自主 switch_tab 复用其他窗口已打开的标签页（设计能力 + 模型决策）→ prompt 规则 9 要求主动说明操作页面
13. **goto 直链策略不可泛化**（Google Scholar 实测 2026-09-05）：构造查询 URL 先撞登录墙再触发反爬，改用 API 又限流 → 通用策略=模拟真实用户（输入+点按钮），直链只进站点知识包（WORKFLOW §5）；非浏览器手段须 ask_user 请示
14. DOM 提取需穿透 open shadow root（B站 bili-comments 等 web component 内链接不穿透会漏抓）；`document.contains` 对 shadow 元素不可靠，存活检查用 `isConnected`；iframe 不穿透（坐标系/跨域）
15. 侧边栏 `hidden` 属性会被自定义 `display:flex` 覆盖 → 需显式 `#debugPanel[hidden]{display:none}`
