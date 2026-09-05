// background/conversation.js — 对话存储（2026-09-05 整体重写，接口不变）
//
// ================= 职责边界与接口契约 =================
// 本模块是唯一读写会话数据的模块，拥有两块存储：
//   活跃对话  chrome.storage.session['conversation']
//             { id, title, startedAt, messages: [{role,text,ts,steps?}], archiveSuppressed? }
//             浏览器关闭即清；SW 休眠/被杀不丢（session 持久于 SW 生命周期之外）
//   历史归档  chrome.storage.local['conversationArchive']
//             [{ id, title, startedAt, updatedAt, messageCount, messages }]
//             长期保存，上限 ARCHIVE_MAX 条；每条归档保存全量消息（上限 ARCHIVE_MESSAGES_MAX）
//
// 对决策循环（agent-loop.js）：
//   appendMessage(role, text, steps?)  追加消息；实时同步归档（同 id upsert，不重复）
//   getConversationContext()           → { digest, recent } 供组装 LLM 上下文
//   getAllMessages()                   → 全量消息（GET_STATE 渲染 UI 用）
// 对 UI/入口（service-worker.js 消息路由）：
//   clearConversation()                新对话：仅清活跃对话（归档早已实时同步）
//   getArchiveList()                   → [{id,title,startedAt,updatedAt,messageCount}]
//   loadArchivedConversation(id)       载入归档为活跃对话（带回原 id，续聊更新同一条）
//   deleteArchivedConversation(id)     删除归档；若删的是活跃对话的归档则抑制复活
// 对存储层：其他模块一律不许直读直写上述两个 key。
// steps（当回合 thought/action/result）只供 UI 重开时渲染执行过程，不进 LLM 上下文。
//
// ================= 重写回应的已知 bug 清单 =================
// B1 归档依赖"新对话"按钮、每次点都重复归档同一段对话（f07271d 已修，重写保留：
//    首条消息分配稳定 id，之后每条消息实时 upsert，与按钮无关）
// B2 多步 await 的读-改-写无并发保护：归档 upsert 与删除交错会互相覆盖
//    → 所有写操作经模块内串行队列 enqueueWrite，读-改-写原子化
// B3 删除活跃对话的归档后，下一条消息又把它 upsert 复活
//    → 删除时给活跃对话置 archiveSuppressed，直到新对话
// B4 标题漂移：旧实现 append 时破坏性压缩，首条用户消息被压掉后
//    title 重算成"（无用户消息）"或变成别的话
//    → title 在首个用户消息时确定并持久化，终身不重算
// B5/B6 破坏性压缩丢原文：旧实现压缩直接删除旧消息，归档只剩最近 12 条 + digest，
//    历史重开/续聊永远丢失早期内容
//    → 存储层永不压缩（全量原文）；压缩改为 getConversationContext 现场计算的纯函数，
//    只影响送给 LLM 的视图，不影响数据
// B7 SW 被杀重启后会话丢失 → 数据全量落 storage.session/local，模块零内存态
//    （唯一内存态是写队列本身，随操作完成即耗尽）
// B8 NEW_CONVERSATION 与在途 run 竞态：requestStop 后 runLoop 收尾的
//    appendMessage（"已停止"汇报）可能落在 clearConversation 之后，旧消息写进新对话
//    → 由调用方（service-worker）等 run 结束再 clear；本模块队列保证落盘顺序
// B9 跨窗口同步：会话数据本就全局共享（session/local 均为扩展级），
//    任一窗口的写入经 chrome.storage.onChanged 可被其他窗口感知；
//    侧边栏事件广播的多 port 支持在 service-worker 层修复
// B10 storage.local 配额有限，归档膨胀可能写爆导致整个 append 失败
//    → 归档写入带降级重试（砍消息数 → 砍归档条数），最终失败只警告不阻断对话

const CONVERSATION_KEY = 'conversation';
const ARCHIVE_KEY = 'conversationArchive';
const ARCHIVE_MAX = 20;           // 归档条数上限
const ARCHIVE_MESSAGES_MAX = 200; // 每条归档保存的消息数上限
const FALLBACK_MESSAGES_MAX = 50; // 配额降级时每条归档保留的消息数
const MAX_VERBATIM = 12;          // 送 LLM 上下文时保留原文的最近消息数
const DIGEST_MAX_CHARS = 2000;
const DIGEST_LINE_MAX = 80;
const TITLE_MAX_CHARS = 40;

// ---------- 写串行化（B2） ----------
// 所有写操作排队执行：读-改-写整体作为一个任务，任务间不交错。
// 读操作（getConversationContext/getAllMessages/getArchiveList）不进队列。
let writeQueue = Promise.resolve();
function enqueueWrite(op) {
  const result = writeQueue.then(op);
  writeQueue = result.catch(() => {}); // 单个任务失败不阻塞后续队列
  return result;
}

// ---------- 活跃对话（storage.session） ----------

async function loadConversation() {
  try {
    const stored = await chrome.storage.session.get(CONVERSATION_KEY);
    return stored[CONVERSATION_KEY] || null;
  } catch {
    return null;
  }
}

