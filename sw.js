// 홈 화면 앱용 서비스워커.
// 이 사이트의 파일(html/css/js/아이콘)만 "네트워크 우선, 끊기면 캐시"로 처리한다.
// Supabase(로그인·데이터·파일)와 CDN 요청은 건드리지 않는다.
const CACHE = 'intranet-v1';
const SHELL = [
  './', './index.html', './doc.html', './upload.html', './login.html', './admin.html',
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
