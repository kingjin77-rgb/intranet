// 홈 화면 앱용 서비스워커.
// 이 사이트의 파일(html/css/js/아이콘)만 "네트워크 우선, 끊기면 캐시"로 처리한다.
// Supabase(로그인·데이터·파일)와 CDN 요청은 건드리지 않는다.
const CACHE = 'intranet-v3-1';
const SHELL = [
  './', './index.html', './doc.html', './upload.html', './login.html', './admin.html',
  './cases.html', './case.html', './calendar.html', './help.html',
  './home.html', './tasks.html', './consults.html', './notices.html', './library.html',
  './style.css', './app.js', './config.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      // 쿼리(?id=...)가 달라도 같은 페이지 껍데기를 돌려준다
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});

// ----- 휴대폰 푸시 알림 (send-push 함수가 보냄) -----
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || '제이엘 인트라넷', {
    body: d.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/favicon-32.png',
    tag: d.url || undefined,
    data: { url: d.url || 'home.html' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(e.notification.data && e.notification.data.url || 'home.html', self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = wins.find(w => w.url.startsWith(self.registration.scope));
    if (same) { await same.focus(); return same.navigate(target); }
    return self.clients.openWindow(target);
  })());
});
