// background/actions.js — 浏览器动作执行（wait/look/read/标签页/content 委派）
// 对话策略类动作（reply/ask_user/plan/fail）由 agent-loop 直接处理，不经过这里。

import { sleep, sendToTabWithRetry, collectTabSnapshot } from './page.js';
import { performLook } from './vision.js';

// 返回 { ok, detail, tab, snapshotChanged, vision?, read? }
// tab 可能被 switch/new/close/adopt 改变，调用方以返回值为准。
export async function executeBrowserAction(action, tab, run) {
  switch (action.type) {
    case 'wait': {
      const secs = Math.min(Math.max(Number(action.seconds) || 1, 1), 5);
      await sleep(secs * 1000);
      return { ok: true, detail: `已等待 ${secs} 秒`, tab };
    }

    case 'look': {
      const target = action.target === 'viewport' ? 'viewport' : Number(action.target);
      const question = String(action.question || '这个区域是什么？');
      if (action.target !== 'viewport' && (!Number.isInteger(target) || target < 1)) {
        throw new Error('look 的 target 必须是元素编号或 "viewport"');
      }
      const r = await performLook(tab.id, target, question);
      return {
        ok: true,
        detail: `视觉观察：${r.answer}`,
        tab,
        vision: { target: String(action.target), question, answer: r.answer, screenshot: r.screenshot, usage: r.usage },
      };
    }

    case 'read': {
      const msg = { type: 'AGENT_READ', offset: action.offset, limit: action.limit };
      if (action.selector) {
        msg.selector = String(action.selector);
      } else if (action.id === 'main' || action.id === undefined) {
        msg.id = 'main';
      } else {
        const id = Number(action.id);
        if (!Number.isInteger(id) || id < 1) throw new Error('read 的 id 必须是元素编号、"main"，或改用 selector');
        msg.id = id;
      }
      const resp = await sendToTabWithRetry(tab.id, msg);
      if (!resp.ok) throw new Error(resp.error);
      const r = resp.result;
      const source = action.selector ? `selector ${action.selector}` : `目标 ${action.id ?? 'main'}`;
      return {
        ok: true,
        detail:
          `已读取正文 ${r.text.length} 字（[${r.offset}, ${r.offset + r.text.length}) / 全文 ${r.totalChars} 字` +
          `${r.hasMore ? '，还有剩余' : '，已读完'}${r.note ? '，' + r.note : ''}）。正文见下一轮"最近 read"段`,
        tab,
        read: { ...r, source },
      };
    }

    case 'switch_tab': {
      const targetId = Number(action.tabId);
      if (!Number.isInteger(targetId)) throw new Error('switch_tab 需要数字 tabId（来自标签页快照）');
      const target = await chrome.tabs.get(targetId); // 不存在会抛错
      if (!target.url || !/^https?:/.test(target.url)) {
        throw new Error(`标签页 ${targetId} 不可操作（非 http/https 页面）`);
      }
      await chrome.windows.update(target.windowId, { focused: true });
      await chrome.tabs.update(targetId, { active: true });
      return { ok: true, detail: `已切换到标签页 ${targetId}：${target.title || target.url}`, tab: target, snapshotChanged: true };
    }

    case 'new_tab': {
      const url = new URL(String(action.url || ''));
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('new_tab 只允许 http/https URL');
      }
      const created = await chrome.tabs.create({ url: url.href, active: true });
      return { ok: true, detail: `已新建标签页 ${created.id} 并打开 ${url.href}`, tab: created, snapshotChanged: true };
    }

    case 'close_tab': {
      const targetId = Number(action.tabId);
      if (!Number.isInteger(targetId)) throw new Error('close_tab 需要数字 tabId（来自标签页快照）');
      const target = await chrome.tabs.get(targetId);
      await chrome.tabs.remove(targetId);
      let detail = `已关闭标签页 ${targetId}：${target.title || target.url}`;
      let newTab = tab;
      if (targetId === tab.id) {
        const [active] = await chrome.tabs.query({ active: true, windowId: target.windowId });
        if (!active || !active.url || !/^https?:/.test(active.url)) {
          throw new Error('关闭了当前操作的标签页，且没有可接管的活动标签页，任务无法继续');
        }
        newTab = active;
        detail += `；后续操作转移到标签页 ${active.id}：${active.title || active.url}`;
      }
      return { ok: true, detail, tab: newTab, snapshotChanged: true };
    }

    case 'goto': {
      // goto 不需要 content script：background 直接导航，
      // 浏览器主页等不可注入页面也能正常跳转（冷启动常见路径）。
      const url = new URL(String(action.url || ''));
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('goto 只允许 http/https URL');
      }
      await chrome.tabs.update(tab.id, { url: url.href });
      return { ok: true, detail: `正在跳转到 ${url.href}`, tab };
    }

    default: {
      // click / input_text / scroll 由 content script 执行
      const resp = await sendToTabWithRetry(tab.id, { type: 'AGENT_ACTION', action });
      if (!resp.ok) throw new Error(resp.error);
      return { ok: true, detail: resp.result, tab };
    }
  }
}

export { collectTabSnapshot };
