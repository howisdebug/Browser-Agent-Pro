# 演示环境：Chrome(headful) + Xvfb + Playwright，加载扩展自动执行示例任务
# 构建（在仓库根目录）：docker build -f docker/Dockerfile -t browser-agent-pro .
# 运行：docker run --rm -e MOONSHOT_API_KEY=sk-... browser-agent-pro
# 可选：-e DEMO_TASK="你的任务" -e DEMO_TIMEOUT_MS=600000
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

# 扩展文件（MV3 加载解压扩展的目录结构原样拷入 /ext）
COPY manifest.json /ext/manifest.json
COPY background/ /ext/background/
COPY content/ /ext/content/
COPY sidepanel/ /ext/sidepanel/
COPY bubble/ /ext/bubble/
COPY options/ /ext/options/
COPY sites/ /ext/sites/

COPY docker/run-demo.js /app/run-demo.js

# xvfb-run 提供虚拟显示（MV3 扩展要求 headful Chromium）
CMD ["xvfb-run", "-a", "node", "run-demo.js"]
