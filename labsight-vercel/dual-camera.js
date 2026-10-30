(() => {
  // Two independent camera sessions; all PCB geometry tools remain on #video.
  if (!window.LabSightCreateCameraAdapter || !els.video) return;
  const instrumentState = {stream:null};
  const toolbar = document.querySelector('.camera-toolbar');
  const viewer = els.video.closest('.viewer');
  const settingsNodes = [toolbar];
  let sibling = toolbar.nextElementSibling;
  while (sibling?.classList.contains('camera-adapter-panel')) { settingsNodes.push(sibling); sibling=sibling.nextElementSibling; }

  const controls = document.createElement('div');
  controls.className = 'dual-controls';
  controls.innerHTML = `<label>提问 / 抓图范围 <select id="cameraAnalysisTarget" aria-label="分析摄像头范围">
    <option value="auto">自动 · 使用已连接画面</option><option value="pcb">仅 PCB</option>
    <option value="instrument">仅仪器</option><option value="both">PCB + 仪器</option></select></label>
    <button id="connectSharedMic" class="secondary" type="button">连接麦克风</button>
    <span id="dualCameraHint">可连接一路或两路；两路画面分别标注来源。</span>`;
  const grid = document.createElement('div');
  grid.className = 'dual-camera-grid';
  grid.innerHTML = `<section class="camera-slot" id="pcbCameraSlot" aria-label="PCB 摄像头">
    <div class="camera-slot-head"><strong>① 用于 PCB</strong><span>选择拍摄 PCB 的设备</span></div>
    <div class="camera-slot-settings"></div><div class="instrument-status" id="pcbCameraStatusRow"></div>
    <div class="camera-slot-actions"><button id="capturePcbFrame" class="secondary" type="button">抓取 PCB</button><button id="fullscreenPcb" class="secondary" type="button">放大画面</button></div>
    </section>
    <section class="camera-slot" id="instrumentCameraSlot" aria-label="仪器摄像头">
    <div class="camera-slot-head"><strong>② 用于仪器</strong><span>选择拍摄仪器的设备</span></div>
    <div class="camera-slot-settings">
      <div class="camera-toolbar" id="instrumentToolbar"><select id="instrumentCameraSelect" aria-label="仪器 USB 摄像头"></select>
      <button id="instrumentRefreshDevices" class="secondary" type="button">刷新设备</button><button id="instrumentStartCamera" class="primary" type="button">连接摄像头</button></div>
    </div>
    <div class="instrument-status"><span id="instrumentCameraStatus" class="pill neutral">Camera 未连接</span></div>
    <div class="instrument-viewer"><video id="instrumentVideo" autoplay playsinline muted></video>
      <div class="viewer-badge" id="instrumentViewerBadge">LIVE</div><div class="viewer-empty" id="instrumentViewerEmpty"><strong>连接仪器摄像头</strong><span>对准示波器、电源或万用表屏幕</span></div></div>
    <div class="camera-slot-actions"><button id="captureInstrumentFrame" class="secondary" type="button">抓取仪器</button><button id="fullscreenInstrument" class="secondary" type="button">放大画面</button></div>
    </section>`;
  toolbar.before(controls, grid);
  const pcbSlot = grid.querySelector('#pcbCameraSlot');
  settingsNodes.forEach(node => pcbSlot.querySelector('.camera-slot-settings').appendChild(node));
  pcbSlot.insertBefore(viewer, pcbSlot.querySelector('.camera-slot-actions'));
  const pcbStatus=grid.querySelector('#pcbCameraStatusRow');
  pcbStatus.append(els.cameraStatus);
  const primaryFocus=document.querySelector('.statusrow .camera-focus-pill');
  if(primaryFocus)pcbStatus.append(primaryFocus);
  const audioSettings=document.createElement('details');audioSettings.className='dual-audio-settings';
  audioSettings.innerHTML='<summary>麦克风 / 扬声器</summary><div></div>';
  [els.micSelect,document.getElementById('audioOutputSelect')].filter(Boolean).forEach(node=>audioSettings.querySelector('div').appendChild(node));
  controls.appendChild(audioSettings);
  const secondaryVideo = grid.querySelector('#instrumentVideo');
  const cameraSelect = grid.querySelector('#instrumentCameraSelect');
  const analysisTarget = controls.querySelector('#cameraAnalysisTarget');
  analysisTarget.value = localStorage.getItem('labsight-analysis-target') || 'auto';
  if (!analysisTarget.value) analysisTarget.value='auto';
  // Copy only non-secret legacy Tapo settings to the new instrument slot once.
  for (const name of ['tapo-ip','tapo-user','tapo-rtsp-path','recamera-bridge-port']) {
    const key=`labsight-instrument-${name}`;
    if (localStorage.getItem(key) === null && localStorage.getItem(`labsight-${name}`) !== null) localStorage.setItem(key,localStorage.getItem(`labsight-${name}`));
  }
  async function enumerateInstrument() {
    try {
      const devices=await navigator.mediaDevices.enumerateDevices();
      fillSelect(cameraSelect, devices.filter(d=>d.kind==='videoinput'), 'USB 摄像头');
    } catch { setPill(document.getElementById('instrumentCameraStatus'),'USB 设备枚举失败；网络摄像头仍可连接','warn'); }
  }
  const instrument = window.LabSightCreateCameraAdapter({
    secondary:true, cameraState:instrumentState, toolbar:grid.querySelector('#instrumentToolbar'),
    statusRow:grid.querySelector('#instrumentCameraSlot .instrument-status'), enumerate:enumerateInstrument,
    elements:{...els,video:secondaryVideo,cameraSelect,micStatus:null,
      startCamera:grid.querySelector('#instrumentStartCamera'),refreshDevices:grid.querySelector('#instrumentRefreshDevices'),
      cameraStatus:grid.querySelector('#instrumentCameraStatus'),viewerEmpty:grid.querySelector('#instrumentViewerEmpty'),viewerBadge:grid.querySelector('#instrumentViewerBadge')}
  });
  window.LabSightCreateIMX415Profile?.({secondary:true,sourceSelect:instrument.sourceSelect,cameraSelect,
    toolbar:grid.querySelector('#instrumentToolbar'),cameraState:instrumentState,video:secondaryVideo,
    startButton:grid.querySelector('#instrumentStartCamera'),refreshButton:grid.querySelector('#instrumentRefreshDevices')});
  grid.querySelector('#instrumentRefreshDevices').addEventListener('click',enumerateInstrument);
  navigator.mediaDevices?.addEventListener('devicechange',enumerateInstrument);
  els.video.addEventListener('loadedmetadata',enumerateInstrument);
  void enumerateInstrument();

  function slots() { return [{role:'pcb',video:els.video,stream:state.stream}, {role:'instrument',video:secondaryVideo,stream:instrumentState.stream}]; }
  function ready(slot) { return slot.stream?.getVideoTracks().some(t=>t.readyState==='live') && slot.video.readyState>=2 && slot.video.videoWidth>0; }
  function selectedSlots(target=analysisTarget.value) {
    const all=slots(), live=all.filter(ready);
    if (target==='auto') { if (!live.length) throw new Error('请先连接 PCB 或仪器摄像头。'); return live; }
    const selected=all.filter(s=>target==='both'||s.role===target);
    if (selected.some(s=>!ready(s))) throw new Error('所选画面尚未连接。请连接对应摄像头，或将范围改为“自动”。');
    return selected;
  }
  function updateUI() {
    const roles=slots().filter(ready).map(s=>s.role==='pcb'?'PCB':'仪器');
    controls.querySelector('#dualCameraHint').textContent=roles.length ? `已连接：${roles.join(' + ')} · 两路为近同时截图，非硬件同步` : '可连接一路或两路；两路画面分别标注来源。';
    els.analyzeBtn.textContent='✦ 分析所选画面';
    els.deepVisionBtn.style.display='';
    els.deepVisionBtn.title='仅对第一路 PCB 画面执行 Deep Vision';
  }
  analysisTarget.addEventListener('change',()=>{localStorage.setItem('labsight-analysis-target',analysisTarget.value);updateUI();});
  window.addEventListener('labsight:camera-state',updateUI);
  [els.video,secondaryVideo].forEach(video=>video.addEventListener('loadeddata',updateUI));

  function capture(target=analysisTarget.value) {
    // Drop prior frames before every attempt: disconnected cameras never reuse old evidence.
    state.lastCameraFrames=[];
    try {
      const selected=selectedSlots(target);
      const canvases=selected.map(slot=>{
        const canvas=document.createElement('canvas'); canvas.width=slot.video.videoWidth; canvas.height=slot.video.videoHeight;
        canvas.getContext('2d',{alpha:false}).drawImage(slot.video,0,0);
        return {...slot,canvas,captured_at:new Date().toISOString()};
      });
      let frames;
      for (const [edge,quality] of [[2048,.86],[1600,.78],[1280,.7],[960,.6]]) {
        frames=canvases.map(s=>({role:s.role,captured_at:s.captured_at,image_data_url:canvasScaledDataURL(s.canvas,edge,quality).data}));
        // Legacy field duplicates the first image in the request; keep the total below the serverless request budget.
        if (frames.reduce((n,f)=>n+f.image_data_url.length,0)+frames[0].image_data_url.length < 3000000) break;
      }
      const preview=document.createElement('canvas');preview.width=960;preview.height=canvases.length*570;
      const ctx=preview.getContext('2d');ctx.fillStyle='#09131b';ctx.fillRect(0,0,preview.width,preview.height);
      canvases.forEach((s,i)=>{
        ctx.fillStyle='#ffffff';ctx.font='22px sans-serif';ctx.fillText(`${s.role==='pcb'?'PCB':'Instrument'} · ${s.captured_at}`,16,i*570+28);
        const scale=Math.min(960/s.canvas.width,530/s.canvas.height),w=s.canvas.width*scale,h=s.canvas.height*scale;
        ctx.drawImage(s.canvas,(960-w)/2,i*570+40,w,h);
      });
      state.lastCameraFrames=frames;
      state.lastCapture=preview.toDataURL('image/jpeg',.85);
      els.capturePreview.src=state.lastCapture;els.capturePreview.style.display='block';
      els.captureMeta.textContent=`${frames.map(f=>f.role==='pcb'?'PCB':'仪器').join(' + ')} · ${frames.length} 张独立分析帧 · ${new Date().toLocaleTimeString()}`;
      return frames[0].image_data_url;
    } catch (e) { alert(e.message); return null; }
  }
  function requestFields() {
    const frames=state.lastCameraFrames || [];
    const scene=frames.length===2?'dual':frames[0]?.role==='instrument'?'instrument':state.scene;
    return {camera_frames:frames,scene};
  }
  controls.querySelector('#connectSharedMic').addEventListener('click', async e=>{
    const button=e.currentTarget;button.disabled=true;
    try {
      const deviceId=els.micSelect.value;
      const mic=await navigator.mediaDevices.getUserMedia({video:false,audio:deviceId?{deviceId:{exact:deviceId},echoCancellation:true,noiseSuppression:true}:true});
      stopWakeListening();
      if (!state.stream) state.stream=new MediaStream();
      state.stream.getAudioTracks().forEach(t=>{state.stream.removeTrack(t);t.stop();});
      mic.getAudioTracks().forEach(t=>state.stream.addTrack(t));
      setPill(els.micStatus,`Mic · ${mic.getAudioTracks()[0]?.label||'已连接'}`,'ok');
      if(els.wakeToggle.checked)startWakeListening();
    } catch(e){setPill(els.micStatus,'麦克风连接失败','warn');alert(e.message);}
    finally {button.disabled=false;}
  });
  grid.querySelector('#capturePcbFrame').addEventListener('click',()=>capture('pcb'));
  grid.querySelector('#captureInstrumentFrame').addEventListener('click',()=>capture('instrument'));
  for (const [button,element] of [['fullscreenPcb',viewer],['fullscreenInstrument',secondaryVideo.parentElement]]) {
    grid.querySelector(`#${button}`).addEventListener('click',()=>element.requestFullscreen?.().catch(()=>{}));
  }
  window.LabSightDualCamera={instrument,slots,capture,requestFields,updateUI,
    get target(){return analysisTarget.value;},
    shouldUsePcbTools(){try {const selected=selectedSlots();return selected.length===1&&selected[0].role==='pcb';}catch{return false;}},
    isDeviceInUse(deviceId,role){return !!deviceId&&slots().some(s=>s.role!==role&&s.stream?.getVideoTracks().some(t=>t.readyState==='live'&&t.getSettings?.().deviceId===deviceId));}
  };
  updateUI();
})();
