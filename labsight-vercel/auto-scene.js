(() => {
  // LabSight automatic scene routing EVT0.11
  // Low-resolution snapshots classify PCB / oscilloscope / other instrument.
  // Two consecutive confident results are required before changing UI mode.
  const TICK_MS = 2500;
  const MIN_CONFIDENCE = 0.78;
  const REQUIRED_STREAK = 2;

  let timer = null;
  let detecting = false;
  let candidate = null;
  let streak = 0;
  let lastApplied = null;

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

  async function detectOnce() {
    if (detecting) return;
    const frame = makeLowResFrame();
    if (!frame) {
      candidate = null; streak = 0;
      setStatus('自动识别 · 等待摄像头', 'neutral');
      return;
    }
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
    void detectOnce();
    timer = setInterval(() => void detectOnce(), TICK_MS);
  }

  // Camera adapters call this on explicit disconnect so scene routing resets immediately.
  window.LabSightAutoScene = {
    start,
    reset() {
      candidate = null; streak = 0; lastApplied = null;
      setStatus('自动识别 · 等待摄像头', 'neutral');
    },
    detectNow: detectOnce,
  };

  start();
})();