function newConversation(messages) {
  return {
    id: `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: null, // 首个用户消息时确定（B4）
    startedAt: messages[0]?.ts ?? Date.now(),
    messages,
  };
}

function deriveTitle(messages) {
  const firstUser = messages.find((m) => m.role === 'user');
  return (firstUser?.text || '（无用户消息）').replace(/\s+/g, ' ').slice(0, TITLE_MAX_CHARS);
}

// steps 可选：该消息关联的执行过程记录（thought/action/ok/detail）
export async function appendMessage(role, text, steps = null) {
  return enqueueWrite(async () => {
    const msg = { role, text, ts: Date.now() };
    if (steps?.length) msg.steps = steps;
    const conv = (await loadConversation()) || newConversation([]);
    // 旧版本会话可能缺 id/title（重写前的格式）：补齐关键字段，否则归档会塌缩成一条
    if (!conv.id) {
      conv.id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      conv.startedAt = conv.startedAt ?? conv.messages[0]?.ts ?? Date.now();
    }
    conv.messages.push(msg);
    if (!conv.title && role === 'user') conv.title = deriveTitle(conv.messages);
    await chrome.storage.session.set({ [CONVERSATION_KEY]: conv });
    await upsertArchive(conv); // B1：实时同步，与"新对话"动作无关
    return conv;
  });
}

// 上下文组装用：digest（旧消息规则压缩，现场计算）+ recent（最近消息原文）。
// 纯函数视图：存储层永远保存全量原文（B5/B6）。
export async function getConversationContext() {
  const conv = await loadConversation();
  const messages = conv?.messages || [];
  const recent = messages.slice(-MAX_VERBATIM);
  if (messages.length <= MAX_VERBATIM) return { digest: '', recent };
  const lines = messages.slice(0, messages.length - MAX_VERBATIM).map(
    (m) => `${m.role === 'user' ? '用户' : 'Agent'}: ${m.text.replace(/\s+/g, ' ').slice(0, DIGEST_LINE_MAX)}`
  );
  let digest = lines.join('\n');
  while (digest.length > DIGEST_MAX_CHARS) {
    const nl = digest.indexOf('\n');
    if (nl === -1) { digest = digest.slice(-DIGEST_MAX_CHARS); break; }
    digest = digest.slice(nl + 1);
  }
  return { digest, recent };
}

export async function getAllMessages() {
  const conv = await loadConversation();
  return conv?.messages || [];
}

export async function clearConversation() {
  return enqueueWrite(async () => {
    await chrome.storage.session.remove(CONVERSATION_KEY);
  });
}

// ---------- 历史归档（storage.local） ----------

async function getArchive() {
  try {
    const stored = await chrome.storage.local.get(ARCHIVE_KEY);
    return stored[ARCHIVE_KEY] || [];
  } catch {
    return [];
  }
}

// B10：配额超限时的降级写入——先砍每条归档的消息数，再砍归档条数；
// 全部失败则放弃本次归档（对话本身已落 session，不受影响的）。
async function setArchiveWithFallback(archive) {
  const attempts = [
    archive,
    archive.map((e) => ({ ...e, messages: e.messages.slice(-FALLBACK_MESSAGES_MAX) })),
  ];
  let shrinking = attempts[1];
  while (shrinking.length > 1) {
    shrinking = shrinking.slice(0, Math.ceil(shrinking.length / 2));
    attempts.push(shrinking);
  }
  for (const candidate of attempts) {
    try {
      await chrome.storage.local.set({ [ARCHIVE_KEY]: candidate });
      return;
    } catch {
      // 尝试下一档降级
    }
  }
  console.warn('[conversation] 归档写入失败（配额？），本次归档已跳过');
}

// 同 id 覆盖并置顶：同一段对话无论聊多少轮、是否点过"新对话"，归档里只有一条。
// title/startedAt 以活跃对话为准（title 终身不变，B4）。
async function upsertArchive(conv) {
  if (!conv.messages.length || conv.archiveSuppressed) return;
  const entry = {
    id: conv.id,
    title: conv.title || deriveTitle(conv.messages),
    startedAt: conv.startedAt,
    updatedAt: Date.now(),
    messageCount: conv.messages.length,
    messages: conv.messages.slice(-ARCHIVE_MESSAGES_MAX),
  };
  const archive = await getArchive();
  const idx = archive.findIndex((c) => c.id === conv.id);
  if (idx !== -1) archive.splice(idx, 1);
  archive.unshift(entry);
  while (archive.length > ARCHIVE_MAX) archive.pop();
  await setArchiveWithFallback(archive);
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
// 兼容旧格式归档（曾存 digest 字段）：直接忽略，上下文摘要现场重算。
export async function loadArchivedConversation(id) {
  return enqueueWrite(async () => {
    const archive = await getArchive();
    const entry = archive.find((c) => c.id === id);
    if (!entry) throw new Error('历史对话不存在或已被清理');
    await chrome.storage.session.set({
      [CONVERSATION_KEY]: {
        id: entry.id,
        title: entry.title || null,
        startedAt: entry.startedAt,
        messages: entry.messages,
      },
    });
    return entry;
  });
}

export async function deleteArchivedConversation(id) {
  return enqueueWrite(async () => {
    const archive = await getArchive();
    await setArchiveWithFallback(archive.filter((c) => c.id !== id));
    // 删的是当前活跃对话的归档：标记抑制，避免下一条消息又把它 upsert 回来（B3）
    const conv = await loadConversation();
    if (conv?.id === id) {
      conv.archiveSuppressed = true;
      await chrome.storage.session.set({ [CONVERSATION_KEY]: conv });
    }
  });
}
