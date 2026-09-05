// background/agent-loop.js — 统一对话决策循环（M2 核心，PLAN.md §3.1/§3.2）
//
// 用户消息 → 逐轮决策 {thought, memory?, action} → 执行 → 观察 → 再决策，
// 直到 reply/ask_user/fail 把话语权交还用户。plan 输出纲要后直接继续执行。
//
// 状态机：idle → running ⇄ awaiting_user → idle
// RunState 每步 checkpoint 到 chrome.storage.session；SW 休眠/被杀后可恢复：
//   - awaiting_user：侧边栏重连后 GET_STATE 返回 pendingAsk，用户重新作答续跑
//   - running 中断：SW 重启时 recoverInterruptedRun() 从 checkpoint 续跑

import { callLlm } from './llm.js';
import { emitEvent, logWork, registerLogSecrets, clearEventLog } from './log.js';
import {
  getActiveWebTab,
  observeOrExplain,
  waitPageSettled,
  adoptActiveWebTab,
  collectTabSnapshot,
} from './page.js';
import { executeBrowserAction } from './actions.js';
import {
  appendMessage,
  getConversationContext,
  getAllMessages,
} from './conversation.js';
import { buildUserMessage, SYSTEM_PROMPT } from './context.js';
import { loadSitePacks, matchSitePack } from './sites.js';
import { updateBubble, finishBubble } from './bubble.js';

const MAX_STEPS = 25;
const LOOK_MAX_PER_TASK = 3;
const MEMORY_MAX_CHARS = 500;
const HISTORY_DETAIL_MAX = 300; // 动作历史里单条 detail 的截断长度
const LOOP_WARN_AT = 3;   // 同签名动作连续 3 次：注入警告
const LOOP_ABORT_AT = 5;  // 连续 5 次：终止并说明
const RUN_STATE_KEY = 'runState';

let running = false;
let stopRequested = false;
let run = null; // 内存镜像，checkpoint 持久化
let currentAbort = null; // 当前回合的 LLM 请求中断器（不放进 run：不可序列化进 checkpoint）
const pendingAsks = new Map(); // askId → resolve(answer|null)

// ---------- 对外状态 ----------

export function isRunning() {
  return running;
}

export async function getState() {
  return {
    running,
    messages: await getAllMessages(),
    run: run
      ? {
          runId: run.runId,
          step: run.step,
          status: run.status,
          pendingAsk: run.pendingAsk,
        }
      : null,
  };
}

// ---------- 持久化 ----------

async function checkpoint() {
  if (!run) return;
  try {
    await chrome.storage.session.set({ [RUN_STATE_KEY]: run });
  } catch (err) {
    logWork('warn', 'run.checkpoint', 'RunState 持久化失败', { error: err.message });
  }
}

async function clearCheckpoint() {
  try {
    await chrome.storage.session.remove(RUN_STATE_KEY);
  } catch {
    // 忽略
  }
}

// SW 重启恢复：running 中断 → 续跑；awaiting_user → 重新挂起等回答
export async function recoverInterruptedRun() {
  let stored;
  try {
    stored = await chrome.storage.session.get(RUN_STATE_KEY);
  } catch {
    return;
  }
  const saved = stored[RUN_STATE_KEY];
  if (!saved || (saved.status !== 'running' && saved.status !== 'awaiting_user')) return;
  logWork('info', 'run.recover', '检测到中断的执行，开始恢复', {
    runId: saved.runId,
    step: saved.step,
    status: saved.status,
  });
  run = saved;
  run.status = 'running';
  run.pendingAsk = null; // 等待中的提问由侧边栏经 GET_STATE 重渲染，用户重新作答
  running = true;
  stopRequested = false;
  currentAbort = new AbortController();
  emitEvent({ kind: 'notice', text: '检测到上次执行被中断，正在恢复…' });
  runLoop().catch((err) => {
    logWork('error', 'run.recover', '恢复执行失败', { error: err.message });
    finishRun('error', `恢复执行失败: ${err.message}`);
  });
}

// ---------- 停止 ----------

export function requestStop() {
  if (!running) return;
  stopRequested = true;
  currentAbort?.abort(); // 中断在途 LLM 请求，停止不必等当前步走完
  for (const resolve of pendingAsks.values()) resolve(null);
}

// ---------- 入口 ----------

export async function handleUserMessage(text) {
  if (running) {
    emitEvent({ kind: 'notice', text: '正在执行中，请先停止当前任务' });
    return;
  }
  clearEventLog(); // 新回合清空事件缓冲，重连回放不串台
  await appendMessage('user', text);
  emitEvent({ kind: 'user_message', text });
  run = {
    runId: `run-${Date.now()}`,
    status: 'running',
    step: 0,
    history: [],
    memory: '',
    visionNotes: [],
    lookUsed: 0,
    plan: null,
    lastRead: null,
    pendingAsk: null,
    tabId: null,
    repeatSignature: null,
    repeatCount: 0,
  };
  running = true;
  stopRequested = false;
  currentAbort = new AbortController();
  await loadSitePacks();
  await checkpoint();
  try {
    await runLoop();
  } catch (err) {
    logWork('error', 'run', '执行异常终止', { error: err.message });
    await finishRun('error', `执行出错: ${err.message}`);
  }
}

