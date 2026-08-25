const $ = (id) => document.getElementById(id);

const AUTO_CHUNK_MS = 4200;
const SESSION_MS = 60_000;
const WAKE_PATTERNS = [
  /\blab\s*[- ]?\s*sight\b/i,
  /\blabsight\b/i,
  /莱布\s*赛特/i,
  /拉布\s*赛特/i,
  /小\s*lab/i,
];

const state = {
  stream: null,
  scene: 'pcb',
  projectContext: null,
  lastCapture: null,
  mediaRecorder: null,
  audioChunks: [],
  conversation: [],
  speakingAudio: null,
  recordingTimer: null,
  autoWakeEnabled: false,
  autoWakeRecorder: null,
  autoWakeTimer: null,
  autoWakeRestartTimer: null,
  autoWakeBusy: false,
  sessionUntil: 0,
  sessionTicker: null,
  isSpeaking: false,
  manualRecording: false,
};

const els = {
  apiStatus: $('apiStatus'), cameraStatus: $('cameraStatus'), projectStatus: $('projectStatus'), micStatus: $('micStatus'),
  cameraSelect: $('cameraSelect'), micSelect: $('micSelect'), refreshDevices: $('refreshDevices'), startCamera: $('startCamera'),
  video: $('video'), canvas: $('captureCanvas'), viewerEmpty: $('viewerEmpty'), viewerBadge: $('viewerBadge'),
  captureBtn: $('captureBtn'), analyzeBtn: $('analyzeBtn'), capturePreview: $('capturePreview'), captureMeta: $('captureMeta'),
  projectFile: $('projectFile'), dropzone: $('dropzone'), projectSummary: $('projectSummary'),
  chat: $('chat'), question: $('question'), sendBtn: $('sendBtn'), voiceBtn: $('voiceBtn'), recordingState: $('recordingState'),
  autoSpeak: $('autoSpeak'), cloudTts: $('cloudTts'), clearChat: $('clearChat'),
  wakeToggle: $('wakeToggle'), wakeStatus: $('wakeStatus'), wakeSession: $('wakeSession'),
};

function setPill(el, text, kind='neutral') { if (!el) return; el.textContent = text; el.className = `pill ${kind}`; }
function preferredMime() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return types.find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

async function checkHealth() {
  try {
    const r = await fetch('/api/health');
    const d = await r.json();
    setPill(els.apiStatus, d.ai ? `AI 在线 · ${d.vision_model}` : 'AI Demo · 未配置 Key', d.ai ? 'ok' : 'warn');
  } catch { setPill(els.apiStatus, '后端离线', 'warn'); }
}

async function enumerateDevices(requestPermission=false) {
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持 MediaDevices；请使用 Chrome/Edge/Safari 并通过 HTTPS 访问。');
    if (requestPermission && !state.stream) {
      const temp = await navigator.mediaDevices.getUserMedia({video:true,audio:true});
      temp.getTracks().forEach(t=>t.stop());
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d=>d.kind==='videoinput');
    const mics = devices.filter(d=>d.kind==='audioinput');
    fillSelect(els.cameraSelect, cams, '摄像头');
    fillSelect(els.micSelect, mics, '麦克风');
    const instaCam = [...els.cameraSelect.options].find(o => /insta|link 2|link 2c/i.test(o.textContent));
    const instaMic = [...els.micSelect.options].find(o => /insta|link 2|link 2c/i.test(o.textContent));
    if (instaCam) els.cameraSelect.value = instaCam.value;
    if (instaMic) els.micSelect.value = instaMic.value;
  } catch (e) { console.warn(e); setPill(els.cameraStatus, '需要 Camera 权限', 'warn'); }
}

function fillSelect(select, items, prefix) {
  const old = select.value; select.innerHTML='';
  if (!items.length) { select.add(new Option(`未发现${prefix}`, '')); return; }
  items.forEach((d,i)=>select.add(new Option(d.label || `${prefix} ${i+1}`, d.deviceId)));
  if ([...select.options].some(o=>o.value===old)) select.value=old;
}

