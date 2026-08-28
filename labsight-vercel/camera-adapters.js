(() => {
  // LabSight Camera Adapters EVT0.10
  // UVC/Insta360: 4K + browser-exposed continuous AF.
  // reCamera Pro: RTSP is converted to WebRTC by the auto-start local service;
  // the browser receives a real MediaStreamTrack (no JPEG polling / canvas bridge).

  const DEFAULT_BRIDGE_PORT = 18765;
  let remotePc = null;
  let remoteMicStream = null;

  const style = document.createElement('style');
  style.textContent = `
    .camera-toolbar{grid-template-columns:repeat(12,minmax(0,1fr));align-items:stretch}
    .camera-toolbar>*{min-width:0;width:100%}
    .camera-toolbar select{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .camera-toolbar button{white-space:nowrap}
    .camera-source-select,#cameraSelect,#micSelect,#audioOutputSelect{grid-column:span 3}
    #refreshDevices,#disconnectCamera{grid-column:span 2}
    #startCamera{grid-column:span 3}
    .camera-source-select{min-width:0}
    .camera-adapter-panel{display:none;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:10px 20px 0;padding:12px;border:1px solid rgba(86,220,190,.20);border-radius:10px;background:rgba(8,20,27,.50);max-width:calc(100% - 40px);overflow:hidden}
    .camera-adapter-panel.show{display:grid}
    .camera-adapter-panel label{display:flex;min-width:0;flex-direction:column;gap:5px;font-size:11px;color:#8ea6b5}
    .camera-adapter-panel input{width:100%;min-width:0;padding:8px 9px;border-radius:8px;border:1px solid rgba(126,160,177,.26);background:#09131b;color:#dbe8ef}
    .camera-adapter-help{grid-column:1/-1;font-size:11px;color:#829aa9;line-height:1.45;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .camera-focus-pill{white-space:nowrap}
    .bridge-state{font-weight:650}
    .bridge-state.ok{color:#57e3b2}.bridge-state.warn{color:#ffbf69}
    .camera-disconnect{display:none;border-color:rgba(255,106,106,.38)!important;color:#ff9a9a!important}
    .camera-disconnect.show{display:inline-flex}
    @media(max-width:1250px){
      .camera-toolbar{grid-template-columns:repeat(2,minmax(0,1fr))}
      .camera-toolbar>*{grid-column:span 1!important}
    }
    @media(max-width:900px){
      .camera-adapter-panel{grid-template-columns:repeat(2,minmax(0,1fr))}
    }
    @media(max-width:560px){
      .camera-toolbar,.camera-adapter-panel{grid-template-columns:minmax(0,1fr)}
    }
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

  const disconnectBtn = document.createElement('button');
  disconnectBtn.id = 'disconnectCamera';
  disconnectBtn.className = 'secondary camera-disconnect';
  disconnectBtn.type = 'button';
  disconnectBtn.textContent = '断开连接';
  toolbar.appendChild(disconnectBtn);

  const panel = document.createElement('div');
  panel.className = 'camera-adapter-panel';
  panel.innerHTML = `
    <label>reCamera Pro IP<input id="recameraIp" value="${localStorage.getItem('labsight-recamera-ip') || '192.168.42.1'}" placeholder="192.168.1.100"></label>
    <label>用户名<input id="recameraUser" value="${localStorage.getItem('labsight-recamera-user') || 'admin'}" autocomplete="username"></label>
    <label>密码<input id="recameraPassword" type="password" value="" autocomplete="current-password" placeholder="设备登录密码"></label>
    <label>RTSP 路径<input id="recameraRtspPath" value="${localStorage.getItem('labsight-recamera-rtsp-path') || '/main'}" placeholder="/main"></label>
    <label>Bridge 端口<input id="recameraBridgePort" type="number" min="1" max="65535" value="${localStorage.getItem('labsight-recamera-bridge-port') || DEFAULT_BRIDGE_PORT}" placeholder="${DEFAULT_BRIDGE_PORT}"></label>
    <div class="camera-adapter-help"><span id="recameraBridgeState" class="bridge-state">正在检测 WebRTC 服务…</span><span>视频链路：reCamera RTSP/H.264 → 本机后台 WebRTC → LabSight Browser。后台服务安装一次后会随系统登录自动启动。</span></div>`;
  toolbar.insertAdjacentElement('afterend', panel);

  const focusPill = document.createElement('span');
  focusPill.className = 'pill neutral camera-focus-pill';
  focusPill.textContent = '自动对焦 · 待检测';
  document.querySelector('.statusrow')?.appendChild(focusPill);

  const ipEl = panel.querySelector('#recameraIp');
  const userEl = panel.querySelector('#recameraUser');
  const passEl = panel.querySelector('#recameraPassword');
  const rtspPathEl = panel.querySelector('#recameraRtspPath');
  const bridgePortEl = panel.querySelector('#recameraBridgePort');
  const bridgeStateEl = panel.querySelector('#recameraBridgeState');

  const setFocusPill = (text, kind='neutral') => {
    focusPill.textContent = text;
    focusPill.className = `pill ${kind} camera-focus-pill`;
  };

  function stopRemote() {
    try { remotePc?.close(); } catch {}
    remotePc = null;
    try { remoteMicStream?.getTracks().forEach(t => t.stop()); } catch {}
    remoteMicStream = null;
  }

  function setConnectedUi(connected) {
    disconnectBtn.classList.toggle('show', connected);
    if (!connected) {
      els.viewerBadge.style.display = 'none';
      els.viewerEmpty.classList.remove('hidden');
      els.startCamera.textContent = sourceSelect.value === 'recamera' ? '连接 reCamera Pro' : '连接摄像头';
    }
  }

  function disconnectCamera() {
    stopWakeListening();
    try { window.cancelLabSightSpeech?.(false); } catch {}
    stopRemote();
    try { state.stream?.getTracks().forEach(t => t.stop()); } catch {}
    state.stream = null;
    try { els.video.pause(); } catch {}
    els.video.srcObject = null;
    setPill(els.cameraStatus, 'Camera 未连接', 'neutral');
    setPill(els.micStatus, 'Mic 未连接', 'neutral');
    setFocusPill('自动对焦 · 待检测', 'neutral');
    setConnectedUi(false);
    window.LabSightAutoScene?.reset?.();
  }

  function bridgeOrigin() {
    const rawPort = bridgePortEl.value.trim() || String(DEFAULT_BRIDGE_PORT);
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Bridge 端口必须是 1–65535 的整数');
    bridgePortEl.value = String(port);
    localStorage.setItem('labsight-recamera-bridge-port', String(port));
    return `http://127.0.0.1:${port}`;
  }

  async function checkBridge(origin) {
    try {
      const bridge = origin || bridgeOrigin();
      const r = await fetch(`${bridge}/health?t=${Date.now()}`, {cache:'no-store'});
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error('health failed');
      bridgeStateEl.textContent = 'WebRTC 后台服务已就绪';
      bridgeStateEl.className = 'bridge-state ok';
      return true;
    } catch (error) {
      bridgeStateEl.textContent = error.message?.startsWith('Bridge 端口') ? error.message : 'WebRTC 后台服务未运行：请检查 Bridge 端口和服务状态';
      bridgeStateEl.className = 'bridge-state warn';
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
        await track.applyConstraints({advanced:[{focusMode:'continuous'}]});
        const mode = track.getSettings?.().focusMode || 'continuous';
        setFocusPill(`自动对焦 · ${mode === 'continuous' ? '连续 AF' : mode}`, 'ok');
      } else if (/insta360|link\s*2|link\s*2c|insta360\s*link/i.test(label)) {
        setFocusPill('自动对焦 · 相机固件管理', 'ok');
      } else {
        setFocusPill(modes.length ? `对焦模式 · ${modes.join('/')}` : '自动对焦 · 浏览器不可控', 'neutral');
      }
    } catch (e) {
      console.warn('autofocus:', e);
      setFocusPill('自动对焦 · 保持设备默认', 'warn');
    }
  }

  async function startUvc() {
    disconnectCamera();
    const videoId = els.cameraSelect.value, audioId = els.micSelect.value;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoId ? {deviceId:{exact:videoId},width:{ideal:3840},height:{ideal:2160},frameRate:{ideal:30,max:30}} : {width:{ideal:3840},height:{ideal:2160},frameRate:{ideal:30,max:30}},
        audio: audioId ? {deviceId:{exact:audioId},echoCancellation:true,noiseSuppression:true,autoGainControl:true} : true
      });
      state.stream = stream;
      els.video.srcObject = stream;
      await els.video.play();
      const vt=stream.getVideoTracks()[0], at=stream.getAudioTracks()[0], s=vt.getSettings?.()||{};
      await enableAutofocus(vt);
      setPill(els.cameraStatus, `Camera · ${vt.label || '已连接'} · ${s.width || '?'}×${s.height || '?'}`, 'ok');
      setPill(els.micStatus, `Mic · ${at?.label || '已连接'}`, 'ok');
      els.viewerEmpty.classList.add('hidden'); els.viewerBadge.style.display='block'; els.viewerBadge.textContent='LIVE'; els.startCamera.textContent='重新连接';
      setConnectedUi(true);
      await enumerateDevices(false);
      window.LabSightAutoScene?.detectNow?.();
      if (els.wakeToggle.checked) startWakeListening();
    } catch (e) {
      disconnectCamera();
      setPill(els.cameraStatus, 'Camera/Mic 连接失败', 'warn');
      alert(`连接失败：${e.message}\n\n请允许摄像头和麦克风权限。`);
    }
  }

  function waitIceGatheringComplete(pc, timeout=1800) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(done, timeout);
      function done(){ clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', onChange); resolve(); }
      function onChange(){ if (pc.iceGatheringState === 'complete') done(); }
      pc.addEventListener('icegatheringstatechange', onChange);
    });
  }

  async function startReCamera() {
    disconnectCamera();
    setPill(els.cameraStatus, 'reCamera Pro · WebRTC 正在连接…', 'neutral');
    setFocusPill('reCamera Pro · M12 镜头手动对焦', 'neutral');

    const ip = ipEl.value.trim();
    const username = userEl.value.trim() || 'admin';
    const password = passEl.value;
    const rawRtspPath = rtspPathEl.value.trim() || '/main';
    const rtspPath = rawRtspPath.startsWith('/') ? rawRtspPath : `/${rawRtspPath}`;
    if (!ip) { alert('请输入 reCamera Pro IP 地址'); return; }
    let bridge;
    try { bridge = bridgeOrigin(); } catch (error) { alert(error.message); return; }
    rtspPathEl.value = rtspPath;
    localStorage.setItem('labsight-recamera-ip', ip);
    localStorage.setItem('labsight-recamera-user', username);
    localStorage.setItem('labsight-recamera-rtsp-path', rtspPath);

    try {
      if (!(await checkBridge(bridge))) throw new Error('本机 WebRTC 后台服务未运行。请检查 Bridge 端口和服务状态。');

      let audioTracks = [];
      try {
        const audioId = els.micSelect.value;
        remoteMicStream = await navigator.mediaDevices.getUserMedia({video:false,audio:audioId?{deviceId:{exact:audioId},echoCancellation:true,noiseSuppression:true,autoGainControl:true}:true});
        audioTracks = remoteMicStream.getAudioTracks();
      } catch (e) { console.warn('reCamera local mic:', e); }

      const pc = new RTCPeerConnection();
      remotePc = pc;
      pc.addTransceiver('video', {direction:'recvonly'});

      let gotVideo = false;
      pc.ontrack = async ev => {
        if (ev.track.kind !== 'video') return;
        gotVideo = true;
        state.stream = new MediaStream([ev.track, ...audioTracks]);
        els.video.srcObject = new MediaStream([ev.track]);
        try { await els.video.play(); } catch {}
      };
      pc.onconnectionstatechange = () => {
        if (pc !== remotePc) return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') setPill(els.cameraStatus, `reCamera Pro · WebRTC ${pc.connectionState}`, 'warn');
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitIceGatheringComplete(pc);

      const r = await fetch(`${bridge}/offer`, {
        method:'POST', cache:'no-store', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({sdp:pc.localDescription.sdp,type:pc.localDescription.type,camera_ip:ip,username,password,rtsp_path:rtspPath})
      });
      const text = await r.text();
      let answer={}; try { answer=JSON.parse(text); } catch {}
      if (!r.ok) throw new Error(answer.error || text || `WebRTC bridge HTTP ${r.status}`);
      await pc.setRemoteDescription(answer);

      const deadline = Date.now()+8000;
      while (!gotVideo && Date.now()<deadline) await new Promise(r=>setTimeout(r,100));
      if (!gotVideo) throw new Error(`WebRTC 已协商，但没有收到 reCamera 视频轨道；请确认 RTSP ${rtspPath} 已启用。`);

      setPill(els.cameraStatus, 'reCamera Pro · Wi‑Fi · WebRTC', 'ok');
      setPill(els.micStatus, audioTracks.length ? `Mic · ${audioTracks[0].label || '本机麦克风'}` : 'Mic · 未连接', audioTracks.length?'ok':'warn');
      els.viewerEmpty.classList.add('hidden'); els.viewerBadge.style.display='block'; els.viewerBadge.textContent='reCamera WebRTC'; els.startCamera.textContent='重新连接';
      setConnectedUi(true);
      window.LabSightAutoScene?.detectNow?.();
      if (els.wakeToggle.checked && audioTracks.length) startWakeListening();
    } catch (e) {
      disconnectCamera();
      setPill(els.cameraStatus, 'reCamera Pro 连接失败', 'warn');
      alert(`reCamera Pro 连接失败：${e.message}`);
    }
  }

  sourceSelect.addEventListener('change', () => {
    disconnectCamera();
    const remote = sourceSelect.value === 'recamera';
    panel.classList.toggle('show', remote);
    els.cameraSelect.disabled = remote;
    els.refreshDevices.disabled = remote;
    els.startCamera.textContent = remote ? '连接 reCamera Pro' : '连接摄像头';
    if (remote) checkBridge(); else setFocusPill('自动对焦 · 待检测', 'neutral');
  });

  els.startCamera.addEventListener('click', async e => {
    e.preventDefault(); e.stopImmediatePropagation();
    if (sourceSelect.value === 'recamera') await startReCamera(); else await startUvc();
  }, true);

  disconnectBtn.addEventListener('click', e => {
    e.preventDefault(); e.stopImmediatePropagation();
    disconnectCamera();
  }, true);

  window.LabSightCameraAdapters = {
    enableAutofocus, stopRemote, disconnectCamera, checkBridge,
    get source(){ return sourceSelect.value; },
    get peerConnection(){ return remotePc; }
  };
})();
