// 인트라넷 페이지(app.js)가 보내는 배지 숫자를 확장프로그램 아이콘으로 전달한다.
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.type !== 'intranet-badge') return;
  chrome.runtime.sendMessage({ type: 'badge', count: e.data.count }).catch(() => {});
});
