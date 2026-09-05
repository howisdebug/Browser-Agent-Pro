// background/conversation-test.js — 会话模块调试面板测试组
// 五个用例：新对话 / 多轮累积 / 压缩触发 / SW 重启后恢复 / 跨窗口同步。
// 跑前备份真实会话与归档，跑完整体恢复——测试在真实 storage 上做（行为即契约），
// 但绝不留痕迹。任务运行中禁止执行（写队列会排队等待，测试语义会乱）。

import {
  appendMessage,
  getAllMessages,
  getConversationContext,
  clearConversation,
  getArchiveList,
  loadArchivedConversation,
  deleteArchivedConversation,
} from './conversation.js';

const CONVERSATION_KEY = 'conversation';
const ARCHIVE_KEY = 'conversationArchive';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function wipe() {
  await clearConversation();
  await chrome.storage.local.remove(ARCHIVE_KEY);
}

// ---------- 用例 1：新对话 ----------
// 清空后开始新对话：活跃消息清零、旧对话留在归档、新对话获得独立 id、归档不重复
async function testNewConversation() {
  await wipe();
  await appendMessage('user', '测试A：第一条');
  await appendMessage('agent', '测试A：回复');
  await clearConversation();
  assert((await getAllMessages()).length === 0, '清空后活跃对话应为空');
  let list = await getArchiveList();
  assert(list.length === 1, `清空后归档应有 1 条，实际 ${list.length}`);
  assert(list[0].title.includes('测试A'), `归档标题应来自首条用户消息，实际 "${list[0].title}"`);
  await appendMessage('user', '测试B：新对话第一条');
  list = await getArchiveList();
  assert(list.length === 2, `新对话应产生独立归档条目，实际 ${list.length} 条`);
  assert(list[0].id !== list[1].id, '两段对话的归档 id 必须不同');
}

// ---------- 用例 2：多轮累积 ----------
// 同一段对话多轮 append：归档始终单条、messageCount 同步增长、title 终身不变（B4）
async function testMultiTurnAccumulation() {
  await wipe();
  for (let i = 1; i <= 3; i++) {
    await appendMessage('user', `第${i}轮提问`);
    await appendMessage('agent', `第${i}轮回答`);
  }
  assert((await getAllMessages()).length === 6, '活跃对话应有 6 条消息');
  let list = await getArchiveList();
  assert(list.length === 1, `多轮累积归档应保持单条，实际 ${list.length}`);
  assert(list[0].messageCount === 6, `归档 messageCount 应为 6，实际 ${list[0].messageCount}`);
  assert(list[0].title.includes('第1轮提问'), `title 应固定为首条用户消息，实际 "${list[0].title}"`);
  await appendMessage('user', '第4轮提问');
  list = await getArchiveList();
  assert(list.length === 1 && list[0].messageCount === 7, '继续累积后归档仍应为单条且 messageCount=7');
  assert(list[0].title.includes('第1轮提问'), 'title 不应随新消息漂移');
}

// ---------- 用例 3：压缩触发 ----------
// 超过 MAX_VERBATIM(12) 条后：getConversationContext 出现 digest 且 recent=12；
// 存储层原文一条不丢（重写核心：压缩只是送 LLM 的视图，B5/B6）
async function testCompaction() {
  await wipe();
  for (let i = 1; i <= 20; i++) {
    await appendMessage(i % 2 ? 'user' : 'agent', `压缩测试消息${i}`);
  }
  const ctx = await getConversationContext();
  assert(ctx.recent.length === 12, `recent 应为 12 条，实际 ${ctx.recent.length}`);
  assert(ctx.digest.length > 0, '超过 12 条后 digest 应非空');
  assert(ctx.digest.includes('压缩测试消息1'), 'digest 应覆盖最早的消息');
  assert(ctx.recent.at(-1).text === '压缩测试消息20', 'recent 末条应是最新消息');
  const all = await getAllMessages();
  assert(all.length === 20, `存储层应保留全量原文 20 条，实际 ${all.length}（压缩不得破坏数据）`);
  assert(all[0].text === '压缩测试消息1', '最早的消息原文必须还在');
}

