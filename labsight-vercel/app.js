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
  captureBtn: $('captureBtn'), analyzeBtn: $('analyzeBtn'), deepVisionBtn: $('deepVisionBtn'), deepVisionState: $('deepVisionState'),
  capturePreview: $('capturePreview'), captureMeta: $('captureMeta'),
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

function updateSceneUI() {
  const isPcb = state.scene === 'pcb';
  const isScope = state.scene === 'scope';
  if (els.deepVisionBtn) els.deepVisionBtn.style.display = isPcb ? '' : 'none';
  if (els.deepVisionState && !isPcb) els.deepVisionState.classList.add('hidden');
  if (els.analyzeBtn) {
    els.analyzeBtn.textContent = isScope ? '✦ 分析当前信号' : state.scene === 'instrument' ? '✦ 分析当前仪器' : '✦ 分析当前画面';
  }
  const guide = document.querySelector('.focus-guide span');
  if (guide) {
    guide.textContent = isScope
      ? 'Signal ROI · 把示波器波形与刻度完整放在框内'
      : state.scene === 'instrument'
        ? 'Instrument ROI · 把仪器屏幕与关键读数放在框内'
        : 'Deep Vision ROI · 把整块 PCB 放在框内';
  }
}

async function readJsonResponse(r) {
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`API 返回非 JSON (${r.status})：${text.slice(0,220)}`); }
  if(!r.ok) throw new Error(data.detail || data.error || `HTTP ${r.status}`);
  return data;
}

async function checkHealth() {
  try {
    const r=await fetch('/api/health'); state.health=await readJsonResponse(r); updateProviderUI();
  } catch { setPill(els.apiStatus,'后端离线','warn'); }
}

async function enumerateDevices(requestPermission=false) {
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持 MediaDevices；请使用 HTTPS 下的 Chrome/Edge/Safari。');
    if (requestPermission && !state.stream) {
      const temp=await navigator.mediaDevices.getUserMedia({video:true,audio:true}); temp.getTracks().forEach(t=>t.stop());
    }
    const devices=await navigator.mediaDevices.enumerateDevices();
    const cams=devices.filter(d=>d.kind==='videoinput'),mics=devices.filter(d=>d.kind==='audioinput');
    fillSelect(els.cameraSelect,cams,'摄像头'); fillSelect(els.micSelect,mics,'麦克风');
    const instaCam=[...els.cameraSelect.options].find(o=>/insta|link 2|link 2c/i.test(o.textContent));
    const instaMic=[...els.micSelect.options].find(o=>/insta|link 2|link 2c/i.test(o.textContent));
    if(instaCam) els.cameraSelect.value=instaCam.value; if(instaMic) els.micSelect.value=instaMic.value;
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
    stopWakeListening(); if(state.stream) state.stream.getTracks().forEach(t=>t.stop());
    const videoId=els.cameraSelect.value,audioId=els.micSelect.value;
    state.stream=await navigator.mediaDevices.getUserMedia({
      video:videoId?{deviceId:{exact:videoId},width:{ideal:3840},height:{ideal:2160},frameRate:{ideal:30,max:30}}:{width:{ideal:3840},height:{ideal:2160}},
      audio:audioId?{deviceId:{exact:audioId},echoCancellation:true,noiseSuppression:true,autoGainControl:true}:true
    });
    els.video.srcObject=state.stream; await els.video.play();
    const vt=state.stream.getVideoTracks()[0],at=state.stream.getAudioTracks()[0],s=vt.getSettings?.()||{};
    setPill(els.cameraStatus,`Camera · ${vt.label||'已连接'} · ${s.width||'?'}×${s.height||'?'}`,'ok');
    setPill(els.micStatus,`Mic · ${at?.label||'已连接'}`,'ok');
    els.viewerEmpty.classList.add('hidden'); els.viewerBadge.style.display='block'; els.startCamera.textContent='重新连接';
    await enumerateDevices(false); if(els.wakeToggle.checked) startWakeListening();
  } catch(e) {
    setPill(els.cameraStatus,'Camera/Mic 连接失败','warn'); alert(`连接失败：${e.message}\n\n请允许摄像头和麦克风权限。`);
  }
}

