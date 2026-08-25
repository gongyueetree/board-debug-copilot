const $ = (id) => document.getElementById(id);

const state = {
  stream: null,
  scene: 'pcb',
  provider: localStorage.getItem('labsight-provider') || 'openai',
  projectContext: null,
  lastCapture: null,
  mediaRecorder: null,
  audioChunks: [],
  conversation: [],
  speakingAudio: null,
  recordingTimer: null,
  health: null,
  wakeEnabled: false,
  wakeRecorder: null,
  wakeChunks: [],
  wakeTimer: null,
  sessionUntil: 0,
  sessionTicker: null,
  listeningSuspended: false,
};

const els = {
  apiStatus: $('apiStatus'), cameraStatus: $('cameraStatus'), micStatus: $('micStatus'), projectStatus: $('projectStatus'),
  providerSelect: $('providerSelect'), providerMeta: $('providerMeta'),
  cameraSelect: $('cameraSelect'), micSelect: $('micSelect'), refreshDevices: $('refreshDevices'), startCamera: $('startCamera'),
  video: $('video'), canvas: $('captureCanvas'), viewerEmpty: $('viewerEmpty'), viewerBadge: $('viewerBadge'),
  captureBtn: $('captureBtn'), analyzeBtn: $('analyzeBtn'), capturePreview: $('capturePreview'), captureMeta: $('captureMeta'),
  projectFile: $('projectFile'), dropzone: $('dropzone'), projectSummary: $('projectSummary'),
  chat: $('chat'), question: $('question'), sendBtn: $('sendBtn'), voiceBtn: $('voiceBtn'), recordingState: $('recordingState'),
  autoSpeak: $('autoSpeak'), cloudTts: $('cloudTts'), clearChat: $('clearChat'),
  wakeToggle: $('wakeToggle'), wakeState: $('wakeState'), sessionState: $('sessionState')
};

function setPill(el, text, kind='neutral') { if(!el) return; el.textContent=text; el.className=`pill ${kind}`; }
function providerConfig() { return state.health?.providers?.[state.provider] || {}; }
function updateProviderUI() {
  els.providerSelect.value = state.provider;
  localStorage.setItem('labsight-provider', state.provider);
  const p = providerConfig();
  const label = state.provider === 'gemini' ? 'Gemini' : 'OpenAI';
  const model = p.vision_model || '—';
  els.providerMeta.textContent = `${label} · ${model}${p.configured ? '' : ' · 未配置 Key'}`;
  setPill(els.apiStatus, `${label} · ${p.configured ? model : 'Demo'}`, p.configured ? 'ok' : 'warn');
}

async function checkHealth() {
  try {
    const r=await fetch('/api/health'); state.health=await r.json(); updateProviderUI();
  } catch { setPill(els.apiStatus,'后端离线','warn'); }
}

async function enumerateDevices(requestPermission=false) {
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持 MediaDevices；请使用 HTTPS 下的 Chrome/Edge/Safari。');
    if (requestPermission && !state.stream) {
      const temp=await navigator.mediaDevices.getUserMedia({video:true,audio:true});
      temp.getTracks().forEach(t=>t.stop());
    }
    const devices=await navigator.mediaDevices.enumerateDevices();
    const cams=devices.filter(d=>d.kind==='videoinput');
    const mics=devices.filter(d=>d.kind==='audioinput');
    fillSelect(els.cameraSelect,cams,'摄像头'); fillSelect(els.micSelect,mics,'麦克风');
    const instaCam=[...els.cameraSelect.options].find(o=>/insta|link 2|link 2c/i.test(o.textContent));
    const instaMic=[...els.micSelect.options].find(o=>/insta|link 2|link 2c/i.test(o.textContent));
    if(instaCam) els.cameraSelect.value=instaCam.value;
    if(instaMic) els.micSelect.value=instaMic.value;
  } catch(e) { console.warn(e); setPill(els.cameraStatus,'需要 Camera/Mic 权限','warn'); }
}
function fillSelect(select,items,prefix){
  const old=select.value; select.innerHTML='';
  if(!items.length){select.add(new Option(`未发现${prefix}`,''));return;}
  items.forEach((d,i)=>select.add(new Option(d.label||`${prefix} ${i+1}`,d.deviceId)));
  if([...select.options].some(o=>o.value===old)) select.value=old;
}

