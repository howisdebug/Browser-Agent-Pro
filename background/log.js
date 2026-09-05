// background/log.js — 日志级别 / 敏感信息脱敏 / 事件总线 / 导出
// 移植自练习版 background.js 的日志体系（已验证），架构上独立成模块。
//
// 两条输出通道：
//   1. 事件总线 emitEvent()：结构化事件 → 脱敏 → 加盖时间戳 → 入缓冲 → 广播给订阅者
//      （sidepanel 经 port 订阅，重连时回放缓冲，误关重开不丢）
//   2. logWork()：工作日志，包一层 emitEvent(kind='work_log') 并同步 console
//
// 脱敏铁律：API key 等秘密先 registerLogSecrets()，所有事件在 emitEvent 出口统一
// redactLogData；导出时再脱敏一次兜底。

export const LOG_LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3, trace: 4 });
const DEFAULT_LOG_LEVEL = 'debug';
const MAX_EVENT_LOG_ENTRIES = 10000;
// 事件缓冲持久化：SW 休眠会被回收，内存缓冲会丢（导出日志只剩重启后的两条）。
// 镜像到 chrome.storage.session，防抖写入，重启后恢复。
const EVENT_BUFFER_KEY = 'eventLogBuffer';
const PERSIST_MAX_EVENTS = 800;        // 持久化只留最近 N 条（控制体积）
const PERSIST_DEBOUNCE_MS = 1200;
const PERSIST_STRING_MAX = 4000;       // 截图 base64 等超长字段持久化时截断

let configuredLogLevel = DEFAULT_LOG_LEVEL;
let droppedEventLogEntries = 0;
let eventLog = [];
let workLogSequence = 0;
let persistTimer = null;
const knownLogSecrets = new Set();
const eventListeners = new Set();

// ---------- 日志级别 ----------

export function normalizeLogLevel(value) {
  return Object.hasOwn(LOG_LEVELS, value) ? value : DEFAULT_LOG_LEVEL;
}

function shouldLog(level) {
  return LOG_LEVELS[level] <= LOG_LEVELS[configuredLogLevel];
}

export async function initLogLevel() {
  const { logLevel } = await chrome.storage.local.get('logLevel');
  configuredLogLevel = normalizeLogLevel(logLevel);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.logLevel) {
      configuredLogLevel = normalizeLogLevel(changes.logLevel.newValue);
    }
  });
  await restoreEventBuffer();
}

// ---------- 事件缓冲持久化 ----------

function truncateForPersist(value, depth = 0) {
  if (typeof value === 'string') {
    return value.length > PERSIST_STRING_MAX
      ? `[TRUNCATED ${value.length} chars] ${value.slice(0, 500)}`
      : value;
  }
  if (!value || typeof value !== 'object' || depth >= 6) return value;
  if (Array.isArray(value)) return value.map((item) => truncateForPersist(item, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = truncateForPersist(v, depth + 1);
  return out;
}

async function restoreEventBuffer() {
  try {
    const stored = await chrome.storage.session.get(EVENT_BUFFER_KEY);
    const saved = stored[EVENT_BUFFER_KEY];
    if (saved?.events?.length) {
      eventLog = saved.events;
      droppedEventLogEntries = saved.dropped || 0;
    }
  } catch {
    // 恢复失败不致命：日志从新会话开始记
  }
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      await chrome.storage.session.set({
        [EVENT_BUFFER_KEY]: {
          dropped: droppedEventLogEntries,
          events: truncateForPersist(eventLog.slice(-PERSIST_MAX_EVENTS)),
        },
      });
    } catch {
      // 写失败可接受：不阻塞主流程
    }
  }, PERSIST_DEBOUNCE_MS);
}

// ---------- 脱敏 ----------

export function registerLogSecrets(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    if (value.length >= 4) knownLogSecrets.add(value);
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    registerLogSecrets(item, seen);
  }
}

function replaceKnownSecrets(value) {
  let redacted = value;
  for (const secret of knownLogSecrets) {
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of url.searchParams.keys()) url.searchParams.set(key, '[REDACTED]');
    url.hash = '';
    return replaceKnownSecrets(url.toString());
  } catch {
    return replaceKnownSecrets(value);
  }
}

function redactSensitiveString(value) {
  let redacted = replaceKnownSecrets(value);
  // 模型原始输出尚未解析时，也要遮蔽 input_text 的文本。
  if (/"type"\s*:\s*"input_text"/i.test(redacted)) {
    redacted = redacted.replace(
      /"text"\s*:\s*"(?:\\.|[^"\\])*"/gi,
      '"text":"[REDACTED_INPUT]"'
    );
  }
  return redacted.replace(/https?:\/\/[^\s<>"']+/gi, (url) => redactUrl(url));
}

export function redactLogData(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return redactSensitiveString(value);
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSensitiveString(value.message),
      stack: redactSensitiveString(value.stack || ''),
    };
  }
  if (depth >= 8) return '[MAX_DEPTH]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactLogData(item, depth + 1, seen));
  }
  const redacted = {};
  for (const [key, item] of Object.entries(value)) {
    if (/api.?key|authorization|password|secret|credential|cookie/i.test(key)) {
      redacted[key] = '[REDACTED]';
    } else if (/url|href/i.test(key) && typeof item === 'string') {
      redacted[key] = redactUrl(item);
    } else if (key === 'text' && value.type === 'input_text') {
      redacted[key] = `[REDACTED_INPUT length=${String(item ?? '').length}]`;
    } else {
      redacted[key] = redactLogData(item, depth + 1, seen);
    }
  }
  return redacted;
}

// ---------- 事件总线 ----------

export function addEventListener(fn) {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

export function emitEvent(event) {
  // 所有事件统一在出口脱敏。
  const safeEvent = redactLogData(event);
  const timestampMs = safeEvent.timestampMs || Date.now();
  const stamped = {
    ...safeEvent,
    timestamp: safeEvent.timestamp || new Date(timestampMs).toISOString(),
    timestampMs,
  };
  if (eventLog.length >= MAX_EVENT_LOG_ENTRIES) {
    const removeCount = Math.min(1000, eventLog.length);
    eventLog.splice(0, removeCount);
    droppedEventLogEntries += removeCount;
  }
  eventLog.push(stamped);
  schedulePersist();
  for (const fn of eventListeners) {
    try {
      fn(stamped);
    } catch (err) {
      console.error('事件订阅者异常:', err);
    }
  }
  return stamped;
}

export function getEventLog() {
  return eventLog;
}

// 新对话/新任务开始时清空缓冲（重连回放不串台）
export function clearEventLog() {
  eventLog = [];
  droppedEventLogEntries = 0;
  chrome.storage.session.remove(EVENT_BUFFER_KEY).catch(() => {});
}

export function logWork(level, scope, message, data = null) {
  if (!shouldLog(level)) return;
  const event = emitEvent({
    kind: 'work_log',
    sequence: ++workLogSequence,
    level,
    scope,
    message,
    ...(data === null ? {} : { data }),
  });
  const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
  // SW DevTools 可能把第二参数对象显示成 [object Object]，序列化后输出。
  console[consoleMethod](`[${level.toUpperCase()}][${scope}] ${message} ${JSON.stringify(event.data ?? '')}`);
}

export function buildLogExport() {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    logLevel: configuredLogLevel,
    retainedEventCount: eventLog.length,
    droppedEventCount: droppedEventLogEntries,
    // eventLog 入口已脱敏；再次处理避免未来新增事件绕过导出保护。
    events: redactLogData(eventLog),
  };
}