function stopTracks() {
  stopAutoWake(false);
  if (state.stream) state.stream.getTracks().forEach(t=>t.stop());
  state.stream = null;
}

async function startCamera() {
  try {
    stopTracks();
    const videoId = els.cameraSelect.value;
    const audioId = els.micSelect.value;
    const constraints = {
      video: videoId ? {deviceId:{exact:videoId}, width:{ideal:3840}, height:{ideal:2160}, frameRate:{ideal:30,max:30}} : {width:{ideal:3840},height:{ideal:2160}},
      audio: audioId ? {deviceId:{exact:audioId}, echoCancellation:true, noiseSuppression:true, autoGainControl:true} : true
    };
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    els.video.srcObject = state.stream;
    await els.video.play();
    const vtrack = state.stream.getVideoTracks()[0];
    const atrack = state.stream.getAudioTracks()[0];
    const settings = vtrack.getSettings?.() || {};
    setPill(els.cameraStatus, `Camera · ${vtrack.label || '已连接'} · ${settings.width || '?'}×${settings.height || '?'}`, 'ok');
    setPill(els.micStatus, atrack ? `Mic · ${atrack.label || '已连接'}` : 'Mic 未连接', atrack ? 'ok' : 'warn');
    els.viewerEmpty.classList.add('hidden'); els.viewerBadge.style.display='block';
    els.startCamera.textContent='重新连接';
    await enumerateDevices(false);
    if (els.wakeToggle?.checked && atrack) await startAutoWake();
  } catch (e) {
    setPill(els.cameraStatus, 'Camera 权限/连接失败', 'warn');
    setPill(els.micStatus, 'Mic 未连接', 'warn');
    alert(`摄像头连接失败：${e.message}\n\n请在浏览器的网站权限中允许摄像头和麦克风。`);
  }
}

function captureFrame() {
  if (!state.stream || !els.video.videoWidth) { alert('请先连接摄像头。'); return null; }
  const srcW = els.video.videoWidth, srcH = els.video.videoHeight;
  const maxEdge = 2048;
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const w = Math.round(srcW * scale), h = Math.round(srcH * scale);
  els.canvas.width=w; els.canvas.height=h;
  const ctx = els.canvas.getContext('2d', {alpha:false});
  ctx.drawImage(els.video, 0,0,w,h);
  const data = els.canvas.toDataURL('image/jpeg', 0.86);
  state.lastCapture=data;
  els.capturePreview.src=data; els.capturePreview.style.display='block';
  const approxKB = Math.round(data.length * 0.75 / 1024);
  els.captureMeta.textContent=`AI 帧 ${w}×${h} · 原视频 ${srcW}×${srcH} · ≈${approxKB} KB · ${new Date().toLocaleTimeString()}`;
  return data;
}

function addMessage(role, text, klass='') {
  const wrap=document.createElement('div'); wrap.className=`message ${role} ${klass}`;
  const bubble=document.createElement('div'); bubble.className='bubble'; bubble.textContent=text;
  wrap.appendChild(bubble); els.chat.appendChild(wrap); els.chat.scrollTop=els.chat.scrollHeight;
  return wrap;
}

async function askAI(questionOverride=null) {
  const q=(questionOverride ?? els.question.value).trim() || '请分析当前画面并告诉我下一步应该做什么。';
  const image=captureFrame(); if(!image) return;
  addMessage('user', q); els.question.value='';
  const thinking=addMessage('assistant','正在读取当前画面，并结合 KiCad 工程判断…','thinking');
  els.sendBtn.disabled=true; els.analyzeBtn.disabled=true;
  try {
    const payload={question:q,scene:state.scene,image_data_url:image,project_context:state.projectContext,conversation:state.conversation.slice(-8)};
    const r=await fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const d=await r.json(); if(!r.ok) throw new Error(d.detail || '分析失败');
    thinking.remove(); addMessage('assistant', d.answer);
    state.conversation.push({role:'user',content:q},{role:'assistant',content:d.answer});
    if (state.conversation.length>20) state.conversation=state.conversation.slice(-20);
    if (els.autoSpeak.checked) await speakAnswer(d.answer);
  } catch(e) { thinking.remove(); addMessage('assistant',`分析失败：${e.message}`); }
  finally { els.sendBtn.disabled=false; els.analyzeBtn.disabled=false; }
}