async function startCamera() {
  try {
    stopWakeListening();
    if(state.stream) state.stream.getTracks().forEach(t=>t.stop());
    const videoId=els.cameraSelect.value,audioId=els.micSelect.value;
    state.stream=await navigator.mediaDevices.getUserMedia({
      video: videoId?{deviceId:{exact:videoId},width:{ideal:3840},height:{ideal:2160},frameRate:{ideal:30,max:30}}:{width:{ideal:3840},height:{ideal:2160}},
      audio: audioId?{deviceId:{exact:audioId},echoCancellation:true,noiseSuppression:true,autoGainControl:true}:true
    });
    els.video.srcObject=state.stream; await els.video.play();
    const vt=state.stream.getVideoTracks()[0], at=state.stream.getAudioTracks()[0];
    const s=vt.getSettings?.()||{};
    setPill(els.cameraStatus,`Camera · ${vt.label||'已连接'} · ${s.width||'?'}×${s.height||'?'}`,'ok');
    setPill(els.micStatus,`Mic · ${at?.label||'已连接'}`,'ok');
    els.viewerEmpty.classList.add('hidden'); els.viewerBadge.style.display='block'; els.startCamera.textContent='重新连接';
    await enumerateDevices(false);
    if(els.wakeToggle.checked) startWakeListening();
  } catch(e) {
    setPill(els.cameraStatus,'Camera/Mic 连接失败','warn');
    alert(`连接失败：${e.message}\n\n请允许摄像头和麦克风权限。`);
  }
}

function captureFrame() {
  if(!state.stream||!els.video.videoWidth){alert('请先连接摄像头。');return null;}
  const srcW=els.video.videoWidth,srcH=els.video.videoHeight,maxEdge=2048;
  const scale=Math.min(1,maxEdge/Math.max(srcW,srcH)),w=Math.round(srcW*scale),h=Math.round(srcH*scale);
  els.canvas.width=w;els.canvas.height=h;els.canvas.getContext('2d',{alpha:false}).drawImage(els.video,0,0,w,h);
  const data=els.canvas.toDataURL('image/jpeg',0.86); state.lastCapture=data;
  els.capturePreview.src=data;els.capturePreview.style.display='block';
  els.captureMeta.textContent=`AI 帧 ${w}×${h} · 原视频 ${srcW}×${srcH} · ≈${Math.round(data.length*.75/1024)} KB · ${new Date().toLocaleTimeString()}`;
  return data;
}
function addMessage(role,text,klass=''){
  const wrap=document.createElement('div');wrap.className=`message ${role} ${klass}`;
  const bubble=document.createElement('div');bubble.className='bubble';bubble.textContent=text;wrap.appendChild(bubble);
  els.chat.appendChild(wrap);els.chat.scrollTop=els.chat.scrollHeight;return wrap;
}

async function askAI(questionOverride=null) {
  const q=(questionOverride??els.question.value).trim()||'请分析当前画面并告诉我下一步应该做什么。';
  const image=captureFrame(); if(!image)return;
  addMessage('user',q);els.question.value='';
  const thinking=addMessage('assistant',`正在用 ${state.provider==='gemini'?'Gemini':'OpenAI'} 读取当前画面…`,'thinking');
  els.sendBtn.disabled=els.analyzeBtn.disabled=true;
  try{
    const payload={question:q,scene:state.scene,provider:state.provider,image_data_url:image,project_context:state.projectContext,conversation:state.conversation.slice(-8)};
    const r=await fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const d=await r.json();if(!r.ok)throw new Error(d.detail||'分析失败');
    thinking.remove();addMessage('assistant',`[${d.provider.toUpperCase()} · ${d.model}]\n${d.answer}`);
    state.conversation.push({role:'user',content:q},{role:'assistant',content:d.answer});
    if(state.conversation.length>20)state.conversation=state.conversation.slice(-20);
    extendSession();
    if(els.autoSpeak.checked)await speakAnswer(d.answer);
  }catch(e){thinking.remove();addMessage('assistant',`分析失败：${e.message}`);}
  finally{els.sendBtn.disabled=els.analyzeBtn.disabled=false;}
}