export function handleAskAnswer(askId, answer) {
  const resolve = pendingAsks.get(askId);
  if (resolve) resolve(String(answer ?? ''));
  // 超时/停止后到达的回答静默忽略
}

// ---------- 决策 ----------

// 容错解析：剥 markdown 代码块 / 截取首尾大括号，要求 thought 与 action.type 齐备
function parseReply(text) {
  const candidates = [text.trim()];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const s of candidates) {
    try {
      const obj = JSON.parse(s);
      if (typeof obj.thought === 'string' && obj.action && typeof obj.action.type === 'string') {
        return obj;
      }
    } catch {
      // 尝试下一个候选
    }
  }
  return null;
}

async function decide(userMessage) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await callLlm(messages, {
      purpose: `decision_attempt_${attempt}`,
      signal: currentAbort?.signal,
    });
    messages.push({ role: 'assistant', content: reply });
    const parsed = parseReply(reply);
    if (parsed) return parsed;
    logWork('warn', 'decision', '模型输出无法解析为动作 JSON', { attempt });
    if (attempt === 2) throw new Error('模型连续两次输出非法 JSON');
    messages.push({
      role: 'user',
      content:
        '你的输出不是合法 JSON。请重新输出：只输出一个 JSON 对象，包含 thought 和 action 字段，不要包含任何其他文字。',
    });
  }
  return null; // 不可达
}

// ---------- 回合结束 ----------

async function finishRun(status, agentText) {
  const bubbleTabId = run?.tabId;
  if (agentText) {
    await appendMessage('agent', agentText);
    emitEvent({ kind: 'agent_message', text: agentText, status });
  }
  emitEvent({ kind: 'run_end', status, step: run?.step ?? 0 });
  finishBubble(bubbleTabId, status === 'error' ? 'failed' : status);
  running = false;
  stopRequested = false;
  currentAbort = null;
  if (run) run.status = 'ended';
  await clearCheckpoint();
  run = null;
}

function waitForAskAnswer(askId) {
  // 无超时（对话范式：用户何时回答都继续）；停止时 resolve(null)
  return new Promise((resolve) => {
    pendingAsks.set(askId, (answer) => {
      pendingAsks.delete(askId);
      resolve(answer);
    });
  });
}

// ---------- 主循环 ----------

