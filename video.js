// =====================================================================
// 영상 (v6.3): 50MB가 넘는 영상은 올리기 전에 이 브라우저 안에서 720p로 줄인다
//   파일은 외부 서버로 나가지 않는다. 영상을 재생하면서 다시 녹화하므로 영상 길이만큼 걸린다.
// =====================================================================
(() => {
  const LIMIT = 50 * 1024 * 1024;
  const isVideo = (f) => /^video\//i.test((f && f.type) || '') || /\.(mp4|m4v|mov|webm|ogv)$/i.test((f && f.name) || '');
  const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  // 시험할 때 기준을 낮출 수 있게 (localStorage.video_limit_mb)
  const limit = () => { try { const v = +localStorage.getItem('video_limit_mb'); return v > 0 ? v * 1024 * 1024 : LIMIT; } catch { return LIMIT; } };

  function pickMime() {
    if (!window.MediaRecorder) return null;
    return ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find(t => MediaRecorder.isTypeSupported(t)) || null;
  }

  function overlay(name) {
    const el = document.createElement('div');
    el.className = 'modal-back vid-wrap';
    el.innerHTML = `<div class="card modal vid-modal">
      <h2>🎬 영상 용량 줄이는 중</h2>
      <p class="muted vid-name">${App.esc(name)}</p>
      <div class="progress"><div class="vid-bar" style="width:0"></div></div>
      <p class="vid-txt muted">준비 중…</p>
      <p class="muted" style="font-size:.9em">50MB가 넘어서 720p로 줄여서 올립니다. 영상 길이만큼 시간이 걸려요. 이 화면을 닫지 마세요.</p>
      <div class="btn-row"><button class="btn" type="button" data-start hidden>▶ 시작</button><button class="btn ghost" type="button" data-cancel>취소</button></div></div>`;
    document.body.appendChild(el);
    return el;
  }

  // 한 번 녹화: 재생하면서 canvas 로 줄이고 소리와 함께 MediaRecorder 로 담는다
  function encodeOnce(file, { vbps, onProgress, signal, needGesture }) {
    return new Promise((resolve, reject) => {
      const mime = pickMime();
      if (!mime) return reject(new Error('이 브라우저는 영상 줄이기를 지원하지 않습니다. 크롬이나 휴대폰에서 올려 주세요.'));
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.src = url; v.playsInline = true; v.preload = 'auto'; v.muted = false;
      v.style.cssText = 'position:fixed;left:-9999px;width:2px;height:2px';
      document.body.appendChild(v);
      let rec, ac, raf, done = false;
      const cleanup = () => { done = true; cancelAnimationFrame(raf); try { v.pause(); } catch {} v.remove(); URL.revokeObjectURL(url); if (ac) ac.close().catch(() => {}); };
      const fail = (msg) => { if (done) return; cleanup(); reject(new Error(msg)); };
      if (signal) signal.addEventListener('abort', () => { if (rec && rec.state !== 'inactive') rec.stop(); fail('취소했습니다'); });
      v.onerror = () => fail('이 영상은 이 기기에서 변환할 수 없습니다. 휴대폰에서 올리거나 50MB 이하로 줄여서 올려 주세요.');
      v.onloadedmetadata = async () => {
        if (!v.videoWidth || !isFinite(v.duration)) return fail('영상 정보를 읽지 못했습니다.');
        const scale = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
        const cv = document.createElement('canvas');
        cv.width = Math.round(v.videoWidth * scale / 2) * 2; cv.height = Math.round(v.videoHeight * scale / 2) * 2;
        const g = cv.getContext('2d');
        const stream = cv.captureStream(30);
        // 소리: 영상 소리를 녹화 스트림에 넣고, 스피커로는 내보내지 않는다
        try {
          ac = new (window.AudioContext || window.webkitAudioContext)();
          const src = ac.createMediaElementSource(v), dst = ac.createMediaStreamDestination();
          src.connect(dst);
          dst.stream.getAudioTracks().forEach(t => stream.addTrack(t));
        } catch { v.muted = true; }
        const chunks = [];
        rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: vbps, audioBitsPerSecond: 96000 });
        rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
        rec.onstop = () => {
          if (done && signal && signal.aborted) return;
          cleanup();
          const type = mime.split(';')[0];
          const ext = type === 'video/mp4' ? 'mp4' : 'webm';
          resolve(new File(chunks, file.name.replace(/\.[^.]+$/, '') + '.' + ext, { type }));
        };
        const draw = () => {
          if (done) return;
          g.drawImage(v, 0, 0, cv.width, cv.height);
          onProgress && onProgress(Math.min(1, v.currentTime / v.duration), v.duration - v.currentTime);
          raf = requestAnimationFrame(draw);
        };
        v.onended = () => { g.drawImage(v, 0, 0, cv.width, cv.height); setTimeout(() => rec.state !== 'inactive' && rec.stop(), 200); };
        rec.start(1000);
        // 파일을 고른 지 오래 지나면 브라우저가 소리 있는 재생을 막는다 → [시작] 버튼을 한 번 누르게 한다
        const start = async () => { if (ac && ac.state === 'suspended') await ac.resume(); await v.play(); };
        try { await start(); }
        catch {
          try { await (needGesture ? needGesture() : Promise.reject()); await start(); }
          catch { return fail('영상을 재생하지 못했습니다. 다시 시도해 주세요.'); }
        }
        draw();
      };
    });
  }

  // 50MB 이하면 그대로, 넘으면 줄여서 돌려준다
  async function prepareVideo(file) {
    if (!isVideo(file) || file.size <= limit()) return file;
    const ui = overlay(file.name);
    const ctl = new AbortController();
    ui.querySelector('[data-cancel]').onclick = () => ctl.abort();
    const bar = ui.querySelector('.vid-bar'), txt = ui.querySelector('.vid-txt');
    try {
      let out = null;
      for (const vbps of [1500000, 700000]) {
        out = await encodeOnce(file, {
          vbps, signal: ctl.signal,
          needGesture: () => new Promise((ok) => {
            const b = ui.querySelector('[data-start]');
            b.hidden = false; txt.textContent = '▶ 시작을 눌러 주세요';
            b.onclick = () => { b.hidden = true; ok(); };
          }),
          onProgress: (p, left) => { bar.style.width = (p * 100).toFixed(1) + '%'; txt.textContent = `${Math.round(p * 100)}% · 남은 시간 ${fmtT(Math.max(0, left))}`; },
        });
        if (out.size <= limit()) break;
        txt.textContent = '아직 커서 한 번 더 줄이는 중…';
      }
      if (out.size > limit()) throw new Error('영상이 너무 길어서 50MB 아래로 줄이지 못했습니다. 나눠서 올려 주세요.');
      App.toast(`영상을 ${App.fmtSize(file.size)} → ${App.fmtSize(out.size)}로 줄였습니다.`);
      return out;
    } finally { ui.remove(); }
  }

  Object.assign(window.App, { isVideo, prepareVideo, fmtT, VIDEO_LIMIT: LIMIT });
})();
