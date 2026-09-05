// options/options.js — 设置读写（chrome.storage.local）
// key 仅存本地浏览器，禁止进日志；保存后侧边栏经 storage.onChanged 即时生效。

const fields = ['apiKey', 'modelApiUrl', 'modelName', 'devMode', 'bubbleEnabled', 'petMode'];
const statusEl = document.getElementById('status');

async function load() {
  const stored = await chrome.storage.local.get(fields);
  document.getElementById('apiKey').value = stored.apiKey || '';
  document.getElementById('modelApiUrl').value = stored.modelApiUrl || '';
  document.getElementById('modelName').value = stored.modelName || '';
  document.getElementById('devMode').checked = Boolean(stored.devMode);
  document.getElementById('bubbleEnabled').checked = stored.bubbleEnabled === true; // 默认关
  document.getElementById('petMode').value = stored.petMode || 'run';
}

async function save() {
  const apiKey = document.getElementById('apiKey').value.trim();
  const modelApiUrl = document.getElementById('modelApiUrl').value.trim();
  const modelName = document.getElementById('modelName').value.trim();
  const devMode = document.getElementById('devMode').checked;
  const bubbleEnabled = document.getElementById('bubbleEnabled').checked;
  const petMode = document.getElementById('petMode').value;
  if (modelApiUrl) {
    try {
      const url = new URL(modelApiUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    } catch {
      statusEl.style.color = '#f7768e';
      statusEl.textContent = 'API URL 格式不正确（仅支持 http/https）';
      return;
    }
  }
  await chrome.storage.local.set({ apiKey, modelApiUrl, modelName, devMode, bubbleEnabled, petMode });
  statusEl.style.color = '#9ece6a';
  statusEl.textContent = '已保存 ✓';
  setTimeout(() => { statusEl.textContent = ''; }, 2000);
}

document.getElementById('saveBtn').addEventListener('click', save);
load();