function getNativeFrameCanvas() {
  if(!state.stream||!els.video.videoWidth) return null;
  const c=document.createElement('canvas'); c.width=els.video.videoWidth; c.height=els.video.videoHeight;
  c.getContext('2d',{alpha:false}).drawImage(els.video,0,0,c.width,c.height); return c;
}
function canvasScaledDataURL(source,maxEdge=2048,quality=.86){
  const scale=Math.min(1,maxEdge/Math.max(source.width,source.height));
  const c=document.createElement('canvas'); c.width=Math.max(1,Math.round(source.width*scale));c.height=Math.max(1,Math.round(source.height*scale));
  c.getContext('2d',{alpha:false}).drawImage(source,0,0,c.width,c.height); return {data:c.toDataURL('image/jpeg',quality),width:c.width,height:c.height};
}
function cropCanvas(source,x,y,w,h){
  const c=document.createElement('canvas');c.width=Math.max(1,Math.round(w));c.height=Math.max(1,Math.round(h));
  c.getContext('2d',{alpha:false}).drawImage(source,Math.round(x),Math.round(y),Math.round(w),Math.round(h),0,0,c.width,c.height);return c;
}
function captureFrame() {
  const native=getNativeFrameCanvas(); if(!native){alert('请先连接摄像头。');return null;}
  const out=canvasScaledDataURL(native,2048,.86); state.lastCapture=out.data;
  els.capturePreview.src=out.data;els.capturePreview.style.display='block';
  els.captureMeta.textContent=`AI 帧 ${out.width}×${out.height} · 原视频 ${native.width}×${native.height} · ≈${Math.round(out.data.length*.75/1024)} KB · ${new Date().toLocaleTimeString()}`;
  return out.data;
}

function buildDeepVisionPack(){
  const native=getNativeFrameCanvas(); if(!native){alert('请先连接摄像头。');return null;}
  const rx=.13*native.width, ry=.14*native.height, rw=.74*native.width, rh=.72*native.height;
  const board=cropCanvas(native,rx,ry,rw,rh);
  const overview=canvasScaledDataURL(board,1800,.84);
  const tiles=[]; const cols=3,rows=2,overlap=.12;
  const baseW=board.width/cols,baseH=board.height/rows;
  for(let row=0;row<rows;row++) for(let col=0;col<cols;col++){
    const padX=baseW*overlap,padY=baseH*overlap;
    const x=Math.max(0,col*baseW-padX),y=Math.max(0,row*baseH-padY);
    const right=Math.min(board.width,(col+1)*baseW+padX),bottom=Math.min(board.height,(row+1)*baseH+padY);
    const tile=cropCanvas(board,x,y,right-x,bottom-y);tiles.push(canvasScaledDataURL(tile,1100,.80).data);
  }
  const totalChars=overview.data.length+tiles.reduce((a,b)=>a+b.length,0);
  els.capturePreview.src=overview.data;els.capturePreview.style.display='block';
  els.captureMeta.textContent=`Deep Vision · 原始 ${native.width}×${native.height} · ROI ${Math.round(rw)}×${Math.round(rh)} · 1 Overview + ${tiles.length} Tiles · ≈${Math.round(totalChars*.75/1024)} KB`;
  return {overview_image:overview.data,tile_images:tiles,source_width:native.width,source_height:native.height,totalChars};
}

