// background/vision.js — look 视觉观察管线（移植自练习版，已验证）
// 滚动到位 → 截图 → 元素裁剪（×DPR，OffscreenCanvas）→ 视觉问答 → 文字结论
// 已知坑：不用 fetch(dataURL)（CSP），用 dataUrlToBlob；截图是物理像素，坐标 ×DPR；
// base64 走 arrayBuffer + 分块 btoa（不依赖 FileReader，SW 全环境可用）。

import { callLlm } from './llm.js';
import { logWork } from './log.js';
import { sendToTabWithRetry } from './page.js';
import { withBubbleHidden } from './bubble.js';

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const mime = (dataUrl.slice(5, comma).split(';')[0]) || 'image/jpeg';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000; // 分块避免 apply 参数过多爆栈
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return 'data:image/jpeg;base64,' + btoa(binary);
}

// rect 为视口相对 CSS 像素，截图是物理像素，坐标一律 ×dpr；四周外扩 20px（CSS）。
async function cropScreenshot(dataUrl, rect, dpr, padCss = 20) {
  const blob = dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(blob);
  const pad = padCss * dpr;
  const sx = Math.max(0, Math.round(rect.left * dpr - pad));
  const sy = Math.max(0, Math.round(rect.top * dpr - pad));
  const x2 = Math.min(bitmap.width, Math.round((rect.left + rect.width) * dpr + pad));
  const y2 = Math.min(bitmap.height, Math.round((rect.top + rect.height) * dpr + pad));
  if (x2 - sx <= 0 || y2 - sy <= 0) {
    logWork('warn', 'vision.crop', '元素完全在视口外，回退整图', { rect, dpr });
    return dataUrl;
  }
  const canvas = new OffscreenCanvas(x2 - sx, y2 - sy);
  canvas
    .getContext('2d')
    .drawImage(bitmap, sx, sy, x2 - sx, y2 - sy, 0, 0, x2 - sx, y2 - sy);
  const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  return blobToDataUrl(outBlob);
}

// look 核心管线。target 为元素编号或 'viewport'。
export async function performLook(tabId, target, question) {
  const isViewport = target === 'viewport';
  const resp = await sendToTabWithRetry(tabId, {
    type: 'AGENT_PREPARE_LOOK',
    id: isViewport ? null : target,
  });
  if (!resp.ok) throw new Error(resp.error);
  const tab = await chrome.tabs.get(tabId);
  // 截图前临时隐藏飘窗，截完恢复（防视觉污染）
  const full = await withBubbleHidden(tabId, () =>
    chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 70,
    })
  );
  const image = isViewport ? full : await cropScreenshot(full, resp.rect, resp.dpr);
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `这是网页${isViewport ? '整个视口' : '某个元素区域'}的截图。\n` +
            `问题：${question}\n请用中文简明回答，只描述截图中能看到的内容。`,
        },
        { type: 'image_url', image_url: { url: image } },
      ],
    },
  ];
  const meta = {};
  const answer = await callLlm(messages, { purpose: 'look', meta });
  return {
    answer,
    usage: meta.usage || null,
    screenshot: image,
    base64KB: Math.round(image.length / 1024),
  };
}
