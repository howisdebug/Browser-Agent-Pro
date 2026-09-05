// background/bubble.js — 状态飘窗（PLAN.md §3.9）
// 双通道：
//   1. 桌宠窗口（默认，petMode='run'）：chrome.windows.create popup 扩展小窗，
//      窄长条、OS 原生可拖动、不抢焦点；独立于页面，天然跨窗口、覆盖不可注入页面
//   2. 页内飘窗（旧方案保留，默认关，bubbleEnabled 开关）：closed shadow DOM 注入页面
// 调用方接口不变：updateBubble / finishBubble（agent-loop 每轮决策后调用）。
// 桌宠是独立窗口，不进页面截图，look 无需防污染；页内飘窗仍需截图前隐藏。

const PHASE_ICON = {
  running: '⚡',
  waiting: '⏸',
  done: '✅',
  failed: '❌',
  stopped: '⏹',
  idle: '🤖',
};
const TEXT_MAX = 60;

let pageBubbleEnabled = false; // 页内飘窗，默认关
let petMode = 'run';           // off | run（任务运行时才出现）| always（常驻）
let panelOpenCount = 0;        // 页内飘窗与侧边栏互斥用（桌宠不互斥）
let state = null;              // { tabId, text, phase }
let autoHideTimer = null;

// ---------- 设置 ----------

export async function initBubble() {
  const stored = await chrome.storage.local.get(['bubbleEnabled', 'petMode']);
  pageBubbleEnabled = stored.bubbleEnabled === true; // 默认关
  petMode = stored.petMode || 'run';
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.bubbleEnabled !== undefined) {
      pageBubbleEnabled = changes.bubbleEnabled.newValue === true;
      applyPageBubble();
    }
    if (changes.petMode !== undefined) {
      petMode = changes.petMode.newValue || 'run';
      syncPetLifecycle();
    }
  });
  if (petMode === 'always') ensurePetWindow();
}

// ---------- 页内飘窗（旧方案，默认关；与侧边栏互斥） ----------

export function setPanelOpen(open) {
  panelOpenCount = Math.max(0, panelOpenCount + (open ? 1 : -1));
  applyPageBubble();
}

function pageBubblePayload() {
  if (!state) return { type: 'BUBBLE_SYNC', show: false };
  return {
    type: 'BUBBLE_SYNC',
    show: pageBubbleEnabled && panelOpenCount === 0,
    text: state.text,
    icon: PHASE_ICON[state.phase] || '⚡',
    phase: state.phase,
  };
}

async function applyPageBubble() {
  if (!state?.tabId) return;
  try {
    await chrome.tabs.sendMessage(state.tabId, pageBubblePayload());
  } catch {
    // 页面无接收端（导航中/不可注入页面）：静默，下一轮同步重建
  }
}

// look 截图前临时隐藏页内飘窗（桌宠是独立窗口，不进截图，无需处理）
export async function withBubbleHidden(tabId, fn) {
  if (pageBubbleEnabled) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'BUBBLE_SYNC', show: false });
    } catch {}
  }
  try {
    return await fn();
  } finally {
    applyPageBubble();
  }
}

// ---------- 桌宠窗口 ----------

let petWindowId = null;
let petPort = null;
let petCreating = null; // 防并发创建

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === petWindowId) {
    petWindowId = null;
    petPort = null;
  }
});

export function registerPetPort(port) {
  petPort = port;
  pushPetState(); // 重连后立刻重推当前状态
  port.onDisconnect.addListener(() => {
    if (petPort === port) petPort = null;
  });
}

async function ensurePetWindow() {
  if (petWindowId !== null) {
    try {
      await chrome.windows.get(petWindowId);
      return;
    } catch {
      petWindowId = null;
    }
  }
  if (petCreating) return petCreating;
  petCreating = chrome.windows
    .create({
      url: chrome.runtime.getURL('bubble/bubble.html'),
      type: 'popup',
      width: 320,
      height: 48,
      focused: false, // 不抢焦点
    })
    .then((win) => {
      petWindowId = win.id;
    })
    .finally(() => {
      petCreating = null;
    });
  return petCreating;
}

async function closePetWindow() {
  if (petWindowId === null) return;
  const id = petWindowId;
  petWindowId = null;
  petPort = null;
  try {
    await chrome.windows.remove(id);
  } catch {
    // 已被用户关闭
  }
}

function petPayload() {
  if (!state) return { text: '空闲', phase: 'idle', icon: PHASE_ICON.idle };
  return {
    text: state.text,
    phase: state.phase,
    icon: PHASE_ICON[state.phase] || '⚡',
  };
}

function pushPetState() {
  try {
    petPort?.postMessage(petPayload());
  } catch {
    // port 刚断开，下次重连会重推
  }
}

// 按 petMode 决定桌宠是否该存在
function syncPetLifecycle() {
  const shouldExist = petMode === 'always' || (petMode === 'run' && state !== null);
  if (shouldExist) {
    ensurePetWindow().then(pushPetState);
  } else {
    closePetWindow();
  }
}

// ---------- 对外接口（agent-loop 调用） ----------

export function updateBubble(tabId, text, phase = 'running') {
  const oldTabId = state && state.tabId !== tabId ? state.tabId : null;
  if (autoHideTimer) {
    clearTimeout(autoHideTimer);
    autoHideTimer = null;
  }
  state = { tabId, text: String(text || '').slice(0, TEXT_MAX), phase };
  // 页内飘窗：跨 tab 时旧 tab 隐藏
  if (oldTabId && pageBubbleEnabled) {
    chrome.tabs.sendMessage(oldTabId, { type: 'BUBBLE_SYNC', show: false }).catch(() => {});
  }
  applyPageBubble();
  syncPetLifecycle();
  pushPetState();
}

// 任务结束：显示终态，5 秒后页内飘窗消失；petMode='run' 时桌宠关窗
export function finishBubble(tabId, phase) {
  if (!tabId) return;
  const label = { done: '完成', failed: '未完成', stopped: '已停止' }[phase] || '结束';
  updateBubble(tabId, label, phase);
  autoHideTimer = setTimeout(() => {
    autoHideTimer = null;
    const tabIdToHide = state?.tabId;
    state = null;
    if (tabIdToHide && pageBubbleEnabled) {
      chrome.tabs
        .sendMessage(tabIdToHide, { type: 'BUBBLE_SYNC', show: false })
        .catch(() => {});
    }
    syncPetLifecycle(); // 'run' 模式下关窗；'always' 模式转为显示"空闲"
    pushPetState();
  }, 5000);
}

// 桌宠点击：提供 Agent 操作窗口的 windowId（供唤出侧边栏定位）
export function getBubbleTabId() {
  return state?.tabId ?? null;
}