function plainForSpeech(text) { return text.replace(/[*#>`_\\-]/g,' ').replace(/\s+/g,' ').trim().slice(0,2600); }
function setSpeaking(on) {
  state.isSpeaking = on;
  if (on && state.autoWakeRecorder?.state === 'recording') {
    try { state.autoWakeRecorder.stop(); } catch {}
  }
  if (!on && state.autoWakeEnabled) scheduleAutoWake(650);
}

async function speakAnswer(text) {
  const clean=plainForSpeech(text); if(!clean) return;
  setSpeaking(true);
  if (els.cloudTts.checked) {
    try {
      const r=await fetch('/api/speech',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:clean})});
      if(!r.ok) throw new Error((await r.json()).detail || 'TTS 失败');
      const blob=await r.blob(); const url=URL.createObjectURL(blob);
      if(state.speakingAudio) state.speakingAudio.pause();
      const audio=new Audio(url); state.speakingAudio=audio;
      await new Promise((resolve,reject)=>{audio.onended=resolve; audio.onerror=reject; audio.play().catch(reject);});
      URL.revokeObjectURL(url); setSpeaking(false); return;
    } catch(e) { console.warn('Cloud TTS failed, fallback to browser:',e); }
  }
  if ('speechSynthesis' in window) {
    await new Promise(resolve=>{
      speechSynthesis.cancel(); const u=new SpeechSynthesisUtterance(clean); u.lang='zh-CN'; u.rate=1.02;
      u.onend=resolve; u.onerror=resolve; speechSynthesis.speak(u);
    });
  }
  setSpeaking(false);
}

function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function takeMatches(regex, text, set) { let m; regex.lastIndex = 0; while ((m = regex.exec(text)) !== null) { if (m[1]) set.add(m[1]); if (set.size > 1200) break; } }

async function parseKiCadZip(file) {
  if (!window.JSZip) throw new Error('JSZip 加载失败，请检查网络后刷新页面。');
  const zip = await JSZip.loadAsync(file);
  const result = {filename:file.name,files:[],schematics:[],pcbs:[],project_files:[],references:[],values:[],nets:[],raw_context:''};
  const refs=new Set(), vals=new Set(), nets=new Set(); let raw='';
  const entries = Object.values(zip.files).filter(e=>!e.dir);
  for (const entry of entries) {
    const name=entry.name.replace(/\\/g,'/'); result.files.push(name); const lower=name.toLowerCase();
    if(lower.endsWith('.kicad_sch')) result.schematics.push(name);
    else if(lower.endsWith('.kicad_pcb')) result.pcbs.push(name);
    else if(lower.endsWith('.kicad_pro') || lower.endsWith('.pro')) result.project_files.push(name);
    if(!/\.(kicad_sch|kicad_pcb|kicad_pro|net|csv|bom)$/i.test(lower)) continue;
    const text=await entry.async('string');
    takeMatches(/\(property\s+"Reference"\s+"([^"\n]+)"/g,text,refs);
    takeMatches(/\(property\s+"Value"\s+"([^"\n]+)"/g,text,vals);
    takeMatches(/\(fp_text\s+reference\s+"?([^"\s\)]+)/g,text,refs);
    takeMatches(/\(net\s+\d+\s+"([^"\n]+)"\)/g,text,nets);
    if(raw.length < 45000) raw += `\n--- ${name} ---\n${text.slice(0,12000)}`;
  }
  result.references=[...refs].sort().slice(0,800); result.values=[...vals].sort().slice(0,800); result.nets=[...nets].sort().slice(0,800); result.raw_context=raw.slice(0,45000);
  return result;
}

