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
  const KIND_LABEL = { pen: '✏️ 펜', highlight: '🖍 형광펜', underline: '＿ 밑줄', note: '📝 메모', stamp: '🔖 도장' };

  let ctx = null;          // init 에서 받는 문서·사용자 정보
  let host = null;         // #viewerBody
  let card = null;         // #viewerCard
  let pages = [];          // [{el, num, layer}]
  let filePath = '';
  let zoom = 1, zoomable = null;   // 현재 파일의 확대 함수
  let anns = [], prevAnns = [], showPrev = false, hidden = new Set();
  let mode = null, tool = 'pen', color = COLORS[0], stampKind = 'ok';
  let canMarkup = false, mineThisSession = [];
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
      el = document.createElementNS('http://www.w3.org/2000/svg', tool === 'highlight' ? 'rect' : tool === 'underline' ? 'line' : 'polyline');
      el.setAttribute('class', 'pv-live ' + tool);
      el.style.setProperty('--c', tool === 'highlight' ? HL_COLOR : color);
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
      } else if (tool === 'highlight') {
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
    };
    layer.addEventListener('pointerup', up);
    layer.addEventListener('pointercancel', up);
  }
  const setRect = (el, r) => { el.setAttribute('x', r.x); el.setAttribute('y', r.y); el.setAttribute('width', r.w); el.setAttribute('height', r.h); };
  const setLine = (el, r) => { el.setAttribute('x1', r.x); el.setAttribute('x2', r.x + r.w); el.setAttribute('y1', r.y); el.setAttribute('y2', r.y); };

  function addNote(layer, num, x, y) {
    closePop();
    const pop = document.createElement('form');
    pop.className = 'pv-pop pv-noteform';
    pop.style.left = (x * 100) + '%'; pop.style.top = (y * 100) + '%';
    pop.innerHTML = `<textarea maxlength="1000" placeholder="메모를 입력하세요" required></textarea>
      <div class="pv-popbtns"><button class="btn sm" type="submit">붙이기</button><button class="btn ghost sm" type="button" data-x>취소</button></div>`;
    layer.querySelector('.pv-pins').appendChild(pop);
    const ta = pop.querySelector('textarea');
    ta.focus();
    pop.querySelector('[data-x]').onclick = () => pop.remove();
    ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) pop.requestSubmit(); };
    pop.onsubmit = (e) => {
      e.preventDefault();
      const body = ta.value.trim();
      if (!body) return;
      pop.remove();
      save({ page: num, kind: 'note', data: { x, y }, body, color });
    };
    pop.addEventListener('pointerdown', e => e.stopPropagation());
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
      svg.innerHTML = mine.filter(a => ['pen', 'highlight', 'underline'].includes(a.kind)).map(a => {
        const tip = `<title>${esc(who(a.user_id))} · ${esc(fmtDate(a.created_at))}${a._prev ? ' (이전 버전)' : ''}</title>`;
        const cls = `pv-a ${a.kind}${a._prev ? ' prev' : ''}${a.checked_at ? ' checked' : ''}`;
        const st = `style="--c:${esc(a.color || '#e11d48')}" data-ann="${a._prev ? '' : esc(a.id)}"`;
        const d = a.data || {};
        if (a.kind === 'pen') return `<polyline class="${cls}" ${st} points="${(d.pts || []).map(q => q.join(',')).join(' ')}">${tip}</polyline>`;
        if (a.kind === 'highlight') return `<rect class="${cls}" ${st} x="${+d.x}" y="${+d.y}" width="${+d.w}" height="${+d.h}">${tip}</rect>`;
        return `<line class="${cls}" ${st} x1="${+d.x}" x2="${+d.x + +d.w}" y1="${+d.y}" y2="${+d.y}">${tip}</line>`;
      }).join('');
      const form = pins.querySelector('.pv-noteform');
      pins.innerHTML = mine.filter(a => a.kind === 'note' || a.kind === 'stamp').map(a => {
        const d = a.data || {}, pos = `left:${+d.x * 100}%;top:${+d.y * 100}%;--c:${esc(a.color || '#2563eb')}`;
        const id = a._prev ? '' : esc(a.id);
        if (a.kind === 'stamp') return `<div class="pv-stamp${a._prev ? ' prev' : ''}" style="${pos}" data-ann="${id}" data-open="${id}" title="${esc(who(a.user_id))} · ${esc(fmtDate(a.created_at))}">
          <b>${esc(STAMPS[a.body] || a.body || '')}</b><small>${esc(who(a.user_id))} ${esc(fmtDate(a.created_at).split(' ')[0])}</small></div>`;
        return `<button type="button" class="pv-pin${a._prev ? ' prev' : ''}${a.checked_at ? ' checked' : ''}${+d.x > 0.6 ? ' flip' : ''}" style="${pos}" data-ann="${id}" data-open="${id}" title="${esc(who(a.user_id))}: ${esc(a.body || '')}">
          ${ctx.avatar(a.user_id, 20)}<span>${esc((a.body || '').slice(0, 14))}${(a.body || '').length > 14 ? '…' : ''}</span></button>`;
      }).join('');
      if (form) pins.appendChild(form);
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
    const pinEl = card.querySelector(`[data-open="${CSS.escape(id)}"]`);
    if (!a || !pinEl) return;
    const pop = document.createElement('div');
    pop.className = 'pv-pop';
    pop.style.left = pinEl.style.left; pop.style.top = pinEl.style.top;
    pop.innerHTML = `<div class="pv-pophead">${ctx.avatar(a.user_id, 24)}<b>${esc(who(a.user_id))}</b><span class="muted">${esc(fmtDate(a.created_at))}</span></div>
      ${a.kind === 'note' ? `<div class="pv-popbody">${esc(a.body || '')}</div>` : `<div class="pv-popbody">🔖 ${esc(STAMPS[a.body] || '')} 도장</div>`}
      <div class="pv-popbtns">
        ${canCheck(a) ? `<button class="btn ghost sm" type="button" data-chk="${esc(a.id)}">${a.checked_at ? '☑ 고침 확인됨' : '☐ 고침 체크'}</button>` : (a.checked_at ? '<span class="muted">☑ 확인됨</span>' : '')}
        ${a.user_id === ctx.me.id || ctx.me.role === 'admin' ? `<button class="btn ghost sm" type="button" data-del="${esc(a.id)}" style="color:var(--bad)">삭제</button>` : ''}
        <button class="btn ghost sm" type="button" data-x>닫기</button></div>`;
    pinEl.parentElement.appendChild(pop);
    pop.addEventListener('pointerdown', e => e.stopPropagation());
    pop.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.chk) toggleCheck(b.dataset.chk);
      if (b.dataset.del) remove(b.dataset.del);
      pop.remove();
    };
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
    drawAll();
  }
  async function loadAnns() {
    if (!ctx.hasV6) return;
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
    init, start, reload: () => fetchAnns(), pdf, docxPages, image, plain, focus, toggleCheck, canCheck, remove,
    get anns() { return anns; },
    STAMPS, KIND_LABEL, loadPdfJs, pagesInfo: () => pages, get current() { return current; }, get filePath() { return filePath; }, scroller: () => scroller(), buildToolbar: () => buildToolbar(),
  };
})();
