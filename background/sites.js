// background/sites.js — 站点知识包：加载与按域匹配（PLAN.md §3.6）
// 知识包是纯提示词层：命中即在每轮 user message 注入"## 站点提示"，
// 通用引擎不依赖知识包也能工作。

import { logWork } from './log.js';

// 打包进扩展的知识包文件清单（新增站点在此登记）
const PACK_FILES = ['bilibili.json'];

let packs = null;

export async function loadSitePacks() {
  if (packs) return packs;
  packs = [];
  for (const file of PACK_FILES) {
    try {
      const resp = await fetch(chrome.runtime.getURL('sites/' + file));
      const pack = await resp.json();
      if (pack?.hosts?.length && pack?.prompt) {
        packs.push(pack);
      } else {
        logWork('warn', 'sites', '知识包格式不完整，已跳过', { file });
      }
    } catch (err) {
      logWork('warn', 'sites', '知识包加载失败，已跳过', { file, error: err.message });
    }
  }
  logWork('info', 'sites', '站点知识包已加载', { count: packs.length });
  return packs;
}

// 按当前 URL 的 host 后缀匹配；每轮重匹配（换站即换包）
export function matchSitePack(url) {
  if (!packs?.length || !url) return null;
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return packs.find((p) => p.hosts.some((h) => host === h || host.endsWith('.' + h))) || null;
}
