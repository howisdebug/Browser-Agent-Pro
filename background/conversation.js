// background/conversation.js — 对话存储
// 活跃对话：chrome.storage.session（浏览器关闭即清）。
// 历史归档：chrome.storage.local（长期保存，上限 ARCHIVE_MAX 条）——活跃对话从
// 首条消息起即获得稳定 id，每次 appendMessage 同步 upsert 到归档（同 id 覆盖更新，
// 不产生重复条目），与"新对话"按钮无关。用户可从侧边栏历史入口重新载入续聊，
// 载入会带回原 id，续聊内容仍更新到同一条归档。
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
  return { ...conv, messages: conv.messages.slice(compactCount), digest };
}

// 活跃对话首条消息时分配稳定 id（归档 upsert 的键），保证同一段对话只对应一条历史
function ensureConvId(conv) {
  if (!conv.id) {
    conv.id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    conv.startedAt = conv.messages[0]?.ts ?? Date.now();
  }
  return conv;
}

// steps 可选：该消息关联的执行过程记录（thought/action/ok/detail）
export async function appendMessage(role, text, steps = null) {
  const conv = ensureConvId(await loadConversation());
  const msg = { role, text, ts: Date.now() };
  if (steps?.length) msg.steps = steps;
  conv.messages.push(msg);
  const compacted = maybeCompact(conv);
  await saveConversation(compacted);
  await upsertArchive(compacted); // 历史归档实时同步，不依赖"新对话"动作
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

// 每次 appendMessage 后同步：按对话 id upsert（存在则覆盖并置顶，不存在则插入），
// 因此同一段对话无论聊多少轮、是否点过"新对话"，归档里永远只有一条记录。
async function upsertArchive(conv) {
  if (!conv.id || !conv.messages.length || conv.archiveSuppressed) return;
  const firstUser = conv.messages.find((m) => m.role === 'user');
  const entry = {
    id: conv.id,
    title: (firstUser?.text || '（无用户消息）').replace(/\s+/g, ' ').slice(0, 40),
    startedAt: conv.startedAt ?? conv.messages[0].ts,
    updatedAt: Date.now(),
    messageCount: conv.messages.length,
    digest: conv.digest || '',
    messages: conv.messages.slice(-ARCHIVE_MESSAGES_MAX),
  };
  const archive = await getArchive();
  const idx = archive.findIndex((c) => c.id === conv.id);
  if (idx !== -1) archive.splice(idx, 1);
  archive.unshift(entry);
  while (archive.length > ARCHIVE_MAX) archive.pop();
  await chrome.storage.local.set({ [ARCHIVE_KEY]: archive });
}

// 历史列表（不含 messages 正文，供 UI 列表展示）
export async function getArchiveList() {
  const archive = await getArchive();
  return archive.map(({ id, title, startedAt, updatedAt, messageCount }) => ({
    id,
    title,
    startedAt,
    updatedAt,
    messageCount,
  }));
}

// 载入归档对话为当前活跃对话（续聊：下一轮用户消息将以它为上下文）。
// 带回原 id：续聊产生的新消息仍 upsert 到同一条归档，不会生成重复历史。
export async function loadArchivedConversation(id) {
  const archive = await getArchive();
  const entry = archive.find((c) => c.id === id);
  if (!entry) throw new Error('历史对话不存在或已被清理');
  await chrome.storage.session.set({
    [CONVERSATION_KEY]: {
      id: entry.id,
      startedAt: entry.startedAt,
      messages: entry.messages,
      digest: entry.digest || '',
    },
  });
  return entry;
}

export async function deleteArchivedConversation(id) {
  const archive = await getArchive();
  const next = archive.filter((c) => c.id !== id);
  await chrome.storage.local.set({ [ARCHIVE_KEY]: next });
  // 删的是当前活跃对话的归档：标记抑制，避免下一条消息又把它 upsert 回来
  const conv = await loadConversation();
  if (conv.id === id) {
    conv.archiveSuppressed = true;
    await saveConversation(conv);
  }
}