function plainForSpeech(text){return text.replace(/[*#>`_\-]/g,' ').replace(/\s+/g,' ').trim().slice(0,2600);}
async function speakAnswer(text){
  const clean=plainForSpeech(text);if(!clean)return;
  state.listeningSuspended=true; stopWakeListening();
  try{
    if(els.cloudTts.checked && state.health?.providers?.openai?.configured){
      const r=await fetch('/api/speech',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:clean})});
      if(!r.ok)throw new Error((await r.json()).detail||'TTS 失败');
      const blob=await r.blob(),url=URL.createObjectURL(blob);
      if(state.speakingAudio)state.speakingAudio.pause();
      const audio=new Audio(url);state.speakingAudio=audio;
      await new Promise((resolve,reject)=>{audio.onended=resolve;audio.onerror=reject;audio.play().catch(reject);});
      URL.revokeObjectURL(url);
    }else if('speechSynthesis'in window){
      await new Promise(resolve=>{speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(clean);u.lang='zh-CN';u.rate=1.02;u.onend=resolve;u.onerror=resolve;speechSynthesis.speak(u);});
    }
  }catch(e){console.warn(e);}
  finally{
    setTimeout(()=>{state.listeningSuspended=false;if(els.wakeToggle.checked)startWakeListening();},650);
  }
}

function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function takeMatches(regex,text,set){let m;regex.lastIndex=0;while((m=regex.exec(text))!==null){if(m[1])set.add(m[1]);if(set.size>1200)break;}}
async function parseKiCadZip(file){
  if(!window.JSZip)throw new Error('JSZip 加载失败');
  const zip=await JSZip.loadAsync(file),result={filename:file.name,files:[],schematics:[],pcbs:[],project_files:[],references:[],values:[],nets:[],raw_context:''};
  const refs=new Set(),vals=new Set(),nets=new Set();let raw='';
  for(const entry of Object.values(zip.files).filter(e=>!e.dir)){
    const name=entry.name.replace(/\\/g,'/');result.files.push(name);const lower=name.toLowerCase();
    if(lower.endsWith('.kicad_sch'))result.schematics.push(name);else if(lower.endsWith('.kicad_pcb'))result.pcbs.push(name);else if(lower.endsWith('.kicad_pro')||lower.endsWith('.pro'))result.project_files.push(name);
    if(!/\.(kicad_sch|kicad_pcb|kicad_pro|net|csv|bom)$/i.test(lower))continue;
    const text=await entry.async('string');
    takeMatches(/\(property\s+"Reference"\s+"([^"\n]+)"/g,text,refs);takeMatches(/\(property\s+"Value"\s+"([^"\n]+)"/g,text,vals);
    takeMatches(/\(fp_text\s+reference\s+"?([^"\s\)]+)/g,text,refs);takeMatches(/\(net\s+\d+\s+"([^"\n]+)"\)/g,text,nets);
    if(raw.length<45000)raw+=`\n--- ${name} ---\n${text.slice(0,12000)}`;
  }
  result.references=[...refs].sort().slice(0,800);result.values=[...vals].sort().slice(0,800);result.nets=[...nets].sort().slice(0,800);result.raw_context=raw.slice(0,45000);return result;
}
async function uploadProject(file){
  if(!file)return;if(!file.name.toLowerCase().endsWith('.zip')){alert('请上传 KiCad 工程 ZIP。');return;}
  setPill(els.projectStatus,'KiCad 本地解析中…','neutral');
  try{
    const s=await parseKiCadZip(file);state.projectContext=s;setPill(els.projectStatus,`KiCad · ${s.filename}`,'ok');els.projectSummary.classList.remove('hidden');
    els.projectSummary.innerHTML=`<strong>${escapeHtml(s.filename)}</strong><div>原理图：${escapeHtml(s.schematics.join(', ')||'未发现')}</div><div>PCB：${escapeHtml(s.pcbs.join(', ')||'未发现')}</div><div class="stats"><span>${s.references.length} 位号</span><span>${s.values.length} 型号/值</span><span>${s.nets.length} 网络</span><span>${s.files.length} 文件</span></div>`;
  }catch(e){state.projectContext=null;setPill(els.projectStatus,'KiCad 解析失败','warn');alert(e.message);}
}

