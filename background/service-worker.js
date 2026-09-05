// background/service-worker.js — MV3 service worker 入口
// M0 职责：port 长连接管理（事件广播/重连回放）、消息路由（连接测试/日志导出/token 统计）
// M1 起挂动作分发；M2 起挂对话循环（agent-loop.js）。

import {
  initLogLevel,
  addEventListener,
  emitEvent,
  getEventLog,
  clearEventLog,
  buildLogExport,
  logWork,
} from './log.js';
import { callLlm, getTokenStats } from './llm.js';
import { getActiveWebTab, sendToTabWithRetry } from './page.js';
import { performLook } from './vision.js';
import {
  handleUserMessage,
  handleAskAnswer,
  requestStop,
  getState,
  recoverInterruptedRun,
  isRunning,
} from './agent-loop.js';
import { clearConversation, getArchiveList, loadArchivedConversation, deleteArchivedConversation } from './conversation.js';
import { initBubble, setPanelOpen, registerPetPort, getBubbleTabId } from './bubble.js';

initLogLevel().then(() => logWork('info', 'sw', 'service worker 已启动'));
initBubble();
recoverInterruptedRun(); // SW 被杀/休眠重启：有中断的执行则续跑

// 运行期看门狗：agent-loop 在任务运行时创建 30s 周期闹钟。
// 闹钟事件既重置 SW 空闲计时（保活），又能在 SW 已被回收时唤醒它并恢复执行。
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'agent-watchdog') return;
  recoverInterruptedRun();
});

// 点击工具栏图标直接打开 side panel（popup 会在点击页面时关闭，日志会丢）
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('setPanelBehavior 失败:', err));

// ---------- port 长连接（sidepanel 保活 SW + 事件推送） ----------

let currentPort = null;

addEventListener((event) => {
  if (!currentPort) return;
  try {
    currentPort.postMessage(event);
  } catch (err) {
    console.error('事件推送失败:', err);
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'bubble') {
    registerPetPort(port); // 桌宠小窗：注册即重推当前状态
    return;
  }
  if (port.name !== 'sidepanel') return;
  logWork('info', 'sidepanel', 'side panel 端口已连接');
  currentPort = port;
  setPanelOpen(true); // 陪伴模式互斥：侧边栏打开时飘窗隐藏
  // 重连时回放已有事件缓冲
  for (const event of getEventLog()) {
    try {
      port.postMessage(event);
    } catch {
      break;
    }
  }
  port.onDisconnect.addListener(() => {
    if (currentPort === port) currentPort = null;
    setPanelOpen(false); // 侧边栏关闭：飘窗恢复（若任务在跑）
    logWork('warn', 'sidepanel', 'side panel 端口已断开');
  });
  port.onMessage.addListener((msg) => {
    logWork('debug', 'sidepanel', '收到 side panel port 消息', { type: msg?.type });
    if (msg.type === 'USER_MESSAGE' && typeof msg.text === 'string' && msg.text.trim()) {
      handleUserMessage(msg.text.trim());
      return;
    }
    if (msg.type === 'ASK_ANSWER') {
      handleAskAnswer(msg.askId, msg.answer);
      return;
    }
    if (msg.type === 'STOP') {
      requestStop();
      return;
    }
    if (msg.type === 'NEW_CONVERSATION') {
      requestStop();
      clearEventLog(); // 防止重连回放把旧对话事件灌回新对话
      // 旧对话已随 appendMessage 实时归档，这里只需清活跃对话
      clearConversation()
        .then(() => emitEvent({ kind: 'conversation_cleared' }))
        .catch((err) => logWork('error', 'conversation', '清空对话失败', { error: err.message }));
      return;
    }
  });
});

