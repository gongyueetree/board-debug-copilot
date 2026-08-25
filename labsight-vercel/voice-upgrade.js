(() => {
  let vadCtx = null;
  let vadTimer = null;
  let vadStartedAt = 0;
  let speechSeenAt = 0;
  let lastVoiceAt = 0;

  const stopVad = async () => {
    if (vadTimer) cancelAnimationFrame(vadTimer);
    vadTimer = null;
    try { if (vadCtx) await vadCtx.close(); } catch {}
    vadCtx = null;
  };

  const startVad = (audioStream, recorder, maxSeconds=20) => {
    stopVad();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    vadCtx = new AudioCtx();
    const source = vadCtx.createMediaStreamSource(audioStream);
    const analyser = vadCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = .18;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    vadStartedAt = performance.now(); speechSeenAt = 0; lastVoiceAt = 0;

    const loop = () => {
      if (recorder.state !== 'recording') { stopVad(); return; }
      analyser.getByteTimeDomainData(data);
      let sum=0;
      for (let i=0;i<data.length;i++) { const v=(data[i]-128)/128; sum += v*v; }
      const rms=Math.sqrt(sum/data.length);
      const now=performance.now();
      if (rms > .022) {
        if (!speechSeenAt) speechSeenAt=now;
        lastVoiceAt=now;
      }
      const spokeEnough = speechSeenAt && now-speechSeenAt > 260;
      const silenceLongEnough = lastVoiceAt && now-lastVoiceAt > 950;
      const minRecord = now-vadStartedAt > 900;
      const maxed = now-vadStartedAt > maxSeconds*1000;
      if ((spokeEnough && silenceLongEnough && minRecord) || maxed) {
        try { recorder.stop(); } catch {}
        return;
      }
      vadTimer=requestAnimationFrame(loop);
    };
    vadTimer=requestAnimationFrame(loop);
  };

  recordOnce = function(seconds=20, fromWake=false){
    if(state.mediaRecorder?.state==='recording'){state.mediaRecorder.stop();return;}
    const audioTracks=state.stream?.getAudioTracks()||[];
    if(!audioTracks.length){alert('请先连接麦克风。');return;}
    const audioStream=new MediaStream(audioTracks),types=['audio/webm;codecs=opus','audio/webm','audio/mp4'];
    const mime=types.find(t=>MediaRecorder.isTypeSupported(t))||'';
    state.audioChunks=[];
    state.mediaRecorder=new MediaRecorder(audioStream,mime?{mimeType:mime}:undefined);
    state.mediaRecorder.ondataavailable=e=>{if(e.data.size)state.audioChunks.push(e.data);};
    state.mediaRecorder.onstop=async()=>{
      await stopVad();
      transcribeBlob(new Blob(state.audioChunks,{type:mime||'audio/webm'}),mime||'audio/webm',fromWake);
    };
    state.mediaRecorder.start(300);
    els.voiceBtn.classList.add('recording');
    els.voiceBtn.querySelector('span').textContent='正在听…';
    els.recordingState.textContent='● 正在聆听；说完后停顿约 1 秒会自动提交';
    clearTimeout(state.recordingTimer);
    state.recordingTimer=setTimeout(()=>{if(state.mediaRecorder?.state==='recording')state.mediaRecorder.stop();},seconds*1000);
    startVad(audioStream,state.mediaRecorder,seconds);
  };

  transcribeBlob = async function(blob,mime,fromWake=false){
    clearTimeout(state.recordingTimer);
    els.voiceBtn.classList.remove('recording');
    els.voiceBtn.querySelector('span').textContent='语音提问';
    els.recordingState.textContent='正在转写并自动提交…';
    const ext=mime.includes('mp4')?'m4a':'webm',fd=new FormData();
    fd.append('file',blob,`question.${ext}`);
    try{
      const r=await fetch(`/api/transcribe?provider=${encodeURIComponent(state.provider)}`,{method:'POST',body:fd});
      const d=await readJsonResponse(r);
      const text=(d.text||'').trim();
      els.recordingState.textContent=text?`${d.provider.toUpperCase()}：${text}`:'未识别到语音';
      if(text){
        els.question.value='';
        await askAI(text);
      }
    }catch(e){
      els.recordingState.textContent=`转写失败：${e.message}`;
    }
  };

  const playBlob = async (blob) => {
    const url=URL.createObjectURL(blob);
    if(state.speakingAudio) state.speakingAudio.pause();
    const audio=new Audio(url); state.speakingAudio=audio;
    audio.playbackRate=1.08;
    await new Promise((resolve,reject)=>{audio.onended=resolve;audio.onerror=reject;audio.play().catch(reject);});
    URL.revokeObjectURL(url);
  };

  const splitTtsChunks = (text) => {
    const normalized=String(text||'').replace(/\s+/g,' ').trim();
    if(!normalized) return [];
    const sentences=normalized.match(/[^。！？；.!?]+[。！？；.!?]?/g)||[normalized];
    const chunks=[];
    let current='';
    const target=90, hardMax=150;
    for(const sentence of sentences){
      const s=sentence.trim(); if(!s)continue;
      if(!current){current=s;continue;}
      if((current+s).length<=target){current+=s;continue;}
      chunks.push(current);
      current=s;
      while(current.length>hardMax){chunks.push(current.slice(0,hardMax));current=current.slice(hardMax);}
    }
    if(current)chunks.push(current);
    return chunks.slice(0,18);
  };

  const fetchTtsBlob = async (url,text) => {
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
    if(!r.ok){let msg='TTS 失败';try{msg=(await r.json()).detail||msg;}catch{}throw new Error(msg);}
    return r.blob();
  };

  const playCloudChunks = async (url,text) => {
    const chunks=splitTtsChunks(text);
    if(!chunks.length)return;
    // 首段尽量短：先开始说，再后台预生成下一段，降低“文字出来后等很久”的感觉。
    if(chunks[0].length>70){
      const first=chunks[0], cut=Math.max(first.lastIndexOf('，',70),first.lastIndexOf(',',70));
      const at=cut>24?cut+1:70;
      chunks.splice(0,1,first.slice(0,at),first.slice(at));
    }
    let nextPromise=fetchTtsBlob(url,chunks[0]);
    for(let i=0;i<chunks.length;i++){
      const blob=await nextPromise;
      nextPromise=i+1<chunks.length?fetchTtsBlob(url,chunks[i+1]):null;
      await playBlob(blob);
    }
  };

  const browserNaturalSpeech = async (text) => {
    if(!('speechSynthesis' in window)) return;
    const synth=window.speechSynthesis;
    const voices=synth.getVoices();
    const zh = voices.find(v=>/zh-CN|cmn-CN/i.test(v.lang) && /ting|xiaoxiao|huihui|meijia|sinji|natural|premium/i.test(v.name))
      || voices.find(v=>/zh-CN|cmn-CN/i.test(v.lang))
      || voices.find(v=>/^zh/i.test(v.lang));
    const chunks=splitTtsChunks(text);
    synth.cancel();
    for(const chunk of chunks){
      await new Promise(resolve=>{
        const u=new SpeechSynthesisUtterance(chunk);
        u.lang='zh-CN'; if(zh)u.voice=zh;
        u.rate=1.08; u.pitch=1.03; u.volume=1;
        u.onend=resolve;u.onerror=resolve;synth.speak(u);
      });
    }
  };

  speakAnswer = async function(text){
    const clean=plainForSpeech(text); if(!clean)return;
    state.listeningSuspended=true; stopWakeListening();
    const started=performance.now();
    if(els.recordingState)els.recordingState.textContent='AI 已回答 · 正在准备语音…';
    try{
      if(els.cloudTts.checked && state.provider==='gemini' && state.health?.providers?.gemini?.configured){
        await playCloudChunks('/api/gemini_speech',clean);
      }else if(els.cloudTts.checked && state.health?.providers?.openai?.configured){
        await playCloudChunks('/api/speech',clean);
      }else{
        await browserNaturalSpeech(clean);
      }
      if(els.recordingState)els.recordingState.textContent='';
      console.debug(`TTS total ${Math.round(performance.now()-started)}ms`);
    }catch(e){
      console.warn('natural TTS fallback:',e);
      if(els.recordingState)els.recordingState.textContent='云端语音较慢，已切换本地语音';
      await browserNaturalSpeech(clean);
    }finally{
      setTimeout(()=>{state.listeningSuspended=false;if(els.wakeToggle.checked)startWakeListening();},500);
    }
  };

  document.querySelector('.checklist-panel')?.remove();
  const ttsLabel=els.cloudTts?.closest('label')?.querySelector('span');
  if(ttsLabel) ttsLabel.textContent='自然语音';
  if(els.cloudTts) els.cloudTts.checked=true;
  const voiceSpan=els.voiceBtn?.querySelector('span');
  if(voiceSpan) voiceSpan.textContent='语音提问';
})();
