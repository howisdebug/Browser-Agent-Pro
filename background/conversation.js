// background/conversation.js — 对话存储（chrome.storage.session）
// 历史即对话本身：messages 全量存 session；超阈值时旧消息规则压缩为 digest 一行/条。
// （LLM 摘要压缩是延期项，见 PLAN.md §7）

const CONVERSATION_KEY = 'conversation';
const MAX_VERBATIM = 12;      // 保留原文的最近消息数
const COMPACT_CHUNK = 6;      // 超出后每次压缩的旧消息批大小
const DIGEST_MAX_CHARS = 2000;
const DIGEST_LINE_MAX = 80;

async function loadConversation() {
  try {
    const stored = await chrome.storage.session.get(CONVERSATION_KEY);
    return stored[CONVERSATION_KEY] || { messages: [], digest: '' };
  } catch {
    return { messages: [], digest: '' };
  }
}

async function saveConversation(conv) {
  await chrome.storage.session.set({ [CONVERSATION_KEY]: conv });
}

// 规则压缩：最旧的一批消息压成一行摘要进 digest，只保留最近 MAX_VERBATIM 条原文
function maybeCompact(conv) {
  if (conv.messages.length <= MAX_VERBATIM + COMPACT_CHUNK) return conv;
  const compactCount = conv.messages.length - MAX_VERBATIM;
  const old = conv.messages.slice(0, compactCount);
  const lines = old.map(
    (m) => `${m.role === 'user' ? '用户' : 'Agent'}: ${m.text.replace(/\s+/g, ' ').slice(0, DIGEST_LINE_MAX)}`
  );
  let digest = conv.digest ? conv.digest + '\n' + lines.join('\n') : lines.join('\n');
  // digest 超长时从头部丢弃（保留最近的压缩信息）
  while (digest.length > DIGEST_MAX_CHARS) {
    const nl = digest.indexOf('\n');
    if (nl === -1) { digest = digest.slice(-DIGEST_MAX_CHARS); break; }
    digest = digest.slice(nl + 1);
  }
  return { messages: conv.messages.slice(compactCount), digest };
}

export async function appendMessage(role, text) {
  const conv = await loadConversation();
  conv.messages.push({ role, text, ts: Date.now() });
  const compacted = maybeCompact(conv);
  await saveConversation(compacted);
  return compacted;
}

// 上下文组装用：digest（旧对话压缩摘要）+ recent（最近消息原文）
export async function getConversationContext() {
  const conv = await loadConversation();
  return { digest: conv.digest, recent: conv.messages.slice(-MAX_VERBATIM) };
}

export async function getAllMessages() {
  const conv = await loadConversation();
  return conv.messages;
}

export async function clearConversation() {
  await chrome.storage.session.remove(CONVERSATION_KEY);
}