async function recordOnce(seconds=30, fromWake=false){
  if(state.mediaRecorder?.state==='recording'){state.mediaRecorder.stop();return;}
  const audioTracks=state.stream?.getAudioTracks()||[];if(!audioTracks.length){alert('请先连接麦克风。');return;}
  const audioStream=new MediaStream(audioTracks),types=['audio/webm;codecs=opus','audio/webm','audio/mp4'];
  const mime=types.find(t=>MediaRecorder.isTypeSupported(t))||'';
  state.audioChunks=[];state.mediaRecorder=new MediaRecorder(audioStream,mime?{mimeType:mime}:undefined);
  state.mediaRecorder.ondataavailable=e=>{if(e.data.size)state.audioChunks.push(e.data);};
  state.mediaRecorder.onstop=()=>transcribeBlob(new Blob(state.audioChunks,{type:mime||'audio/webm'}),mime||'audio/webm',fromWake);
  state.mediaRecorder.start(400);els.voiceBtn.classList.add('recording');els.voiceBtn.querySelector('span').textContent='停止并提问';els.recordingState.textContent='● 正在录音…';
  clearTimeout(state.recordingTimer);state.recordingTimer=setTimeout(()=>{if(state.mediaRecorder?.state==='recording')state.mediaRecorder.stop();},seconds*1000);
}
async function transcribeBlob(blob,mime,fromWake=false){
  clearTimeout(state.recordingTimer);els.voiceBtn.classList.remove('recording');els.voiceBtn.querySelector('span').textContent='语音提问';els.recordingState.textContent='正在转写语音…';
  const ext=mime.includes('mp4')?'m4a':'webm',fd=new FormData();fd.append('file',blob,`question.${ext}`);
  try{
    const r=await fetch(`/api/transcribe?provider=${encodeURIComponent(state.provider)}`,{method:'POST',body:fd});const d=await r.json();if(!r.ok)throw new Error(d.detail||'转写失败');
    const text=(d.text||'').trim();els.recordingState.textContent=`${d.provider.toUpperCase()}：${text||'未识别到语音'}`;
    if(text){els.question.value=text;if(fromWake||sessionActive())await askAI(text);}
  }catch(e){els.recordingState.textContent=`转写失败：${e.message}`;}
}
function toggleVoice(){recordOnce(30,false);}