function addMessage(role,text,klass=''){
  const wrap=document.createElement('div');wrap.className=`message ${role} ${klass}`;
  const bubble=document.createElement('div');bubble.className='bubble';bubble.textContent=text;wrap.appendChild(bubble);
  els.chat.appendChild(wrap);els.chat.scrollTop=els.chat.scrollHeight;return wrap;
}
function deepResultText(d){
  const r=d.result||{},b=r.board_identity||{}; const lines=[];
  lines.push(`[${String(d.provider||'AI').toUpperCase()} · ${d.model}] · PCB DEEP VISION`);
  if(b.name||b.type) lines.push(`\n板卡识别\n- ${b.name||'未确认'}${b.type?` · ${b.type}`:''}${Number.isFinite(b.confidence)?` · 置信度 ${Math.round(b.confidence*100)}%`:''}`);
  if(r.visible_texts?.length){lines.push('\n可见丝印 / 标记');r.visible_texts.slice(0,30).forEach(x=>lines.push(`- ${x.text}${x.kind?` [${x.kind}]`:''}${Number.isFinite(x.confidence)?` · ${Math.round(x.confidence*100)}%`:''}`));}
  if(r.components?.length){lines.push('\n关键器件');r.components.slice(0,20).forEach(x=>{const cand=x.marking||x.likely_part||(x.candidates||[]).join('/');lines.push(`- ${x.reference||x.region||'器件'}：${cand||x.category||'未确认'}${x.role?` · ${x.role}`:''}${Number.isFinite(x.confidence)?` · ${Math.round(x.confidence*100)}%`:''}`);});}
  if(r.connectors?.length){lines.push('\n接口');r.connectors.slice(0,12).forEach(x=>lines.push(`- ${(x.labels||[]).join(' / ')||x.region||'接口'}${x.function?` → ${x.function}`:''}`));}
  if(r.signal_chain?.length) lines.push(`\n信号链\n- ${r.signal_chain.join('\n- ')}`);
  if(r.board_function) lines.push(`\n功能判断\n${r.board_function}`);
  if(r.uncertain_items?.length) lines.push(`\n待确认\n- ${r.uncertain_items.slice(0,10).join('\n- ')}`);
  if(r.next_actions?.length) lines.push(`\n下一步\n- ${r.next_actions.slice(0,8).join('\n- ')}`);
  if(r.summary) lines.push(`\n结论\n${r.summary}`);
  return lines.join('\n');
}

