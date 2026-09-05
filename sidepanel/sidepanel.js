// sidepanel/sidepanel.js — 对话流 UI + 执行进度 + 调试面板
// 状态权威在 background（conversation/runState 存 storage.session）：
// 连接时 GET_STATE 全量渲染，之后经 port 事件增量更新。

const chatEl = document.getElementById('chat');
const runStateEl = document.getElementById('runState');
const stepCountEl = document.getElementById('stepCount');
const tokenStatsEl = document.getElementById('tokenStats');
const debugPanel = document.getElementById('debugPanel');
const debugLogEl = document.getElementById('debugLog');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const stopBtn = document.getElementById('stopBtn');

let port = null;
let running = false;
let progressEl = null;      // 当前回合的执行进度容器
let currentRoundEl = null;  // 当前轮的容器（thought/action/result 挂进去）

// ---------- 极简 markdown 渲染（先转义 HTML，报告卡片够用） ----------

function renderMarkdown(text) {
  const esc = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const lines = esc.split('\n');
  let html = '';
  let inList = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^#{1,4}\s/.test(t)) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<div class="md-h">${inlineMd(t.replace(/^#{1,4}\s*/, ''))}</div>`;
    } else if (/^[-*]\s+/.test(t)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inlineMd(t.replace(/^[-*]\s+/, ''))}</li>`;
    } else if (/^\d+\.\s+/.test(t)) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<div class="md-num">${inlineMd(t)}</div>`;
    } else if (t === '') {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<div class="md-gap"></div>';
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<div>${inlineMd(t)}</div>`;
    }
  }
  if (inList) html += '</ul>';
  return html;
}

function inlineMd(text) {
  return text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
}

// ---------- DOM 工具 ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function appendBubble(role, text, status) {
  const msg = el('div', `msg ${role}`);
  const bubble = el('div', 'bubble');
  if (role === 'agent') {
    bubble.innerHTML = renderMarkdown(text);
    if (status === 'done') bubble.classList.add('report');
  } else {
    bubble.textContent = text;
  }
  msg.appendChild(bubble);
  chatEl.appendChild(msg);
  scrollToBottom();
}

function appendProgressLine(node) {
  (currentRoundEl || progressEl || chatEl).appendChild(node);
  scrollToBottom();
}

// ---------- 状态栏 / 输入区 ----------

function setRunning(isRunning, label) {
  running = isRunning;
  runStateEl.textContent = label || (isRunning ? '执行中…' : '空闲');
  runStateEl.className = isRunning ? 'running' : '';
  userInput.disabled = isRunning;
  sendBtn.disabled = isRunning;
  stopBtn.hidden = !isRunning;
  if (!isRunning) userInput.focus();
}

function setStep(n) {
  stepCountEl.textContent = `步数 ${n}`;
}

// ---------- ask_user 内联作答 ----------

function renderAskBox(askId, question) {
  const box = el('div', 'ask-box');
  box.dataset.askId = askId;
  box.appendChild(el('div', 'q', `🤖 ${question}`));
  const row = el('div', 'ask-row');
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '输入回答，回车或点提交';
  const btn = el('button', '', '提交');
  const submit = () => {
    const answer = input.value.trim();
    if (!answer) return;
    postToBackground({ type: 'ASK_ANSWER', askId, answer });
    input.disabled = true;
    btn.disabled = true;
    box.classList.add('answered');
  };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  row.appendChild(input);
  row.appendChild(btn);
  box.appendChild(row);
  chatEl.appendChild(box);
  scrollToBottom();
  input.focus();
}

// ---------- 事件渲染 ----------

function renderEvent(event) {
  switch (event.kind) {
    case 'user_message':
      appendBubble('user', event.text);
      break;
    case 'agent_message':
      appendBubble('agent', event.text, event.status);
      break;
    case 'notice':
      chatEl.appendChild(el('div', 'notice', event.text));
      scrollToBottom();
      break;
    case 'conversation_cleared':
      chatEl.innerHTML = '';
      progressEl = null;
      currentRoundEl = null;
      setRunning(false);
      setStep(0);
      break;
    case 'run_start':
      setRunning(true);
      setStep(0);
      progressEl = el('div', 'progress');
      currentRoundEl = null;
      chatEl.appendChild(progressEl);
      break;
    case 'round': {
      setStep(event.step);
      const round = el('div', 'round');
      round.appendChild(el('div', 'round-head', `第 ${event.step} 轮`));
      currentRoundEl = el('div', 'round-body');
      round.appendChild(currentRoundEl);
      (progressEl || chatEl).appendChild(round);
      scrollToBottom();
      break;
    }
    case 'thought':
      appendProgressLine(el('div', 'thought', `💭 ${event.text}`));
      break;
    case 'action':
      appendProgressLine(el('div', 'action-line', `⚡ ${JSON.stringify(event.action)}`));
      break;
    case 'result':
      appendProgressLine(
        el('div', event.ok ? 'result ok' : 'result err', `${event.ok ? '✓' : '✗'} ${event.text}`)
      );
      break;
    case 'vision': {
      const box = el('div', 'vision-note');
      const img = document.createElement('img');
      img.src = event.screenshot;
      img.alt = 'look 截图';
      box.appendChild(img);
      box.appendChild(el('div', 'a', `👁 ${event.answer}`));
      appendProgressLine(box);
      break;
    }
    case 'ask':
      renderAskBox(event.askId, event.question);
      runStateEl.textContent = '等待你的回答…';
      break;
    case 'run_end': {
      const label =
        event.status === 'done' ? '已完成' :
        event.status === 'stopped' ? '已停止' :
        event.status === 'failed' ? '未完成' : '出错';
      setRunning(false, label);
      runStateEl.className =
        event.status === 'done' ? 'done' : event.status === 'stopped' ? '' : 'failed';
      progressEl = null;
      currentRoundEl = null;
      break;
    }
    case 'stats':
      renderTokenStats(event.stats);
      break;
    case 'model_response':
      debugLine(`← 模型[${event.purpose}] ${event.durationMs}ms tok ${event.usage?.total_tokens ?? '?'}`);
      break;
    case 'model_error':
      debugLine(`× 模型错误[${event.purpose}] ${event.error}`);
      break;
    case 'work_log':
      if (event.level === 'error' || event.level === 'warn') {
        debugLine(`[${event.level.toUpperCase()}] ${event.scope}: ${event.message}`);
      }
      break;
    case 'probe_result':
      debugLine('🧪 探针结果: ' + event.text);
      break;
  }
}

function renderTokenStats(stats) {
  if (!stats) return;
  tokenStatsEl.textContent = `tok ${stats.prompt}/${stats.completion}/${stats.total}`;
  tokenStatsEl.title = `累计 token（输入 ${stats.prompt} / 输出 ${stats.completion} / 总计 ${stats.total}），调用 ${stats.calls} 次`;
}

async function refreshTokenStats() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_TOKEN_STATS' });
  if (resp?.ok) renderTokenStats(resp.stats);
}

// ---------- 连接与状态恢复 ----------

function connect() {
  if (port) return;
  port = chrome.runtime.connect({ name: 'sidepanel' });
  port.onMessage.addListener(renderEvent);
  port.onDisconnect.addListener(() => {
    port = null;
    if (running) runStateEl.textContent = '连接中断，重连中…（任务在后台继续）';
    setTimeout(connect, 500); // SW 重启导致断连时自动重连
  });
}

// GET_STATE 全量渲染（连接时调用；事件回放只作增量）
async function restoreState() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  if (!resp?.ok) return;
  const { messages, running: isRunning, run } = resp.state;
  chatEl.innerHTML = '';
  for (const m of messages) {
    appendBubble(m.role, m.text, m.role === 'agent' ? 'done' : undefined);
  }
  if (isRunning) {
    setRunning(true, run?.status === 'awaiting_user' ? '等待你的回答…' : '执行中…');
    setStep(run?.step || 0);
    if (run?.pendingAsk) renderAskBox(run.pendingAsk.askId, run.pendingAsk.question);
  } else {
    setRunning(false);
  }
}

// ---------- port 发送（SW 休眠导致 port 断开时重连重发一次） ----------

function postToBackground(msg) {
  connect();
  try {
    port.postMessage(msg);
  } catch {
    port = null;
    connect();
    port.postMessage(msg);
  }
}

// ---------- 输入区 ----------

function sendUserMessage() {
  const text = userInput.value.trim();
  if (!text || running) return;
  postToBackground({ type: 'USER_MESSAGE', text });
  userInput.value = '';
}

sendBtn.addEventListener('click', sendUserMessage);
userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendUserMessage();
  }
});
stopBtn.addEventListener('click', () => {
  postToBackground({ type: 'STOP' });
  runStateEl.textContent = '正在停止…';
});
document.getElementById('newConvBtn').addEventListener('click', () => {
  // 先本地立即清屏给反馈，再通知 background 清存储
  chatEl.innerHTML = '';
  progressEl = null;
  currentRoundEl = null;
  setRunning(false);
  setStep(0);
  chatEl.appendChild(el('div', 'notice', '已开始新对话'));
  postToBackground({ type: 'NEW_CONVERSATION' });
});

// ---------- 调试面板 ----------

function debugLine(text) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  debugLogEl.textContent += `\n${time} ${text}`;
  debugLogEl.scrollTop = debugLogEl.scrollHeight;
}

async function applyDevMode() {
  const { devMode } = await chrome.storage.local.get('devMode');
  debugPanel.hidden = !devMode;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.devMode) applyDevMode();
});

document.getElementById('testConnBtn').addEventListener('click', async () => {
  debugLine('→ 连接测试：调用模型 API…');
  const resp = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' });
  if (chrome.runtime.lastError) {
    debugLine('✗ 消息发送失败: ' + chrome.runtime.lastError.message);
    return;
  }
  debugLine(resp?.ok ? '✓ 模型回复: ' + resp.reply : '✗ 失败: ' + (resp?.error || '未知错误'));
  refreshTokenStats();
});

document.getElementById('exportLogBtn').addEventListener('click', async () => {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'EXPORT_LOGS' });
    if (!resp?.ok) throw new Error(resp?.error || '未能获取日志');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const blob = new Blob([JSON.stringify(resp.logExport, null, 2) + '\n'], {
      type: 'application/json;charset=utf-8',
    });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = `browser-agent-pro-log-${timestamp}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    debugLine('✓ 日志已导出（已脱敏）');
  } catch (err) {
    debugLine('✗ 日志导出失败: ' + err.message);
  }
});

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ---------- M1 单测区 ----------

