(() => {
  const primaryEls = els, primaryState = state;
  function createCameraAdapter(options = {}) {
  const els = options.elements || primaryEls, state = options.cameraState || primaryState;
  const secondary = !!options.secondary;
  const id = name => secondary ? `instrument-${name}` : name;
  const storage = name => secondary ? `labsight-instrument-${name}` : `labsight-${name}`;
  const enumerate = options.enumerate || enumerateDevices;
  // LabSight Camera Adapters EVT0.13

  const DEFAULT_BRIDGE_PORT = 18765;
  const profiles = {
    recamera: { name: 'reCamera Pro', ip: '192.168.42.1', user: 'admin', path: '/main', focus: 'M12 镜头手动对焦' },
    tapo: { name: 'Tapo C113', ip: '', user: '', path: '/stream1', focus: '对焦不可由浏览器控制' }
  };
  const profile = () => profiles[sourceSelect.value];
  let connectionId = 0;
  let pendingRequest = null;
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

  const toolbar = options.toolbar || document.querySelector('.camera-toolbar');
  if (!toolbar || !window.navigator?.mediaDevices) return;

  const sourceSelect = document.createElement('select');
  sourceSelect.id = id('cameraSourceSelect');
  sourceSelect.className = 'camera-source-select';
  sourceSelect.setAttribute('aria-label', secondary ? '仪器摄像头类型' : 'PCB 摄像头类型');
  sourceSelect.add(new Option('USB / UVC 摄像头', 'uvc'));
  sourceSelect.add(new Option('IMX415 8MP UVC（变焦/自动对焦）', 'imx415'));
  sourceSelect.add(new Option('Seeed reCamera Pro（Wi‑Fi）', 'recamera'));
  sourceSelect.add(new Option('Tapo C113（Wi‑Fi / RTSP）', 'tapo'));
  toolbar.insertBefore(sourceSelect, els.cameraSelect);

  const disconnectBtn = document.createElement('button');
  disconnectBtn.id = id('disconnectCamera');
  disconnectBtn.className = 'secondary camera-disconnect';
  disconnectBtn.type = 'button';
  disconnectBtn.textContent = '断开连接';
  toolbar.appendChild(disconnectBtn);

  const panel = document.createElement('div');
  panel.className = 'camera-adapter-panel';
  panel.innerHTML = `
    <label><span id="networkCameraLabel">摄像头 IP</span><input id="recameraIp" placeholder="192.168.1.100"></label>
    <label><span id="networkUserLabel">用户名</span><input id="recameraUser" autocomplete="username"></label>
    <label>密码<input id="recameraPassword" type="password" autocomplete="off" placeholder="摄像机账户密码（不保存）"></label>
    <label>RTSP 路径<input id="recameraRtspPath" list="networkStreamPaths" placeholder="/main"><datalist id="networkStreamPaths"></datalist></label>
    <label>Bridge 端口<input id="recameraBridgePort" type="number" min="1" max="65535" placeholder="18765"></label>
    <div class="camera-adapter-help"><span id="recameraBridgeState" class="bridge-state">请先启动本机 WebRTC 服务</span><span id="networkCameraHelp"></span>
    <a href="https://github.com/gongyueetree/board-debug-copilot/blob/main/labsight-vercel/TAPO_C113.md" target="_blank" rel="noopener noreferrer">安装与连接说明</a></div>`;
  if (secondary) panel.innerHTML = panel.innerHTML.replace(/(id|list)="([^"]+)"/g, (_, attr, name) => `${attr}="${id(name)}"`);
  const field = name => panel.querySelector(`#${id(name)}`);
  toolbar.insertAdjacentElement('afterend', panel);

  const focusPill = document.createElement('span');
  focusPill.className = 'pill neutral camera-focus-pill';
  focusPill.textContent = '自动对焦 · 待检测';
  (options.statusRow || document.querySelector('.statusrow'))?.appendChild(focusPill);

  const ipEl = field('recameraIp');
  const userEl = field('recameraUser');
  const passEl = field('recameraPassword');
  const rtspPathEl = field('recameraRtspPath');
  const bridgePortEl = field('recameraBridgePort');
  const bridgeStateEl = field('recameraBridgeState');

  bridgePortEl.value = localStorage.getItem(storage('recamera-bridge-port')) || DEFAULT_BRIDGE_PORT;
  function loadProfile() {
    const p = profile();
    passEl.value = '';
    if (!p) return;
    const prefix = storage(sourceSelect.value);
    ipEl.value = localStorage.getItem(`${prefix}-ip`) || p.ip;
    userEl.value = localStorage.getItem(`${prefix}-user`) || p.user;
    rtspPathEl.value = localStorage.getItem(`${prefix}-rtsp-path`) || p.path;
    field('networkCameraLabel').textContent = `${p.name} 局域网 IP`;
    field('networkUserLabel').textContent = sourceSelect.value === 'tapo' ? '摄像机账户（不是 TP-Link 登录账号）' : '用户名';
    field('networkStreamPaths').replaceChildren(...(sourceSelect.value === 'tapo' ? ['/stream1', '/stream2'] : ['/main']).map(v => new Option(v, v)));
    field('networkCameraHelp').textContent = sourceSelect.value === 'tapo'
      ? 'Tapo App → 设备设置 → 高级设置 → 摄像机账户。/stream1 高清，/stream2 标清。电脑和摄像头须在同一局域网；语音使用本机麦克风。'
      : 'RTSP → 本机 WebRTC → LabSight。先启动本地桥接；只有安装自启动服务后才会随系统登录启动。';
  }

  const setFocusPill = (text, kind='neutral') => {
    focusPill.textContent = text;
    focusPill.className = `pill ${kind} camera-focus-pill`;
  };

  function stopRemote() {
    connectionId++;
    pendingRequest?.abort();
    pendingRequest = null;
    try { remotePc?.close(); } catch {}
    remotePc = null;
    try { remoteMicStream?.getTracks().forEach(t => t.stop()); } catch {}
    remoteMicStream = null;
  }

  function setConnectedUi(connected) {
    disconnectBtn.classList.toggle('show', connected);
    window.dispatchEvent(new CustomEvent('labsight:camera-state', {detail:{role:secondary ? 'instrument' : 'pcb', connected}}));
    if (!connected) {
      els.viewerBadge.style.display = 'none';
      els.viewerEmpty.classList.remove('hidden');
      els.startCamera.textContent = profile() ? `连接 ${profile().name}` : '连接摄像头';
    }
  }

  function disconnectCamera() {
    if (!secondary) stopWakeListening();
    if (!secondary) { try { window.cancelLabSightSpeech?.(false); } catch {} }
    stopRemote();
    try { state.stream?.getTracks().forEach(t => t.stop()); } catch {}
    state.stream = null;
    try { els.video.pause(); } catch {}
    els.video.srcObject = null;
    setPill(els.cameraStatus, 'Camera 未连接', 'neutral');
    if (!secondary) setPill(els.micStatus, 'Mic 未连接', 'neutral');
    setFocusPill('自动对焦 · 待检测', 'neutral');
    setConnectedUi(false);
    if (!secondary) window.LabSightAutoScene?.reset?.();
  }

  function bridgeOrigin() {
    const rawPort = bridgePortEl.value.trim() || String(DEFAULT_BRIDGE_PORT);
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Bridge 端口必须是 1–65535 的整数');
    bridgePortEl.value = String(port);
    localStorage.setItem(storage('recamera-bridge-port'), String(port));
    return `http://127.0.0.1:${port}`;
  }

  async function checkBridge(origin) {
    try {
      const bridge = origin || bridgeOrigin();
      const r = await fetch(`${bridge}/health?t=${Date.now()}`, {cache:'no-store', signal:AbortSignal.timeout(4000)});
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
    const attempt = connectionId;
    const videoId = els.cameraSelect.value;
    try {
      if (window.LabSightDualCamera?.isDeviceInUse(videoId, secondary ? 'instrument' : 'pcb')) throw new Error('这台 USB 摄像头已被另一路使用，请选择另一台设备。');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {...(videoId ? {deviceId:{exact:videoId}} : {}),width:{ideal:3840},height:{ideal:2160},frameRate:{ideal:30,max:30}}, audio:false
      });
      if (attempt !== connectionId) { stream.getTracks().forEach(t => t.stop()); return; }
      state.stream = stream;
      if (!secondary) {
        try {
          const audioId = els.micSelect.value;
          const mic = await navigator.mediaDevices.getUserMedia({video:false,audio:audioId?{deviceId:{exact:audioId},echoCancellation:true,noiseSuppression:true}:true});
          if (attempt !== connectionId) { mic.getTracks().forEach(t=>t.stop()); return; }
          mic.getAudioTracks().forEach(t => stream.addTrack(t));
        } catch { /* Video remains usable without a microphone. */ }
      }
      if (attempt !== connectionId) return;
      els.video.srcObject = stream;
      await els.video.play();
      if (attempt !== connectionId) return;
      const vt=stream.getVideoTracks()[0], at=stream.getAudioTracks()[0], settings=vt.getSettings?.()||{};
      vt.addEventListener('ended', () => { if (attempt === connectionId) disconnectCamera(); });
      await enableAutofocus(vt);
      if (attempt !== connectionId) return;
      setPill(els.cameraStatus, `Camera · ${vt.label || '已连接'} · ${settings.width || '?'}×${settings.height || '?'}`, 'ok');
      if (!secondary) setPill(els.micStatus, at ? `Mic · ${at.label || '已连接'}` : 'Mic · 未连接（可文字提问）', at ? 'ok' : 'warn');
      els.viewerEmpty.classList.add('hidden'); els.viewerBadge.style.display='block'; els.viewerBadge.textContent='LIVE'; els.startCamera.textContent='重新连接';
      setConnectedUi(true);
      await enumerate(false);
      if (!secondary) window.LabSightAutoScene?.detectNow?.();
      if (!secondary && els.wakeToggle.checked && at) startWakeListening();
    } catch (e) {
      if (attempt !== connectionId) return;
      disconnectCamera();
      setPill(els.cameraStatus, 'Camera 连接失败', 'warn');
      alert(`连接失败：${e.message}`);
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

  async function startNetworkCamera() {
    disconnectCamera();
    const attempt = connectionId;
    const current = () => attempt === connectionId;
    const p = profile();
    const source = sourceSelect.value;
    const ip = ipEl.value.trim();
    const username = userEl.value.trim() || p.user;
    const password = passEl.value;
    const rawPath = rtspPathEl.value.trim() || p.path;
    const rtspPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    if (!ip) { alert(`请输入 ${p.name} 的局域网 IP 地址`); return; }
    if (source === 'tapo' && (!username || !password)) {
      alert('请先在 Tapo App → 设备设置 → 高级设置 → 摄像机账户中创建用户名和密码，然后填写到这里。不是 TP-Link 登录账号。');
      return;
    }
    let bridge;
    try { bridge = bridgeOrigin(); } catch (error) { alert(error.message); return; }
    rtspPathEl.value = rtspPath;
    localStorage.setItem(`${storage(source)}-ip`, ip);
    localStorage.setItem(`${storage(source)}-user`, username);
    localStorage.setItem(`${storage(source)}-rtsp-path`, rtspPath);
    setPill(els.cameraStatus, `${p.name} · 正在连接…`, 'neutral');
    setFocusPill(`${p.name} · ${p.focus}`, 'neutral');
    // Allow cancellation even while waiting for the first frame.
    disconnectBtn.classList.add('show');
    try {
      if (!(await checkBridge(bridge))) throw new Error('本机 WebRTC 服务未运行或被浏览器阻止。请启动 Bridge，并允许此网站访问本地网络。');
      if (!current()) return;
      let audioTracks = [];
      try {
        if (secondary) throw new Error("shared microphone");
        const audioId = els.micSelect.value;
        const mic = await navigator.mediaDevices.getUserMedia({video:false,audio:audioId?{deviceId:{exact:audioId},echoCancellation:true,noiseSuppression:true,autoGainControl:true}:true});
        if (!current()) { mic.getTracks().forEach(t => t.stop()); return; }
        remoteMicStream = mic;
        audioTracks = mic.getAudioTracks();
      } catch { /* Video remains available without microphone permission. */ }
      if (!current()) return;
      const pc = new RTCPeerConnection({iceServers:[]});
      remotePc = pc;
      pc.addTransceiver('video', {direction:'recvonly'});
      pc.ontrack = ev => {
        if (!current() || ev.track.kind !== 'video') return;
        state.stream = new MediaStream([ev.track, ...audioTracks]);
        els.video.srcObject = new MediaStream([ev.track]);
        els.video.play().catch(() => {});
      };
      pc.onconnectionstatechange = () => {
        if (!current()) return;
        if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
          disconnectCamera();
          setPill(els.cameraStatus, `${p.name} · 连接中断，请重新连接`, 'warn');
        }
      };
      await pc.setLocalDescription(await pc.createOffer());
      await waitIceGatheringComplete(pc);
      if (!current()) return;
      const controller = new AbortController();
      pendingRequest = controller;
      const timer = setTimeout(() => controller.abort(), 20000);
      let answer;
      try {
        const r = await fetch(`${bridge}/offer`, {
          method:'POST', cache:'no-store', headers:{'Content-Type':'application/json'}, signal:controller.signal,
          body:JSON.stringify({sdp:pc.localDescription.sdp,type:pc.localDescription.type,camera_ip:ip,username,password,rtsp_path:rtspPath})
        });
        answer = await r.json();
        // Never display raw decoder errors: old bridges may include credentials in them.
        if (!r.ok) throw new Error(`摄像头连接失败（HTTP ${r.status}）。检查 IP、摄像机账户、隐私模式和 RTSP 路径。`);
      } finally { clearTimeout(timer); if (pendingRequest === controller) pendingRequest = null; }
      if (!current()) return;
      await pc.setRemoteDescription(answer);
      const deadline = Date.now()+12000;
      // An SDP track event alone does not prove that frames are arriving.
      while (current() && Date.now()<deadline && (pc.connectionState !== 'connected' || els.video.readyState < 2 || !els.video.videoWidth)) {
        await new Promise(resolve => setTimeout(resolve,100));
      }
      if (!current()) return;
      if (pc.connectionState !== 'connected' || els.video.readyState < 2 || !els.video.videoWidth) {
        throw new Error(`没有收到可显示的视频。检查局域网、防火墙和隐私模式；Tapo 可尝试 /stream2，并关闭其它正在播放摄像头的应用。`);
      }
      setPill(els.cameraStatus, `${p.name} · ${els.video.videoWidth}×${els.video.videoHeight} · WebRTC`, 'ok');
      if (!secondary) setPill(els.micStatus, audioTracks.length ? `Mic · ${audioTracks[0].label || '本机麦克风'}` : 'Mic · 未连接（可文字提问）', audioTracks.length?'ok':'warn');
      els.viewerEmpty.classList.add('hidden');
      els.viewerBadge.style.display='block';
      els.viewerBadge.textContent=`${p.name} LIVE`;
      els.startCamera.textContent='重新连接';
      setConnectedUi(true);
      if (!secondary) window.LabSightAutoScene?.detectNow?.();
      if (!secondary && els.wakeToggle.checked && audioTracks.length) startWakeListening();
    } catch (e) {
      if (!current()) return;
      disconnectCamera();
      setPill(els.cameraStatus, `${p.name} 连接失败`, 'warn');
      alert(`${p.name} 连接失败：${e.name === 'AbortError' ? '连接超时，请检查摄像头网络和本地 Bridge。' : e.message}`);
    }
  }

  const connectionDialog = window.LabSightCameraDialog({panel,id,button:els.startCamera,profile,
    connect:startNetworkCamera,disconnect:disconnectCamera,checkBridge,
    connected:()=>!!state.stream?.getVideoTracks().some(t=>t.readyState==='live')&&els.video.readyState>=2});
  sourceSelect.addEventListener('change', () => {
    disconnectCamera();
    const remote = !!profile();
    localStorage.setItem(storage('camera-source'), sourceSelect.value);
    loadProfile();
    els.cameraSelect.disabled = remote;
    els.cameraSelect.hidden = remote;
    els.refreshDevices.hidden = remote;
    els.refreshDevices.disabled = false;
    els.startCamera.textContent = remote ? `连接 ${profile().name}` : '连接摄像头';
    setFocusPill(remote ? `${profile().name} · 待连接` : '自动对焦 · 待检测', 'neutral');
  });

  els.startCamera.addEventListener('click', async e => {
    e.preventDefault(); e.stopImmediatePropagation();
    if (profile()) connectionDialog.open(); else await startUvc();
  }, true);

  disconnectBtn.addEventListener('click', e => {
    e.preventDefault(); e.stopImmediatePropagation();
    disconnectCamera();
  }, true);

  window.addEventListener('pagehide', stopRemote);

  sourceSelect.value = localStorage.getItem(storage('camera-source')) || 'uvc';
  if (!sourceSelect.value) sourceSelect.value = 'uvc';
  sourceSelect.dispatchEvent(new Event('change'));
  return {
    enableAutofocus, stopRemote, disconnectCamera, checkBridge, sourceSelect,
    get source(){ return sourceSelect.value; },
    get peerConnection(){ return remotePc; }
  };
  }
  window.LabSightCreateCameraAdapter = createCameraAdapter;
  window.LabSightCameraAdapters = createCameraAdapter();
})();
