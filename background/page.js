// background/page.js — 标签页交互助手（移植自练习版，已验证）
// 选择任务标签页 / content script 补注入与重试 / 页面观察 / 等待页面稳定 / 新标签页接管

import { logWork } from './log.js';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PAGE_SETTLE_MAX_MS = 8000; // 单步动作后等页面稳定的上限

export async function getActiveWebTab(preferredTabId = null) {
  if (preferredTabId !== null) {
    const preferred = await chrome.tabs.get(preferredTabId);
    if (preferred?.url && /^https?:/.test(preferred.url)) return preferred;
    logWork('warn', 'tab.select', '指定标签页不可操作，回退到当前活动标签页', {
      preferredTabId,
      url: preferred?.url,
    });
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('找不到活动标签页');
  if (!tab.url || !/^https?:/.test(tab.url)) {
    // 浏览器主页/扩展页等：不硬失败，由合成观察引导模型 new_tab（PLAN.md 已知坑 6）。
    // 这是符合预期的冷启动路径，用 info 而非 warn——符合功能逻辑的不报错。
    logWork('info', 'tab.select', '活动标签页不是 http/https 页面，进入冷启动流程（模型将自行打开目标站点）', {
      tabId: tab.id,
      url: tab.url,
    });
  }
  return tab;
}

function hasNoContentScriptReceiver(err) {
  return err?.message?.includes('Could not establish connection. Receiving end does not exist.');
}

async function injectContentScript(tabId, messageType) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    throw new Error('目标标签页不是可注入 content script 的 http/https 页面');
  }
  logWork('info', 'content.inject', 'content script 未就绪，开始补注入', { tabId, messageType });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/content.js'],
    injectImmediately: true,
  });
}

// 页面跳转、扩展重载后，已打开标签页可能尚未有 content script。
// 首次发现接收端不存在时主动补注入；其余临时错误仍按原策略重试。
export async function sendToTabWithRetry(tabId, msg, retries = 10, intervalMs = 500) {
  let lastErr;
  let injectionAttempted = false;
  for (let i = 0; i < retries; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (err) {
      lastErr = err;
      logWork(i + 1 === retries ? 'error' : 'warn', 'content.message', 'content script 通信失败', {
        tabId,
        messageType: msg.type,
        attempt: i + 1,
        error: err.message,
      });
      if (hasNoContentScriptReceiver(err) && !injectionAttempted) {
        injectionAttempted = true;
        try {
          await injectContentScript(tabId, msg.type);
          continue;
        } catch (injectionErr) {
          throw new Error('content script 无法注入: ' + injectionErr.message);
        }
      }
      await sleep(intervalMs);
    }
  }
  throw new Error('content script 无响应: ' + (lastErr ? lastErr.message : '未知'));
}

export async function observe(tabId) {
  const resp = await sendToTabWithRetry(tabId, { type: 'AGENT_EXTRACT' });
  if (!resp.ok) throw new Error(resp.error);
  return resp.observation;
}

// 起始页可能是浏览器主页/扩展页等不可注入 content script 的页面：
// 不硬失败，给模型一轮合成观察，引导它用 new_tab/switch_tab 迁到可操作页面。
// 同样是预期路径，info 级别即可。
async function observeOrExplain(tab) {
  const fresh = await chrome.tabs.get(tab.id);
  if (fresh?.url && /^https?:/.test(fresh.url)) return observe(fresh.id);
  logWork('info', 'observation', '当前标签页不可提取 DOM，返回合成观察（冷启动）', {
    tabId: tab.id,
    url: fresh?.url,
  });
  return {
    url: fresh?.url || '',
    title: fresh?.title || '',
    scrollY: 0,
    count: 0,
    pageText: '',
    text: '当前页面无法提取 DOM（浏览器内部页面）。如需操作网页，请先用 new_tab 打开目标站点',
  };
}

// 动作执行后等页面稳定：tab 状态转 complete 再留一点 React 渲染时间
export async function waitPageSettled(tabId) {
  const deadline = Date.now() + PAGE_SETTLE_MAX_MS;
  await sleep(500); // 给跳转一点触发时间
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') {
      await sleep(500);
      return;
    }
    await sleep(300);
  }
  logWork('warn', 'page.wait', '等待页面稳定超时，将继续执行', { tabId });
}

// 点击 target=_blank 后跟随当前激活的新标签页（PLAN.md 已知坑 4）。
export async function adoptActiveWebTab(tab) {
  const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  const selected = active?.url && /^https?:/.test(active.url) ? active : tab;
  if (selected.id !== tab.id) {
    logWork('info', 'tab.adopt', '检测到新活动标签页，后续任务切换到该标签页', {
      previousTabId: tab.id,
      selectedTabId: selected.id,
      url: selected.url,
    });
  }
  return selected;
}

export async function collectTabSnapshot() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({
    tabId: t.id,
    title: (t.title || '').slice(0, 40),
    url: t.url || '',
    active: Boolean(t.active),
  }));
}

export { observeOrExplain };