async function uploadProject(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.zip')) { alert('请上传 KiCad 工程 ZIP。'); return; }
  if (file.size > 150 * 1024 * 1024 && !confirm('工程 ZIP 超过 150MB，浏览器解析可能较慢。仍然继续吗？')) return;
  setPill(els.projectStatus,'KiCad 本地解析中…','neutral');
  try {
    const s=await parseKiCadZip(file); state.projectContext=s;
    setPill(els.projectStatus,`KiCad · ${s.filename}`,'ok'); els.projectSummary.classList.remove('hidden');
    els.projectSummary.innerHTML=`<strong>${escapeHtml(s.filename)}</strong><div>原理图：${escapeHtml((s.schematics||[]).join(', ')||'未发现')}</div><div>PCB：${escapeHtml((s.pcbs||[]).join(', ')||'未发现')}</div><div class="stats"><span>${(s.references||[]).length} 位号</span><span>${(s.values||[]).length} 型号/值</span><span>${(s.nets||[]).length} 网络</span><span>${(s.files||[]).length} 文件</span></div><div style="margin-top:7px;color:#7892a8">位号示例：${escapeHtml((s.references||[]).slice(0,24).join(', ')||'—')}</div><div style="margin-top:7px;color:#5f7d94">完整 ZIP 未上传到服务器；仅分析时发送约 ${Math.round((s.raw_context||'').length/1000)}K 字符工程上下文。</div>`;
    addMessage('assistant',`KiCad 工程已在浏览器中解析：${s.filename}\n提取到 ${(s.references||[]).length} 个位号、${(s.nets||[]).length} 个网络名。现在可以把摄像头对准实物板，然后问我具体问题。`);
  } catch(e) { state.projectContext=null; setPill(els.projectStatus,'KiCad 解析失败','warn'); alert(`KiCad 解析失败：${e.message}`); }
}

async function transcribeBlob(blob, mime='audio/webm', filename='question.webm') {
  if (!blob?.size) return '';
  const fd=new FormData(); fd.append('file',blob,filename);
  const r=await fetch('/api/transcribe',{method:'POST',body:fd});
  let d={}; try { d=await r.json(); } catch {}
  if(!r.ok) throw new Error(d.detail||`转写失败 (${r.status})`);
  return String(d.text||'').trim();
}

async function toggleVoice() {
  if (state.manualRecording && state.mediaRecorder?.state==='recording') { state.mediaRecorder.stop(); return; }
  try {
    stopAutoWake(false);
    let audioStream;
    if (state.stream?.getAudioTracks().length) audioStream=new MediaStream(state.stream.getAudioTracks());
    else audioStream=await navigator.mediaDevices.getUserMedia({audio:true});
    const mime=preferredMime(); state.audioChunks=[]; state.manualRecording=true;
    state.mediaRecorder=new MediaRecorder(audioStream,mime?{mimeType:mime}:undefined);
    state.mediaRecorder.ondataavailable=e=>{if(e.data.size)state.audioChunks.push(e.data)};
    state.mediaRecorder.onstop=()=>transcribeRecording(mime||state.mediaRecorder.mimeType);
    state.mediaRecorder.start(500);
    els.voiceBtn.classList.add('recording'); els.voiceBtn.querySelector('span').textContent='停止并提问'; els.recordingState.textContent='● 正在录音… 最长 30 秒';
    clearTimeout(state.recordingTimer); state.recordingTimer=setTimeout(()=>{ if(state.mediaRecorder?.state==='recording') state.mediaRecorder.stop(); },30000);
  } catch(e) { state.manualRecording=false; alert(`无法录音：${e.message}`); }
}