function sessionActive(){return Date.now()<state.sessionUntil;}
function extendSession(ms=60000){
  state.sessionUntil=Date.now()+ms;
  clearInterval(state.sessionTicker);state.sessionTicker=setInterval(()=>{
    const left=Math.max(0,Math.ceil((state.sessionUntil-Date.now())/1000));
    els.sessionState.textContent=left?`连续对话 ${left}s`:'待唤醒';
    if(!left){clearInterval(state.sessionTicker);els.sessionState.className='pill neutral';}
    else els.sessionState.className='pill ok';
  },500);
}
function wakePhrase(text){return /(lab\s*sight|labsight|莱布赛特|拉布赛特|小\s*lab)/i.test(text);}
function stopWakeListening(){
  clearTimeout(state.wakeTimer);
  if(state.wakeRecorder?.state==='recording'){try{state.wakeRecorder.onstop=null;state.wakeRecorder.stop();}catch{}}
  state.wakeRecorder=null;
}
async function startWakeListening(){
  if(!els.wakeToggle.checked||state.listeningSuspended||state.wakeRecorder?.state==='recording')return;
  const audioTracks=state.stream?.getAudioTracks()||[];if(!audioTracks.length)return;
  state.wakeEnabled=true;setPill(els.wakeState,'自动唤醒 ON','ok');
  const mime=['audio/webm;codecs=opus','audio/webm'].find(t=>MediaRecorder.isTypeSupported(t))||'';
  state.wakeChunks=[];const rec=new MediaRecorder(new MediaStream(audioTracks),mime?{mimeType:mime}:undefined);state.wakeRecorder=rec;
  rec.ondataavailable=e=>{if(e.data.size)state.wakeChunks.push(e.data);};
  rec.onstop=async()=>{
    if(!els.wakeToggle.checked||state.listeningSuspended)return;
    const blob=new Blob(state.wakeChunks,{type:mime||'audio/webm'});
    try{
      const fd=new FormData();fd.append('file',blob,'wake.webm');
      const r=await fetch(`/api/transcribe?provider=${encodeURIComponent(state.provider)}`,{method:'POST',body:fd});const d=await r.json();
      if(r.ok){
        const text=(d.text||'').trim();
        if(sessionActive() && text && !wakePhrase(text)){extendSession();await askAI(text);return;}
        if(wakePhrase(text)){extendSession();addMessage('assistant','我在。');await speakAnswer('我在');setTimeout(()=>recordOnce(12,true),900);return;}
      }
    }catch(e){console.warn('wake:',e);}
    setTimeout(startWakeListening,300);
  };
  rec.start(400);state.wakeTimer=setTimeout(()=>{if(rec.state==='recording')rec.stop();},4200);
}

els.providerSelect.addEventListener('change',()=>{state.provider=els.providerSelect.value;updateProviderUI();stopWakeListening();if(els.wakeToggle.checked)setTimeout(startWakeListening,250);});
[...document.querySelectorAll('.scene')].forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('.scene').forEach(x=>x.classList.remove('active'));btn.classList.add('active');state.scene=btn.dataset.scene;}));
els.refreshDevices.addEventListener('click',()=>enumerateDevices(true));
els.startCamera.addEventListener('click',startCamera);els.captureBtn.addEventListener('click',captureFrame);els.analyzeBtn.addEventListener('click',()=>askAI());els.sendBtn.addEventListener('click',()=>askAI());
els.voiceBtn.addEventListener('click',toggleVoice);els.projectFile.addEventListener('change',e=>uploadProject(e.target.files[0]));
els.clearChat.addEventListener('click',()=>{state.conversation=[];els.chat.innerHTML='';addMessage('assistant','对话已清空。');});
els.question.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();askAI();}});
document.querySelectorAll('.quickprompts button').forEach(b=>b.addEventListener('click',()=>askAI(b.dataset.prompt)));
els.wakeToggle.addEventListener('change',()=>{if(els.wakeToggle.checked)startWakeListening();else{stopWakeListening();setPill(els.wakeState,'自动唤醒 OFF','neutral');}});
['dragenter','dragover'].forEach(n=>els.dropzone.addEventListener(n,e=>{e.preventDefault();els.dropzone.classList.add('drag');}));
['dragleave','drop'].forEach(n=>els.dropzone.addEventListener(n,e=>{e.preventDefault();els.dropzone.classList.remove('drag');}));
els.dropzone.addEventListener('drop',e=>{const f=e.dataTransfer.files[0];if(f)uploadProject(f);});
navigator.mediaDevices?.addEventListener?.('devicechange',()=>enumerateDevices(false));
checkHealth();enumerateDevices(false);
