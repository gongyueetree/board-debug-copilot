(() => {
  // LabSight Camera Adapters EVT0.8
  // - UVC/Insta360: request 4K and enable continuous autofocus when the browser exposes UVC focus controls.
  // - Seeed reCamera Pro: use the auto-start LabSight background bridge on localhost.
  //   After one-time installation on macOS it starts at login, so the user no longer launches Python manually.

  let remoteRun = 0;
  let remoteCanvas = null;
  let remoteTimer = null;
  let remoteMicStream = null;
  const BRIDGE_BASE = 'http://127.0.0.1:8765';

  const style = document.createElement('style');
  style.textContent = `
    .camera-source-select{min-width:190px}
    .camera-adapter-panel{display:none;grid-template-columns:1.2fr 1fr 1fr;gap:8px;margin-top:10px;padding:10px;border:1px solid rgba(86,220,190,.20);border-radius:10px;background:rgba(8,20,27,.50)}
    .camera-adapter-panel.show{display:grid}
    .camera-adapter-panel label{display:flex;flex-direction:column;gap:5px;font-size:11px;color:#8ea6b5}
    .camera-adapter-panel input{min-width:0;padding:8px 9px;border-radius:8px;border:1px solid rgba(126,160,177,.26);background:#09131b;color:#dbe8ef}
    .camera-adapter-help{grid-column:1/-1;font-size:11px;color:#829aa9;line-height:1.45}
    .camera-focus-pill{white-space:nowrap}
    .bridge-ok{color:#6fe5b0}
    .bridge-warn{color:#ffcb73}
    @media(max-width:900px){.camera-adapter-panel{grid-template-columns:1fr 1fr}.camera-adapter-help{grid-column:1/-1}}
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
    <div class="camera-adapter-help"><span id="recameraBridgeState">正在检测 LabSight 摄像头服务…</span>　reCamera Pro 通过 Wi‑Fi/RTSP 接入；后台转换服务安装一次后会随 Mac 登录自动启动，不再需要手动运行 Python。</div>`;
  toolbar.insertAdjacentElement('afterend', panel);

  const focusPill = document.createElement('span');
  focusPill.className = 'pill neutral camera-focus-pill';
  focusPill.textContent = '自动对焦 · 待检测';
  document.querySelector('.statusrow')?.appendChild(focusPill);

  const ipEl = panel.querySelector('#recameraIp');
  const userEl = panel.querySelector('#recameraUser');
  const passEl = panel.querySelector('#recameraPassword');
  const bridgeStateEl = panel.querySelector('#recameraBridgeState');

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

  async function bridgeRequest(path, options={}) {
    const r = await fetch(BRIDGE_BASE + path, { cache:'no-store', ...options });
    const txt = await r.text();
    let d = {};
    try { d = JSON.parse(txt); } catch { throw new Error(`后台服务返回异常 (${r.status})：${txt.slice(0,160)}`); }
    if (!r.ok || d.ok === false) throw new Error(d.error || d.detail || `后台服务 HTTP ${r.status}`);
    return d;
  }

  async function probeBridge(show=true) {
    try {
      const d = await bridgeRequest('/health');
      bridgeStateEl.textContent = d.connected ? '后台服务已就绪 · reCamera 视频已连接' : '后台服务已就绪';
      bridgeStateEl.className = 'bridge-ok';
      return true;
    } catch (e) {
      bridgeStateEl.textContent = '后台服务尚未安装/启动';
      bridgeStateEl.className = 'bridge-warn';
      if (show) console.warn('reCamera background service:', e);
      return false;
    }
  }

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

  async function configureBridge() {
    const ip = ipEl.value.trim();
    const username = userEl.value.trim() || 'admin';
    const password = passEl.value;
    if (!ip) throw new Error('请输入 reCamera Pro IP 地址');
    localStorage.setItem('labsight-recamera-ip', ip);
    localStorage.setItem('labsight-recamera-user', username);
    return bridgeRequest('/configure', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ camera_ip:ip, username, password, rtsp_path:'/live' })
    });
  }

  async function fetchRemoteFrame(runId) {
    if (runId !== remoteRun) return;
    try {
      const r = await fetch(`${BRIDGE_BASE}/frame.jpg?t=${Date.now()}`, { cache:'no-store' });
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
      remoteTimer = setTimeout(() => fetchRemoteFrame(runId), 70);
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
      const ready = await probeBridge(false);
      if (!ready) {
        throw new Error('LabSight 摄像头后台服务未就绪。首次只需双击 tools/install-recamera-service.command 安装；以后 Mac 登录后会自动运行。');
      }
      const cfg = await configureBridge();
      let firstBlob = null;
      for (let i=0;i<30;i++) {
        const r = await fetch(`${BRIDGE_BASE}/frame.jpg?t=${Date.now()}`, { cache:'no-store' });
        if (r.ok) { firstBlob = await r.blob(); break; }
        await new Promise(r => setTimeout(r, 200));
      }
      if (!firstBlob) throw new Error('后台服务已连接，但暂未从 reCamera RTSP 收到视频帧，请确认 IP、密码和 RTSP 已启用');
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
      await probeBridge(false);
      setPill(els.cameraStatus, `reCamera Pro · Wi‑Fi/RTSP · ${cfg.width || remoteCanvas.width}×${cfg.height || remoteCanvas.height}`, 'ok');
      setPill(els.micStatus, audioTracks.length ? `Mic · ${audioTracks[0].label || '本机麦克风'}` : 'Mic · 未连接', audioTracks.length?'ok':'warn');
      els.viewerEmpty.classList.add('hidden'); els.viewerBadge.style.display='block'; els.viewerBadge.textContent='reCamera LIVE'; els.startCamera.textContent='重新连接';
      if (els.wakeToggle.checked && audioTracks.length) startWakeListening();
    } catch (e) {
      setPill(els.cameraStatus, 'reCamera Pro 连接失败', 'warn');
      alert(`reCamera Pro 连接失败：${e.message}`);
    }
  }

  sourceSelect.addEventListener('change', () => {
    const remote = sourceSelect.value === 'recamera';
    panel.classList.toggle('show', remote);
    els.cameraSelect.disabled = remote;
    els.refreshDevices.disabled = remote;
    els.startCamera.textContent = remote ? '连接 reCamera Pro' : '连接摄像头';
    if (remote) probeBridge(false); else setFocusPill('自动对焦 · 待检测', 'neutral');
  });

  els.startCamera.addEventListener('click', async (e) => {
    e.preventDefault(); e.stopImmediatePropagation();
    if (sourceSelect.value === 'recamera') await startReCamera(); else await startUvc();
  }, true);

  probeBridge(false);

  window.LabSightCameraAdapters = {
    enableAutofocus,
    stopRemote,
    probeBridge,
    get source(){ return sourceSelect.value; },
    get remoteCanvas(){ return remoteCanvas; }
  };
})();
