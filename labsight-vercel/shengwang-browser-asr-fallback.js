(() => {
  // Browser-side ASR fallback for Shengwang realtime voice.
  // Speech is transcribed in-browser/server, then visual questions are answered
  // against the current LabSight camera frame before being spoken through Shengwang.
  const bar = document.querySelector('.wakebar');
  if (!bar || !navigator.mediaDevices?.getUserMedia) return;

  const pill = document.createElement('span');
  pill.id = 'shengwangBrowserAsrState';
  pill.className = 'pill neutral';
  pill.textContent = '语音输入待机';
  bar.appendChild(pill);

  let running = false;
  let stream = null;
  let ctx = null;
  let analyser = null;
  let timer = null;
  let recorder = null;
  let chunks = [];
  let speechFrames = 0;
  let silenceFrames = 0;
  let speaking = false;
  let processing = false;

  const setState = (text, kind='neutral') => {
    pill.textContent = text;
    pill.className = `pill ${kind}`;
  };

  const postAgent = async (action, extra={}) => {
    const voice = window.LabSightShengwangVoice;
    const session = voice?.session;
    if (!voice?.active || !session?.agent_id) throw new Error('声网会话已结束');
    const r = await fetch('/api/shengwang_session', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action, agent_id:session.agent_id, channel:session.channel, provider:state?.provider, ...extra}),
    });
    const raw = await r.text();
    let data = {};
    try { data = JSON.parse(raw); } catch {}
    if (!r.ok) throw new Error(data.detail || raw || `HTTP ${r.status}`);
    return data;
  };

  const postThink = async (text) => {
    const voice = window.LabSightShengwangVoice;
    const session = voice?.session;
    if (!voice?.active || !session?.agent_id) throw new Error('声网会话已结束');
    const r = await fetch('/api/shengwang_control', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'think', agent_id:session.agent_id, text}),
    });
    const raw = await r.text();
    let data = {};
    try { data = JSON.parse(raw); } catch {}
    if (!r.ok) throw new Error(data.detail || raw || `HTTP ${r.status}`);
    return data;
  };

  const analyzeCurrentFrame = async (text) => {
    if (!state?.stream || !els?.video?.videoWidth) return null;
    const image = captureFrame();
    if (!image) return null;

    addMessage('user', `🎙 ${text}`);
    const thinking = addMessage('assistant', '正在结合当前画面判断…', 'thinking');
    try {
      const payload = {
        question:text,
        scene:state.scene,
        provider:state.provider,
        image_data_url:image,
        project_context:state.projectContext,
        conversation:state.conversation.slice(-8),
      };
      const r = await fetch('/api/analyze', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload),
      });
      const d = await readJsonResponse(r);
      thinking.remove();
      addMessage('assistant', `[${d.provider.toUpperCase()} · ${d.model}]\n${d.answer}`);
      state.conversation.push({role:'user', content:text}, {role:'assistant', content:d.answer});
      if (state.conversation.length > 20) state.conversation = state.conversation.slice(-20);
      extendSession();
      return d.answer;
    } catch (e) {
      thinking.remove();
      addMessage('assistant', `分析失败：${e.message}`);
      throw e;
    }
  };

  const transcribe = async (blob, mime) => {
    if (!blob || blob.size < 1200 || processing) return;
    processing = true;
    setState('正在识别语音…', 'warn');
    try {
      const fd = new FormData();
      const ext = mime.includes('mp4') ? 'm4a' : 'webm';
      fd.append('file', blob, `shengwang-fallback.${ext}`);
      const provider = state?.provider || 'gemini';
      const r = await fetch(`/api/transcribe?provider=${encodeURIComponent(provider)}`, {method:'POST', body:fd});
      const raw = await r.text();
      let data = {};
      try { data = JSON.parse(raw); } catch {}
      if (!r.ok) throw new Error(data.detail || raw || `HTTP ${r.status}`);
      const text = String(data.text || '').trim();
      if (!text) {
        setState('未识别到语音', 'warn');
        return;
      }

      if (els.recordingState) els.recordingState.textContent = `🎙 已识别：${text}`;
      setState('正在结合画面分析…', 'ok');

      const answer = await analyzeCurrentFrame(text);
      if (answer) {
        if (els.recordingState) els.recordingState.textContent = `✅ 已结合当前画面回答：${text}`;
        setState('正在语音回答', 'ok');
        await postAgent('speak', {text:answer});
      } else {
        addMessage('user', `🎙 ${text}`);
        setState('已识别 · 送入声网', 'ok');
        await postThink(text);
        if (els.recordingState) els.recordingState.textContent = `✅ 语音已识别并送入声网 Agent：${text}`;
        setState('正在等待回答', 'ok');
      }
    } catch (e) {
      console.warn('Shengwang browser ASR fallback:', e);
      setState('语音处理失败', 'warn');
      if (els.recordingState) els.recordingState.textContent = `❌ 语音处理失败：${e.message}`;
    } finally {
      processing = false;
    }
  };

  const stopRecording = () => {
    if (!recorder || recorder.state !== 'recording') return;
    try { recorder.stop(); } catch {}
  };

  const startRecording = () => {
    if (!stream || recorder?.state === 'recording' || processing) return;
    const mime = ['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    chunks = [];
    recorder = new MediaRecorder(stream, mime ? {mimeType:mime} : undefined);
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, {type:mime || 'audio/webm'});
      chunks = [];
      transcribe(blob, mime || 'audio/webm');
    };
    recorder.start(250);
    setState('听到你了…', 'ok');
  };

  const tick = () => {
    if (!running || !analyser) return;
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i=0;i<data.length;i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const threshold = 0.012;

    if (rms >= threshold) {
      speechFrames += 1;
      silenceFrames = 0;
      if (!speaking && speechFrames >= 2) {
        speaking = true;
        startRecording();
      }
    } else {
      speechFrames = 0;
      if (speaking) {
        silenceFrames += 1;
        if (silenceFrames >= 7) {
          speaking = false;
          silenceFrames = 0;
          stopRecording();
        }
      }
    }
    timer = setTimeout(tick, 100);
  };

  const start = async () => {
    if (running) return;
    const voice = window.LabSightShengwangVoice;
    if (!voice?.active || voice?.ttsTarget === 'probe') return;
    running = true;
    setState('正在接管语音输入…', 'warn');
    try {
      const deviceId = els.micSelect?.value || '';
      stream = await navigator.mediaDevices.getUserMedia({
        video:false,
        audio: deviceId ? {
          deviceId:{exact:deviceId},
          echoCancellation:true,
          noiseSuppression:true,
          autoGainControl:true,
        } : {
          echoCancellation:true,
          noiseSuppression:true,
          autoGainControl:true,
        },
      });
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      ctx = new AudioCtx();
      await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      setState('语音输入已就绪', 'ok');
      tick();
    } catch (e) {
      running = false;
      setState('无法打开麦克风', 'warn');
      console.warn('browser ASR fallback init:', e);
    }
  };

  const stop = async () => {
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
    speaking = false;
    speechFrames = 0;
    silenceFrames = 0;
    stopRecording();
    recorder = null;
    try { stream?.getTracks().forEach(t => t.stop()); } catch {}
    stream = null;
    analyser = null;
    try { await ctx?.close(); } catch {}
    ctx = null;
    setState('语音输入待机', 'neutral');
  };

  setInterval(() => {
    const voice = window.LabSightShengwangVoice;
    if (voice?.active && voice?.ttsTarget !== 'probe') {
      if (!running) start();
    } else if (running) {
      stop();
    }
  }, 500);

  window.LabSightShengwangBrowserAsr = {start, stop, get running(){return running;}};
})();