// ---------- 用例 4：SW 重启后恢复 ----------
// SW 重启等价于内存清零：会话/归档必须完整落在 storage.session/local，
// 直接读存储层的数据与 API 返回一致即证明无内存态依赖（B7）
async function testPersistenceAcrossSwRestart() {
  await wipe();
  await appendMessage('user', '持久化测试');
  await appendMessage('agent', '持久化回复', [
    { thought: 't', action: { type: 'reply' }, ok: true, detail: 'd' },
  ]);
  const rawSession = await chrome.storage.session.get(CONVERSATION_KEY);
  const conv = rawSession[CONVERSATION_KEY];
  assert(conv && conv.id && conv.startedAt, 'session 中的对话应含 id/startedAt');
  assert(conv.messages.length === 2 && conv.messages[1].steps?.length === 1, 'session 应含全量消息与 steps');
  const rawLocal = await chrome.storage.local.get(ARCHIVE_KEY);
  const archive = rawLocal[ARCHIVE_KEY];
  assert(Array.isArray(archive) && archive.length === 1, '归档应已落 storage.local');
  assert(archive[0].messages.length === 2, '归档应含全量消息');
  // 载入归档续聊：恢复原 id（重启后从归档重建活跃对话的路径，B1 不重复的关键）
  await clearConversation();
  const entry = await loadArchivedConversation(archive[0].id);
  assert(entry.id === archive[0].id, '载入应返回原归档条目');
  assert((await getAllMessages()).length === 2, '载入后活跃对话应恢复全量消息');
  await appendMessage('user', '续聊一条');
  const list = await getArchiveList();
  assert(list.length === 1 && list[0].messageCount === 3, '续聊必须更新同一条归档（id 带回）');
}

// ---------- 用例 5：跨窗口同步 ----------
// 同步机制 = chrome.storage（扩展级共享）+ onChanged 事件。任一窗口的写入
// 必须产生 onChanged，另一个窗口的 sidepanel 据此感知（B9）
async function testCrossWindowSync() {
  await wipe();
  const changed = new Promise((resolve) => {
    const listener = (changes, area) => {
      if (area === 'session' && changes[CONVERSATION_KEY]) {
        chrome.storage.onChanged.removeListener(listener);
        resolve(changes[CONVERSATION_KEY].newValue);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    setTimeout(() => {
      chrome.storage.onChanged.removeListener(listener);
      resolve(null);
    }, 3000);
  });
  await appendMessage('user', '跨窗口同步测试');
  const newValue = await changed;
  assert(newValue && newValue.messages?.length === 1, 'append 必须触发 session onChanged（跨窗口同步的基础）');
  // 删除活跃对话的归档：不应复活（B3）
  const list = await getArchiveList();
  await deleteArchivedConversation(list[0].id);
  await appendMessage('user', '删除后继续聊');
  assert((await getArchiveList()).length === 0, '删除活跃对话的归档后不应被新消息复活');
}

const TESTS = [
  ['新对话', testNewConversation],
  ['多轮累积', testMultiTurnAccumulation],
  ['压缩触发', testCompaction],
  ['SW重启后恢复', testPersistenceAcrossSwRestart],
  ['跨窗口同步', testCrossWindowSync],
];

export async function runConversationTests() {
  // 备份真实数据，finally 整体恢复
  const backupConv = (await chrome.storage.session.get(CONVERSATION_KEY))[CONVERSATION_KEY];
  const backupArchive = (await chrome.storage.local.get(ARCHIVE_KEY))[ARCHIVE_KEY];
  const results = [];
  try {
    for (const [name, fn] of TESTS) {
      try {
        await fn();
        results.push({ name, pass: true });
      } catch (err) {
        results.push({ name, pass: false, error: err.message });
      }
    }
  } finally {
    await wipe();
    if (backupConv) await chrome.storage.session.set({ [CONVERSATION_KEY]: backupConv });
    if (backupArchive) await chrome.storage.local.set({ [ARCHIVE_KEY]: backupArchive });
  }
  return results;
}