async function deepVisionAnalyze(){
  if(state.scene!=='pcb'){
    document.querySelectorAll('.scene').forEach(x=>x.classList.toggle('active',x.dataset.scene==='pcb'));state.scene='pcb';updateSceneUI();
  }
  const pack=buildDeepVisionPack();if(!pack)return;
  const q=(els.question.value||'').trim()||'深度识别这块 PCB：优先读取板名、所有可见丝印、主要 IC 顶标/型号候选、接口引脚、时钟/频率标记，并分析核心器件和整板功能。';
  addMessage('user',`【PCB Deep Vision】${q}`);els.question.value='';
  const thinking=addMessage('assistant',`正在做 PCB Deep Vision：整板 Overview + 6 个高清局部 Tile，优先读取丝印和芯片顶标…`,'thinking');
  els.deepVisionBtn.disabled=els.analyzeBtn.disabled=els.sendBtn.disabled=true;
  els.deepVisionState.classList.remove('hidden');els.deepVisionState.textContent=`正在上传 1+6 张局部图像（约 ${Math.round(pack.totalChars*.75/1024)} KB），使用 ${state.provider==='gemini'?'Gemini':'OpenAI'} 深度识别…`;
  try{
    const payload={provider:state.provider,overview_image:pack.overview_image,tile_images:pack.tile_images,question:q,project_context:state.projectContext,source_width:pack.source_width,source_height:pack.source_height};
    const r=await fetch('/api/pcb_deep_analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const d=await readJsonResponse(r); const text=deepResultText(d); thinking.remove();addMessage('assistant',text,'deepvision-result');
    state.conversation.push({role:'user',content:`PCB Deep Vision: ${q}`},{role:'assistant',content:d.result?.summary||text.slice(0,2500)});if(state.conversation.length>20)state.conversation=state.conversation.slice(-20);
    els.deepVisionState.textContent=`完成 · ${d.model} · ${d.source?.images||7} 张图 · 原始 ${d.source?.width||'?'}×${d.source?.height||'?'}`;
    extendSession(); if(els.autoSpeak.checked&&d.result?.summary) await speakAnswer(d.result.summary);
  }catch(e){thinking.remove();addMessage('assistant',`PCB Deep Vision 失败：${e.message}`);els.deepVisionState.textContent=`失败：${e.message}`;}
  finally{els.deepVisionBtn.disabled=els.analyzeBtn.disabled=els.sendBtn.disabled=false;}
}

async function askAI(questionOverride=null) {
  const defaults = {
    pcb: '请分析当前画面并告诉我下一步应该做什么。',
    scope: '请分析当前示波器信号，直接读取并判断波形的频率、周期、Vpp、偏置、占空比、时基、垂直档位以及明显异常。',
    instrument: '请分析当前仪器画面，直接读取关键参数、状态和异常。'
  };
  const q=(questionOverride??els.question.value).trim()||defaults[state.scene]||defaults.pcb;
  const image=captureFrame(); if(!image)return; addMessage('user',q);els.question.value='';
  const thinkingText = state.scene==='scope' ? '正在读取当前示波器信号…' : state.scene==='instrument' ? '正在读取当前仪器画面…' : '正在读取当前画面…';
  const thinking=addMessage('assistant',`正在用 ${state.provider==='gemini'?'Gemini':'OpenAI'} ${thinkingText.replace('正在','')}`,'thinking');els.sendBtn.disabled=els.analyzeBtn.disabled=true;
  try{
    const payload={question:q,scene:state.scene,provider:state.provider,image_data_url:image,project_context:state.projectContext,conversation:state.conversation.slice(-8)};
    const r=await fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const d=await readJsonResponse(r);
    thinking.remove();addMessage('assistant',`[${d.provider.toUpperCase()} · ${d.model}]\n${d.answer}`);state.conversation.push({role:'user',content:q},{role:'assistant',content:d.answer});
    if(state.conversation.length>20)state.conversation=state.conversation.slice(-20);extendSession();if(els.autoSpeak.checked)await speakAnswer(d.answer);
  }catch(e){thinking.remove();addMessage('assistant',`分析失败：${e.message}`);}
  finally{els.sendBtn.disabled=els.analyzeBtn.disabled=false;}
}

async function speakAnswer(text){
  if(!text)return;try{if(state.speakingAudio){state.speakingAudio.pause();state.speakingAudio=null;}const r=await fetch('/api/speech',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:state.provider,text})});if(!r.ok)throw new Error(`HTTP ${r.status}`);const blob=await r.blob(),url=URL.createObjectURL(blob),a=new Audio(url);state.speakingAudio=a;await a.play();a.onended=()=>{URL.revokeObjectURL(url);state.speakingAudio=null;};}catch(e){console.warn('tts:',e);}
}

function escapeHtml(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function takeMatches(re,text,set){let m;while((m=re.exec(text)))if(m[1])set.add(m[1]);}
async function parseKiCadZip(file){
  if(!window.JSZip)throw new Error('JSZip 未加载');const zip=await JSZip.loadAsync(file),names=Object.keys(zip.files).filter(n=>!zip.files[n].dir),refs=new Set(),vals=new Set(),nets=new Set();let raw='';const result={filename:file.name,files:names.slice(0,500),schematics:names.filter(n=>n.endsWith('.kicad_sch')),pcbs:names.filter(n=>n.endsWith('.kicad_pcb')),references:[],values:[],nets:[],raw_context:''};
  for(const name of names){const lower=name.toLowerCase();if(!/\.(kicad_sch|kicad_pcb|kicad_pro|net|csv|bom)$/i.test(lower))continue;
    const text=await zip.files[name].async('string');takeMatches(/\(property\s+"Reference"\s+"([^"\n]+)"/g,text,refs);takeMatches(/\(property\s+"Value"\s+"([^"\n]+)"/g,text,vals);takeMatches(/\(fp_text\s+reference\s+"?([^"\s\)]+)/g,text,refs);takeMatches(/\(net\s+\d+\s+"([^"\n]+)"\)/g,text,nets);
    if(raw.length<45000)raw+=`\n--- ${name} ---\n${text.slice(0,12000)}`;
  }
  result.references=[...refs].sort().slice(0,800);result.values=[...vals].sort().slice(0,800);result.nets=[...nets].sort().slice(0,800);result.raw_context=raw.slice(0,45000);return result;
}
async function uploadProject(file){
  if(!file)return;if(!file.name.toLowerCase().endsWith('.zip')){alert('请上传 KiCad 工程 ZIP。');return;}setPill(els.projectStatus,'KiCad 本地解析中…','neutral');
  try{const s=await parseKiCadZip(file);state.projectContext=s;setPill(els.projectStatus,`KiCad · ${s.filename}`,'ok');els.projectSummary.classList.remove('hidden');els.projectSummary.innerHTML=`<strong>${escapeHtml(s.filename)}</strong><div>原理图：${escapeHtml(s.schematics.join(', ')||'未发现')}</div><div>PCB：${escapeHtml(s.pcbs.join(', ')||'未发现')}</div><div class="stats"><span>${s.references.length} 位号</span><span>${s.values.length} 型号/值</span><span>${s.nets.length} 网络</span><span>${s.files.length} 文件</span></div>`;}catch(e){state.projectContext=null;setPill(els.projectStatus,'KiCad 解析失败','warn');alert(e.message);}
}

