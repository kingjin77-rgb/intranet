// 공통: Supabase 클라이언트, 로그인 확인, 헤더, 유틸
(function () {
  const cfg = window.INTRANET_CONFIG || {};
  const configured = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes('YOUR-PROJECT') && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.includes('YOUR-ANON-KEY');

  const sb = configured ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

  // 배포할 때마다 version.json 과 함께 올린다. 다르면 "새 버전" 안내를 띄운다.
  const APP_VERSION = '6.3.2';

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
    if ((/schema cache|does not exist/.test(m) && /annotation_replies/.test(m)) || /doc_annotations_kind_check/.test(m)) return '고쳐쓰기·답글을 쓰려면 DB 업데이트가 필요합니다. 관리자가 Supabase에서 migrations/011_fix.sql 을 실행하면 바로 켜집니다.';
    if (/schema cache|does not exist|Could not find the function/.test(m) && /set_avatar|avatar/.test(m)) return '아바타 저장은 관리자가 Supabase에서 migrations/010_v6.sql 을 실행한 뒤에 됩니다.';
    if (/schema cache|does not exist/.test(m) && /admin_set_title|title/.test(m)) return '직함(변호사님 호칭)은 관리자가 Supabase에서 migrations/010_v6.sql 을 실행한 뒤에 됩니다.';
    if (/schema cache|does not exist/.test(m) && /doc_annotations|toggle_annotation/.test(m)) return V6_NOTICE_TEXT;
    if (/schema cache|does not exist/.test(m) && /comment_reactions|attachments|add_approvers|extra_files|create_document_v3|chat_|presence|admin_user_status|leave_|attendance|bookings|resources|clock|nudge_doc|set_doc_due|toggle_comment|storage_usage|offboard|activity_log/.test(m))
      return /leave_|attendance|bookings|resources|clock|nudge_doc|set_doc_due|toggle_comment|storage_usage|offboard|activity_log/.test(m)
        ? 'DB 업데이트가 필요합니다. 관리자가 Supabase에서 migrations/008_v5.sql 을 실행하면 바로 됩니다.'
        : /chat_|presence|admin_user_status/.test(m)
        ? 'DB 업데이트가 필요합니다. 관리자가 Supabase에서 migrations/007_chat.sql 을 실행하면 바로 됩니다.'
        : /extra_files|create_document_v3/.test(m)
        ? 'DB 업데이트가 필요합니다. 관리자가 Supabase에서 migrations/006_files.sql 을 실행하면 바로 됩니다.'
        : 'DB 업데이트가 필요합니다. 관리자가 Supabase에서 migrations/005_v33.sql 을 실행하면 바로 됩니다.';
    if (m.includes('반려된 문서입니다')) return '반려가 있는 문서에 컨펌자를 추가하려면 DB 업데이트가 필요합니다. 관리자가 Supabase에서 migrations/009_reject.sql 을 실행하면 바로 됩니다.';
    if (m.includes('rate limit')) return '요청이 너무 많습니다. 잠시 후 다시 시도하세요.';
    if (/Failed to fetch|NetworkError|Load failed|NotReadable|could not be read/i.test(m) || (e && e.name === 'NotReadableError'))
      return '파일을 보내지 못했습니다. 인터넷 연결을 확인하고, 파일을 고른 뒤 워드·엑셀에서 다시 저장했다면 파일을 다시 선택해 주세요.';
    // 이미 설치된 DB 함수의 오류 문구도 화면 용어(컨펌)로 맞춘다
    return m.replace(/결재/g, '컨펌');
  }

  // 고른 파일을 그 자리에서 메모리로 복사해 둔다.
  // (파일을 고른 뒤 워드에서 다시 저장하거나, 원드라이브 '온라인 전용' 파일이면 올릴 때 "Failed to fetch" 가 난다)
  async function snapshotFile(f) {
    try {
      const buf = await f.arrayBuffer();
      return new File([buf], f.name, { type: f.type, lastModified: f.lastModified });
    } catch {
      throw new Error('파일을 읽을 수 없습니다. 워드·엑셀에서 파일을 닫거나 저장을 마친 뒤, 파일을 다시 선택해 주세요. (원드라이브 파일이면 내 PC에 내려받은 뒤 선택)');
    }
  }

  // 순간적인 네트워크 끊김이면 한 번 더 시도
  async function uploadFile(path, f) {
    const opts = { contentType: f.type || 'application/octet-stream' };
    let r = await sb.storage.from('docs').upload(path, f, opts);
    if (r.error && /Failed to fetch|NetworkError|Load failed/i.test(r.error.message || '')) {
      await new Promise(res => setTimeout(res, 1500));
      r = await sb.storage.from('docs').upload(path, f, opts);
    }
    return r;
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

  // ----- 화면 테마·글꼴 (페이지가 그려지기 전에 적용) -----
  // 글꼴: Pretendard (한글 가독성용, 필요한 글자만 내려받는 dynamic subset)
  (() => {
    try {
      const t = localStorage.getItem('intranet_theme');
      // 기본은 밝게. '어둡게'를 직접 고른 사람만 어두운 화면 (휴대폰 다크 모드를 따라가지 않음)
      if (t === 'dark') document.documentElement.dataset.theme = 'dark';
      const fs = localStorage.getItem('intranet_fs');
      if (fs === '1' || fs === '3') document.documentElement.dataset.fs = fs;
    } catch {}
    if (!document.querySelector('link[data-font]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.dataset.font = '1';
      l.href = 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css';
      document.head.appendChild(l);
    }
  })();
  function setTheme(t) {
    try { t === 'dark' ? localStorage.setItem('intranet_theme', 'dark') : localStorage.removeItem('intranet_theme'); } catch {}
    if (t === 'dark') document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme;
  }

  // ----- 아바타 (사진 또는 캐릭터, 없으면 이름 첫 글자) -----
  const AVATAR_COLORS = ['#2457c5', '#e8590c', '#0f8a5f', '#7048e8', '#c2255c', '#0b7285', '#b35c00', '#5c940d'];
  const CHARS = {
    fox: ['🦊', '#ffd8a8', '#ff922b'], bear: ['🐻', '#e9d5c4', '#a47148'], panda: ['🐼', '#f1f3f5', '#adb5bd'],
    tiger: ['🐯', '#ffe8a3', '#f59f00'], lion: ['🦁', '#ffec99', '#e8a400'], rabbit: ['🐰', '#ffdeeb', '#f783ac'],
    penguin: ['🐧', '#d0ebff', '#4dabf7'], koala: ['🐨', '#e9ecef', '#868e96'], frog: ['🐸', '#d3f9d8', '#51cf66'],
    dog: ['🐶', '#fff3bf', '#fab005'], cat: ['🐱', '#ffe3e3', '#ff8787'], owl: ['🦉', '#e5dbff', '#9775fa'],
  };
  const people = {};          // id → 프로필 (avatar 포함)
  const avatarUrl = {};       // 'img:경로' → 서명 URL
  function avColor(uid) {
    let h = 0;
    for (const ch of uid || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }
  // size: px. 사진은 비공개 저장소라 서명 URL 이 준비된 뒤에 보인다 (그 전엔 글자)
  function avatar(u, size = 32, cls = '') {
    const p = typeof u === 'string' ? (people[u] || { id: u }) : (u || {});
    const name = p.name || '?', a = p.avatar || '';
    const st = `width:${size}px;height:${size}px;flex-basis:${size}px;font-size:${Math.round(size * 0.44)}px`;
    if (a.startsWith('img:') && avatarUrl[a]) return `<span class="av ${cls}" style="${st}" title="${esc(name)}"><img src="${esc(avatarUrl[a])}" alt=""></span>`;
    const c = a.startsWith('char:') && CHARS[a.slice(5)];
    if (c) return `<span class="av av-char ${cls}" style="${st};background:linear-gradient(135deg,${c[1]},${c[2]});font-size:${Math.round(size * 0.58)}px" title="${esc(name)}">${c[0]}</span>`;
    return `<span class="av ${cls}" style="${st};background:${avColor(p.id)}" title="${esc(name)}">${esc(name.slice(0, 1))}</span>`;
  }
  async function signAvatars(list) {
    const need = [...new Set(list.map(p => p.avatar).filter(a => a && a.startsWith('img:') && !avatarUrl[a]))];
    if (!need.length || !sb) return;
    try {
      const { data } = await sb.storage.from('docs').createSignedUrls(need.map(a => a.slice(4)), 3600);
      (data || []).forEach((d, i) => { if (d && d.signedUrl) avatarUrl[need[i]] = d.signedUrl; });
    } catch {}
  }
  // 호칭: 직함이 있으면 'OOO 변호사님', 없으면 'OOO님'
  function honor(u) {
    const p = typeof u === 'string' ? (people[u] || {}) : (u || {});
    return `${p.name || ''}${p.title ? ' ' + p.title : ''}님`;
  }
  function remember(list) { (list || []).forEach(p => { if (p && p.id) people[p.id] = { ...people[p.id], ...p }; }); }

  // ----- 메뉴 (PC: 왼쪽 사이드바 / 휴대폰: 위쪽 바 + 아래 탭바 + 펼침 메뉴) -----
  const NAV = [
    ['home.html', '🏠', '홈'], ['chat.html', '💬', '채팅', 'chat'], ['index.html', '📄', '문서함'], ['cases.html', '⚖️', '사건'],
    ['tasks.html', '📌', '업무'], ['calendar.html', '📅', '일정'], ['consults.html', '📞', '상담'], ['notices.html', '📢', '공지'],
    ['library.html', '📁', '자료실'], ['office.html', '🕘', '근태·예약'],
  ];
  function renderHeader(profile) {
    if (profile) remember([profile]);
    const here = location.pathname.split('/').pop() || 'index.html';
    const link = ([href, icon, label, k]) => `<a href="${href}" class="${[k === 'chat' && 'nav-chat', here === href && 'on'].filter(Boolean).join(' ')}"${here === href ? ' aria-current="page"' : ''}>
        <i>${icon}</i><span>${label}</span>${k === 'chat' ? '<span class="nav-badge chat-badge" id="chatBadge" hidden></span>' : ''}</a>`;
    const header = document.createElement('header');
    header.className = 'topbar';
    header.innerHTML = `
      <div class="topbar-inner">
        <a class="brand" href="home.html"><span class="brand-logo${cfg.LOGO_URL ? ' has-img' : ''}">${cfg.LOGO_URL ? `<img src="${esc(cfg.LOGO_URL)}" alt="${esc(cfg.COMPANY_NAME || '')} 로고">` : esc((cfg.COMPANY_NAME || 'JL').slice(0, 2))}</span><span class="brand-name">${esc(cfg.FIRM_NAME || (cfg.COMPANY_NAME || '') + ' 인트라넷')}${cfg.FIRM_NAME ? '<small>인트라넷</small>' : ''}</span></a>
        ${profile ? '<button class="side-toggle" id="sideToggle" type="button" title="메뉴 접기/펴기" aria-label="메뉴 접기">«</button>' : ''}
        <button class="menu-btn" id="menuBtn" type="button" aria-label="메뉴 열기">☰</button>
        <nav>
          <button type="button" class="nav-close" id="navClose" aria-label="메뉴 닫기">✕</button>
          <a href="upload.html" class="nav-cta${here === 'upload.html' ? ' on' : ''}"><i>＋</i><span>문서 올리기</span></a>
          ${NAV.map(n => link(n) + (n[0] === 'index.html' ? `
          <a href="index.html?tab=myturn" class="nav-sub"><i>✍️</i><span>내 컨펌 대기</span><span class="nav-badge turn-badge" hidden></span></a>
          <a href="index.html?tab=unread" class="nav-sub"><i>👀</i><span>안 읽은 문서</span><span class="nav-badge unread-badge" hidden></span></a>` : '')).join('')}
          <div class="nav-sep"></div>
          ${profile && profile.role === 'admin' ? `<a href="admin.html"${here === 'admin.html' ? ' class="on"' : ''}><i>🛡</i><span>직원관리</span></a>` : ''}
          <a href="search.html" title="통합 검색"${here === 'search.html' ? ' class="on"' : ''}><i>🔍</i><span>검색</span></a>
          <a href="help.html" title="PC·휴대폰 설치 안내"${here === 'help.html' ? ' class="on"' : ''}><i>❓</i><span>설치</span></a>
          <div class="nav-foot">
            ${profile && 'Notification' in window && Notification.permission === 'default' ? '<button id="notifyBtn" type="button"><i>🔔</i><span>알림 켜기</span></button>' : ''}
            ${profile ? `<button id="meBtn" type="button" title="내 정보 · 아바타 · 비밀번호">${avatar(profile, 28, 'me-av')}<span>${esc(profile.name)}</span></button><button id="logoutBtn" type="button"><i>↪</i><span>로그아웃</span></button>` : ''}
          </div>
        </nav>
      </div>`;
    document.body.prepend(header);
    document.body.classList.add('has-nav');
    try { if (localStorage.getItem('intranet_side') === 'mini') document.body.classList.add('side-mini'); } catch {}
    // 휴대폰 아래 탭바
    if (profile) {
      const tb = document.createElement('nav');
      tb.className = 'tabbar';
      tb.innerHTML = [['home.html', '🏠', '홈'], ['index.html', '📄', '문서'], ['upload.html', '＋', '올리기'], ['chat.html', '💬', '채팅'], ['tasks.html', '📌', '업무']]
        .map(([h, i, l]) => `<a href="${h}"${here === h ? ' class="on"' : ''}><i>${i}</i><span>${l}</span>${h === 'chat.html' ? '<b class="chat-badge" hidden></b>' : ''}</a>`).join('');
      document.body.appendChild(tb);
    }
    const menu = header.querySelector('#menuBtn');
    // 휴대폰 펼침 메뉴: 덮개를 누르거나 ✕·Esc 로 닫는다
    const closeNav = () => { document.body.classList.remove('nav-open'); document.querySelectorAll('.nav-dim').forEach(d => d.remove()); };
    menu.onclick = () => {
      if (document.body.classList.contains('nav-open')) return closeNav();
      document.body.classList.add('nav-open');
      const dim = document.createElement('div');
      dim.className = 'nav-dim';
      dim.onclick = closeNav;
      document.body.appendChild(dim);
    };
    header.querySelector('#navClose').onclick = closeNav;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('nav-open')) closeNav(); });
    header.querySelector('nav').addEventListener('click', (e) => { if (e.target.closest('a')) closeNav(); });
    const st = header.querySelector('#sideToggle');
    if (st) st.onclick = () => {
      const mini = document.body.classList.toggle('side-mini');
      try { localStorage.setItem('intranet_side', mini ? 'mini' : 'full'); } catch {}
    };
    const btn = header.querySelector('#logoutBtn');
    if (btn) btn.onclick = async () => {
      try { localStorage.removeItem(WATCH_KEY); } catch {}
      await unsubscribePush();
      await sb.auth.signOut();
      location.href = 'login.html';
    };
    const mb = header.querySelector('#meBtn');
    if (mb) {
      mb.onclick = () => openProfileDialog(profile);
      // 내 사진 아바타는 서명 URL 을 받은 뒤 바꿔 끼운다
      signAvatars([profile]).then(() => { const el = mb.querySelector('.me-av'); if (el) el.outerHTML = avatar(profile.id, 28, 'me-av'); });
    }
    const nb = header.querySelector('#notifyBtn');
    if (nb) nb.onclick = async () => {
      const r = await Notification.requestPermission();
      nb.remove();
      if (r === 'granted') subscribePush(profile).catch(e => console.warn('푸시 등록 실패', e));
      toast(r === 'granted' ? '알림을 켰습니다. 새 문서·코멘트·열람 확인·컨펌을 알려드려요.' : '알림이 꺼져 있습니다. 브라우저 설정에서 켤 수 있어요.', r !== 'granted');
    };
  }

  // ----- 내 정보: 아바타(사진·캐릭터) · 화면 테마 · 비밀번호 -----
  function openProfileDialog(profile) {
    if (document.getElementById('meDialog')) return;
    const me = people[profile.id] || profile;
    const wrap = document.createElement('div');
    wrap.id = 'meDialog';
    wrap.className = 'modal-back';
    let theme = 'light';
    try { theme = localStorage.getItem('intranet_theme') === 'dark' ? 'dark' : 'light'; } catch {}
    wrap.innerHTML = `
      <div class="card modal me-modal">
        <div class="me-head"><span id="meAvPreview">${avatar(me, 64)}</span><div><h2>${esc(me.name)}</h2><p class="muted">${esc([me.dept, me.email].filter(Boolean).join(' · '))}</p></div></div>
        <h3>아바타</h3>
        ${'avatar' in me ? '' : '<div class="notice" style="margin:0 0 8px">⚠️ 아바타 저장은 관리자가 Supabase에서 <b>migrations/010_v6.sql</b> 을 실행한 뒤에 됩니다. 실행 후 화면 위 [업데이트] 또는 새로고침하세요.</div>'}
        <div class="av-grid${'avatar' in me ? '' : ' av-off'}">
          <label class="av-pick av-photo" title="사진 올리기">📷<span>사진</span><input type="file" id="avFile" accept="image/*" hidden></label>
          ${Object.keys(CHARS).map(k => `<button type="button" class="av-pick${me.avatar === 'char:' + k ? ' on' : ''}" data-char="${k}" title="${k}">${avatar({ id: me.id, name: me.name, avatar: 'char:' + k }, 40)}</button>`).join('')}
          <button type="button" class="av-pick${!me.avatar ? ' on' : ''}" data-char="" title="이름 글자">${avatar({ id: me.id, name: me.name }, 40)}</button>
        </div>
        <h3>글자 크기</h3>
        <div class="seg" id="fsSeg">${[['1', '보통'], ['2', '크게'], ['3', '아주 크게']].map(([k, v]) => `<button type="button" data-fs="${k}"${(document.documentElement.dataset.fs || '2') === k ? ' class="on"' : ''}>${v}</button>`).join('')}</div>
        <h3>화면</h3>
        <div class="seg" id="themeSeg">${[['light', '밝게'], ['dark', '어둡게']].map(([k, v]) => `<button type="button" data-theme="${k}"${theme === k ? ' class="on"' : ''}>${v}</button>`).join('')}</div>
        <div class="btn-row">
          <button class="btn ghost" type="button" id="pwOpen">🔑 비밀번호 변경</button>
          <button class="btn" type="button" data-close style="margin-left:auto">닫기</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
    wrap.querySelector('#pwOpen').onclick = () => { close(); openPasswordDialog(); };
    wrap.querySelector('#fsSeg').onclick = (e) => {
      const b = e.target.closest('[data-fs]'); if (!b) return;
      if (b.dataset.fs === '2') delete document.documentElement.dataset.fs; else document.documentElement.dataset.fs = b.dataset.fs;
      try { b.dataset.fs === '2' ? localStorage.removeItem('intranet_fs') : localStorage.setItem('intranet_fs', b.dataset.fs); } catch {}
      wrap.querySelectorAll('#fsSeg button').forEach(x => x.classList.toggle('on', x === b));
      window.dispatchEvent(new Event('resize'));
    };
    wrap.querySelector('#themeSeg').onclick = (e) => {
      const b = e.target.closest('[data-theme]'); if (!b) return;
      setTheme(b.dataset.theme);
      wrap.querySelectorAll('#themeSeg button').forEach(x => x.classList.toggle('on', x === b));
    };
    const save = async (val) => {
      if (!('avatar' in me)) return toast('아바타 저장은 관리자가 Supabase에서 migrations/010_v6.sql 을 실행한 뒤에 됩니다.', true);
      const { error } = await sb.rpc('set_avatar', { p: val || null });
      if (error) return toast(errMsg(error), true);
      me.avatar = val || null; remember([me]);
      await signAvatars([me]);
      wrap.querySelector('#meAvPreview').innerHTML = avatar(me, 64);
      wrap.querySelectorAll('.av-pick[data-char]').forEach(b => b.classList.toggle('on', (b.dataset.char ? 'char:' + b.dataset.char : '') === (val || '')));
      document.querySelectorAll('.me-av').forEach(el => (el.outerHTML = avatar(me, 28, 'me-av')));
      toast('아바타를 바꿨습니다.');
    };
    wrap.querySelectorAll('.av-pick[data-char]').forEach(b => (b.onclick = () => save(b.dataset.char ? 'char:' + b.dataset.char : '')));
    wrap.querySelector('#avFile').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (!('avatar' in me)) return toast('아바타 저장은 관리자가 Supabase에서 migrations/010_v6.sql 을 실행한 뒤에 됩니다.', true);
      try {
        // 정사각형으로 잘라 256px JPEG 로 줄여서 올린다 (원본 사진은 올리지 않음)
        const bmp = await createImageBitmap(f);
        const side = Math.min(bmp.width, bmp.height), cv = document.createElement('canvas');
        cv.width = cv.height = 256;
        cv.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
        const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.86));
        const path = `${me.id}/avatar-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.jpg`;
        const { error } = await sb.storage.from('docs').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
        if (error) return toast(errMsg(error), true);
        const old = me.avatar;
        await save('img:' + path);
        if (old && old.startsWith('img:')) sb.storage.from('docs').remove([old.slice(4)]).catch(() => {});
      } catch (err) { toast('사진을 읽지 못했습니다. JPG·PNG 사진을 골라 주세요.', true); }
    };
  }

  // ----- ✉️ 우편 전송 애니메이션: 버튼에서 봉투가 날아가 받는 사람(또는 메뉴)으로 -----
  function sendMail(from, opts = {}) {
    try {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { if (opts.label) toast(opts.label); return; }
      const src = (from && from.getBoundingClientRect) ? from.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
      const target = (opts.to && document.querySelector(opts.to)) || document.querySelector('.tabbar a.on, .topbar nav a.on') || document.querySelector('.brand');
      const dst = target ? target.getBoundingClientRect() : { left: 20, top: 20, width: 0, height: 0 };
      const x0 = src.left + src.width / 2, y0 = src.top + src.height / 2;
      const x1 = dst.left + dst.width / 2, y1 = dst.top + dst.height / 2;
      const el = document.createElement('div');
      el.className = 'mail-fly' + (opts.small ? ' small' : '');
      el.innerHTML = opts.small ? '<span>🕊️</span>' : '<span class="env"><b class="flap"></b><b class="body"></b><b class="seal">✉️</b></span>';
      el.style.left = x0 + 'px'; el.style.top = y0 + 'px';
      document.body.appendChild(el);
      const lift = Math.min(240, Math.abs(x1 - x0) * 0.4 + 120);
      const anim = el.animate([
        { transform: 'translate(-50%,-50%) scale(.4) rotate(0deg)', opacity: 0 },
        { transform: 'translate(-50%,-50%) scale(1.1) rotate(-6deg)', opacity: 1, offset: 0.18 },
        { transform: `translate(calc(-50% + ${(x1 - x0) * 0.5}px), calc(-50% + ${(y1 - y0) * 0.5 - lift}px)) scale(.9) rotate(${x1 > x0 ? 18 : -18}deg)`, opacity: 1, offset: 0.6 },
        { transform: `translate(calc(-50% + ${x1 - x0}px), calc(-50% + ${y1 - y0}px)) scale(.25) rotate(0deg)`, opacity: 0.2 },
      ], { duration: opts.small ? 650 : 1100, easing: 'cubic-bezier(.45,.05,.35,1)' });
      anim.onfinish = () => {
        el.remove();
        if (target) { target.classList.remove('mail-hit'); void target.offsetWidth; target.classList.add('mail-hit'); }
        if (opts.label) {
          const b = document.createElement('div');
          b.className = 'mail-done'; b.textContent = opts.label;
          b.style.left = x1 + 'px'; b.style.top = y1 + 'px';
          document.body.appendChild(b);
          setTimeout(() => b.remove(), 1600);
        }
      };
    } catch {}
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

  // 앱 아이콘·확장 아이콘 숫자 = 내 컨펌 대기 + 안 읽은 채팅
  const badgeState = { confirm: 0, chat: 0 };
  function pushBadge() {
    const n = badgeState.confirm + badgeState.chat;
    setBadge(n);
    // 크롬 확장프로그램이 있으면 툴바 아이콘에도 숫자를 표시
    window.postMessage({ type: 'intranet-badge', count: n }, location.origin);
    document.querySelectorAll('.chat-badge').forEach(el => { el.textContent = badgeState.chat > 99 ? '99+' : String(badgeState.chat); el.hidden = !badgeState.chat; });
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
        // 변호사님께는 '검토 부탁드립니다', 나머지는 'OOO님, 컨펌 부탁드립니다'
        myTurn.forEach(s => notify(me.title === '변호사' ? `⚖️ ${honor(me)}, 검토 부탁드립니다` : `✍️ ${honor(me)}, 컨펌 부탁드립니다`, (s.documents && s.documents.title) || '', s.doc_id));
        docs.data.filter(d => d.created_at > state.lastDocAt && d.uploader_id !== me.id && !myTurn.some(s => s.doc_id === d.id))
          .forEach(d => notify('📄 새 문서가 올라왔습니다', d.title, d.id));
      }
      const prevAt = state ? state.lastDocAt : '';
      state = { user: me.id, steps: stepIds, lastDocAt: lastDocAt > prevAt ? lastDocAt : prevAt };
      try { localStorage.setItem(WATCH_KEY, JSON.stringify(state)); } catch {}
      badgeState.confirm = stepIds.length;
      document.querySelectorAll('.turn-badge').forEach(el => { el.textContent = stepIds.length; el.hidden = !stepIds.length; });
      pushBadge();
      // 메뉴의 '안 읽은 문서' 숫자 (최근 문서 중 내가 아직 안 연 것)
      const [recent, seen] = await Promise.all([
        sb.from('documents').select('id,uploader_id,group_id,version').order('created_at', { ascending: false }).limit(200),
        sb.from('document_views').select('doc_id').eq('user_id', me.id),
      ]);
      if (!recent.error && !seen.error) {
        const seenSet = new Set((seen.data || []).map(v => v.doc_id));
        const latest = {};
        (recent.data || []).forEach(d => { const g = d.group_id || d.id; if (!latest[g] || d.version > latest[g].version) latest[g] = d; });
        const n = Object.values(latest).filter(d => d.uploader_id !== me.id && !seenSet.has(d.id)).length;
        document.querySelectorAll('.unread-badge').forEach(el => { el.textContent = n > 99 ? '99+' : n; el.hidden = !n; });
      }
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
    // 내 문서·내가 관여한 문서의 새 코멘트, 내 문서를 누가 열어봤는지, 컨펌·반려 결과
    const WATCH_ACT = 'intranet_watch_act';
    async function checkActivity() {
      let st = null;
      try { st = JSON.parse(localStorage.getItem(WATCH_ACT) || 'null'); } catch {}
      if (st && st.user !== me.id) st = null;
      // 서버 시각 기준 커서: 처음엔 지금, 이후엔 마지막으로 본 코멘트·열람 시각
      const since = st ? st.since : new Date().toISOString();
      const [mine, myCm, mySteps] = await Promise.all([
        sb.from('documents').select('id,title,status').eq('uploader_id', me.id).order('created_at', { ascending: false }).limit(200),
        sb.from('comments').select('doc_id').eq('user_id', me.id).limit(500),
        sb.from('approval_steps').select('doc_id').eq('approver_id', me.id).limit(500),
      ]);
      if (mine.error || myCm.error || mySteps.error) return;
      const myIds = mine.data.map(d => d.id);
      const related = [...new Set([...myIds, ...myCm.data.map(r => r.doc_id), ...mySteps.data.map(r => r.doc_id)])];
      // 다른 문서라도 나를 @언급한 코멘트
      let mention = { data: [] };
      try {
        if (me.name) mention = await sb.from('comments').select('id,doc_id,body,user_id,created_at,profiles(name),documents(title)')
          .ilike('body', `%@${me.name}%`).neq('user_id', me.id).gt('created_at', since).limit(10);
      } catch (e) { console.warn('멘션 확인 실패', e); }
      const [cm, vw] = await Promise.all([
        related.length ? sb.from('comments').select('id,doc_id,body,user_id,created_at,profiles(name),documents(title)')
          .in('doc_id', related).neq('user_id', me.id).gt('created_at', since).order('created_at') : { data: [] },
        myIds.length ? sb.from('document_views').select('doc_id,user_id,first_viewed_at,profiles(name),documents(title)')
          .in('doc_id', myIds).neq('user_id', me.id).gt('first_viewed_at', since) : { data: [] },
      ]);
      if (cm.error || vw.error) return;
      const status = Object.fromEntries(mine.data.map(d => [d.id, d.status]));
      if (st) {
        const mentioned = new Set((mention.data || []).map(c => c.id));
        (mention.data || []).forEach(c => notify(`📣 ${(c.profiles && c.profiles.name) || ''}님이 언급: ${(c.documents && c.documents.title) || ''}`, c.body.slice(0, 80), c.doc_id));
        cm.data.filter(c => !mentioned.has(c.id)).forEach(c => notify(`💬 ${(c.profiles && c.profiles.name) || ''}: ${(c.documents && c.documents.title) || ''}`, (c.body || '📎 첨부').slice(0, 80), c.doc_id));
        vw.data.forEach(v => notify(`👀 ${(v.profiles && v.profiles.name) || ''}님이 확인했습니다`, (v.documents && v.documents.title) || '', v.doc_id));
        mine.data.filter(d => st.status[d.id] === 'pending' && d.status !== 'pending')
          .forEach(d => notify(d.status === 'approved' ? `🎉 최종 컨펌완료: ${d.title}` : `↩️ 반려: ${d.title}`, '', d.id));
      }
      const next = [since, ...cm.data.map(c => c.created_at), ...vw.data.map(v => v.first_viewed_at), ...(mention.data || []).map(c => c.created_at)]
        .reduce((a, b) => (new Date(b) > new Date(a) ? b : a));
      try { localStorage.setItem(WATCH_ACT, JSON.stringify({ user: me.id, since: next, status })); } catch {}
    }
    // v4: 접속 상태 기록 + 안 읽은 채팅 수 + 새 메시지 PC 알림
    const WATCH_CHAT = 'intranet_watch_chat';
    async function checkChat() {
      if (!(await hasV4())) return;
      const ext = document.documentElement.dataset.intranetExt === '1';
      sb.rpc('touch_presence', { p_client: isStandalone ? 'app' : ext ? 'ext' : 'web', p_ua: navigator.userAgent.slice(0, 300) }).then(() => {}, () => {});
      const { data: un } = await sb.rpc('chat_unread');
      badgeState.chat = (un || []).reduce((a, r) => a + (r.unread || 0), 0);
      pushBadge();
      let st = null;
      try { st = JSON.parse(localStorage.getItem(WATCH_CHAT) || 'null'); } catch {}
      if (st && st.user !== me.id) st = null;
      const since = st ? st.since : new Date().toISOString();
      const { data, error } = await sb.from('chat_messages').select('id,room_id,user_id,body,attachments,created_at,profiles(name),chat_rooms(kind,name)')
        .gt('created_at', since).neq('user_id', me.id).is('deleted_at', null).order('created_at').limit(20);
      if (error) return;
      const watching = (id) => /chat\.html$/.test(location.pathname) && window.__chatRoom === id && !document.hidden;
      if (st) (data || []).filter(m => !watching(m.room_id)).forEach(m => {
        const room = m.chat_rooms || {};
        const who = (m.profiles && m.profiles.name) || '';
        notify(`💬 ${who}${room.kind && room.kind !== 'dm' ? ` (${room.name || ''})` : ''}`,
          (m.body || '').slice(0, 80) || '📎 첨부', m.room_id, `chat.html#${m.room_id}`);
      });
      const next = [since, ...(data || []).map(m => m.created_at)].reduce((a, b) => (new Date(b) > new Date(a) ? b : a));
      try { localStorage.setItem(WATCH_CHAT, JSON.stringify({ user: me.id, since: next })); } catch {}
    }
    refreshChat = () => checkChat().catch(() => {});
    const safeCheck = () => {
      check().catch(e => console.warn('알림 확인 실패', e));
      checkChat().catch(e => console.warn('채팅 확인 실패', e));
      checkActivity().catch(e => console.warn('코멘트·열람 확인 실패', e));
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
    // '*': 010 실행 뒤엔 avatar 도 함께 (실행 전엔 컬럼이 없어도 오류 없이)
    const { data, error } = await sb.from('profiles').select('*').eq('active', true).order('name');
    if (error) throw error;
    remember(data);
    await signAvatars(data);
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
    // HEAD 요청은 테이블이 없어도 오류가 안 잡히는 경우가 있어 GET 으로 확인한다
    if (!v2Promise) v2Promise = sb.from('cases').select('id').limit(1)
      .then(({ error, data }) => !error && Array.isArray(data), () => false);
    return v2Promise;
  }
  let v3Promise, v4Promise, v5Promise;
  function hasV5() {
    if (!v5Promise) v5Promise = sb.from('leave_requests').select('id').limit(1)
      .then(({ error, data }) => !error && Array.isArray(data), () => false);
    return v5Promise;
  }
  let v6Promise;
  function hasV6() {
    if (!v6Promise) v6Promise = sb.from('doc_annotations').select('id').limit(1)
      .then(({ error, data }) => !error && Array.isArray(data), () => false);
    return v6Promise;
  }
  const V6_NOTICE_TEXT = '첨삭을 쓰려면 DB 업데이트가 필요합니다. 관리자가 Supabase에서 migrations/010_v6.sql 을 실행하면 바로 켜집니다.';
  const V5_NOTICE = '<div class="notice">이 기능을 쓰려면 DB 업데이트가 필요합니다. 관리자가 Supabase에서 <b>migrations/008_v5.sql</b>을 실행하면 바로 켜집니다.</div>';
  // 파일 저장 (링크를 문서에 붙였다 떼야 파일 이름이 지켜진다)
  function saveFile(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  // 컨펌 기한 배지: D-3 / 오늘까지 / 기한 지남
  function dueBadge(due) {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const n = Math.round((new Date(due + 'T00:00:00') - t) / 86400000);
    return n < 0 ? `<span class="badge rejected">⏰ ${-n}일 지남</span>` : n === 0 ? '<span class="badge pending">⏰ 오늘까지</span>'
      : `<span class="badge none">⏰ D-${n}</span>`;
  }
  // 다운로드 같은 활동 기록 (008 전이면 조용히 넘어감)
  function logActivity(action, type, id, detail) {
    sb.rpc('log_activity', { p_action: action, p_target_type: type, p_target_id: String(id || ''), p_detail: detail || '' }).then(() => {}, () => {});
  }
  // 입력칸에서 @ 를 치면 직원 이름 추천
  function attachMention(ta, getNames) {
    const box = document.createElement('div');
    box.className = 'mention-box';
    box.hidden = true;
    ta.parentElement.style.position = ta.parentElement.style.position || 'relative';
    ta.insertAdjacentElement('afterend', box);
    let start = -1, items = [], sel = 0;
    const close = () => { box.hidden = true; start = -1; };
    const pick = (name) => {
      const pos = ta.selectionStart;
      ta.value = ta.value.slice(0, start) + '@' + name + ' ' + ta.value.slice(pos);
      ta.selectionStart = ta.selectionEnd = start + name.length + 2;
      close(); ta.focus(); ta.dispatchEvent(new Event('input'));
    };
    ta.addEventListener('input', () => {
      const upto = ta.value.slice(0, ta.selectionStart);
      const m = upto.match(/(^|\s)@([^\s@]{0,10})$/);
      if (!m) return close();
      start = upto.length - m[2].length - 1;
      items = getNames().filter(n => n && n.includes(m[2])).slice(0, 6);
      if (!items.length) return close();
      sel = 0;
      box.innerHTML = items.map((n, i) => `<button type="button" class="${i ? '' : 'on'}" data-n="${esc(n)}">@${esc(n)}</button>`).join('');
      box.hidden = false;
    });
    ta.addEventListener('keydown', (e) => {
      if (box.hidden) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sel = (sel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        box.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === sel));
      } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing) {
        e.preventDefault(); e.stopImmediatePropagation(); pick(items[sel]);
      } else if (e.key === 'Escape') close();
    }, true);
    box.addEventListener('mousedown', (e) => { const b = e.target.closest('button'); if (b) { e.preventDefault(); pick(b.dataset.n); } });
    ta.addEventListener('blur', () => setTimeout(close, 150));
  }
  let refreshChat = () => {};
  function hasV4() {
    if (!v4Promise) v4Promise = sb.from('chat_rooms').select('id').limit(1)
      .then(({ error, data }) => !error && Array.isArray(data), () => false);
    return v4Promise;
  }
  const V4_NOTICE = '<div class="notice">채팅을 쓰려면 DB 업데이트가 필요합니다. 관리자가 Supabase에서 <b>migrations/007_chat.sql</b>을 실행하면 바로 켜집니다.</div>';
  function hasV3() {
    if (!v3Promise) v3Promise = sb.from('tasks').select('id').limit(1)
      .then(({ error, data }) => !error && Array.isArray(data), () => false);
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
    if ((type || '').startsWith('video/') || n.match(/\.(mp4|m4v|mov|webm)$/)) return '🎬';
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
    try { return localStorage.getItem('intranet_install_tip2') === 'off'; } catch { return false; }
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
          try { localStorage.setItem('intranet_install_tip2', 'off'); } catch {}
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
      showInstallTip('<a href="install.html"><b>📲 휴대폰 앱으로 설치하기</b></a><br>카톡에서는 설치가 안 돼요. 눌러서 안내대로 하세요.');
    } else if (isIOS || isAndroid) {
      showInstallTip('<a href="install.html"><b>📲 휴대폰 앱으로 설치하기</b></a><br>홈 화면 아이콘으로 열고 알림도 받아요.');
    }
  }

  // 앱 아이콘에 숫자 배지 (지원하는 기기만)
  function setBadge(n) {
    if (!('setAppBadge' in navigator)) return;
    (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  }

  window.App = { honor, avatar, avColor, people, remember, signAvatars, sendMail, setTheme, hasV6, V6_NOTICE_TEXT, saveFile, dueBadge, hasV5, V5_NOTICE, logActivity, attachMention, hasV4, V4_NOTICE, refreshChatBadge: () => refreshChat(), snapshotFile, uploadFile, sb, cfg, configured, esc, fmtDate, fmtSize, statusBadge, toast, errMsg, copyText, pageUrl, requireAuth, loadMembers, loadScript, fileIcon, setBadge, hasV2, V2_NOTICE, hasV3, V3_NOTICE, TASK_STATUS, CONSULT_STATUS, ymdLocal, ddayDate, loadCases, EVENT_KIND, fmtWon, dday, openPasswordDialog, STATUS_LABEL };
})();
