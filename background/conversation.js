// background/conversation.js — 对话存储
// 活跃对话：chrome.storage.session（浏览器关闭即清）。
// 历史归档：chrome.storage.local（长期保存，上限 ARCHIVE_MAX 条）——点"新对话"时
// 自动归档当前对话，用户可从侧边栏历史入口重新载入续聊。
// 消息可带 steps（当回合 thought/action/result 记录），供 UI 重开时渲染执行过程；
// steps 不进 LLM 上下文（getConversationContext 只取 text）。

const CONVERSATION_KEY = 'conversation';
const ARCHIVE_KEY = 'conversationArchive';
const ARCHIVE_MAX = 20;
const ARCHIVE_MESSAGES_MAX = 100;
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

// steps 可选：该消息关联的执行过程记录（thought/action/ok/detail）
export async function appendMessage(role, text, steps = null) {
  const conv = await loadConversation();
  const msg = { role, text, ts: Date.now() };
  if (steps?.length) msg.steps = steps;
  conv.messages.push(msg);
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

// ---------- 历史归档（storage.local） ----------

export async function getArchive() {
  try {
    const stored = await chrome.storage.local.get(ARCHIVE_KEY);
    return stored[ARCHIVE_KEY] || [];
  } catch {
    return [];
  }
}

// 新对话前调用：当前对话非空则归档。返回是否归档了内容。
export async function archiveCurrentConversation() {
  const conv = await loadConversation();
  if (!conv.messages.length) return false;
  const firstUser = conv.messages.find((m) => m.role === 'user');
  const entry = {
    id: `conv-${Date.now()}`,
    title: (firstUser?.text || '（无用户消息）').replace(/\s+/g, ' ').slice(0, 40),
    startedAt: conv.messages[0].ts,
    messageCount: conv.messages.length,
    digest: conv.digest || '',
    messages: conv.messages.slice(-ARCHIVE_MESSAGES_MAX),
  };
  const archive = await getArchive();
  archive.unshift(entry);
  while (archive.length > ARCHIVE_MAX) archive.pop();
  await chrome.storage.local.set({ [ARCHIVE_KEY]: archive });
  return true;
}

// 历史列表（不含 messages 正文，供 UI 列表展示）
export async function getArchiveList() {
  const archive = await getArchive();
  return archive.map(({ id, title, startedAt, messageCount }) => ({
    id,
    title,
    startedAt,
    messageCount,
  }));
}

// 载入归档对话为当前活跃对话（续聊：下一轮用户消息将以它为上下文）
export async function loadArchivedConversation(id) {
  const archive = await getArchive();
  const entry = archive.find((c) => c.id === id);
  if (!entry) throw new Error('历史对话不存在或已被清理');
  await chrome.storage.session.set({
    [CONVERSATION_KEY]: { messages: entry.messages, digest: entry.digest || '' },
  });
  return entry;
}

export async function deleteArchivedConversation(id) {
  const archive = await getArchive();
  const next = archive.filter((c) => c.id !== id);
  await chrome.storage.local.set({ [ARCHIVE_KEY]: next });
}
