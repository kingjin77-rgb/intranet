// =====================================================================
// 수정본 자동 비교 (v6): 이전 버전과 글자를 비교해 바뀐 곳에 밑줄
//   추가·바뀐 글자 = 초록 밑줄, 지워진 글자 = 빨간 ▾ (누르면 지운 내용)
//   PDF 는 글자 위치(좌표)로 밑줄 레이어를 그리고, 워드는 화면 글자를 직접 감싼다.
//   변경 목록의 ☐ 확인 은 doc_annotations(kind='check') 로 저장 → 누가 확인했는지 모두에게 보임.
// =====================================================================
(() => {
  const { sb, esc, fmtDate, toast, errMsg } = App;
  const CDN = 'https://cdn.jsdelivr.net/npm/';
  let ctx = null, on = false, changes = [], busy = false, prevCache = null;

  const isPdf = (f) => f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
  const isDocx = (f) => f && /\.docx$/i.test(f.name || '');
  const sameKind = (a, b) => (isPdf(a) && isPdf(b)) || (isDocx(a) && isDocx(b));

  function init(o) {
    ctx = o;
    document.getElementById('diffCard').addEventListener('click', onListClick);
  }

  // 뷰어가 파일을 다 그린 뒤 호출됨: 비교 버튼을 보일지 정한다
  function ready() {
    if (!ctx) return;
    const row = document.querySelector('#viewerCard .pv-row');
    let btn = row && row.querySelector('.pv-diff');
    if (row && !btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pv-btn pv-diff';
      btn.title = '이전 버전과 비교해서 바뀐 글자에 밑줄';
      btn.onclick = () => toggle();
      row.insertBefore(btn, row.querySelector('.pv-sp'));
    }
    const cur = Viewer.current;
    const ok = !!(ctx.prev && cur && Viewer.filePath === ctx.primaryPath && sameKind(ctx.prev, ctx.primary));
    if (btn) { btn.hidden = !ok; btn.innerHTML = `🔍 <span>v${ctx.prev ? ctx.prev.version : ''}과 비교</span>`; btn.classList.toggle('on', on); }
    if (ok && on) run();
  }
  function reset() {
    document.querySelectorAll('.df-layer').forEach(n => n.remove());
    const card = document.getElementById('diffCard');
    if (card && !on) card.hidden = true;
  }

  async function toggle() {
    on = !on;
    document.querySelector('.pv-diff').classList.toggle('on', on);
    if (on) return run();
    clearMarks();
    document.getElementById('diffCard').hidden = true;
  }

  // ----- 글자 추출: 한 줄 문자열 + 각 글자가 어디(페이지·좌표/DOM)에서 왔는지 -----
  async function pdfText(pdf) {
    const chars = [], map = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const pg = await pdf.getPage(i);
      const vp = pg.getViewport({ scale: 1 });
      const tc = await pg.getTextContent();
      tc.items.forEach(it => {
        if (!('str' in it)) return;
        const s = it.str;
        for (let k = 0; k < s.length; k++) { chars.push(s[k]); map.push({ page: i, it, k, vp }); }
        if (it.hasEOL) { chars.push(' '); map.push(null); }
      });
      chars.push(' '); map.push(null);
    }
    return { text: chars.join(''), map };
  }
  async function docxXmlText(buf) {
    await App.loadScript(CDN + 'jszip@3.10.2/dist/jszip.min.js');
    const zip = await window.JSZip.loadAsync(buf);
    const xml = await zip.file('word/document.xml').async('string');
    const dom = new DOMParser().parseFromString(xml, 'application/xml');
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    return [...dom.getElementsByTagNameNS(W, 'p')].map(p =>
      [...p.getElementsByTagNameNS(W, 't')].map(t => t.textContent).join('')).join(' ') + ' ';
  }
  // 화면에 그려진 워드: 문단(<p>)마다 글자 노드를 모아 같은 규칙(문단 사이 공백)으로 잇는다
  function docxDomText(box) {
    const chars = [], map = [];
    box.querySelectorAll('section.docx').forEach((sec, si) => {
      sec.querySelectorAll('p').forEach(p => {
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          if (n.parentElement.closest('.pv-ann, .df-del')) continue;
          for (let k = 0; k < n.data.length; k++) { chars.push(n.data[k]); map.push({ page: si + 1, node: n, k }); }
        }
        chars.push(' '); map.push(null);
      });
    });
    return { text: chars.join(''), map };
  }

  async function prevText() {
    if (prevCache) return prevCache;
    const { data } = await sb.storage.from('docs').createSignedUrl(ctx.prev.path, 600);
    if (!data || !data.signedUrl) throw new Error('이전 버전 파일을 열 수 없습니다');
    const buf = await (await fetch(data.signedUrl)).arrayBuffer();
    if (isPdf(ctx.prev)) {
      const lib = await Viewer.loadPdfJs();
      const pdf = await lib.getDocument({ data: buf, cMapUrl: CDN + 'pdfjs-dist@3.11.174/cmaps/', cMapPacked: true }).promise;
      prevCache = (await pdfText(pdf)).text;
    } else {
      prevCache = await docxXmlText(buf);
    }
    return prevCache;
  }

  async function run() {
    if (busy) return;
    busy = true;
    const card = document.getElementById('diffCard');
    card.hidden = false;
    document.getElementById('diffSummary').textContent = '비교하는 중…';
    document.getElementById('diffList').innerHTML = '';
    try {
      await App.loadScript(CDN + 'diff@5.2.0/dist/diff.min.js');
      if (!window.Diff) throw new Error('비교 도구를 불러오지 못했습니다');
      const cur = Viewer.current;
      const [old, now] = await Promise.all([prevText(), cur.kind === 'pdf' ? pdfText(cur.pdf) : Promise.resolve(docxDomText(cur.box))]);
      // 띄어쓰기 단위(한글 어절 '15일부터' 를 한 덩어리)로 비교
      const tok = (t) => t.split(/(\s+)/).filter(Boolean);
      const raw = window.Diff.diffArrays(tok(old), tok(now.text), { timeout: 4000 });
      if (!raw) throw new Error('문서가 너무 커서 비교하지 못했습니다');
      changes = collect(group(raw.map(p => ({ ...p, value: p.value.join('') }))), now);
      clearMarks();
      draw(cur, now);
      renderList();
    } catch (e) {
      console.warn(e);
      document.getElementById('diffSummary').textContent = '비교하지 못했습니다: ' + (e.message || e);
    } finally { busy = false; }
  }

  // 가까이 붙은 변경들은 하나로 묶는다 → "1일부터 12월 31일까지" → "15일부터 2027년 1월 15일까지"
  function group(parts) {
    const out = [];
    let g = null;
    const flush = () => { if (g) out.push(g); g = null; };
    parts.forEach((p, i) => {
      const changed = p.added || p.removed;
      // 사이에 낀 짧은 같은 글자(띄어쓰기, '월'·'일까지' 같은 3글자 이하)도 변경에 붙여 한 덩어리로
      const short = !changed && g && p.value.trim().length <= 3 && parts.slice(i + 1, i + 3).some(x => x.added || x.removed);
      if (changed || short) {
        g = g || { change: true, old: '', now: '' };
        if (!p.added) g.old += p.value;
        if (!p.removed) g.now += p.value;
      } else { flush(); out.push({ change: false, now: p.value }); }
    });
    flush();
    return out;
  }

  function collect(parts, now) {
    const out = [];
    let pos = 0;
    const seen = {};
    for (const p of parts) {
      if (!p.change) { pos += p.now.length; continue; }
      const o = p.old.trim(), n = p.now.trim();
      if (!o && !n) { pos += p.now.length; continue; }
      const lead = p.now.length - p.now.trimStart().length;
      const c = n
        ? { type: o ? 'rep' : 'add', old: o, text: n, s: pos + lead, e: pos + lead + n.length }
        : { type: 'del', old: o, s: pos, e: pos };
      pos += p.now.length;
      // 목록에서 어디인지 알 수 있게 앞뒤 문맥을 조금 붙인다
      c.before = now.text.slice(Math.max(0, c.s - 16), c.s).replace(/\s+/g, ' ').trimStart();
      c.after = now.text.slice(c.e, c.e + 12).replace(/\s+/g, ' ').trimEnd();
      const m = now.map[Math.min(c.s, now.map.length - 1)] || now.map.slice(0, c.s).reverse().find(Boolean);
      c.page = m ? m.page : 1;
      // 같은 내용의 변경이 여러 곳이면 순번으로 구분 (확인 체크 키)
      const base = `${c.type}|${(c.old || '').slice(0, 60)}|${(c.text || '').slice(0, 60)}`;
      seen[base] = (seen[base] || 0) + 1;
      c.key = base + '|' + seen[base];
      c.id = 'df' + out.length;
      out.push(c);
    }
    return out;
  }

  // ----- 화면에 표시 -----
  function clearMarks() {
    document.querySelectorAll('.df-layer').forEach(n => n.remove());
    document.querySelectorAll('span.df-add').forEach(s => { const p = s.parentNode; while (s.firstChild) p.insertBefore(s.firstChild, s); s.remove(); p.normalize(); });
    document.querySelectorAll('span.df-del').forEach(s => s.remove());
  }

  function draw(cur, now) {
    if (cur.kind === 'pdf') return drawPdf(cur, now);
    // 워드: 글자 노드를 잘라서 <span class="df-add"> 로 감싼다 (뒤에서부터 해야 앞 위치가 안 밀림)
    [...changes].reverse().forEach(c => {
      if (c.type !== 'del') {
        const segs = [];
        for (let i = c.s; i < c.e; i++) {
          const m = now.map[i];
          if (!m) continue;
          const last = segs[segs.length - 1];
          if (last && last.node === m.node && last.e === m.k) last.e = m.k + 1; else segs.push({ node: m.node, s: m.k, e: m.k + 1 });
        }
        segs.reverse().forEach(g => {
          if (!g.node.parentNode) return;
          const r = document.createRange();
          r.setStart(g.node, g.s); r.setEnd(g.node, g.e);
          const span = document.createElement('span');
          span.className = 'df-add'; span.dataset.df = c.id;
          if (c.type === 'rep') span.title = '이전: ' + c.old;
          try { r.surroundContents(span); } catch {}
        });
      }
      if (c.type === 'del') {
        const m = now.map[c.s] || now.map.slice(0, c.s).reverse().find(Boolean);
        if (!m || !m.node.parentNode) return;
        const mark = document.createElement('span');
        mark.className = 'df-del'; mark.dataset.df = c.id; mark.textContent = '▾';
        mark.title = '삭제됨: ' + c.old;
        const r = document.createRange();
        r.setStart(m.node, Math.min(m.k, m.node.length)); r.collapse(true);
        r.insertNode(mark);
      }
    });
  }

  // PDF: 글자 좌표(transform)로 밑줄 위치를 계산해 페이지 위 SVG 에 그린다
  function drawPdf(cur, now) {
    const byPage = {};
    const rectOf = (m) => {
      const it = m.it, len = it.str.length || 1;
      const [a, b, , , e, f] = it.transform;
      const h = Math.hypot(a, b) || it.height || 10;
      const x0 = e + (it.width * m.k) / len, w = it.width / len;
      return { x: x0 / m.vp.width, y: 1 - f / m.vp.height, w: w / m.vp.width, h: h / m.vp.height };
    };
    changes.forEach(c => {
      if (c.type === 'del') {
        const m = now.map[c.s] || now.map.slice(0, c.s).reverse().find(Boolean);
        if (!m) return;
        const r = rectOf(m);
        (byPage[m.page] = byPage[m.page] || []).push({ del: true, x: r.x, y: r.y, c });
        return;
      }
      // 같은 줄(같은 item)끼리 이어서 한 줄 밑줄로
      let run = null;
      for (let i = c.s; i < c.e; i++) {
        const m = now.map[i];
        if (!m) { run = null; continue; }
        const r = rectOf(m);
        if (run && run.it === m.it) { run.x2 = r.x + r.w; continue; }
        run = { it: m.it, page: m.page, x: r.x, x2: r.x + r.w, y: r.y, h: r.h, c };
        (byPage[m.page] = byPage[m.page] || []).push(run);
      }
    });
    cur.pages.forEach(p => {
      const items = byPage[p.num];
      if (!items) return;
      const layer = document.createElement('div');
      layer.className = 'df-layer';
      layer.innerHTML = `<svg viewBox="0 0 1 1" preserveAspectRatio="none">${items.filter(r => !r.del).map(r =>
          `<rect class="df-bg" data-df="${r.c.id}" x="${r.x}" y="${r.y - r.h * 0.95}" width="${Math.max(0.002, r.x2 - r.x)}" height="${r.h * 1.15}"><title>${esc(r.c.type === 'rep' ? '이전: ' + r.c.old : '추가됨')}</title></rect>
           <line class="df-ul" data-df="${r.c.id}" x1="${r.x}" x2="${r.x2}" y1="${r.y + r.h * 0.18}" y2="${r.y + r.h * 0.18}"></line>`).join('')}</svg>` +
        items.filter(r => r.del).map(r => `<button type="button" class="df-del df-pin" data-df="${r.c.id}" style="left:${r.x * 100}%;top:${r.y * 100}%" title="삭제됨: ${esc(r.c.old)}">▾</button>`).join('');
      p.el.appendChild(layer);
    });
  }

  // ----- 변경 목록 + 확인 체크 -----
  const checksOf = () => {
    const m = {};
    (Viewer.anns || []).filter(a => a.kind === 'check' && a.file_path === Viewer.filePath).forEach(a => (m[a.body] = m[a.body] || []).push(a));
    return m;
  };
  function renderList() {
    if (!on) return;
    const chk = checksOf();
    const n = { add: 0, del: 0, rep: 0 };
    changes.forEach(c => n[c.type]++);
    const done = changes.filter(c => (chk[c.key] || []).length).length;
    document.getElementById('diffSummary').innerHTML = changes.length
      ? `v${ctx.prev.version} → v${ctx.doc.version}: <b class="df-n add">추가 ${n.add}</b> · <b class="df-n rep">변경 ${n.rep}</b> · <b class="df-n del">삭제 ${n.del}</b>${done ? ` · 확인 ${done}/${changes.length}` : ''}`
      : '이전 버전과 글자가 같습니다. (서식·그림 차이는 비교하지 않아요)';
    document.getElementById('diffList').innerHTML = changes.map(c => {
      const who = chk[c.key] || [];
      const mine = who.find(a => a.user_id === ctx.me.id);
      return `<li class="df-item${who.length ? ' done' : ''}">
        <button type="button" class="mk-check" data-dfchk="${c.id}" title="확인 체크"${ctx.hasV6 ? '' : ' disabled'}>${mine ? '☑' : who.length ? '◪' : '☐'}</button>
        <button type="button" class="mk-go" data-dfgo="${c.id}">
          <span class="mk-top"><b class="df-tag ${c.type}">${{ add: '추가', del: '삭제', rep: '변경' }[c.type]}</b><span class="muted">p.${c.page}</span></span>
          <span class="df-ctx">${c.before ? '…' + esc(c.before) : ''}${c.type !== 'add' ? `<del class="df-old">${esc(c.old.slice(0, 120))}</del>` : ''}${c.type !== 'del' ? `<ins class="df-new">${esc(c.text.slice(0, 120))}</ins>` : ''}${c.after ? esc(c.after) + '…' : ''}</span>
          ${who.length ? `<span class="mk-meta">✔ ${who.map(a => esc(ctx.nameOf[a.user_id] || '')).join(', ')} 확인</span>` : ''}
        </button></li>`;
    }).join('');
  }

  async function onListClick(e) {
    const go = e.target.closest('[data-dfgo]'), ck = e.target.closest('[data-dfchk]');
    if (go) return focus(go.dataset.dfgo);
    if (!ck) return;
    const c = changes.find(x => x.id === ck.dataset.dfchk);
    if (!c) return;
    const mine = (checksOf()[c.key] || []).find(a => a.user_id === ctx.me.id);
    // 내 확인이 있으면 지우고, 없으면 남긴다 (사람마다 따로)
    if (mine) await Viewer.remove(mine.id);
    else {
      const { error } = await sb.from('doc_annotations').insert({ doc_id: ctx.doc.id, file_path: Viewer.filePath, page: c.page, kind: 'check', body: c.key, data: { type: c.type } });
      if (error) return toast(errMsg(error), true);
      await Viewer.reload();
    }
    renderList();
  }

  function focus(id) {
    const els = document.querySelectorAll(`[data-df="${id}"]`);
    if (!els.length) return;
    const el = els[0], s = Viewer.scroller(), r = el.getBoundingClientRect();
    s.scrollTo({ top: s.scrollTop + r.top - s.getBoundingClientRect().top - s.clientHeight / 3, behavior: 'smooth' });
    document.getElementById('viewerCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => els.forEach(n => { n.classList.remove('pv-flash'); void n.getBoundingClientRect(); n.classList.add('pv-flash'); }), 350);
  }

  window.DocDiff = { init, ready, reset, refresh: () => renderList(), get changes() { return changes; } };
})();