// ---------- 一次性消息 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'EXPORT_LOGS') {
    sendResponse({ ok: true, logExport: buildLogExport() });
    return false;
  }
  if (msg.type === 'GET_TOKEN_STATS') {
    getTokenStats()
      .then((stats) => sendResponse({ ok: true, stats }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // 异步 sendResponse
  }
  if (msg.type === 'GET_STATE') {
    getState()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  // ---------- 历史对话 ----------
  if (msg.type === 'GET_HISTORY') {
    getArchiveList()
      .then((list) => sendResponse({ ok: true, list }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'LOAD_HISTORY') {
    (async () => {
      if (isRunning()) {
        throw new Error('任务执行中，请先停止再载入历史对话');
      }
      await clearEventLog();
      return loadArchivedConversation(msg.id);
    })()
      .then((entry) => sendResponse({ ok: true, title: entry.title }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'DELETE_HISTORY') {
    deleteArchivedConversation(msg.id)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'TEST_CONNECTION') {
    callLlm([{ role: 'user', content: '用一句话介绍你自己' }], { purpose: 'connection_test' })
      .then((reply) => sendResponse({ ok: true, reply }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  // ---------- 飘窗点击：唤出侧边栏（优先 sidePanel.open，失败回退 popup 窗口） ----------
  if (msg.type === 'BUBBLE_CLICK' || msg.type === 'PET_CLICK') {
    (async () => {
      // 页内飘窗：来源 tab 的窗口；桌宠：Agent 当前操作 tab 所在窗口（桌宠自身的
      // 小窗不应作为侧边栏宿主），都取不到则用最近聚焦的普通窗口
      let windowId = null;
      if (msg.type === 'BUBBLE_CLICK') {
        windowId = sender.tab?.windowId ?? null;
      } else {
        const bubbleTabId = getBubbleTabId();
        if (bubbleTabId !== null) {
          try {
            windowId = (await chrome.tabs.get(bubbleTabId)).windowId;
          } catch {
            windowId = null;
          }
        }
      }
      if (windowId == null) {
        const [win] = await chrome.windows.getAll({ windowTypes: ['normal'] });
        windowId = win?.id;
      }
      if (windowId == null) throw new Error('无法确定目标窗口');
      if (typeof chrome.sidePanel?.open === 'function') {
        try {
          await chrome.sidePanel.open({ windowId });
          return { via: 'sidePanel.open' };
        } catch (err) {
          // 手势透传在某些浏览器/版本不可行（探针 PROBE_CLICK 验证），回退 popup 窗口
          logWork('info', 'bubble', 'sidePanel.open 不可用，回退 popup 窗口', { error: err.message });
        }
      }
      await chrome.windows.create({
        url: chrome.runtime.getURL('sidepanel/sidepanel.html'),
        type: 'popup',
        width: 420,
        height: 720,
        focused: true,
      });
      return { via: 'windows.create' };
    })()
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  // ---------- 手势透传探针：结果进调试面板 ----------
  if (msg.type === 'PROBE_CLICK') {
    (async () => {
      const windowId = sender.tab?.windowId;
      let detail;
      if (typeof chrome.sidePanel?.open !== 'function') {
        detail = 'chrome.sidePanel.open 不存在（该浏览器不支持此 API）→ 将使用 popup 窗口回退';
      } else {
        try {
          await chrome.sidePanel.open({ windowId });
          detail = 'sidePanel.open 成功 ✓ content script 点击的手势透传可行，主路径可用';
        } catch (err) {
          detail = `sidePanel.open 失败：${err.message} → 将使用 popup 窗口回退`;
        }
      }
      emitEvent({ kind: 'probe_result', text: detail });
      return detail;
    })()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'DEBUG_PROBE_INJECT') {
    (async () => {
      const tab = await getActiveWebTab();
      const resp = await sendToTabWithRetry(tab.id, { type: 'PROBE_INJECT_BUTTON' });
      if (!resp.ok) throw new Error(resp.error);
    })()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  // ---------- M1 调试面板单测 ----------
  if (msg.type === 'DEBUG_EXTRACT') {
    (async () => {
      const tab = await getActiveWebTab();
      const resp = await sendToTabWithRetry(tab.id, { type: 'AGENT_EXTRACT' });
      if (!resp.ok) throw new Error(resp.error);
      return resp.observation;
    })()
      .then((observation) => sendResponse({ ok: true, observation }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'DEBUG_ACTION') {
    (async () => {
      const tab = await getActiveWebTab();
      const resp = await sendToTabWithRetry(tab.id, { type: 'AGENT_ACTION', action: msg.action });
      if (!resp.ok) throw new Error(resp.error);
      return resp.result;
    })()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'DEBUG_READ') {
    (async () => {
      const tab = await getActiveWebTab();
      const resp = await sendToTabWithRetry(tab.id, {
        type: 'AGENT_READ',
        id: msg.id,
        offset: msg.offset,
        limit: msg.limit,
      });
      if (!resp.ok) throw new Error(resp.error);
      return resp.result;
    })()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'DEBUG_LOOK') {
    (async () => {
      const tab = await getActiveWebTab();
      const target = msg.target === 'viewport' ? 'viewport' : Number(msg.target);
      if (target !== 'viewport' && (!Number.isInteger(target) || target < 1)) {
        throw new Error('target 必须是元素编号或 "viewport"');
      }
      return performLook(tab.id, target, String(msg.question || '这个区域是什么？'));
    })()
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});
