(() => {
  // LabSight Camera Adapters EVT0.7
  // - UVC/Insta360: request 4K and enable continuous autofocus when the browser exposes UVC focus controls.
  // - Seeed reCamera Pro: consume frames from a local LabSight reCamera Bridge and expose them as a MediaStream,
  //   so the existing capture / AI / Deep Vision pipeline continues to work unchanged.

  let remoteRun = 0;
  let remoteCanvas = null;
  let remoteTimer = null;
  let remoteMicStream = null;

  const style = document.createElement('style');
  style.textContent = `
    .camera-source-select{min-width:170px}
    .camera-adapter-panel{display:none;grid-template-columns:1.1fr 1fr 1fr 1fr;gap:8px;margin-top:10px;padding:10px;border:1px solid rgba(86,220,190,.20);border-radius:10px;background:rgba(8,20,27,.50)}
    .camera-adapter-panel.show{display:grid}
    .camera-adapter-panel label{display:flex;flex-direction:column;gap:5px;font-size:11px;color:#8ea6b5}
    .camera-adapter-panel input{min-width:0;padding:8px 9px;border-radius:8px;border:1px solid rgba(126,160,177,.26);background:#09131b;color:#dbe8ef}
    .camera-adapter-help{grid-column:1/-1;font-size:11px;color:#829aa9;line-height:1.45}
    .camera-focus-pill{white-space:nowrap}
    @media(max-width:900px){.camera-adapter-panel{grid-template-columns:1fr 1fr}}
  `;
  document.head.appendChild(style);

  const toolbar = document.querySelector('.camera-toolbar');
  if (!toolbar || !window.navigator?.mediaDevices) return;

  const sourceSelect = document.createElement('select');
  sourceSelect.id = 'cameraSourceSelect';
  sourceSelect.className = 'camera-source-select';
  sourceSelect.setAttribute('aria-label', '摄像头类型');
  sourceSelect.add(new Option('USB / UVC 摄像头', 'uvc'));
  sourceSelect.add(new Option('Seeed reCamera Pro（Wi‑Fi）', 'recamera'));
  toolbar.insertBefore(sourceSelect, els.cameraSelect);

  const panel = document.createElement('div');
  panel.className = 'camera-adapter-panel';
  panel.innerHTML = `
    <label>reCamera Pro IP<input id="recameraIp" value="${localStorage.getItem('labsight-recamera-ip') || '192.168.42.1'}" placeholder="192.168.1.100"></label>
    <label>用户名<input id="recameraUser" value="${localStorage.getItem('labsight-recamera-user') || 'admin'}" autocomplete="username"></label>
    <label>密码<input id="recameraPassword" type="password" value="" autocomplete="current-password" placeholder="设备登录密码"></label>
    <label>本地 Bridge<input id="recameraBridge" value="${localStorage.getItem('labsight-recamera-bridge') || 'http://127.0.0.1:8765'}" placeholder="http://127.0.0.1:8765"></label>
    <div class="camera-adapter-help">reCamera Pro 通过 Wi‑Fi 输出 RTSP；浏览器不能直接播放 RTSP，因此 LabSight 使用本地 reCamera Bridge 转换为浏览器可用帧。语音输入仍使用上方选择的本机/USB 麦克风。</div>`;
  toolbar.insertAdjacentElement('afterend', panel);

  const focusPill = document.createElement('span');
  focusPill.className = 'pill neutral camera-focus-pill';
  focusPill.textContent = '自动对焦 · 待检测';
  document.querySelector('.statusrow')?.appendChild(focusPill);

  const ipEl = panel.querySelector('#recameraIp');
  const userEl = panel.querySelector('#recameraUser');
  const passEl = panel.querySelector('#recameraPassword');
  const bridgeEl = panel.querySelector('#recameraBridge');

  const setFocusPill = (text, kind='neutral') => {
    focusPill.textContent = text;
    focusPill.className = `pill ${kind} camera-focus-pill`;
  };

  const stopRemote = () => {
    remoteRun += 1;
    clearTimeout(remoteTimer); remoteTimer = null;
    try { remoteMicStream?.getTracks().forEach(t => t.stop()); } catch {}
    remoteMicStream = null;
  };

  async function enableAutofocus(track) {
    if (!track) return;
    const label = track.label || '';
    const caps = track.getCapabilities?.() || {};
    const modes = Array.isArray(caps.focusMode) ? caps.focusMode : [];
    try {
      if (modes.includes('continuous')) {
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        const mode = track.getSettings?.().focusMode || 'continuous';
        setFocusPill(`自动对焦 · ${mode === 'continuous' ? '连续 AF' : mode}`, 'ok');
        return;
      }
      // Insta360 Link performs autofocus in camera firmware even when the host browser does not expose UVC focusMode.
      if (/insta360|link\s*2|link\s*2c|insta360\s*link/i.test(label)) {
        setFocusPill('自动对焦 · 相机固件管理', 'ok');
        return;
      }
      setFocusPill(modes.length ? `对焦模式 · ${modes.join('/')}` : '自动对焦 · 浏览器不可控', 'neutral');
    } catch (e) {
      console.warn('autofocus:', e);
      setFocusPill('自动对焦 · 保持设备默认', 'warn');
    }
  }

  async function startUvc() {
    stopRemote();
    stopWakeListening();
    try { state.stream?.getTracks().forEach(t => t.stop()); } catch {}
    const videoId = els.cameraSelect.value, audioId = els.micSelect.value;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoId ? {
          deviceId: { exact: videoId },
          width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30, max: 30 }
        } : { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30, max: 30 } },
        audio: audioId ? { deviceId:{exact:audioId}, echoCancellation:true, noiseSuppression:true, autoGainControl:true } : true
      });
      state.stream = stream;
      els.video.srcObject = stream;
      await els.video.play();
      const vt = stream.getVideoTracks()[0], at = stream.getAudioTracks()[0], s = vt.getSettings?.() || {};
      await enableAutofocus(vt);
      setPill(els.cameraStatus, `Camera · ${vt.label || '已连接'} · ${s.width || '?'}×${s.height || '?'}`, 'ok');
      setPill(els.micStatus, `Mic · ${at?.label || '已连接'}`, 'ok');
      els.viewerEmpty.classList.add('hidden'); els.viewerBadge.style.display='block'; els.startCamera.textContent='重新连接';
      await enumerateDevices(false);
      if (els.wakeToggle.checked) startWakeListening();
    } catch (e) {
      setPill(els.cameraStatus, 'Camera/Mic 连接失败', 'warn');
      alert(`连接失败：${e.message}\n\n请允许摄像头和麦克风权限。`);
    }
  }

  async function bridgeJson(path, options={}) {
    const base = bridgeEl.value.trim().replace(/\/$/, '');
    const r = await fetch(base + path, { cache:'no-store', ...options });
    const txt = await r.text();
    let d = {};
    try { d = JSON.parse(txt); } catch { throw new Error(`Bridge 返回异常 (${r.status})：${txt.slice(0,160)}`); }
    if (!r.ok || d.ok === false) throw new Error(d.error || d.detail || `Bridge HTTP ${r.status}`);
    return d;
  }

  async function configureBridge() {
    const ip = ipEl.value.trim();
    const username = userEl.value.trim() || 'admin';
    const password = passEl.value;
    if (!ip) throw new Error('请输入 reCamera Pro IP 地址');
    localStorage.setItem('labsight-recamera-ip', ip);
    localStorage.setItem('labsight-recamera-user', username);
    localStorage.setItem('labsight-recamera-bridge', bridgeEl.value.trim());
    return bridgeJson('/configure', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ camera_ip:ip, username, password, rtsp_path:'/live' })
    });
  }

  async function fetchRemoteFrame(runId) {
    if (runId !== remoteRun) return;
    const base = bridgeEl.value.trim().replace(/\/$/, '');
    try {
      const r = await fetch(`${base}/frame.jpg?t=${Date.now()}`, { cache:'no-store' });
      if (!r.ok) throw new Error(`frame HTTP ${r.status}`);
      const blob = await r.blob();
      const bitmap = await createImageBitmap(blob);
      if (runId !== remoteRun) { bitmap.close(); return; }
      if (!remoteCanvas) remoteCanvas = document.createElement('canvas');
      if (remoteCanvas.width !== bitmap.width || remoteCanvas.height !== bitmap.height) {
        remoteCanvas.width = bitmap.width; remoteCanvas.height = bitmap.height;
      }
      remoteCanvas.getContext('2d', {alpha:false}).drawImage(bitmap,0,0);
      bitmap.close();
      remoteTimer = setTimeout(() => fetchRemoteFrame(runId), 70); // target ~14 fps; bridge/camera may deliver less.
    } catch (e) {
      console.warn('reCamera frame:', e);
      if (runId === remoteRun) remoteTimer = setTimeout(() => fetchRemoteFrame(runId), 500);
    }
  }

  async function startReCamera() {
    stopRemote();
    stopWakeListening();
    try { state.stream?.getTracks().forEach(t => t.stop()); } catch {}
    setPill(els.cameraStatus, 'reCamera Pro · 正在连接…', 'neutral');
    setFocusPill('reCamera Pro · M12 镜头对焦', 'neutral');
    try {
      const cfg = await configureBridge();
      const base = bridgeEl.value.trim().replace(/\/$/, '');
      // Wait until the bridge has decoded at least one frame.
      let firstBlob = null;
      for (let i=0;i<25;i++) {
        const r = await fetch(`${base}/frame.jpg?t=${Date.now()}`, { cache:'no-store' });
        if (r.ok) { firstBlob = await r.blob(); break; }
        await new Promise(r => setTimeout(r, 200));
      }
      if (!firstBlob) throw new Error('已连接 Bridge，但暂未从 RTSP 收到视频帧');
      const bitmap = await createImageBitmap(firstBlob);
      remoteCanvas = document.createElement('canvas');
      remoteCanvas.width = bitmap.width; remoteCanvas.height = bitmap.height;
      remoteCanvas.getContext('2d', {alpha:false}).drawImage(bitmap,0,0); bitmap.close();

      const canvasStream = remoteCanvas.captureStream ? remoteCanvas.captureStream(15) : null;
      if (!canvasStream) throw new Error('当前浏览器不支持 Canvas captureStream，请使用 Chrome/Edge');
      let audioTracks = [];
      try {
        const audioId = els.micSelect.value;
        remoteMicStream = await navigator.mediaDevices.getUserMedia({audio:audioId?{deviceId:{exact:audioId},echoCancellation:true,noiseSuppression:true,autoGainControl:true}:true,video:false});
        audioTracks = remoteMicStream.getAudioTracks();
      } catch (e) { console.warn('local mic for reCamera:', e); }
      state.stream = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);
      els.video.srcObject = state.stream; await els.video.play();
      const runId = ++remoteRun;
      fetchRemoteFrame(runId);
      setPill(els.cameraStatus, `reCamera Pro · Wi‑Fi/RTSP · ${cfg.width || remoteCanvas.width}×${cfg.height || remoteCanvas.height}`, 'ok');
      setPill(els.micStatus, audioTracks.length ? `Mic · ${audioTracks[0].label || '本机麦克风'}` : 'Mic · 未连接', audioTracks.length?'ok':'warn');
      els.viewerEmpty.classList.add('hidden'); els.viewerBadge.style.display='block'; els.viewerBadge.textContent='reCamera LIVE'; els.startCamera.textContent='重新连接';
      if (els.wakeToggle.checked && audioTracks.length) startWakeListening();
    } catch (e) {
      setPill(els.cameraStatus, 'reCamera Pro 连接失败', 'warn');
      alert(`reCamera Pro 连接失败：${e.message}\n\n请先运行 tools/recamera_bridge.py，并确认 reCamera Pro 与电脑处于同一网络。`);
    }
  }

  sourceSelect.addEventListener('change', () => {
    const remote = sourceSelect.value === 'recamera';
    panel.classList.toggle('show', remote);
    els.cameraSelect.disabled = remote;
    els.refreshDevices.disabled = remote;
    els.startCamera.textContent = remote ? '连接 reCamera Pro' : '连接摄像头';
    if (!remote) setFocusPill('自动对焦 · 待检测', 'neutral');
  });

  // Capture phase replaces the old direct event listener from app.js without invasive edits.
  els.startCamera.addEventListener('click', async (e) => {
    e.preventDefault(); e.stopImmediatePropagation();
    if (sourceSelect.value === 'recamera') await startReCamera(); else await startUvc();
  }, true);

  // When reCamera is active, the existing capture button can keep using the video's MediaStream.
  // The frame source is the remote canvas, so captureFrame/buildDeepVisionPack need no special branch.

  // Expose adapter diagnostics for console/debugging.
  window.LabSightCameraAdapters = {
    enableAutofocus,
    stopRemote,
    get source(){ return sourceSelect.value; },
    get remoteCanvas(){ return remoteCanvas; }
  };
})();
