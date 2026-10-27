// 툴바 아이콘을 누르면 인트라넷을 주소창 없는 작은 창으로 연다.
// 이미 열려 있으면 그 창을 앞으로 가져오고, 창 크기·위치는 기억한다.
const START_URL = 'https://kingjin77-rgb.github.io/intranet/index.html';
const DEFAULT_SIZE = { width: 420, height: 760 };

async function openIntranet({ focused = true } = {}) {
  const { winId } = await chrome.storage.session.get('winId');
  if (winId) {
    try {
      await chrome.windows.update(winId, { focused: true, state: 'normal' });
      return winId;
    } catch {
      // 사용자가 창을 닫았으면 새로 연다
    }
  }
  const { bounds } = await chrome.storage.local.get('bounds');
  const win = await chrome.windows.create({ url: START_URL, type: 'popup', focused, ...DEFAULT_SIZE, ...bounds });
  await chrome.storage.session.set({ winId: win.id });
  return win.id;
}

chrome.action.onClicked.addListener(() => openIntranet());

// 크롬을 켜면 자동으로 열어 둔다 (앞으로 튀어나오지는 않게)
chrome.runtime.onStartup.addListener(() => openIntranet({ focused: false }));
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') openIntranet();
});

chrome.windows.onBoundsChanged.addListener(async (win) => {
  const { winId } = await chrome.storage.session.get('winId');
  if (win.id !== winId) return;
  const { left, top, width, height } = win;
  await chrome.storage.local.set({ bounds: { left, top, width, height } });
});

chrome.windows.onRemoved.addListener(async (id) => {
  const { winId } = await chrome.storage.session.get('winId');
  if (id === winId) await chrome.storage.session.remove('winId');
});

// 인트라넷 페이지가 알려주는 "내 컨펌 대기" 개수를 아이콘에 숫자로 표시
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'badge') return;
  const n = Number(msg.count) || 0;
  chrome.action.setBadgeBackgroundColor({ color: '#e8821a' });
  chrome.action.setBadgeText({ text: n ? String(n) : '' });
  chrome.action.setTitle({ title: n ? `제이엘 인트라넷 — 컨펌 대기 ${n}건` : '제이엘 인트라넷 열기' });
});