async function runLoop() {
  let tab = await getActiveWebTab(run.tabId);
  run.tabId = tab.id;
  let tabSnapshot = await collectTabSnapshot();
  let obs = await observeOrExplain(tab);
  emitEvent({ kind: 'run_start', runId: run.runId });
  emitEvent({ kind: 'observe', observation: obs });
  updateBubble(tab.id, '开始执行…', 'running');

  for (let step = run.step; step < MAX_STEPS; step++) {
    run.step = step + 1;
    if (stopRequested) {
      await finishRun('stopped', '好的，已停止执行。有什么需要调整的吗？');
      return;
    }
    emitEvent({ kind: 'round', step: run.step });
    logWork('info', 'run.round', '开始新一轮决策', { step: run.step, url: obs.url });

    // lastRead 只注入一轮
    const lastRead = run.lastRead;
    run.lastRead = null;

    const convCtx = await getConversationContext();
    const userMessage = buildUserMessage({
      digest: convCtx.digest,
      recent: convCtx.recent,
      plan: run.plan,
      memory: run.memory,
      history: run.history,
      visionNotes: run.visionNotes,
      lastRead,
      tabSnapshot,
      obs,
      sitePack: matchSitePack(obs.url),
    });

    let parsed;
    try {
      parsed = await decide(userMessage);
    } catch (err) {
      if (stopRequested) {
        await finishRun('stopped', '好的，已停止执行。有什么需要调整的吗？');
        return;
      }
      await finishRun('error', `模型决策出错：${err.message}。请重试或换个说法。`);
      return;
    }

    emitEvent({ kind: 'thought', text: parsed.thought, step: run.step });
    updateBubble(tab.id, parsed.thought, 'running');
    if (typeof parsed.memory === 'string' && parsed.memory.trim()) {
      run.memory = parsed.memory.slice(0, MEMORY_MAX_CHARS);
    }
    const action = parsed.action;
    if (action.type === 'input_text') registerLogSecrets(action.text);
    emitEvent({ kind: 'action', action, step: run.step });

    // ---------- 话语权动作 ----------
    if (action.type === 'reply') {
      await finishRun('done', String(action.text || '（无内容）'));
      return;
    }
    if (action.type === 'fail') {
      await finishRun('failed', `抱歉，这个任务我没能完成：${action.reason || '未知原因'}`);
      return;
    }
    if (action.type === 'ask_user') {
      const question = String(action.question || '').trim();
      if (!question) {
        run.history.push({ step: run.step, action, ok: false, detail: 'ask_user 需要非空 question' });
        continue;
      }
      const askId = `ask-${Date.now()}-${run.step}`;
      run.status = 'awaiting_user';
      run.pendingAsk = { askId, question };
      await checkpoint();
      emitEvent({ kind: 'ask', askId, question });
      updateBubble(tab.id, '等待你的回答…', 'waiting');
      const answer = await waitForAskAnswer(askId);
      if (answer === null || stopRequested) {
        await finishRun('stopped', '好的，已停止执行。有什么需要调整的吗？');
        return;
      }
      run.status = 'running';
      run.pendingAsk = null;
      await appendMessage('user', answer);
      emitEvent({ kind: 'user_message', text: answer });
      run.history.push({ step: run.step, action, ok: true, detail: `用户回答：${answer.slice(0, 200)}` });
      await checkpoint();
      continue; // 页面未变，用现有观察直接进入下一轮
    }
    if (action.type === 'plan') {
      const steps = Array.isArray(action.steps)
        ? action.steps.map((s) => String(s)).filter(Boolean).slice(0, 8)
        : [];
      if (!steps.length) {
        run.history.push({ step: run.step, action, ok: false, detail: 'plan 需要非空 steps 数组' });
        continue;
      }
      run.plan = steps;
      const planText = `计划：\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n开始执行，如需调整请随时叫停。`;
      await appendMessage('agent', planText);
      emitEvent({ kind: 'agent_message', text: planText, status: 'plan' });
      run.history.push({ step: run.step, action, ok: true, detail: `已输出 ${steps.length} 步计划` });
      await checkpoint();
      continue;
    }

    // ---------- look 额度 ----------
    if (action.type === 'look' && run.lookUsed >= LOOK_MAX_PER_TASK) {
      run.history.push({
        step: run.step,
        action,
        ok: false,
        detail: `视觉观察额度已用完（${run.lookUsed}/${LOOK_MAX_PER_TASK}），请基于现有信息决策`,
      });
      emitEvent({ kind: 'result', ok: false, text: 'look 额度已用完', step: run.step });
      continue;
    }
    if (action.type === 'look') run.lookUsed++; // 调用即计额度，失败也消耗

    // ---------- 浏览器动作 ----------
    let execOk = true;
    let execDetail = '';
    try {
      const r = await executeBrowserAction(action, tab, run);
      execDetail = r.detail;
      tab = r.tab;
      run.tabId = tab.id;
      if (r.vision) {
        run.visionNotes.push({ target: r.vision.target, question: r.vision.question, answer: r.vision.answer });
        emitEvent({ kind: 'vision', ...r.vision, step: run.step });
      }
      if (r.read) run.lastRead = r.read;
      if (r.snapshotChanged) tabSnapshot = await collectTabSnapshot();
    } catch (err) {
      execOk = false;
      execDetail = err.message;
      logWork('error', 'run.action', '动作执行异常', { step: run.step, action, error: err.message });
    }
    run.history.push({
      step: run.step,
      action,
      ok: execOk,
      detail: execDetail.slice(0, HISTORY_DETAIL_MAX),
    });
    emitEvent({ kind: 'result', ok: execOk, text: execDetail, step: run.step });

    // 动作执行后再查一次停止：跳过页面稳定等待与观察，尽快停下
    if (stopRequested) {
      await finishRun('stopped', '好的，已停止执行。有什么需要调整的吗？');
      return;
    }

    // ---------- 循环检测 ----------
    const signature = `${action.type}:${action.id ?? action.selector ?? action.url ?? ''}:${obs.url}`;
    if (signature === run.repeatSignature) {
      run.repeatCount++;
    } else {
      run.repeatSignature = signature;
      run.repeatCount = 1;
    }
    if (run.repeatCount === LOOP_WARN_AT) {
      run.history.push({
        step: run.step,
        action: { type: '_system_note' },
        ok: false,
        detail: '系统提示：你正在重复同样的动作且页面没有变化。请换一种策略（如 goto 直链、scroll、read、look 或 ask_user）。',
      });
      logWork('warn', 'run.loop', '检测到动作循环，已注入警告', { signature });
    }
    if (run.repeatCount >= LOOP_ABORT_AT) {
      await finishRun(
        'failed',
        `我在「${obs.title || obs.url}」上反复尝试同一个动作都没有进展，先停下来了。` +
          `你可以给我更多提示（比如换个入口），我再试。`
      );
      return;
    }

    await checkpoint();
    await waitPageSettled(tab.id);
    tab = await adoptActiveWebTab(tab);
    run.tabId = tab.id;
    obs = await observeOrExplain(tab);
    emitEvent({ kind: 'observe', observation: obs });
    // 动作后 tab 可能已切换（switch/new/adopt）：飘窗跟随到新的操作 tab
    updateBubble(tab.id, parsed.thought, 'running');
  }

  // 达到步数上限：说明进展与卡点，不静默失败（WORKFLOW §11）
  const lastUrl = obs?.url || '';
  await finishRun(
    'failed',
    `这个任务已经达到单回合步数上限（${MAX_STEPS} 步），我还没有完成它。\n` +
      `目前停在：${lastUrl}\n记忆便签：${run.memory || '（空）'}\n` +
      `你可以让我"继续"，或给我更具体的指示。`
  );
}