async function recordOnce(seconds=30, fromWake=false){
  if(state.mediaRecorder?.state==='recording'){state.mediaRecorder.stop();return;}const audioTracks=state.stream?.getAudioTracks()||[];if(!audioTracks.length){alert('请先连接麦克风。');return;}
  const audioStream=new MediaStream(audioTracks),types=['audio/webm;codecs=opus','audio/webm','audio/mp4'];const mime=types.find(t=>MediaRecorder.isTypeSupported(t))||'';
  state.audioChunks=[];state.mediaRecorder=new MediaRecorder(audioStream,mime?{mimeType:mime}:undefined);state.mediaRecorder.ondataavailable=e=>{if(e.data.size)state.audioChunks.push(e.data);};
  state.mediaRecorder.onstop=()=>transcribeBlob(new Blob(state.audioChunks,{type:mime||'audio/webm'}),mime||'audio/webm',fromWake);state.mediaRecorder.start(400);els.voiceBtn.classList.add('recording');els.voiceBtn.querySelector('span').textContent='停止并提问';els.recordingState.textContent='● 正在录音…';
  clearTimeout(state.recordingTimer);state.recordingTimer=setTimeout(()=>{if(state.mediaRecorder?.state==='recording')state.mediaRecorder.stop();},seconds*1000);
}
async function transcribeBlob(blob,mime,fromWake=false){
  clearTimeout(state.recordingTimer);els.voiceBtn.classList.remove('recording');els.voiceBtn.querySelector('span').textContent='语音提问';els.recordingState.textContent='正在转写语音…';
  const ext=mime.includes('mp4')?'m4a':'webm',fd=new FormData();fd.append('file',blob,`question.${ext}`);
  try{const r=await fetch(`/api/transcribe?provider=${encodeURIComponent(state.provider)}`,{method:'POST',body:fd});const d=await readJsonResponse(r);const text=(d.text||'').trim();els.recordingState.textContent=`${d.provider.toUpperCase()}：${text||'未识别到语音'}`;if(text){els.question.value=text;if(fromWake||sessionActive())await askAI(text);}}catch(e){els.recordingState.textContent=`转写失败：${e.message}`;}
}
function toggleVoice(){recordOnce(30,false);}
function sessionActive(){return Date.now()<state.sessionUntil;}
function extendSession(ms=60000){state.sessionUntil=Date.now()+ms;clearInterval(state.sessionTicker);state.sessionTicker=setInterval(()=>{const left=Math.max(0,Math.ceil((state.sessionUntil-Date.now())/1000));els.sessionState.textContent=left?`连续对话 ${left}s`:'待唤醒';if(!left){clearInterval(state.sessionTicker);els.sessionState.className='pill neutral';}else els.sessionState.className='pill ok';},500);}
function wakePhrase(text){return /(lab\s*sight|labsight|莱布赛特|拉布赛特|小\s*lab)/i.test(text);}
function stopWakeListening(){clearTimeout(state.wakeTimer);if(state.wakeRecorder?.state==='recording'){try{state.wakeRecorder.onstop=null;state.wakeRecorder.stop();}catch{}}state.wakeRecorder=null;}
async function startWakeListening(){
  if(!els.wakeToggle.checked||state.listeningSuspended||state.wakeRecorder?.state==='recording')return;const audioTracks=state.stream?.getAudioTracks()||[];if(!audioTracks.length)return;
  state.wakeEnabled=true;setPill(els.wakeState,'自动唤醒 ON','ok');const mime=['audio/webm;codecs=opus','audio/webm'].find(t=>MediaRecorder.isTypeSupported(t))||'';state.wakeChunks=[];
  const rec=new MediaRecorder(new MediaStream(audioTracks),mime?{mimeType:mime}:undefined);state.wakeRecorder=rec;rec.ondataavailable=e=>{if(e.data.size)state.wakeChunks.push(e.data);};
  rec.onstop=async()=>{if(!els.wakeToggle.checked||state.listeningSuspended)return;const blob=new Blob(state.wakeChunks,{type:mime||'audio/webm'});try{const fd=new FormData();fd.append('file',blob,'wake.webm');const r=await fetch(`/api/transcribe?provider=${encodeURIComponent(state.provider)}`,{method:'POST',body:fd});const d=await readJsonResponse(r);const text=(d.text||'').trim();if(sessionActive()&&text&&!wakePhrase(text)){extendSession();await askAI(text);return;}if(wakePhrase(text)){extendSession();addMessage('assistant','我在。');await speakAnswer('我在');setTimeout(()=>recordOnce(12,true),900);return;}}catch(e){console.warn('wake:',e);}setTimeout(startWakeListening,300);};
  rec.start(400);state.wakeTimer=setTimeout(()=>{if(rec.state==='recording')rec.stop();},4200);
}

