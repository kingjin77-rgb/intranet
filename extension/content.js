// 인트라넷 페이지(app.js)가 보내는 배지 숫자를 확장프로그램 아이콘으로 전달한다.
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.type !== 'intranet-badge') return;
  chrome.runtime.sendMessage({ type: 'badge', count: e.data.count }).catch(() => {});
});

// 확장프로그램 창으로 접속했다는 표시 (관리자 화면의 '사용 기기'에 🧩로 보임)
document.documentElement.dataset.intranetExt = '1';
