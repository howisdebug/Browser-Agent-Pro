// background/llm.js — OpenAI 兼容 Chat Completions 客户端（默认 Kimi）
// 硬约束：kimi-k3 必须 temperature=1（写死在请求构造处，否则 API 400）。
// key 从 chrome.storage.local 读取，禁止硬编码；读取后立即 registerLogSecrets。
// 每次调用记录请求快照/原始输出/耗时/usage（不含 key），并累计 token 统计。

import { emitEvent, logWork, registerLogSecrets } from './log.js';

const DEFAULT_API_URL = 'https://api.moonshot.cn/v1/chat/completions';
const DEFAULT_MODEL = 'kimi-k3';
const KIMI_TEMPERATURE = 1; // kimi-k3 硬约束，勿改

const TOKEN_STATS_KEY = 'tokenStats';
let modelCallSequence = 0;
let tokenStats = null; // 内存缓存，写回 storage.session

function validateApiUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('模型 API URL 格式不正确');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('模型 API URL 只支持 http 或 https');
  }
  return url.toString();
}

export async function getModelConfig() {
  const stored = await chrome.storage.local.get(['modelApiUrl', 'modelName', 'apiKey']);
  const apiUrl = validateApiUrl(stored.modelApiUrl || DEFAULT_API_URL);
  const model = (stored.modelName || DEFAULT_MODEL).trim();
  const apiKey = (stored.apiKey || '').trim();
  if (!model) throw new Error('未配置模型名称');
  if (!apiKey) throw new Error('未配置 API key，请先在设置页填写');
  registerLogSecrets(apiKey);
  return { apiUrl, model, apiKey };
}

// ---------- token 统计 ----------

async function loadTokenStats() {
  if (tokenStats) return tokenStats;
  try {
    const stored = await chrome.storage.session.get(TOKEN_STATS_KEY);
    tokenStats = stored[TOKEN_STATS_KEY] || { calls: 0, prompt: 0, completion: 0, total: 0, byPurpose: {} };
  } catch {
    tokenStats = { calls: 0, prompt: 0, completion: 0, total: 0, byPurpose: {} };
  }
  return tokenStats;
}

async function accumulateUsage(purpose, usage) {
  const stats = await loadTokenStats();
  stats.calls += 1;
  const p = usage?.prompt_tokens ?? 0;
  const c = usage?.completion_tokens ?? 0;
  const t = usage?.total_tokens ?? p + c;
  stats.prompt += p;
  stats.completion += c;
  stats.total += t;
  const bp = stats.byPurpose[purpose] || { calls: 0, total: 0 };
  bp.calls += 1;
  bp.total += t;
  stats.byPurpose[purpose] = bp;
  try {
    await chrome.storage.session.set({ [TOKEN_STATS_KEY]: stats });
  } catch {
    // SW 休眠边缘写失败可接受：统计只是观测数据
  }
  emitEvent({ kind: 'stats', stats });
}

export async function getTokenStats() {
  return loadTokenStats();
}

// ---------- 调用 ----------

// meta 传入对象时回填 usage（调试面板展示单次消耗）
// signal 用于"停止"时中断在途请求（AbortController）
export async function callLlm(messages, { purpose = 'decision', responseFormat = null, meta = null, signal = null } = {}) {
  const callId = `${Date.now()}-${++modelCallSequence}`;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  try {
    const { apiUrl, model, apiKey } = await getModelConfig();
    // 请求快照不含 apiKey/Authorization，可安全进日志。
    const request = JSON.parse(JSON.stringify({
      model,
      temperature: KIMI_TEMPERATURE,
      messages,
      ...(responseFormat ? { response_format: responseFormat } : {}),
    }));
    emitEvent({ kind: 'model_request', callId, purpose, apiUrl, startedAt, startedAtMs, request });

    let resp;
    try {
      resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(request),
        signal,
      });
    } catch (fetchErr) {
      logWork('error', 'model.http', 'fetch 抛出异常（未收到 HTTP 响应）', {
        callId, purpose, errorName: fetchErr.name, errorMessage: fetchErr.message,
      });
      throw fetchErr;
    }
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`模型 API 错误 ${resp.status}: ${body.slice(0, 500)}`);
    }
    const data = await resp.json();
    const output = data.choices[0].message.content;
    const completedAtMs = Date.now();
    emitEvent({
      kind: 'model_response',
      callId,
      purpose,
      startedAt,
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: completedAtMs - startedAtMs,
      output,
      usage: data.usage || null,
    });
    if (meta) meta.usage = data.usage || null;
    await accumulateUsage(purpose, data.usage);
    return output;
  } catch (err) {
    emitEvent({
      kind: 'model_error',
      callId,
      purpose,
      startedAt,
      failedAt: new Date(Date.now()).toISOString(),
      durationMs: Date.now() - startedAtMs,
      error: err.message,
      errorName: err.name,
    });
    throw err;
  }
}
