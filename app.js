// 공통: Supabase 클라이언트, 로그인 확인, 헤더, 유틸
(function () {
  const cfg = window.INTRANET_CONFIG || {};
  const configured = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes('YOUR-PROJECT') && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.includes('YOUR-ANON-KEY');

  const sb = configured ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

  // 배포할 때마다 version.json 과 함께 올린다. 다르면 "새 버전" 안내를 띄운다.
  const APP_VERSION = '3.0.0';

  const STATUS_LABEL = { pending: '컨펌중', approved: '컨펌완료', rejected: '반려', none: '공유' };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (d.toDateString() === now.toDateString()) return `오늘 ${hm}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  }

  function fmtSize(n) {
    if (!n) return '';
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
  }

  function statusBadge(status) {
    return `<span class="badge ${esc(status)}">${STATUS_LABEL[status] || esc(status)}</span>`;
  }

  let toastTimer;
  function toast(msg, isError) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = 'show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = ''), isError ? 4000 : 2200);
  }

  // Supabase 오류 메시지를 사용자용 문장으로
  function errMsg(e) {
    const m = (e && (e.message || e.error_description)) || String(e);
    if (m.includes('Invalid login credentials')) return '이메일 또는 비밀번호가 맞지 않습니다. 비밀번호를 정하지 않았다면 [이메일 코드]로 로그인하세요.';
    if (m.includes('Password should be') || m.includes('weak')) return '비밀번호는 8자 이상으로 정해 주세요.';
    if (m.includes('same as the old')) return '기존 비밀번호와 다르게 정해 주세요.';
    if (m.includes('Database error saving new user') || m.includes('초대되지 않은')) return '초대되지 않은 이메일입니다. 관리자에게 등록을 요청하세요.';
    if (m.includes('Token has expired') || m.includes('invalid')) return '인증 코드가 올바르지 않거나 만료되었습니다.';
    if (m.includes('rate limit')) return '요청이 너무 많습니다. 잠시 후 다시 시도하세요.';
    // 이미 설치된 DB 함수의 오류 문구도 화면 용어(컨펌)로 맞춘다
    return m.replace(/결재/g, '컨펌');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 카톡 인앱 브라우저 등 clipboard API 미지원 환경
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('복사했습니다. 카톡에 붙여넣으세요.');
  }

  function pageUrl(page, params) {
    const u = new URL(page, location.href);
    u.search = params ? new URLSearchParams(params).toString() : '';
    u.hash = '';
    return u.toString();
  }

  function renderHeader(profile) {
    const header = document.createElement('header');
    header.className = 'topbar';
    header.innerHTML = `
      <div class="topbar-inner">
        <a class="brand" href="home.html">📁 ${esc(cfg.COMPANY_NAME || '')} 인트라넷</a>
        <nav>
          <a href="home.html">홈</a>
          <a href="index.html">문서함</a>
          <a href="cases.html">사건</a>
          <a href="tasks.html">업무</a>
          <a href="calendar.html">일정</a>
          <a href="consults.html">상담</a>
          <a href="notices.html">공지</a>
          <a href="library.html">자료실</a>
          <a href="upload.html">＋ 올리기</a>
          ${profile && profile.role === 'admin' ? '<a href="admin.html">직원관리</a>' : ''}
          <a href="help.html" title="PC·휴대폰 설치 안내">❓ 설치</a>
          ${profile && 'Notification' in window && Notification.permission === 'default' ? '<button id="notifyBtn">🔔 알림 켜기</button>' : ''}
          ${profile ? `<button id="meBtn" title="비밀번호 설정">👤 ${esc(profile.name)}</button><button id="logoutBtn">로그아웃</button>` : ''}
        </nav>
      </div>`;
    document.body.prepend(header);
    const btn = header.querySelector('#logoutBtn');
    if (btn) btn.onclick = async () => {
      try { localStorage.removeItem(WATCH_KEY); } catch {}
      await unsubscribePush();
      await sb.auth.signOut();
      location.href = 'login.html';
    };
    const mb = header.querySelector('#meBtn');
    if (mb) mb.onclick = () => openPasswordDialog();
    const nb = header.querySelector('#notifyBtn');
    if (nb) nb.onclick = async () => {
      const r = await Notification.requestPermission();
      nb.remove();
      if (r === 'granted') subscribePush(profile).catch(e => console.warn('푸시 등록 실패', e));
      toast(r === 'granted' ? '알림을 켰습니다. 새 문서와 컨펌 차례를 알려드려요.' : '알림이 꺼져 있습니다. 브라우저 설정에서 켤 수 있어요.', r !== 'granted');
    };
  }

  // ----- 휴대폰 푸시 구독 (앱을 꺼 둬도 알림) -----
  function b64ToBytes(b64) {
    const s = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, c => c.charCodeAt(0));
  }
  async function subscribePush(me) {
    if (!cfg.VAPID_PUBLIC_KEY || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (Notification.permission !== 'granted' || !(await hasV3())) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription()
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.VAPID_PUBLIC_KEY) });
    const j = sub.toJSON();
    await sb.from('push_subscriptions').upsert({ endpoint: j.endpoint, user_id: me.id, p256dh: j.keys.p256dh, auth: j.keys.auth });
  }
  async function unsubscribePush() {
    try {
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) { await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe(); }
    } catch {}
  }

  // ----- 새 문서·내 컨펌 차례 알림 (창이 열려 있는 동안 1분마다 확인) -----
  const WATCH_KEY = 'intranet_watch';
  function notify(title, body, docId, url) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const n = new Notification(title, { body, icon: 'icons/icon-192.png', tag: `${title}-${docId}` });
    n.onclick = () => { window.focus(); location.href = url || `doc.html?id=${encodeURIComponent(docId)}`; n.close(); };
  }

  // 오늘·내일 기일은 하루에 한 번씩 알린다
  async function checkEvents() {
    if (!(await hasV2())) return;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 2);
    const { data, error } = await sb.from('events').select('id,title,starts_at,all_day,kind,location').gte('starts_at', start.toISOString()).lt('starts_at', end.toISOString());
    if (error || !data) return;
    const todayKey = start.toISOString().slice(0, 10);
    let done = [];
    try { done = JSON.parse(localStorage.getItem('intranet_ev_notified') || '[]'); } catch {}
    done = done.filter(k => k.endsWith(todayKey));
    data.forEach(e => {
      const key = `${e.id}:${todayKey}`;
      if (done.includes(key)) return;
      const d = new Date(e.starts_at);
      const isToday = d.toDateString() === new Date().toDateString();
      const when = e.all_day ? '종일' : d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
      notify(`📅 ${isToday ? '오늘' : '내일'} ${EVENT_KIND[e.kind] || '일정'}: ${e.title}`, [when, e.location].filter(Boolean).join(' · '), e.id, 'calendar.html');
      done.push(key);
    });
    try { localStorage.setItem('intranet_ev_notified', JSON.stringify(done)); } catch {}
  }

  // 새 버전이 배포되면 위쪽에 안내 띠를 띄운다 (옛 화면을 계속 쓰는 걸 막기 위해)
  async function checkVersion() {
    try {
      const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const { version } = await res.json();
      if (!version || version === APP_VERSION || document.getElementById('updateBar')) return;
      const bar = document.createElement('div');
      bar.id = 'updateBar';
      bar.innerHTML = `새 버전(${esc(version)})이 나왔습니다. <button type="button">지금 업데이트</button>`;
      bar.querySelector('button').onclick = async () => {
        try {
          if (window.caches) await Promise.all((await caches.keys()).map(k => caches.delete(k)));
          const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
          if (reg) await reg.update();
        } catch {}
        location.reload();
      };
      document.body.prepend(bar);
    } catch {}
  }

  function startWatch(me) {
    let state = null;
    try { state = JSON.parse(localStorage.getItem(WATCH_KEY) || 'null'); } catch {}
    if (!state || state.user !== me.id) state = null;

    async function check() {
      const [steps, docs] = await Promise.all([
        sb.from('approval_steps').select('id,doc_id,documents(title)').eq('approver_id', me.id).eq('state', 'current'),
        sb.from('documents').select('id,title,uploader_id,created_at').order('created_at', { ascending: false }).limit(20),
      ]);
      if (steps.error || docs.error) return;
      const stepIds = steps.data.map(s => s.id);
      const lastDocAt = docs.data[0] ? docs.data[0].created_at : '';
      // 처음 한 번은 기준만 잡고 알리지 않는다
      if (state) {
        const myTurn = steps.data.filter(s => !state.steps.includes(s.id));
        myTurn.forEach(s => notify('✍️ 컨펌 차례입니다', (s.documents && s.documents.title) || '', s.doc_id));
        docs.data.filter(d => d.created_at > state.lastDocAt && d.uploader_id !== me.id && !myTurn.some(s => s.doc_id === d.id))
          .forEach(d => notify('📄 새 문서가 올라왔습니다', d.title, d.id));
      }
      const prevAt = state ? state.lastDocAt : '';
      state = { user: me.id, steps: stepIds, lastDocAt: lastDocAt > prevAt ? lastDocAt : prevAt };
      try { localStorage.setItem(WATCH_KEY, JSON.stringify(state)); } catch {}
      setBadge(stepIds.length);
      // 크롬 확장프로그램이 있으면 툴바 아이콘에도 숫자를 표시
      window.postMessage({ type: 'intranet-badge', count: stepIds.length }, location.origin);
    }
    // v3: 나에게 온 새 업무 지시 · 새 공지
    const WATCH3 = 'intranet_watch3';
    async function checkV3() {
      if (!(await hasV3())) return;
      let st = null;
      try { st = JSON.parse(localStorage.getItem(WATCH3) || 'null'); } catch {}
      if (st && st.user !== me.id) st = null;
      const [t, n] = await Promise.all([
        sb.from('tasks').select('id,title,due_date,created_by').eq('assignee_id', me.id).neq('status', 'done'),
        sb.from('notices').select('id,title,created_by').order('created_at', { ascending: false }).limit(20),
      ]);
      if (t.error || n.error) return;
      if (st) {
        t.data.filter(x => !st.tasks.includes(x.id) && x.created_by !== me.id)
          .forEach(x => notify(`📌 새 업무: ${x.title}`, x.due_date ? `마감 ${x.due_date}` : '', x.id, 'tasks.html'));
        n.data.filter(x => !st.notices.includes(x.id) && x.created_by !== me.id)
          .forEach(x => notify(`📢 공지: ${x.title}`, '', x.id, `notices.html#${x.id}`));
      }
      try { localStorage.setItem(WATCH3, JSON.stringify({ user: me.id, tasks: t.data.map(x => x.id), notices: n.data.map(x => x.id) })); } catch {}
    }
    const safeCheck = () => {
      check().catch(e => console.warn('알림 확인 실패', e));
      checkEvents().catch(e => console.warn('일정 확인 실패', e));
      checkV3().catch(e => console.warn('업무·공지 확인 실패', e));
    };
    safeCheck();
    setInterval(safeCheck, 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { safeCheck(); checkVersion(); } });
    checkVersion();
    setInterval(checkVersion, 5 * 60 * 1000);
  }

  function showFatal(html) {
    const main = document.querySelector('main') || document.body;
    main.innerHTML = `<div class="card">${html}</div>`;
  }

  // 로그인 + 활성 직원인지 확인. 실패하면 로그인 화면으로 보낸다.
  async function requireAuth() {
    if (!sb) {
      renderHeader(null);
      showFatal('<h2>⚙️ 설정 필요</h2><p class="muted">config.js 에 Supabase URL과 anon key를 입력하세요. 자세한 방법은 README.md 를 참고하세요.</p>');
      throw new Error('not configured');
    }
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      location.replace(pageUrl('login.html', { next: location.pathname.split('/').pop() + location.search }));
      throw new Error('no session');
    }
    const { data: profile } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    if (!profile || !profile.active) {
      renderHeader(null);
      showFatal(`<h2>접근 권한이 없습니다</h2><p class="muted">${esc(session.user.email)} 계정은 비활성화되었거나 등록되지 않았습니다. 관리자에게 문의하세요.</p>
        <div class="btn-row"><button class="btn ghost" id="outBtn">다른 계정으로 로그인</button></div>`);
      document.getElementById('outBtn').onclick = async () => { await sb.auth.signOut(); location.href = 'login.html'; };
      throw new Error('inactive');
    }
    renderHeader(profile);
    startWatch(profile);
    // 알림을 이미 허용한 기기는 조용히 푸시 구독을 맞춰 둔다
    if ('Notification' in window && Notification.permission === 'granted') subscribePush(profile).catch(() => {});
    try {
      if (localStorage.getItem('intranet_pw_prompt') === 'pending') {
        localStorage.removeItem('intranet_pw_prompt');
        openPasswordDialog('로그인 완료! 비밀번호를 정해 두면 <b>다음부터는 메일 확인 없이</b> 이메일 + 비밀번호로 바로 들어옵니다.');
      }
    } catch {}
    return profile;
  }

  async function loadMembers() {
    const { data, error } = await sb.from('profiles').select('id,name,dept,role,active').eq('active', true).order('name');
    if (error) throw error;
    return data;
  }

  // ----- 비밀번호 설정 -----
  function openPasswordDialog(intro) {
    if (document.getElementById('pwDialog')) return;
    const wrap = document.createElement('div');
    wrap.id = 'pwDialog';
    wrap.className = 'modal-back';
    wrap.innerHTML = `
      <form class="card modal">
        <h2>🔑 비밀번호 설정</h2>
        <p class="muted">${intro || '비밀번호를 정해 두면 다음부터 메일 확인 없이 <b>이메일 + 비밀번호</b>로 바로 로그인합니다.'}</p>
        <label for="pw1">새 비밀번호 (8자 이상)</label>
        <input type="password" id="pw1" minlength="8" autocomplete="new-password" required>
        <label for="pw2">한 번 더</label>
        <input type="password" id="pw2" minlength="8" autocomplete="new-password" required>
        <div class="btn-row">
          <button class="btn" type="submit" style="flex:1">저장</button>
          <button class="btn ghost" type="button" data-close>나중에</button>
        </div>
      </form>`;
    const close = () => { wrap.remove(); try { localStorage.setItem('intranet_pw_prompted', '1'); } catch {} };
    wrap.querySelector('[data-close]').onclick = close;
    wrap.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const a = wrap.querySelector('#pw1').value, b = wrap.querySelector('#pw2').value;
      if (a !== b) return toast('두 비밀번호가 다릅니다.', true);
      const { error } = await sb.auth.updateUser({ password: a });
      if (error) return toast(errMsg(error), true);
      close();
      toast('비밀번호를 저장했습니다. 다음부터 비밀번호로 로그인하세요.');
    };
    document.body.appendChild(wrap);
    wrap.querySelector('#pw1').focus();
  }

  // ----- v2 (사건·일정·양식) DB 업데이트 여부 -----
  let v2Promise;
  function hasV2() {
    if (!v2Promise) v2Promise = sb.from('cases').select('id', { count: 'exact', head: true })
      .then(({ error }) => !error);
    return v2Promise;
  }
  let v3Promise;
  function hasV3() {
    if (!v3Promise) v3Promise = sb.from('tasks').select('id', { count: 'exact', head: true })
      .then(({ error }) => !error);
    return v3Promise;
  }
  const V3_NOTICE = '<div class="notice">이 메뉴를 쓰려면 DB 업데이트가 필요합니다. 관리자가 Supabase에서 <b>migrations/003_v3.sql</b>을 실행하면 바로 켜집니다.</div>';
  const TASK_STATUS = { todo: '할 일', doing: '진행중', done: '완료' };
  const CONSULT_STATUS = { new: '신규', followup: '후속 연락', retained: '수임', dropped: '종료' };
  function ymdLocal(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  function ddayDate(ymd) { return ymd ? dday(`${ymd}T00:00:00`) : ''; }

  const V2_NOTICE = '<div class="notice">사건·일정·양식 기능을 쓰려면 DB 업데이트가 필요합니다. 관리자가 Supabase에서 <b>migrations/002_v2.sql</b>을 실행하면 바로 켜집니다.</div>';

  async function loadCases(includeClosed) {
    let q = sb.from('cases').select('id,name,client,case_no,status').order('created_at', { ascending: false });
    if (!includeClosed) q = q.eq('status', 'open');
    const { data, error } = await q;
    if (error) throw error;
    return data;
  }

  const EVENT_KIND = { hearing: '기일', deadline: '마감', meeting: '미팅', etc: '기타' };
  function fmtWon(n) { return (Number(n) || 0).toLocaleString('ko-KR') + '원'; }
  function dday(iso) {
    const d = new Date(iso); d.setHours(0, 0, 0, 0);
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const n = Math.round((d - t) / 86400000);
    return n === 0 ? 'D-DAY' : n > 0 ? `D-${n}` : `D+${-n}`;
  }

  // 필요할 때만 외부 라이브러리를 불러온다 (같은 주소는 한 번만)
  const scriptCache = {};
  function loadScript(src) {
    return scriptCache[src] || (scriptCache[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { delete scriptCache[src]; reject(new Error('라이브러리를 불러오지 못했습니다')); };
      document.head.appendChild(s);
    }));
  }

  function fileIcon(type, name) {
    const n = (name || '').toLowerCase();
    if (type === 'application/pdf' || n.endsWith('.pdf')) return '📕';
    if (n.match(/\.pptx?$/)) return '📙';
    if (n.match(/\.xlsx?$/)) return '📗';
    if (n.match(/\.docx?$/) || n.endsWith('.hwp')) return '📘';
    if ((type || '').startsWith('image/')) return '🖼️';
    return '📄';
  }

  // ----- 홈 화면 앱 (PWA) -----
  const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const isInApp = /KAKAOTALK|NAVER|Instagram|FBAN|FBAV|Line\//i.test(ua);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  function tipDismissed() {
    try { return localStorage.getItem('intranet_install_tip') === 'off'; } catch { return false; }
  }

  function showInstallTip(text, onInstall) {
    if (isStandalone || tipDismissed() || document.querySelector('.install-tip')) return;
    const render = () => {
      const el = document.createElement('div');
      el.className = 'install-tip';
      el.innerHTML = `<img src="icons/icon-192.png" alt="">
        <div class="txt">${text}</div>
        ${onInstall ? '<button class="btn sm" data-act="install">설치</button>' : ''}
        <button class="close" data-act="close" aria-label="닫기">✕</button>`;
      el.onclick = async (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'install') await onInstall();
        if (act === 'install' || act === 'close') {
          el.remove();
          try { localStorage.setItem('intranet_install_tip', 'off'); } catch {}
        }
      };
      document.body.appendChild(el);
    };
    document.body ? render() : document.addEventListener('DOMContentLoaded', render);
  }

  // 안드로이드·PC 크롬: 브라우저가 설치 가능하다고 알려주면 버튼 하나로 설치
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    showInstallTip('<b>인트라넷을 앱으로 설치</b>하면 홈 화면에서 바로 열 수 있어요.', async () => {
      e.prompt();
      await e.userChoice.catch(() => {});
    });
  });

  // 카톡 안 브라우저나 아이폰 사파리는 설치 버튼이 없어서 방법을 안내
  if (!isStandalone) {
    if (isInApp && (isIOS || isAndroid)) {
      showInstallTip(isIOS
        ? '앱으로 설치하려면 오른쪽 아래 <b>⋯ → Safari로 열기</b> 후 설치하세요.'
        : '앱으로 설치하려면 오른쪽 위 <b>⋮ → 다른 브라우저로 열기</b>(크롬) 후 설치하세요.');
    } else if (isIOS) {
      showInstallTip('앱으로 설치: 아래 <b>공유 버튼(⬆︎) → 홈 화면에 추가</b>');
    }
  }

  // 앱 아이콘에 숫자 배지 (지원하는 기기만)
  function setBadge(n) {
    if (!('setAppBadge' in navigator)) return;
    (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  }

  window.App = { sb, cfg, configured, esc, fmtDate, fmtSize, statusBadge, toast, errMsg, copyText, pageUrl, requireAuth, loadMembers, loadScript, fileIcon, setBadge, hasV2, V2_NOTICE, hasV3, V3_NOTICE, TASK_STATUS, CONSULT_STATUS, ymdLocal, ddayDate, loadCases, EVENT_KIND, fmtWon, dday, openPasswordDialog, STATUS_LABEL };
})();
