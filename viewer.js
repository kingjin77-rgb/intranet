// =====================================================================
// 문서 뷰어 (v6): 전체화면 · 확대/축소 · 페이지 이동 · 첨삭 레이어
//   PDF 는 pdf.js 로 직접 그려서 그 위에 펜·형광펜·밑줄·메모·도장을 겹친다.
//   워드는 docx-preview 페이지, 사진은 <img> 위에 같은 레이어를 붙인다.
//   좌표는 페이지 크기 기준 0~1 비율로 저장 → 화면 크기·확대와 무관하게 같은 자리.
// =====================================================================
(() => {
  const { sb, esc, fmtDate, toast, errMsg } = App;
  const CDN = 'https://cdn.jsdelivr.net/npm/';
  const PDFJS = CDN + 'pdfjs-dist@3.11.174/build/';
  const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#f59e0b', '#111827'];
  const HL_COLOR = '#facc15';
  const STAMPS = { ok: '확인', fix: '수정요망', approved: '컨펌', rejected: '반려' };
  const KIND_LABEL = { fix: '✍️ 고쳐쓰기', pen: '✏️ 펜', highlight: '🖍 형광펜', underline: '＿ 밑줄', note: '📝 메모', stamp: '🔖 도장' };

  let ctx = null;          // init 에서 받는 문서·사용자 정보
  let host = null;         // #viewerBody
  let card = null;         // #viewerCard
  let pages = [];          // [{el, num, layer}]
  let filePath = '';
  let zoom = 1, zoomable = null;   // 현재 파일의 확대 함수
  let anns = [], prevAnns = [], showPrev = false, hidden = new Set();
  let mode = null, tool = 'pen', color = COLORS[0], stampKind = 'ok';
  let canMarkup = false, mineThisSession = [];
  let replies = {}, hasReplies = false;   // 첨삭 답글 (011): ann_id → [{id,user_id,body,created_at}]
  let io = null;
  let current = null;      // 비교(diff.js)용: { kind: 'pdf'|'docx', pdf, pages, box }

  // ---------------------------------------------------------------
  // 공통 툴바
  // ---------------------------------------------------------------
  function buildToolbar() {
    let bar = card.querySelector('.pv-bar');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'pv-bar';
    bar.innerHTML = `
      <div class="pv-row">
        <button type="button" class="pv-btn" data-act="full" title="전체화면 (Esc 로 닫기)">⛶ <span>전체화면</span></button>
        <span class="pv-zoom" hidden>
          <button type="button" class="pv-btn" data-act="out" title="축소">－</button>
          <button type="button" class="pv-btn pv-zv" data-act="fit" title="폭에 맞추기">100%</button>
          <button type="button" class="pv-btn" data-act="in" title="확대">＋</button>
        </span>
        <span class="pv-nav" hidden>
          <button type="button" class="pv-btn" data-act="prev" title="이전 페이지">‹</button>
          <span class="pv-pg">1 / 1</span>
          <button type="button" class="pv-btn" data-act="next" title="다음 페이지">›</button>
        </span>
        <button type="button" class="pv-btn pv-wide" data-act="wide" title="오른쪽 칸을 아래로 내리고 넓게 보기">▭ <span>넓게 보기</span></button>
        <span class="pv-sp"></span>
        <button type="button" class="pv-btn pv-mk" data-act="markup" hidden>✏️ <span>첨삭</span></button>
        <button type="button" class="pv-btn pv-x" data-act="exitfull" hidden title="닫기">✕</button>
      </div>
      <div class="pv-tools" hidden>
        <button type="button" class="pv-tool pv-tool-fix" data-tool="fix" title="고쳐쓰기: 고칠 글자 위를 끌면 취소선이 그어지고, 고칠 문구를 입력합니다">✍️ 고쳐쓰기</button>
        <button type="button" class="pv-tool" data-tool="pen" title="펜 (자유롭게 그리기)">✏️ 펜</button>
        <button type="button" class="pv-tool" data-tool="highlight" title="형광펜 (끌어서 칠하기)">🖍 형광펜</button>
        <button type="button" class="pv-tool" data-tool="underline" title="밑줄 (끌어서 긋기) — 첨삭 목록에 고침 체크가 생겨요">＿ 밑줄</button>
        <button type="button" class="pv-tool" data-tool="note" title="메모 (누른 자리에 말풍선)">📝 메모</button>
        <span class="pv-stampwrap">
          <button type="button" class="pv-tool" data-tool="stamp" title="도장 찍기">🔖 도장</button>
          <select class="pv-stampsel" title="도장 종류">${Object.entries(STAMPS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        </span>
        <button type="button" class="pv-tool" data-tool="eraser" title="지우개 (내 첨삭 누르면 삭제)">🧽 지우개</button>
        <span class="pv-colors">${COLORS.map((c, i) => `<button type="button" class="pv-color${i ? '' : ' on'}" data-color="${c}" style="--c:${c}" title="색"></button>`).join('')}</span>
        <button type="button" class="pv-btn" data-act="undo" title="방금 한 첨삭 되돌리기">↶</button>
        <button type="button" class="pv-btn pv-done" data-act="markup">완료</button>
      </div>
      <div class="pv-people" hidden></div>`;
    card.insertBefore(bar, host);
    bar.addEventListener('click', onBarClick);
    bar.querySelector('.pv-stampsel').onchange = (e) => { stampKind = e.target.value; setTool('stamp'); };
    document.addEventListener('fullscreenchange', syncFull);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && card.classList.contains('pv-full') && !document.fullscreenElement) setFull(false);
      if (mode && (e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    });
    return bar;
  }

  function onBarClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) return setTool(b.dataset.tool);
    if (b.dataset.color) {
      color = b.dataset.color;
      card.querySelectorAll('.pv-color').forEach(x => x.classList.toggle('on', x === b));
      if (tool === 'eraser' || tool === 'stamp') setTool('pen');
      return;
    }
    if (b.dataset.who) {
      const id = b.dataset.who;
      hidden.has(id) ? hidden.delete(id) : hidden.add(id);
      b.classList.toggle('off', hidden.has(id));
      return drawAll();
    }
    switch (b.dataset.act) {
      case 'full': return setFull(!isFull());
      case 'exitfull': return setFull(false);
      case 'wide': {
        const on = document.body.classList.toggle('doc-wide');
        b.classList.toggle('on', on);
        try { localStorage.setItem('doc_wide', on ? '1' : '0'); } catch {}
        return zoomable && zoomable(zoom);
      }
      case 'in': return setZoom(zoom * 1.2);
      case 'out': return setZoom(zoom / 1.2);
      case 'fit': return setZoom(1);
      case 'prev': return goPage(curPage() - 1);
      case 'next': return goPage(curPage() + 1);
      case 'markup': return setMode(!mode);
      case 'undo': return undo();
      case 'prevAnns': showPrev = !showPrev; b.classList.toggle('on', showPrev); return drawAll();
    }
  }

  // ----- 전체화면 (지원 안 되는 아이폰 등은 화면 꽉 채우기로 대신) -----
  const isFull = () => card.classList.contains('pv-full');
  function setFull(on) {
    if (on) {
      card.classList.add('pv-full');
      document.body.classList.add('pv-locked');
      if (card.requestFullscreen) card.requestFullscreen().catch(() => {});
    } else {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      card.classList.remove('pv-full');
      document.body.classList.remove('pv-locked');
    }
    card.querySelector('[data-act=exitfull]').hidden = !on;
    card.querySelector('[data-act=full] span').textContent = on ? '전체화면 끄기' : '전체화면';
    setTimeout(() => zoomable && zoomable(zoom), 60);
  }
  function syncFull() {
    // 브라우저 Esc 로 전체화면이 풀리면 오버레이도 같이 끈다
    if (!document.fullscreenElement && isFull()) setFull(false);
  }

  function setZoom(z) {
    zoom = Math.max(0.4, Math.min(4, z));
    card.querySelector('.pv-zv').textContent = Math.round(zoom * 100) + '%';
    if (zoomable) zoomable(zoom);
  }

  // ----- 페이지 이동 -----
  function scroller() { return host.querySelector('.pv-scroll') || host.querySelector('.office-view') || host; }
  function curPage() {
    const s = scroller(), top = s.getBoundingClientRect().top;
    let cur = 1;
    for (const p of pages) if (p.el.getBoundingClientRect().top - top < 80) cur = p.num;
    return cur;
  }
  function goPage(n) {
    const p = pages.find(x => x.num === Math.max(1, Math.min(pages.length, n)));
    if (!p) return;
    const s = scroller();
    s.scrollTo({ top: s.scrollTop + p.el.getBoundingClientRect().top - s.getBoundingClientRect().top - 8, behavior: 'smooth' });
  }
  function updatePg() {
    const el = card.querySelector('.pv-pg');
    if (el && pages.length) el.textContent = `${curPage()} / ${pages.length}`;
  }

  // ---------------------------------------------------------------
  // 파일 종류별 렌더
  // ---------------------------------------------------------------
  function reset(path) {
    filePath = path || '';
    pages = []; zoom = 1; zoomable = null; current = null;
    if (window.DocDiff) DocDiff.reset();
    if (io) { io.disconnect(); io = null; }
    setMode(false);
    buildToolbar();
    card.querySelector('.pv-zoom').hidden = true;
    card.querySelector('.pv-nav').hidden = true;
    card.querySelector('.pv-zv').textContent = '100%';
    card.querySelector('.pv-mk').hidden = true;
    card.querySelector('.pv-people').hidden = true;
  }

  async function loadPdfJs() {
    await App.loadScript(PDFJS + 'pdf.min.js');
    const lib = window.pdfjsLib;
    if (!lib || !lib.getDocument) throw new Error('pdf.js 를 불러오지 못했습니다');
    lib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
    return lib;
  }

  // PDF: 페이지마다 canvas + 글자 레이어(선택·비교 밑줄용) + 첨삭 레이어
  async function pdf(url, path) {
    reset(path);
    const lib = await loadPdfJs();
    const buf = await (await fetch(url)).arrayBuffer();
    // 글꼴이 내장 안 된 한글 PDF 도 보이도록 CMap·표준 글꼴 위치를 알려준다
    const doc = await lib.getDocument({ data: buf, cMapUrl: CDN + 'pdfjs-dist@3.11.174/cmaps/', cMapPacked: true,
      standardFontDataUrl: CDN + 'pdfjs-dist@3.11.174/standard_fonts/' }).promise;
    host.innerHTML = '<div class="pv-scroll"><div class="pv-pages"></div></div>';
    const wrap = host.querySelector('.pv-pages');
    const all = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const pg = await doc.getPage(i);
      const vp = pg.getViewport({ scale: 1 });
      const el = document.createElement('div');
      el.className = 'pv-page';
      el.dataset.page = i;
      el.style.aspectRatio = `${vp.width} / ${vp.height}`;
      el.innerHTML = '<canvas></canvas><div class="textLayer"></div>';
      wrap.appendChild(el);
      all.push({ el, num: i, pg, vp, drawn: 0 });
    }
    const draw = async (p) => {
      const w = p.el.clientWidth;
      if (!w || p.drawn === w) return;
      p.drawn = w;
      const scale = w / p.vp.width, dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = p.pg.getViewport({ scale });
      const cv = p.el.querySelector('canvas');
      cv.width = Math.floor(vp.width * dpr); cv.height = Math.floor(vp.height * dpr);
      cv.style.width = vp.width + 'px'; cv.style.height = vp.height + 'px';
      if (p.task) p.task.cancel();
      p.task = p.pg.render({ canvasContext: cv.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
      try { await p.task.promise; } catch { return; }
      const tl = p.el.querySelector('.textLayer');
      tl.innerHTML = '';
      tl.style.setProperty('--scale-factor', scale);
      const text = p.text || (p.text = await p.pg.getTextContent());
      p.textDivs = [];
      await lib.renderTextLayer({ textContentSource: text, container: tl, viewport: vp, textDivs: p.textDivs }).promise;
      p.el.dispatchEvent(new CustomEvent('pv-text', { bubbles: true }));
    };
    io = new IntersectionObserver(es => es.forEach(e => {
      if (e.isIntersecting) draw(all.find(p => p.el === e.target));
    }), { root: host.querySelector('.pv-scroll'), rootMargin: '600px 0px' });
    all.forEach(p => io.observe(p.el));
    zoomable = (z) => {
      wrap.style.width = (z * 100) + '%';
      all.forEach(p => { if (p.el.getBoundingClientRect().bottom > -2000) draw(p); });
      // 화면 밖 페이지는 보일 때 다시 그린다
      all.forEach(p => { if (p.drawn && p.drawn !== p.el.clientWidth) { io.unobserve(p.el); io.observe(p.el); } });
    };
    host.querySelector('.pv-scroll').addEventListener('scroll', updatePg, { passive: true });
    card.querySelector('.pv-zoom').hidden = false;
    card.querySelector('.pv-nav').hidden = doc.numPages < 2;
    attach(all.map(p => ({ el: p.el, num: p.num })));
    updatePg();
    current = { kind: 'pdf', pdf: doc, pages: all };
    if (window.DocDiff) DocDiff.ready();
    return { doc, pages: all };
  }

  // 워드: docx-preview 가 만든 section.docx 페이지에 첨삭 레이어를 붙인다
  function docxPages(box, fit, path) {
    reset(path);
    const secs = [...box.querySelectorAll('section.docx')];
    zoomable = (z) => fit(z);
    card.querySelector('.pv-zoom').hidden = false;
    card.querySelector('.pv-nav').hidden = secs.length < 2;
    box.addEventListener('scroll', updatePg, { passive: true });
    attach(secs.map((el, i) => ({ el, num: i + 1 })));
    updatePg();
    current = { kind: 'docx', box, pages: secs };
    if (window.DocDiff) DocDiff.ready();
  }

  function image(url, name, path) {
    reset(path);
    host.innerHTML = `<div class="pv-scroll pv-imgscroll"><div class="pv-pages"><div class="pv-page pv-imgpage" data-page="1">
      <img src="${esc(url)}" alt="${esc(name)}" draggable="false"></div></div></div>`;
    const wrap = host.querySelector('.pv-pages');
    zoomable = (z) => { wrap.style.width = (z * 100) + '%'; };
    card.querySelector('.pv-zoom').hidden = false;
    attach([{ el: host.querySelector('.pv-page'), num: 1 }]);
  }

  // 영상: 브라우저 기본 플레이어 (전체화면·넓게 보기 툴바 그대로)
  function video(url, name, path, onFail) {
    reset(path);
    host.innerHTML = `<div class="pv-videowrap"><video class="pv-video" controls playsinline preload="metadata" src="${esc(url)}" title="${esc(name)}"></video></div>`;
    const v = host.querySelector('video');
    v.onerror = () => onFail && onFail();
  }
  const currentVideo = () => (host && host.querySelector('video.pv-video')) || null;
  function seek(t) {
    const v = currentVideo(); if (!v) return;
    v.currentTime = t;
    v.play().catch(() => {});
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // 엑셀·양식·미리보기 없는 파일: 전체화면·넓게 보기만
  function plain(path) { reset(path); }

  // ---------------------------------------------------------------
  // 첨삭 레이어
  // ---------------------------------------------------------------
  function attach(list) {
    pages = list.map(p => {
      p.el.classList.add('pv-host');
      let layer = p.el.querySelector(':scope > .pv-ann');
      if (!layer) {
        layer = document.createElement('div');
        layer.className = 'pv-ann';
        layer.innerHTML = '<svg viewBox="0 0 1 1" preserveAspectRatio="none"></svg><div class="pv-pins"></div>';
        p.el.appendChild(layer);
        bindDraw(layer, p.num);
      }
      return { ...p, layer };
    });
    const mk = card.querySelector('.pv-mk');
    mk.hidden = !(ctx.hasV6 && pages.length);
    drawAll();
  }

  const P = (n) => +(+n).toFixed(4);
  function norm(layer, e) {
    const r = layer.getBoundingClientRect();
    return [P(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))), P(Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)))];
  }

  function bindDraw(layer, num) {
    let cur = null, el = null, touches = new Map(), lastY = null;
    const svg = layer.querySelector('svg');
    layer.addEventListener('pointerdown', (e) => {
      if (!mode) return;
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, e.clientY);
        // 손가락 두 개면 그리기 대신 스크롤
        if (touches.size > 1) { if (el) el.remove(); cur = null; el = null; lastY = avgY(); return; }
      }
      if (e.button > 0) return;
      e.preventDefault();
      const [x, y] = norm(layer, e);
      if (tool === 'eraser') return eraseAt(e);
      if (tool === 'note') return addNote(layer, num, x, y);
      if (tool === 'stamp') return save({ page: num, kind: 'stamp', data: { x, y }, body: stampKind, color: stampKind === 'rejected' || stampKind === 'fix' ? '#e11d48' : '#2563eb' });
      layer.setPointerCapture(e.pointerId);
      cur = { x0: x, y0: y, pts: [[x, y]] };
      el = document.createElementNS('http://www.w3.org/2000/svg', tool === 'highlight' || tool === 'fix' ? 'rect' : tool === 'underline' ? 'line' : 'polyline');
      el.setAttribute('class', 'pv-live ' + tool);
      el.style.setProperty('--c', tool === 'highlight' ? HL_COLOR : tool === 'fix' ? '#e11d48' : color);
      svg.appendChild(el);
      move(e);
    });
    const avgY = () => [...touches.values()].reduce((a, b) => a + b, 0) / touches.size;
    function move(e) {
      if (touches.has(e.pointerId)) touches.set(e.pointerId, e.clientY);
      if (touches.size > 1 && lastY != null) {
        const y = avgY();
        scroller().scrollBy(0, lastY - y);
        lastY = y;
        return;
      }
      if (!cur || !el) return;
      const [x, y] = norm(layer, e);
      if (tool === 'pen') {
        const l = cur.pts[cur.pts.length - 1];
        if (Math.hypot(x - l[0], y - l[1]) > 0.002) cur.pts.push([x, y]);
        el.setAttribute('points', cur.pts.map(p => p.join(',')).join(' '));
      } else if (tool === 'highlight' || tool === 'fix') {
        cur.r = { x: Math.min(cur.x0, x), y: Math.min(cur.y0, y), w: Math.abs(x - cur.x0), h: Math.abs(y - cur.y0) };
        setRect(el, cur.r);
      } else {
        cur.r = { x: Math.min(cur.x0, x), y: cur.y0, w: Math.abs(x - cur.x0) };
        setLine(el, cur.r);
      }
    }
    layer.addEventListener('pointermove', move);
    const up = (e) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) lastY = null;
      if (!cur) return;
      const c = cur; cur = null;
      if (el) { el.remove(); el = null; }
      if (tool === 'pen' && c.pts.length > 1) save({ page: num, kind: 'pen', data: { pts: c.pts }, color });
      else if (tool === 'highlight' && c.r && c.r.w > 0.01 && c.r.h > 0.004) save({ page: num, kind: 'highlight', data: c.r, color: HL_COLOR });
      else if (tool === 'underline' && c.r && c.r.w > 0.01) save({ page: num, kind: 'underline', data: c.r, color });
      else if (tool === 'fix') {
        if (!c.r || c.r.w < 0.01) return toast('고칠 글자 위를 옆으로 끌어 주세요.');
        // 한 줄만 끌어도 글자 높이만큼은 잡히게
        const r = { ...c.r, h: Math.max(c.r.h, 0.012) };
        const orig = textIn(layer.parentElement, r);
        openSheet({
          title: '✍️ 고쳐쓰기', sub: orig ? `원래: “${orig}”` : '취소선 친 부분을 무엇으로 고칠까요?',
          placeholder: '고칠 문구 (지우기만 하려면 "삭제"라고 쓰세요)',
          live: { layer, r },
          onSubmit: (body) => save({ page: num, kind: 'fix', data: { ...r, orig }, body, color: '#e11d48' }),
        });
      }
    };
    layer.addEventListener('pointerup', up);
    layer.addEventListener('pointercancel', up);
  }
  const setRect = (el, r) => { el.setAttribute('x', r.x); el.setAttribute('y', r.y); el.setAttribute('width', r.w); el.setAttribute('height', r.h); };
  const setLine = (el, r) => { el.setAttribute('x1', r.x); el.setAttribute('x2', r.x + r.w); el.setAttribute('y1', r.y); el.setAttribute('y2', r.y); };

  function addNote(layer, num, x, y) {
    openSheet({
      title: '📝 메모', placeholder: '메모를 입력하세요', mark: { layer, x, y },
      onSubmit: (body) => save({ page: num, kind: 'note', data: { x, y }, body, color }),
    });
  }

  // 글 입력은 화면 아래 고정 시트로 (휴대폰 키보드 위에 뜨고, 스크롤 상자에 잘리지 않음)
  function openSheet({ title, sub, placeholder, onSubmit, live, mark }) {
    closePop();
    document.querySelectorAll('.pv-sheet').forEach(x => x.remove());
    const sheet = document.createElement('form');
    sheet.className = 'pv-sheet';
    sheet.innerHTML = `<div class="pv-sheet-head"><b>${esc(title)}</b><button type="button" class="pv-sheet-x" data-x aria-label="닫기">✕</button></div>
      ${sub ? `<div class="pv-sheet-sub">${esc(sub)}</div>` : ''}
      <div class="pv-sheet-row"><textarea maxlength="1000" rows="2" placeholder="${esc(placeholder || '')}" enterkeyhint="send"></textarea>
      <button class="btn" type="submit">저장</button></div>`;
    document.body.appendChild(sheet);
    // 입력 중인 자리를 문서 위에 표시 (취소선 미리보기 / 메모 위치 점)
    let ghost = null;
    if (live) {
      ghost = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      ghost.setAttribute('class', 'pv-live fix');
      ghost.style.setProperty('--c', '#e11d48');
      setRect(ghost, live.r);
      live.layer.querySelector('svg').appendChild(ghost);
    } else if (mark) {
      ghost = document.createElement('span');
      ghost.className = 'pv-mark';
      ghost.style.left = (mark.x * 100) + '%'; ghost.style.top = (mark.y * 100) + '%';
      mark.layer.querySelector('.pv-pins').appendChild(ghost);
    }
    const ta = sheet.querySelector('textarea');
    const close = () => { sheet.remove(); if (ghost) ghost.remove(); };
    sheet.querySelector('[data-x]').onclick = close;
    // 손가락을 뗀 뒤에 포커스를 줘야 휴대폰 키보드가 바로 닫히지 않는다
    setTimeout(() => ta.focus(), 120);
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sheet.requestSubmit(); } if (e.key === 'Escape') close(); };
    sheet.onsubmit = (e) => {
      e.preventDefault();
      const body = ta.value.trim();
      if (!body) return ta.focus();
      close();
      onSubmit(body);
    };
  }

  // 끌어서 잡은 범위 안의 원래 글자 (PDF 글자 레이어·워드 화면 글자)
  function textIn(pageEl, r) {
    const pr = pageEl.getBoundingClientRect();
    const box = { l: pr.left + r.x * pr.width, t: pr.top + r.y * pr.height, r: pr.left + (r.x + r.w) * pr.width, b: pr.top + (r.y + r.h) * pr.height };
    const els = [...pageEl.querySelectorAll('.textLayer span, section.docx span, .docx-wrapper span')].filter(el => !el.children.length && el.textContent.trim());
    const hit = els.filter(el => {
      const b = el.getBoundingClientRect();
      const midY = (b.top + b.bottom) / 2;
      return b.right > box.l && b.left < box.r && midY > box.t - 4 && midY < box.b + 4;
    });
    return hit.map(el => el.textContent).join('').replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  async function save(a) {
    const row = { doc_id: ctx.doc.id, file_path: filePath, ...a };
    // 바로 그려서 끊김 없이 보이게 하고, 저장이 끝나면 진짜 id 로 바꾼다
    const tmp = { ...row, id: 'tmp' + Math.random().toString(36).slice(2), user_id: ctx.me.id, created_at: new Date().toISOString() };
    anns.push(tmp); drawAll();
    const { data, error } = await sb.from('doc_annotations').insert(row).select().single();
    anns = anns.filter(x => x !== tmp);
    if (error) { drawAll(); return toast(errMsg(error), true); }
    if (!anns.some(x => x.id === data.id)) anns.push(data);
    mineThisSession.push(data.id);
    drawAll();
  }

  async function remove(id) {
    const a = anns.find(x => x.id === id);
    if (!a || !(a.user_id === ctx.me.id || ctx.me.role === 'admin')) return;
    anns = anns.filter(x => x.id !== id); drawAll();
    const { error } = await sb.from('doc_annotations').delete().eq('id', id);
    if (error) { anns.push(a); drawAll(); toast(errMsg(error), true); }
  }
  function undo() {
    const id = mineThisSession.pop();
    if (id) remove(id); else toast('되돌릴 첨삭이 없습니다.');
  }
  function eraseAt(e) {
    const hit = document.elementsFromPoint(e.clientX, e.clientY).find(n => n.dataset && n.dataset.ann);
    if (!hit) return;
    const a = anns.find(x => x.id === hit.dataset.ann);
    if (a && a.user_id !== ctx.me.id && ctx.me.role !== 'admin') return toast('다른 사람의 첨삭은 지울 수 없습니다.', true);
    remove(hit.dataset.ann);
  }

  // ----- 그리기 -----
  const who = (uid) => ctx.nameOf[uid] || '(퇴사자)';
  function visible() {
    const cur = anns.filter(a => a.kind !== 'check' && a.file_path === filePath);
    const old = showPrev ? prevAnns.filter(a => a.kind !== 'check').map(a => ({ ...a, _prev: true })) : [];
    return [...old, ...cur].filter(a => !hidden.has(a.user_id));
  }
  function drawAll() {
    const list = visible();
    pages.forEach(p => {
      const svg = p.layer.querySelector('svg'), pins = p.layer.querySelector('.pv-pins');
      const mine = list.filter(a => a.page === p.num);
      svg.innerHTML = mine.filter(a => ['pen', 'highlight', 'underline', 'fix'].includes(a.kind)).map(a => {
        const tip = `<title>${esc(who(a.user_id))} · ${esc(fmtDate(a.created_at))}${a._prev ? ' (이전 버전)' : ''}</title>`;
        const cls = `pv-a ${a.kind}${a._prev ? ' prev' : ''}${a.checked_at ? ' checked' : ''}`;
        const st = `style="--c:${esc(a.color || '#e11d48')}" data-ann="${a._prev ? '' : esc(a.id)}"`;
        const d = a.data || {};
        if (a.kind === 'pen') return `<polyline class="${cls}" ${st} points="${(d.pts || []).map(q => q.join(',')).join(' ')}">${tip}</polyline>`;
        if (a.kind === 'highlight') return `<rect class="${cls}" ${st} x="${+d.x}" y="${+d.y}" width="${+d.w}" height="${+d.h}">${tip}</rect>`;
        // 고쳐쓰기: 연한 빨간 바탕 + 가운데 취소선
        if (a.kind === 'fix') return `<rect class="${cls} fixbg" ${st} x="${+d.x}" y="${+d.y}" width="${+d.w}" height="${+d.h}">${tip}</rect>
          <line class="${cls} strike" ${st} x1="${+d.x}" x2="${+d.x + +d.w}" y1="${+d.y + +d.h / 2}" y2="${+d.y + +d.h / 2}"></line>`;
        return `<line class="${cls}" ${st} x1="${+d.x}" x2="${+d.x + +d.w}" y1="${+d.y}" y2="${+d.y}">${tip}</line>`;
      }).join('');
      // 열려 있는 팝업(답글 입력 중 등)은 다시 그려도 유지
      const keep = [...pins.querySelectorAll(':scope > .pv-pop, :scope > .pv-mark')];
      pins.innerHTML = mine.filter(a => a.kind === 'note' || a.kind === 'stamp' || a.kind === 'fix').map(a => {
        const d = a.data || {}, pos = `left:${+d.x * 100}%;top:${+d.y * 100}%;--c:${esc(a.color || '#2563eb')}`;
        const id = a._prev ? '' : esc(a.id);
        const nrep = (replies[a.id] || []).length;
        if (a.kind === 'fix') return `<button type="button" class="pv-fix${a._prev ? ' prev' : ''}${a.checked_at ? ' checked' : ''}${+d.x > 0.55 ? ' flip' : ''}" style="left:${+d.x * 100}%;top:${+d.y * 100}%" data-ann="${id}" data-open="${id}"
          title="${esc(who(a.user_id))}: ${esc(d.orig ? d.orig + ' → ' : '')}${esc(a.body || '')}">${ctx.avatar(a.user_id, 18)}<span>${a.checked_at ? '☑ ' : ''}${esc(a.body || '')}</span>${nrep ? `<i>💬${nrep}</i>` : ''}</button>`;
        if (a.kind === 'stamp') return `<div class="pv-stamp${a._prev ? ' prev' : ''}" style="${pos}" data-ann="${id}" data-open="${id}" title="${esc(who(a.user_id))} · ${esc(fmtDate(a.created_at))}">
          <b>${esc(STAMPS[a.body] || a.body || '')}</b><small>${esc(who(a.user_id))} ${esc(fmtDate(a.created_at).split(' ')[0])}</small></div>`;
        return `<button type="button" class="pv-pin${a._prev ? ' prev' : ''}${a.checked_at ? ' checked' : ''}${+d.x > 0.6 ? ' flip' : ''}" style="${pos}" data-ann="${id}" data-open="${id}" title="${esc(who(a.user_id))}: ${esc(a.body || '')}">
          ${ctx.avatar(a.user_id, 20)}<span>${esc((a.body || '').slice(0, 14))}${(a.body || '').length > 14 ? '…' : ''}</span>${nrep ? `<i>💬${nrep}</i>` : ''}</button>`;
      }).join('');
      keep.forEach(el => pins.appendChild(el));
    });
    renderPeople();
    ctx.onChange && ctx.onChange(anns);
    if (window.DocDiff) DocDiff.refresh();
  }

  // 메모·도장을 누르면 내용·작성자·고침 체크·삭제를 보여준다
  function closePop() { document.querySelectorAll('.pv-pop').forEach(x => x.remove()); }
  function openPop(id) {
    closePop();
    const a = anns.find(x => x.id === id);
    const pinEl = card.querySelector(`[data-open="${CSS.escape(id)}"]`) || card.querySelector(`[data-ann="${CSS.escape(id)}"]`);
    if (!a) return;
    const d = a.data || {};
    const pop = document.createElement('div');
    // 휴대폰·페이지 밖 항목은 화면 아래 시트로, PC 는 그 자리 옆에
    const asSheet = innerWidth < 700 || !pinEl || !pinEl.style.left;
    pop.className = 'pv-pop' + (asSheet ? ' pv-pop-sheet' : '');
    if (!asSheet) { pop.style.left = pinEl.style.left; pop.style.top = pinEl.style.top; }
    const body = a.kind === 'note' ? `<div class="pv-popbody">${esc(a.body || '')}</div>`
      : a.kind === 'fix' ? `<div class="pv-popbody pv-fixbody">${d.orig ? `<del>${esc(d.orig)}</del> → ` : ''}<ins>${esc(a.body || '')}</ins></div>`
      : a.kind === 'stamp' ? `<div class="pv-popbody">🔖 ${esc(STAMPS[a.body] || '')} 도장</div>`
      : `<div class="pv-popbody muted">${esc(KIND_LABEL[a.kind] || '')} · p.${a.page}</div>`;
    pop.innerHTML = `<div class="pv-pophead">${ctx.avatar(a.user_id, 24)}<b>${esc(App.honor ? App.honor(a.user_id) : who(a.user_id))}</b><span class="muted">${esc(fmtDate(a.created_at))}</span></div>
      ${body}
      <div class="pv-replies">${replyList(a.id)}</div>
      ${hasReplies ? `<form class="pv-replyform"><input type="text" maxlength="1000" placeholder="${a.kind === 'fix' ? '답글 · 다른 문구 제안' : '답글로 의견 보태기'}" enterkeyhint="send"><button class="btn sm" type="submit">💬</button></form>` : ''}
      <div class="pv-popbtns">
        ${canCheck(a) ? `<button class="btn ghost sm" type="button" data-chk="${esc(a.id)}">${a.checked_at ? '☑ 반영됨' : '☐ 반영 체크'}</button>` : (a.checked_at ? '<span class="muted">☑ 반영됨</span>' : '')}
        ${a.user_id === ctx.me.id || ctx.me.role === 'admin' ? `<button class="btn ghost sm" type="button" data-del="${esc(a.id)}" style="color:var(--bad)">삭제</button>` : ''}
        <button class="btn ghost sm" type="button" data-x>닫기</button></div>`;
    (asSheet ? document.body : pinEl.parentElement).appendChild(pop);
    pop.addEventListener('pointerdown', e => e.stopPropagation());
    pop.onclick = (e) => {
      const b = e.target.closest('button'); if (!b || b.type === 'submit') return;
      if (b.dataset.repdel) return delReply(b.dataset.repdel).then(() => { const r = pop.querySelector('.pv-replies'); if (r) r.innerHTML = replyList(a.id); });
      if (b.dataset.chk) toggleCheck(b.dataset.chk);
      if (b.dataset.del) remove(b.dataset.del);
      pop.remove();
    };
    const f = pop.querySelector('.pv-replyform');
    if (f) f.onsubmit = async (e) => {
      e.preventDefault();
      const inp = f.querySelector('input'), text = inp.value.trim();
      if (!text) return;
      inp.disabled = true;
      const ok = await addReply(a.id, text);
      inp.disabled = false;
      if (ok) { inp.value = ''; pop.querySelector('.pv-replies').innerHTML = replyList(a.id); }
      inp.focus();
    };
  }

  // ----- 답글 (함께 보완) -----
  function replyList(annId) {
    const list = replies[annId] || [];
    return list.map(r => `<div class="pv-reply">${ctx.avatar(r.user_id, 20)}<div><b>${esc(App.honor ? App.honor(r.user_id) : who(r.user_id))}</b>
      <span class="muted">${esc(fmtDate(r.created_at))}</span>${r.user_id === ctx.me.id || ctx.me.role === 'admin' ? ` <button type="button" class="pv-repdel" data-repdel="${esc(r.id)}" title="답글 삭제">✕</button>` : ''}
      <div>${esc(r.body)}</div></div></div>`).join('');
  }
  async function addReply(annId, body) {
    if (!hasReplies) { toast(errMsg({ message: 'annotation_replies does not exist' }), true); return false; }
    const { data, error } = await sb.from('annotation_replies').insert({ ann_id: annId, body }).select().single();
    if (error) { toast(errMsg(error), true); return false; }
    const l = replies[annId] = replies[annId] || [];
    if (!l.some(r => r.id === data.id)) l.push(data);
    drawAll();
    return true;
  }
  async function delReply(id) {
    const { error } = await sb.from('annotation_replies').delete().eq('id', id);
    if (error) return toast(errMsg(error), true);
    Object.keys(replies).forEach(k => (replies[k] = replies[k].filter(r => r.id !== id)));
    drawAll();
  }
  async function fetchReplies() {
    const ids = anns.filter(a => a.kind !== 'check').map(a => a.id);
    replies = {};
    if (!hasReplies || !ids.length) return;
    const { data } = await sb.from('annotation_replies').select('*').in('ann_id', ids).order('created_at');
    (data || []).forEach(r => (replies[r.ann_id] = replies[r.ann_id] || []).push(r));
  }

  const canCheck = (a) => ctx.me.role === 'admin' || a.user_id === ctx.me.id || ctx.doc.uploader_id === ctx.me.id;
  async function toggleCheck(id) {
    const a = anns.find(x => x.id === id);
    if (!a) return;
    const was = a.checked_at;
    a.checked_at = was ? null : new Date().toISOString(); a.checked_by = was ? null : ctx.me.id;
    drawAll();
    const { error } = await sb.rpc('toggle_annotation_check', { p_id: id });
    if (error) { a.checked_at = was; drawAll(); toast(errMsg(error), true); }
  }

  // 첨삭한 사람 칩: 눌러서 그 사람 첨삭 보이기/숨기기
  function renderPeople() {
    const box = card && card.querySelector('.pv-people');
    if (!box) return;
    const cur = anns.filter(a => a.kind !== 'check' && a.file_path === filePath);
    const counts = {};
    cur.forEach(a => counts[a.user_id] = (counts[a.user_id] || 0) + 1);
    const ids = Object.keys(counts);
    box.hidden = !ids.length && !prevAnns.length;
    box.innerHTML = (ids.length ? '<span class="muted">첨삭</span>' : '') + ids.map(id => `<button type="button" class="pv-who${hidden.has(id) ? ' off' : ''}" data-who="${esc(id)}" title="눌러서 보이기/숨기기">
        ${ctx.avatar(id, 22)}<span>${esc(who(id))}</span><b>${counts[id]}</b></button>`).join('') +
      (prevAnns.length ? `<button type="button" class="pv-who pv-prevbtn${showPrev ? ' on' : ''}" data-act="prevAnns">🕘 이전 버전 첨삭 ${prevAnns.length}</button>` : '');
  }

  function setTool(t) {
    tool = t;
    card.querySelectorAll('.pv-tool').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    card.dataset.tool = t;
  }
  function setMode(on) {
    if (on && !ctx.hasV6) return toast(App.V6_NOTICE_TEXT, true);
    mode = !!on;
    if (!card) return;
    card.classList.toggle('pv-marking', mode);
    const tools = card.querySelector('.pv-tools'), mk = card.querySelector('.pv-mk');
    if (tools) tools.hidden = !mode;
    if (mk) mk.classList.toggle('on', mode);
    if (mode) { setTool(tool); if (!sessionStorage.getItem('pv_tip')) { toast('문서 위에 바로 그리세요. 손가락 두 개로 스크롤, Ctrl+Z 되돌리기'); sessionStorage.setItem('pv_tip', '1'); } }
    closePop();
  }

  // ---------------------------------------------------------------
  // 데이터
  // ---------------------------------------------------------------
  async function fetchAnns() {
    const { data } = await sb.from('doc_annotations').select('*').eq('doc_id', ctx.doc.id).order('created_at');
    anns = data || [];
    await fetchReplies().catch(() => {});
    drawAll();
  }
  async function loadAnns() {
    if (!ctx.hasV6) return;
    // 011 (고쳐쓰기·답글) 실행 여부
    hasReplies = await sb.from('annotation_replies').select('id').limit(1).then(r => !r.error && Array.isArray(r.data), () => false);
    if (!hasReplies) { const fb = card.querySelector('[data-tool=fix]'); if (fb) fb.title = '고쳐쓰기는 DB 업데이트(011_fix.sql) 후에 쓸 수 있습니다'; }
    await fetchAnns();
    if (ctx.prevDocId) {
      const r = await sb.from('doc_annotations').select('*').eq('doc_id', ctx.prevDocId).order('created_at');
      prevAnns = (r.data || []).filter(a => a.kind !== 'check');
    }
    drawAll();
    sb.channel('ann-' + ctx.doc.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'doc_annotations', filter: `doc_id=eq.${ctx.doc.id}` }, (p) => {
        if (p.eventType === 'DELETE') anns = anns.filter(a => a.id !== (p.old && p.old.id));
        else if (p.new) { const i = anns.findIndex(a => a.id === p.new.id); i < 0 ? anns.push(p.new) : (anns[i] = p.new); }
        drawAll();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'annotation_replies' }, (p) => {
        if (p.eventType === 'DELETE') Object.keys(replies).forEach(k => (replies[k] = replies[k].filter(r => r.id !== (p.old && p.old.id))));
        else if (p.new && anns.some(a => a.id === p.new.ann_id)) {
          const l = replies[p.new.ann_id] = replies[p.new.ann_id] || [];
          if (!l.some(r => r.id === p.new.id)) l.push(p.new);
        } else return;
        drawAll();
        const open = document.querySelector('.pv-pop .pv-replies');
        if (open && p.new) open.innerHTML = replyList(p.new.ann_id);
      }).subscribe();
  }

  function init(o) {
    ctx = o;
    host = document.getElementById('viewerBody');
    card = document.getElementById('viewerCard');
    buildToolbar();
    try { if (localStorage.getItem('doc_wide') === '1') { document.body.classList.add('doc-wide'); card.querySelector('.pv-wide').classList.add('on'); } } catch {}
    // 메모·도장 열기 (첨삭 모드가 아닐 때도)
    card.addEventListener('click', (e) => {
      const pin = e.target.closest('[data-open]');
      if (pin && pin.dataset.open && !(mode && tool === 'eraser')) { e.stopPropagation(); openPop(pin.dataset.open); }
    });
  }
  // 화면의 나머지(아바타 함수 등)가 준비된 뒤 첨삭을 불러온다
  const start = () => loadAnns().catch(e => console.warn('첨삭 불러오기 실패', e));

  // 첨삭 목록 카드에서 위치로 이동하고 깜빡이기
  function focus(id) {
    const a = anns.find(x => x.id === id);
    if (!a) return;
    if (a.file_path !== filePath && ctx.switchFile) return ctx.switchFile(a.file_path).then(() => setTimeout(() => focus(id), 400));
    const p = pages.find(x => x.num === a.page);
    if (!p) return;
    const d = a.data || {}, y = d.y != null ? +d.y : (d.pts && d.pts[0] ? d.pts[0][1] : 0);
    const s = scroller();
    s.scrollTo({ top: s.scrollTop + p.el.getBoundingClientRect().top - s.getBoundingClientRect().top + p.el.clientHeight * y - s.clientHeight / 3, behavior: 'smooth' });
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => card.querySelectorAll(`[data-ann="${CSS.escape(id)}"]`).forEach(el => {
      el.classList.remove('pv-flash'); void el.getBoundingClientRect(); el.classList.add('pv-flash');
    }), 350);
  }

  window.Viewer = {
    init, start, video, seek, currentVideo, reload: () => fetchAnns(), openPop, get replies() { return replies; }, get hasReplies() { return hasReplies; }, pdf, docxPages, image, plain, focus, toggleCheck, canCheck, remove,
    get anns() { return anns; },
    STAMPS, KIND_LABEL, loadPdfJs, pagesInfo: () => pages, get current() { return current; }, get filePath() { return filePath; }, scroller: () => scroller(), buildToolbar: () => buildToolbar(),
  };
})();