async function transcribeRecording(mime) {
  clearTimeout(state.recordingTimer); state.manualRecording=false;
  els.voiceBtn.classList.remove('recording'); els.voiceBtn.querySelector('span').textContent='语音提问'; els.recordingState.textContent='正在转写语音…';
  const blob=new Blob(state.audioChunks,{type:mime||'audio/webm'}); const ext=(mime||'').includes('mp4')?'m4a':'webm';
  try {
    const text=await transcribeBlob(blob,mime,`question.${ext}`); els.question.value=text; els.recordingState.textContent=`识别：${text}`;
    if(text) await askAI(text);
  } catch(e) { els.recordingState.textContent=`语音转写失败：${e.message}`; }
  finally { if (els.wakeToggle?.checked) await startAutoWake(); }
}

function normalizeWakeText(text) { return text.replace(/[，。！？,.!?]/g,' ').replace(/\s+/g,' ').trim(); }
function containsWakeWord(text) { const t=normalizeWakeText(text); return WAKE_PATTERNS.some(r=>r.test(t)); }
function stripWakeWord(text) {
  let t=normalizeWakeText(text);
  for (const r of WAKE_PATTERNS) t=t.replace(r,' ');
  return t.replace(/^\s*(你好|请问|帮我|你看|看一下)?\s*/,'').trim();
}
function sessionActive() { return Date.now() < state.sessionUntil; }
function updateSessionUi() {
  if (!els.wakeSession) return;
  const left=Math.max(0,Math.ceil((state.sessionUntil-Date.now())/1000));
  if (left>0) { els.wakeSession.textContent=`连续对话 ${left}s`; els.wakeSession.className='wake-session active'; }
  else { els.wakeSession.textContent='待唤醒'; els.wakeSession.className='wake-session'; }
}
function openVoiceSession() {
  state.sessionUntil=Date.now()+SESSION_MS; updateSessionUi();
  clearInterval(state.sessionTicker); state.sessionTicker=setInterval(()=>{ updateSessionUi(); if(!sessionActive()) clearInterval(state.sessionTicker); },1000);
  if (els.wakeStatus) els.wakeStatus.textContent='已唤醒 · 60 秒内可连续提问';
}
function extendVoiceSession() { if (sessionActive()) { state.sessionUntil=Date.now()+SESSION_MS; updateSessionUi(); } }

function stopAutoWake(updateToggle=true) {
  state.autoWakeEnabled=false;
  clearTimeout(state.autoWakeTimer); clearTimeout(state.autoWakeRestartTimer);
  if(state.autoWakeRecorder?.state==='recording') { try{state.autoWakeRecorder.onstop=null; state.autoWakeRecorder.stop();}catch{} }
  state.autoWakeRecorder=null;
  if(updateToggle && els.wakeToggle) els.wakeToggle.checked=false;
  if(els.wakeStatus) els.wakeStatus.textContent='自动唤醒已关闭';
}
function scheduleAutoWake(delay=120) {
  clearTimeout(state.autoWakeRestartTimer);
  if(!state.autoWakeEnabled || state.isSpeaking || state.manualRecording) return;
  state.autoWakeRestartTimer=setTimeout(()=>recordAutoChunk(),delay);
}

async function startAutoWake() {
  if (!els.wakeToggle?.checked) return;
  const track=state.stream?.getAudioTracks?.()[0];
  if(!track) { els.wakeToggle.checked=false; if(els.wakeStatus) els.wakeStatus.textContent='请先连接带麦克风的 Link 2C'; return; }
  state.autoWakeEnabled=true;
  if(els.wakeStatus) els.wakeStatus.textContent='待唤醒 · 说 “LabSight”';
  scheduleAutoWake(50);
}

