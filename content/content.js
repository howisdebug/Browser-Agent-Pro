// content/content.js — 页面侧：DOM 提取 + 动作执行 + read 正文读取 + 操作高亮 + look 准备
// 注意：MV3 content script 不支持 ES module 静态 import，本文件保持单文件组织。
// 核心规则移植自已验证的练习版（D:\projects\browser-agent\content.js），新增 read 与高亮。
(function () {
  if (window.__browserAgentProLoaded) return; // 防重复注入
  window.__browserAgentProLoaded = true;

  const MAX_ELEMENTS = 120;
  const MAX_PAGE_TEXT = 12000;
  const TEXT_TRUNCATE = 30;
  const READ_DEFAULT_LIMIT = 3000;
  const READ_MAX_LIMIT = 5000;
  const INTERACTIVE_SELECTOR =
    'a, button, input, select, textarea, [role="button"], [role="link"], [role="searchbox"], [onclick]';

  // 最近一次提取的元素引用，index = 编号 - 1
  let currentElements = [];

  // ============================================================
  // 分区 1：DOM 提取（移植自练习版，规则见 PLAN.md §3.5）
  // ============================================================

  function elementText(el) {
    // 密码框的当前值绝不能进入页面观察、模型上下文或日志。
    const safeValue = el instanceof HTMLInputElement && el.type === 'password' ? '' : el.value;
    const raw =
      el.innerText ||
      safeValue ||
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      '';
    return raw.replace(/\s+/g, ' ').trim();
  }

  function truncate(s) {
    return s.length > TEXT_TRUNCATE ? s.slice(0, TEXT_TRUNCATE) + '…' : s;
  }

  function describeElement(el, id) {
    const tag = el.tagName.toLowerCase();
    let text = truncate(elementText(el));
    // 无文本元素（如纯图标按钮）用 class 兜底，方便 LLM 识别
    if (!text && typeof el.className === 'string' && el.className) {
      text = `(${truncate(el.className.trim())})`;
    }
    const extras = [];
    if (el.placeholder) extras.push(`placeholder="${el.placeholder}"`);
    if (el.href) {
      try {
        const href = new URL(el.href);
        href.username = '';
        href.password = '';
        href.search = '';
        href.hash = '';
        extras.push(`href="${href.toString().slice(0, 50)}"`);
      } catch {
        extras.push('href="[INVALID_URL]"');
      }
    }
    if (tag === 'input') extras.push(`type="${el.type}"`);
    return `[${id}] <${tag}> "${text}" ${extras.join(' ')}`.trim();
  }

  // 单次遍历收集：原生交互元素 ∪ 最外层 cursor:pointer 元素
  // （B 站搜索按钮是 div + React onClick，不匹配任何交互选择器，只能靠 pointer 捕获；
  //   只保留最外层是因为 cursor 会继承，div>svg>path 三层都是 pointer，不收敛会刷屏）
  // 递归穿透 open shadow root（B 站 bili-comments 等 web component 里的
  // 链接/按钮在 shadow 树中，不穿透会漏抓）；closed shadow 无法访问，iframe 不穿透
  // （跨 frame 坐标系不同且跨域受限）。
  function* iterateAllElements(root) {
    for (const el of root.querySelectorAll('*')) {
      yield el;
      if (el.shadowRoot) yield* iterateAllElements(el.shadowRoot);
    }
  }

  function collectElements() {
    const interactive = new Set();
    const pointer = new Set();
    for (const el of iterateAllElements(document.body)) {
      if (el.hasAttribute('data-bap-bubble')) continue; // 自家飘窗/探针，永不进清单
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (el.matches(INTERACTIVE_SELECTOR)) interactive.add(el);
      else if (style.cursor === 'pointer') pointer.add(el);
    }
    const result = new Set(interactive);
    for (const el of pointer) {
      let outermost = el;
      while (outermost.parentElement && pointer.has(outermost.parentElement)) {
        outermost = outermost.parentElement;
      }
      result.add(outermost);
    }
    return Array.from(result);
  }

  function extractElements() {
    const all = collectElements();
    // 按视口位置排序（先上后下、先左后右），再截断到上限
    all.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return ra.top - rb.top || ra.left - rb.left;
    });
    currentElements = all.slice(0, MAX_ELEMENTS);
    const lines = currentElements.map((el, i) => describeElement(el, i + 1));
    return {
      url: location.href,
      title: document.title,
      scrollY: Math.round(window.scrollY),
      pageText: (document.body?.innerText || '')
        .replace(/\n\s*\n+/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .trim()
        .slice(0, MAX_PAGE_TEXT),
      count: currentElements.length,
      text: lines.join('\n'),
    };
  }

  function getElement(id) {
    const el = currentElements[id - 1];
    if (!el) throw new Error(`编号 ${id} 不存在（当前共 ${currentElements.length} 个元素，请先提取）`);
    // isConnected 对 shadow DOM 内元素也返回 true（document.contains 不可靠）
    if (!el.isConnected) throw new Error(`编号 ${id} 的元素已从页面消失，请重新提取`);
    return el;
  }

  // ============================================================
  // 分区 2：操作高亮描边（演示需求：页面上被操作元素可见反馈）
  // ============================================================

  let highlightEl = null;
  let highlightTimer = null;

  // 在元素位置叠一个 fixed 描边框 + 动作标签，1.4s 后淡出移除
  function showHighlight(el, label) {
    try {
      if (highlightTimer) clearTimeout(highlightTimer);
      if (highlightEl) highlightEl.remove();
      const r = el.getBoundingClientRect();
      const box = document.createElement('div');
      box.style.cssText =
        'position:fixed;pointer-events:none;z-index:2147483647;' +
        `left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;` +
        'border:2px solid #7aa2f7;border-radius:4px;' +
        'box-shadow:0 0 8px rgba(122,162,247,.6);transition:opacity .4s;';
      const tag = document.createElement('div');
      tag.textContent = label;
      tag.style.cssText =
        'position:absolute;top:-22px;left:-2px;background:#7aa2f7;color:#1a1b26;' +
        'font:600 11px/18px sans-serif;padding:0 6px;border-radius:3px;white-space:nowrap;';
      box.appendChild(tag);
      document.body.appendChild(box);
      highlightEl = box;
      highlightTimer = setTimeout(() => {
        box.style.opacity = '0';
        setTimeout(() => box.remove(), 450);
        if (highlightEl === box) highlightEl = null;
      }, 1400);
    } catch {
      // 高亮是演示增强，任何失败都不影响动作本身
    }
  }

  // ============================================================
  // 分区 3：动作执行（移植 + 高亮接入）
  // ============================================================

  // React/Vue 等受控组件通常需要 native setter + 原生事件（PLAN.md 已知坑 1）。
  function setReactValue(el, text) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : null;
    el.focus();
    const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, text);
    else el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function executeAction(action) {
    switch (action.type) {
      case 'click': {
        const el = getElement(action.id);
        el.scrollIntoView({ block: 'center' });
        showHighlight(el, '👆 点击');
        el.click();
        return `已点击 [${action.id}]`;
      }
      case 'input_text': {
        const el = getElement(action.id);
        el.scrollIntoView({ block: 'center' });
        showHighlight(el, '⌨ 输入');
        setReactValue(el, action.text);
        return `已向 [${action.id}] 输入文本（长度 ${action.text.length}）`;
      }
      case 'goto': {
        const url = new URL(action.url);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new Error('只允许 http/https URL');
        }
        location.href = url.href;
        return `正在跳转到 ${url.href}`;
      }
      case 'scroll': {
        const delta = action.direction === 'up' ? -window.innerHeight : window.innerHeight;
        window.scrollBy({ top: delta, behavior: 'instant' });
        return `已滚动 ${action.direction === 'up' ? '上' : '下'}一屏`;
      }
      case 'wait':
        return `等待 ${action.seconds} 秒（由调用方 sleep）`;
      default:
        throw new Error(`未知动作类型: ${action.type}`);
    }
  }

  // ============================================================
  // 分区 4：read —— 正文读取（与 look 对称的文本感知工具，PLAN.md §3.4）
  // 无状态设计：每次调用重新提取全文，按 offset 切片；懒加载内容 scroll 后再 read 即可读到。
  // ============================================================

  function findMainContainer() {
    // 启发式：语义化正文容器 → 退化 body（body 全文也比没有强）
    return (
      document.querySelector('main') ||
      document.querySelector('article') ||
      document.querySelector('[role="main"]') ||
      document.body
    );
  }

  // 递归穿透 shadow DOM 收集文本（B 站评论区 bili-comments 等 web component
  // 的文本在 shadow root 里，host 的 innerText 取不到）。innerText 本身不含
  // shadow 内容，所以追加不会重复。
  function deepInnerText(root, depth = 0) {
    if (!root || depth > 6) return '';
    let text = root.innerText || '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const shadowRoots = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.shadowRoot) shadowRoots.push(node.shadowRoot);
    }
    for (const sr of shadowRoots) {
      const t = deepInnerText(sr, depth + 1);
      if (t.trim()) text += '\n' + t;
    }
    return text;
  }

  function readText(id, offset, limit, selector) {
    let el;
    if (selector) {
      el = document.querySelector(selector);
      if (!el) throw new Error(`选择器未匹配到元素: ${selector}`);
    } else if (id === 'main' || id === null || id === undefined) {
      el = findMainContainer();
    } else {
      el = getElement(Number(id));
    }
    el.scrollIntoView({ block: 'start' });
    showHighlight(el, '📖 读取');
    // innerText 只含可见渲染文本，天然剔除 script/style/hidden；deepInnerText 补 shadow DOM
    const full = deepInnerText(el)
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .trim();
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.min(Math.max(Number(limit) || READ_DEFAULT_LIMIT, 200), READ_MAX_LIMIT);
    if (start >= full.length && full.length > 0) {
      return {
        text: '',
        offset: start,
        totalChars: full.length,
        hasMore: false,
        note: 'offset 已超出全文长度',
      };
    }
    const slice = full.slice(start, start + size);
    return {
      text: slice,
      offset: start,
      totalChars: full.length,
      hasMore: start + size < full.length,
    };
  }

  // ============================================================
  // 分区 5：look 准备（移植：滚动居中 → 回传 rect + DPR，SW 按物理像素裁剪）
  // ============================================================

  async function prepareLook(id) {
    if (id === null || id === undefined) {
      return { rect: null, dpr: window.devicePixelRatio || 1 };
    }
    const el = getElement(id);
    el.scrollIntoView({ block: 'center' });
    showHighlight(el, '👁 观察');
    await new Promise((resolve) => setTimeout(resolve, 600)); // 等滚动与 React 重渲染
    const r = el.getBoundingClientRect();
    return {
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      dpr: window.devicePixelRatio || 1,
    };
  }

  // ============================================================
  // 分区 6：状态飘窗（closed shadow DOM）
  // 宿主是挂在 documentElement 上的空 div（body 之外，提取器扫不到；
  // innerText 不穿透 shadow，正文不受污染）。样式全在 shadow 内。
  // 后续 logo 美化：替换 assets 图片 + manifest 登记 web_accessible_resources 即可。
  // ============================================================

  let bubbleHost = null;
  let bubbleShadow = null; // closed shadow：shadowRoot 外部取不到，必须自持引用

  function ensureBubble() {
    if (bubbleHost && document.documentElement.contains(bubbleHost)) return;
    const host = document.createElement('div');
    host.setAttribute('data-bap-bubble', '1');
    host.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;display:none;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        .pill {
          display: flex; align-items: center; gap: 6px; max-width: 280px;
          background: #1f2335; color: #c0caf5;
          border: 1px solid #7aa2f7; border-radius: 16px;
          padding: 6px 12px;
          font: 12px/1.4 "Segoe UI", "Microsoft YaHei", sans-serif;
          box-shadow: 0 4px 14px rgba(0,0,0,.5);
          cursor: pointer; user-select: none;
          transition: opacity .3s;
        }
        .pill:hover { border-color: #89b4fa; }
        .pill.waiting { border-color: #e0af68; }
        .pill.done { border-color: #9ece6a; }
        .pill.failed, .pill.stopped { border-color: #f7768e; }
        .icon { flex: none; }
        .text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      </style>
      <div class="pill" title="点击打开 Agent 侧边栏">
        <span class="icon">🤖</span><span class="text"></span>
      </div>`;
    host.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'BUBBLE_CLICK' }).catch(() => {});
    });
    (document.documentElement || document.body).appendChild(host);
    bubbleHost = host;
    bubbleShadow = shadow;
  }

  function syncBubble(msg) {
    try {
      ensureBubble();
      if (!msg.show) {
        bubbleHost.style.display = 'none';
        return;
      }
      bubbleShadow.querySelector('.pill').className = `pill ${msg.phase || 'running'}`;
      bubbleShadow.querySelector('.icon').textContent = msg.icon || '🤖';
      bubbleShadow.querySelector('.text').textContent = msg.text || '';
      bubbleHost.style.display = 'block';
    } catch {
      // 飘窗是演示增强，失败不影响主流程
    }
  }

  // ============================================================
  // 分区 7：探针（验证 content script 点击 → SW sidePanel.open 手势透传）
  // ============================================================

  function injectProbeButton() {
    const btn = document.createElement('button');
    btn.setAttribute('data-bap-bubble', '1');
    btn.textContent = '🧪 探针：点击尝试打开侧边栏';
    btn.style.cssText =
      'position:fixed;top:12px;right:12px;z-index:2147483647;padding:8px 14px;' +
      'background:#7aa2f7;color:#1a1b26;border:none;border-radius:8px;' +
      'font:600 13px sans-serif;cursor:pointer;';
    btn.addEventListener('click', () => {
      btn.textContent = '🧪 已点击，结果见调试面板';
      chrome.runtime.sendMessage({ type: 'PROBE_CLICK' }).catch(() => {});
    });
    (document.documentElement || document.body).appendChild(btn);
    setTimeout(() => btn.remove(), 30000);
  }

  // ============================================================
  // 消息路由
  // ============================================================

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'AGENT_PREPARE_LOOK') {
      prepareLook(msg.id)
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true; // 异步 sendResponse
    }
    try {
      if (msg.type === 'AGENT_EXTRACT') {
        sendResponse({ ok: true, observation: extractElements() });
      } else if (msg.type === 'AGENT_ACTION') {
        const result = executeAction(msg.action);
        sendResponse({ ok: true, result });
      } else if (msg.type === 'AGENT_READ') {
        const result = readText(msg.id, msg.offset, msg.limit, msg.selector);
        sendResponse({ ok: true, result });
      } else if (msg.type === 'BUBBLE_SYNC') {
        syncBubble(msg);
        sendResponse({ ok: true });
      } else if (msg.type === 'PROBE_INJECT_BUTTON') {
        injectProbeButton();
        sendResponse({ ok: true });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return false; // 其余全部同步处理
  });
})();
