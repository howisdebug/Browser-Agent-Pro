// docker/run-demo.js — 容器内演示驱动：加载扩展 → 注入 key → 执行示例任务 → stdout 日志
// 用法：MOONSHOT_API_KEY=sk-... [DEMO_TASK="任务"] node run-demo.js
// 退出码：0 = 任务完成；1 = 失败/超时/配置缺失
const { chromium } = require('playwright');

const EXT_PATH = '/ext';
const API_KEY = process.env.MOONSHOT_API_KEY || '';
const TASK =
  process.env.DEMO_TASK || '在B站搜索影视飓风，打开UP主为影视飓风的最新视频';
const MAX_RUN_MS = Number(process.env.DEMO_TIMEOUT_MS || 10 * 60 * 1000);
const SETTLE_IDLE_MS = 30 * 1000; // 对话区无变化超过该时长且处于空闲态即结束

if (!API_KEY) {
  console.error('[demo] 缺少 MOONSHOT_API_KEY 环境变量');
  process.exit(1);
}

(async () => {
  const context = await chromium.launchPersistentContext('', {
    headless: false, // MV3 扩展必须 headful（外层用 xvfb-run 提供虚拟显示）
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  // 取扩展 ID：等 service worker 出现
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(sw.url()).host;
  console.log(`[demo] 扩展已加载: ${extensionId}`);

  // 写入 API key（经设置页上下文直接写 chrome.storage，key 只来自环境变量）
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/options/options.html`);
  await optionsPage.evaluate(async (key) => {
    await chrome.storage.local.set({ apiKey: key, devMode: true });
  }, API_KEY);
  await optionsPage.close();
  console.log('[demo] API key 已注入设置');

  // 打开侧边栏页面（side panel 可作为普通 tab 打开），驱动对话
  const page = await context.newPage();
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('[mirror]')) console.log(text.slice(9));
  });
  await page.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);

  // DOM 变化镜像到 stdout（对话流 + 执行进度）
  await page.evaluate(() => {
    const chat = document.getElementById('chat');
    const fmt = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent;
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const tag = node.className || node.tagName.toLowerCase();
      return `[${tag}] ${node.innerText || ''}`;
    };
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          const text = fmt(node).trim();
          if (text) console.log('[mirror]', text.slice(0, 2000));
        }
      }
    }).observe(chat, { childList: true, subtree: true });
  });

  console.log(`[demo] 任务: ${TASK}`);
  await page.fill('#userInput', TASK);
  await page.click('#sendBtn');

  // 等待结束：状态栏回到终态（已完成/未完成/出错/已停止）
  const startedAt = Date.now();
  let finalState = null;
  while (Date.now() - startedAt < MAX_RUN_MS) {
    await page.waitForTimeout(2000);
    const state = await page.textContent('#runState');
    if (['已完成', '未完成', '出错', '已停止'].includes((state || '').trim())) {
      finalState = state.trim();
      break;
    }
  }

  if (!finalState) {
    console.error('[demo] 超时未结束');
    await context.close();
    process.exit(1);
  }
  console.log(`[demo] 任务结束: ${finalState}`);
  await context.close();
  process.exit(finalState === '已完成' ? 0 : 1);
})().catch((err) => {
  console.error('[demo] 驱动脚本异常:', err);
  process.exit(1);
});