function recordAutoChunk() {
  if(!state.autoWakeEnabled || state.isSpeaking || state.manualRecording || state.autoWakeRecorder?.state==='recording') return;
  const atrack=state.stream?.getAudioTracks?.()[0];
  if(!atrack || atrack.readyState!=='live') { stopAutoWake(false); if(els.wakeStatus) els.wakeStatus.textContent='麦克风断开，请重新连接'; return; }
  const mime=preferredMime(); const chunks=[];
  try {
    const recorder=new MediaRecorder(new MediaStream([atrack]),mime?{mimeType:mime}:undefined); state.autoWakeRecorder=recorder;
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
    recorder.onstop=async()=>{
      state.autoWakeRecorder=null;
      if(state.autoWakeEnabled && !state.isSpeaking && !state.manualRecording) scheduleAutoWake(80);
      const blob=new Blob(chunks,{type:mime||recorder.mimeType||'audio/webm'});
      if(blob.size<900) return;
      processAutoWakeBlob(blob,mime||recorder.mimeType).catch(e=>{ console.warn('auto wake transcription:',e); if(els.wakeStatus) els.wakeStatus.textContent=`监听中 · ${e.message}`; });
    };
    recorder.start();
    state.autoWakeTimer=setTimeout(()=>{if(recorder.state==='recording') recorder.stop();},AUTO_CHUNK_MS);
  } catch(e) { console.warn(e); scheduleAutoWake(1000); }
}

async function processAutoWakeBlob(blob,mime) {
  if(state.autoWakeBusy || state.isSpeaking) return;
  state.autoWakeBusy=true;
  try {
    const ext=(mime||'').includes('mp4')?'m4a':'webm';
    const text=await transcribeBlob(blob,mime,`wake.${ext}`);
    if(!text) return;
    if(els.wakeStatus) els.wakeStatus.textContent=`听到：${text}`;
    if(!sessionActive()) {
      if(!containsWakeWord(text)) { if(els.wakeStatus) els.wakeStatus.textContent='待唤醒 · 说 “LabSight”'; return; }
      openVoiceSession();
      const remainder=stripWakeWord(text);
      if(els.autoSpeak.checked) await speakAnswer('我在');
      if(remainder.length>=2) { extendVoiceSession(); await askAI(remainder); }
      return;
    }
    const q=stripWakeWord(text);
    if(q.length<2 || /^(嗯|啊|哦|好|好的|谢谢)$/.test(q)) return;
    extendVoiceSession();
    if(els.wakeStatus) els.wakeStatus.textContent=`连续对话 · ${q}`;
    await askAI(q);
  } finally { state.autoWakeBusy=false; }
}

[...document.querySelectorAll('.scene')].forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('.scene').forEach(x=>x.classList.remove('active'));btn.classList.add('active');state.scene=btn.dataset.scene;}));
els.refreshDevices.addEventListener('click',()=>enumerateDevices(true));
els.startCamera.addEventListener('click',startCamera);
els.captureBtn.addEventListener('click',captureFrame);
els.analyzeBtn.addEventListener('click',()=>askAI());
els.sendBtn.addEventListener('click',()=>askAI());
els.voiceBtn.addEventListener('click',toggleVoice);
els.wakeToggle?.addEventListener('change',async e=>{if(e.target.checked) await startAutoWake(); else stopAutoWake(false);});
els.projectFile.addEventListener('change',e=>uploadProject(e.target.files[0]));
els.clearChat.addEventListener('click',()=>{state.conversation=[];els.chat.innerHTML='';addMessage('assistant','对话已清空。摄像头和 KiCad 工程仍保持连接。');});
els.question.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();askAI();}});
document.querySelectorAll('.quickprompts button').forEach(b=>b.addEventListener('click',()=>{els.question.value=b.dataset.prompt; askAI(b.dataset.prompt);}));
['dragenter','dragover'].forEach(n=>els.dropzone.addEventListener(n,e=>{e.preventDefault();els.dropzone.classList.add('drag')}));
['dragleave','drop'].forEach(n=>els.dropzone.addEventListener(n,e=>{e.preventDefault();els.dropzone.classList.remove('drag')}));
els.dropzone.addEventListener('drop',e=>{const f=e.dataTransfer.files[0]; if(f) uploadProject(f);});
navigator.mediaDevices?.addEventListener?.('devicechange',()=>enumerateDevices(false));
window.addEventListener('beforeunload',()=>stopTracks());
checkHealth(); enumerateDevices(false); updateSessionUi();
