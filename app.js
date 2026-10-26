// 공통: Supabase 클라이언트, 로그인 확인, 헤더, 유틸
(function () {
  const cfg = window.INTRANET_CONFIG || {};
  const configured = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes('YOUR-PROJECT') && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.includes('YOUR-ANON-KEY');

  const sb = configured ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

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
        <a class="brand" href="index.html">📁 ${esc(cfg.COMPANY_NAME || '')} 인트라넷</a>
        <nav>
          <a href="index.html">문서함</a>
          <a href="upload.html">＋ 올리기</a>
          ${profile && profile.role === 'admin' ? '<a href="admin.html">직원관리</a>' : ''}
          ${profile ? `<span class="me">${esc(profile.name)}</span><button id="logoutBtn">로그아웃</button>` : ''}
        </nav>
      </div>`;
    document.body.prepend(header);
    const btn = header.querySelector('#logoutBtn');
    if (btn) btn.onclick = async () => { await sb.auth.signOut(); location.href = 'login.html'; };
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
    return profile;
  }

  async function loadMembers() {
    const { data, error } = await sb.from('profiles').select('id,name,dept,role,active').eq('active', true).order('name');
    if (error) throw error;
    return data;
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

  window.App = { sb, cfg, configured, esc, fmtDate, fmtSize, statusBadge, toast, errMsg, copyText, pageUrl, requireAuth, loadMembers, fileIcon, setBadge, STATUS_LABEL };
})();
