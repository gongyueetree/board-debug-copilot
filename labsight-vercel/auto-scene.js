(() => {
  // LabSight automatic scene routing EVT0.16
  // A tiny browser-side frame signature gates cloud scene classification so a
  // stable camera view costs zero API calls. Two consecutive confident cloud
  // results are still required before changing UI mode.
  const TICK_MS = 2500;
  const MIN_CONFIDENCE = 0.78;
  const REQUIRED_STREAK = 2;
  const DIFF_WIDTH = 64;
  const DIFF_HEIGHT = 36;
  const FRAME_DIFF_THRESHOLD = 0.035; // mean absolute luma delta, normalized 0..1
  const MAX_STABLE_MS = 5 * 60 * 1000; // safety heartbeat only; 12 calls/hour max when perfectly static

  let timer = null;
  let detecting = false;
  let candidate = null;
  let streak = 0;
  let lastApplied = null;
  let baselineSignature = null;
  let lastCloudAt = 0;
  let skippedStableTicks = 0;

  const oldTabs = document.querySelector('.scene-tabs');
  if (oldTabs) oldTabs.style.display = 'none';

  const status = document.createElement('div');
  status.id = 'autoSceneStatus';
  status.className = 'pill neutral';
  status.textContent = '自动识别 · 等待摄像头';
  const head = document.querySelector('.camera-panel .panelhead');
  head?.appendChild(status);

  const style = document.createElement('style');
  style.textContent = `
    #autoSceneStatus{white-space:nowrap;align-self:flex-start;margin-left:auto}
    #autoSceneStatus.detecting{opacity:.8}
  `;
  document.head.appendChild(style);

  const labels = {
    pcb: 'PCB',
    scope: '示波器',
    instrument: '仪器',
    other: '其它场景',
  };

  function setStatus(text, kind='neutral') {
    status.textContent = text;
    status.className = `pill ${kind}`;
  }

  function makeLowResFrame() {
    const video = els?.video;
    if (!video?.videoWidth || !video?.videoHeight || !state?.stream) return null;
    const maxEdge = 640;
    const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext('2d', {alpha:false});
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.58);
  }

  function makeFrameSignature() {
    const video = els?.video;
    if (!video?.videoWidth || !video?.videoHeight || !state?.stream) return null;
    const canvas = document.createElement('canvas');
    canvas.width = DIFF_WIDTH;
    canvas.height = DIFF_HEIGHT;
    const ctx = canvas.getContext('2d', {alpha:false, willReadFrequently:true});
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, DIFF_WIDTH, DIFF_HEIGHT);
    const rgba = ctx.getImageData(0, 0, DIFF_WIDTH, DIFF_HEIGHT).data;
    const luma = new Uint8Array(DIFF_WIDTH * DIFF_HEIGHT);
    for (let i = 0, p = 0; i < rgba.length; i += 4, p += 1) {
      luma[p] = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
    }
    return luma;
  }

  function signatureDiff(a, b) {
    if (!a || !b || a.length !== b.length) return 1;
    let total = 0;
    for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
    return total / (a.length * 255);
  }

  function applyScene(scene, confidence, subtype='') {
    if (!['pcb','scope','instrument'].includes(scene)) return;
    state.scene = scene;
    document.querySelectorAll('.scene').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.scene === scene);
    });
    if (typeof updateSceneUI === 'function') updateSceneUI();
    lastApplied = scene;
    const suffix = subtype && subtype !== 'other' ? ` · ${subtype.replaceAll('_',' ')}` : '';
    setStatus(`自动识别：${labels[scene]} · ${Math.round(confidence*100)}%${suffix}`, 'ok');
  }

  function shouldCallCloud(signature, force=false) {
    if (force || !baselineSignature || !lastCloudAt) return {call:true, diff:1};
    // If one confident result is waiting for confirmation, keep the original
    // double-hit debounce and make exactly one additional cloud call.
    if (candidate && streak > 0 && streak < REQUIRED_STREAK) return {call:true, diff:0};
    const diff = signatureDiff(signature, baselineSignature);
    const heartbeatDue = Date.now() - lastCloudAt >= MAX_STABLE_MS;
    return {call: diff >= FRAME_DIFF_THRESHOLD || heartbeatDue, diff};
  }

  async function detectOnce(force=false) {
    if (detecting) return;
    const signature = makeFrameSignature();
    if (!signature) {
      candidate = null; streak = 0; baselineSignature = null;
      setStatus('自动识别 · 等待摄像头', 'neutral');
      return;
    }

    const gate = shouldCallCloud(signature, force);
    if (!gate.call) {
      skippedStableTicks += 1;
      // Keep the last confirmed scene visible; no cloud request is made here.
      if (lastApplied && skippedStableTicks % 12 === 0) {
        setStatus(`自动识别：${labels[lastApplied]} · 画面稳定`, 'ok');
      }
      return;
    }

    const frame = makeLowResFrame();
    if (!frame) return;
    detecting = true;
    status.classList.add('detecting');
    try {
      const r = await fetch('/api/scene_detect', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({provider:state.provider, image_data_url:frame}),
      });
      const d = await readJsonResponse(r);
      const scene = d.scene;
      const confidence = Number(d.confidence || 0);
      baselineSignature = signature;
      lastCloudAt = Date.now();
      skippedStableTicks = 0;

      if (scene === 'other' || confidence < MIN_CONFIDENCE) {
        candidate = null; streak = 0;
        if (lastApplied) setStatus(`自动识别：${labels[lastApplied]} · 当前画面不确定`, 'neutral');
        else setStatus('自动识别 · 当前画面不确定', 'neutral');
        return;
      }

      if (scene === candidate) streak += 1;
      else { candidate = scene; streak = 1; }

      if (scene === lastApplied) {
        streak = REQUIRED_STREAK;
        candidate = scene;
        const suffix = d.subtype && d.subtype !== 'other' ? ` · ${String(d.subtype).replaceAll('_',' ')}` : '';
        setStatus(`自动识别：${labels[scene]} · ${Math.round(confidence*100)}%${suffix}`, 'ok');
        return;
      }

      if (streak >= REQUIRED_STREAK) {
        applyScene(scene, confidence, d.subtype || '');
      } else {
        setStatus(`识别中：${labels[scene]} · ${Math.round(confidence*100)}%（确认中）`, 'neutral');
      }
    } catch (e) {
      console.warn('auto scene:', e);
      setStatus(lastApplied ? `自动识别：${labels[lastApplied]} · 暂停` : '自动识别暂不可用', 'warn');
    } finally {
      detecting = false;
      status.classList.remove('detecting');
    }
  }

  function start() {
    if (timer) clearInterval(timer);
    void detectOnce(true);
    timer = setInterval(() => void detectOnce(false), TICK_MS);
  }

  window.LabSightAutoScene = {
    start,
    reset() {
      candidate = null;
      streak = 0;
      lastApplied = null;
      baselineSignature = null;
      lastCloudAt = 0;
      skippedStableTicks = 0;
      setStatus('自动识别 · 等待摄像头', 'neutral');
    },
    detectNow: () => detectOnce(true),
    get stats() {
      return {lastApplied, skippedStableTicks, lastCloudAt, threshold:FRAME_DIFF_THRESHOLD};
    },
  };

  start();
})();