async function sendDebug(msg) {
  const resp = await chrome.runtime.sendMessage(msg);
  if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
  if (!resp?.ok) throw new Error(resp?.error || '未知错误');
  return resp;
}

function getElId(inputId) {
  const id = parseInt(document.getElementById(inputId).value, 10);
  if (!id || id < 1) throw new Error('请输入有效元素编号（先「提取元素」）');
  return id;
}

document.getElementById('utExtract').addEventListener('click', async () => {
  try {
    debugLine('→ 提取元素清单…');
    const { observation: o } = await sendDebug({ type: 'DEBUG_EXTRACT' });
    debugLine(`✓ ${o.count} 个元素\nURL: ${o.url}\n标题: ${o.title}\n滚动: ${o.scrollY}px\n${o.text}`);
  } catch (err) {
    debugLine('✗ ' + err.message);
  }
});

document.getElementById('utClick').addEventListener('click', async () => {
  try {
    const id = getElId('utElId');
    const { result } = await sendDebug({ type: 'DEBUG_ACTION', action: { type: 'click', id } });
    debugLine('✓ ' + result);
  } catch (err) {
    debugLine('✗ ' + err.message);
  }
});

document.getElementById('utInput').addEventListener('click', async () => {
  try {
    const id = getElId('utElId');
    const text = document.getElementById('utInputText').value;
    if (!text) throw new Error('请输入文本');
    const { result } = await sendDebug({ type: 'DEBUG_ACTION', action: { type: 'input_text', id, text } });
    debugLine('✓ ' + result);
  } catch (err) {
    debugLine('✗ ' + err.message);
  }
});