els.providerSelect.addEventListener('change',()=>{state.provider=els.providerSelect.value;updateProviderUI();stopWakeListening();if(els.wakeToggle.checked)setTimeout(startWakeListening,250);});
[...document.querySelectorAll('.scene')].forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('.scene').forEach(x=>x.classList.remove('active'));btn.classList.add('active');state.scene=btn.dataset.scene;updateSceneUI();}));
els.refreshDevices.addEventListener('click',()=>enumerateDevices(true));els.startCamera.addEventListener('click',startCamera);els.captureBtn.addEventListener('click',captureFrame);els.analyzeBtn.addEventListener('click',()=>askAI());els.deepVisionBtn?.addEventListener('click',deepVisionAnalyze);els.sendBtn.addEventListener('click',()=>askAI());
els.voiceBtn.addEventListener('click',toggleVoice);els.projectFile.addEventListener('change',e=>uploadProject(e.target.files[0]));els.clearChat.addEventListener('click',()=>{state.conversation=[];els.chat.innerHTML='';addMessage('assistant','对话已清空。');});
els.question.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();askAI();}});document.querySelectorAll('.quickprompts button').forEach(b=>b.addEventListener('click',()=>askAI(b.dataset.prompt)));
els.wakeToggle.addEventListener('change',()=>{if(els.wakeToggle.checked)startWakeListening();else{stopWakeListening();setPill(els.wakeState,'自动唤醒 OFF','neutral');}});
['dragenter','dragover'].forEach(n=>els.dropzone.addEventListener(n,e=>{e.preventDefault();els.dropzone.classList.add('drag');}));['dragleave','drop'].forEach(n=>els.dropzone.addEventListener(n,e=>{e.preventDefault();els.dropzone.classList.remove('drag');}));els.dropzone.addEventListener('drop',e=>{const f=e.dataTransfer.files[0];if(f)uploadProject(f);});
navigator.mediaDevices?.addEventListener?.('devicechange',()=>enumerateDevices(false));updateSceneUI();checkHealth();enumerateDevices(false);