// bubble/bubble.js — 桌宠小窗页面：port 连接 background 接收状态，点击唤出侧边栏
// SW 休眠/重启会导致 port 断开，自动重连（重连后 background 会重推当前状态）。

const pillEl = document.getElementById('pill');
const iconEl = document.getElementById('icon');
const textEl = document.getElementById('text');

let port = null;

function render(state) {
  pillEl.className = `pill ${state.phase || 'idle'}`;
  iconEl.textContent = state.icon || '🤖';
  textEl.textContent = state.text || '空闲';
}

function connect() {
  if (port) return;
  port = chrome.runtime.connect({ name: 'bubble' });
  port.onMessage.addListener(render);
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, 500);
  });
}

pillEl.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'PET_CLICK' }).catch(() => {});
});

connect();