document.getElementById('utGoto').addEventListener('click', async () => {
  try {
    const url = document.getElementById('utGotoUrl').value.trim();
    if (!url) throw new Error('请输入 URL');
    const { result } = await sendDebug({ type: 'DEBUG_ACTION', action: { type: 'goto', url } });
    debugLine('✓ ' + result);
  } catch (err) {
    debugLine('✗ ' + err.message);
  }
});

document.getElementById('utScrollDown').addEventListener('click', async () => {
  try {
    const { result } = await sendDebug({ type: 'DEBUG_ACTION', action: { type: 'scroll', direction: 'down' } });
    debugLine('✓ ' + result);
  } catch (err) {
    debugLine('✗ ' + err.message);
  }
});

document.getElementById('utRead').addEventListener('click', async () => {
  try {
    const rawId = document.getElementById('utReadId').value.trim() || 'main';
    const id = rawId === 'main' ? 'main' : parseInt(rawId, 10);
    const offset = parseInt(document.getElementById('utReadOffset').value, 10) || 0;
    debugLine(`→ read ${rawId} offset=${offset}`);
    const { result } = await sendDebug({ type: 'DEBUG_READ', id, offset });
    debugLine(
      `✓ 全文 ${result.totalChars} 字，本段 [${result.offset}, ${result.offset + result.text.length})` +
      `${result.hasMore ? '，还有剩余' : '，已读完'}${result.note ? '（' + result.note + '）' : ''}\n` +
      result.text.slice(0, 1500) + (result.text.length > 1500 ? '\n…（预览截断）' : '')
    );
  } catch (err) {
    debugLine('✗ ' + err.message);
  }
});

document.getElementById('utLook').addEventListener('click', async () => {  try {
    const rawTarget = document.getElementById('utLookTarget').value.trim() || 'viewport';
    const question = document.getElementById('utLookQuestion').value.trim() || '这个区域是什么？';
    const target = rawTarget === 'viewport' ? 'viewport' : parseInt(rawTarget, 10);
    debugLine(`→ look ${rawTarget}："${question}"`);
    const resp = await sendDebug({ type: 'DEBUG_LOOK', target, question });
    const resultEl = document.getElementById('utLookResult');
    document.getElementById('utLookShot').src = resp.screenshot;
    document.getElementById('utLookReply').textContent =
      `${resp.answer}\n（截图约 ${resp.base64KB} KB，token: ${JSON.stringify(resp.usage)}）`;
    resultEl.hidden = false;
    debugLine('✓ look 完成');
    refreshTokenStats();
  } catch (err) {
    debugLine('✗ ' + err.message);
  }
});

document.getElementById('utProbe').addEventListener('click', async () => {
  try {
    await sendDebug({ type: 'DEBUG_PROBE_INJECT' });
    debugLine('✓ 探针按钮已注入当前页面右上角（30 秒有效），请点击它，结果会显示在这里');
  } catch (err) {
    debugLine('✗ ' + err.message);
  }
});

connect();
restoreState();
applyDevMode();
refreshTokenStats();