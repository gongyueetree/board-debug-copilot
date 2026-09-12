(() => {
  // Browser-side ASR input for Shengwang realtime voice.
  // Keep a short rolling pre-roll locally so the beginning of each utterance is
  // not clipped by VAD before the recorder starts.
  const bar = document.querySelector('.wakebar');
  if (!bar || !navigator.mediaDevices?.getUserMedia) return;

  const pill = document.createElement('span');
  pill.id = 'shengwangBrowserAsrState';
  pill.className = 'pill neutral';
  pill.textContent = '语音输入待机';
  bar.appendChild(pill);

  const PRE_ROLL_MS = 1100;
  const TICK_MS = 100;
  const SPEECH_FRAMES_TO_START = 2;
  const SILENCE_FRAMES_TO_END = 7;

  let running = false;
  let stream = null;
  let ctx = null;
  let analyser = null;
  let timer = null;
  let recorder = null;
  let recorderMode = 'discard';
  let recorderStartedAt = 0;
  let recorderMime = '';
  let chunks = [];
  let speechFrames = 0;
  let silenceFrames = 0;
  let speaking = false;
  let processing = false;
  let suppressUntil = 0;
  let lastAcceptedText = '';
  let lastAcceptedAt = 0;

  const setState = (text, kind='neutral') => {
    pill.textContent = text;
    pill.className = `pill ${kind}`;
  };

  const normalizeText = (text='') => String(text)
    .replace(/[\s，。！？,.!?、:：;；'"“”‘’()（）\[\]{}<>《》_-]+/g, '')
    .toLowerCase();

  const looksLikeJunk = (text='') => {
    const raw = String(text).trim();
    if (!raw) return true;
    if (/^(?:\s*\d{1,2}:\d{2}(?::\d{2})?\s*){2,}$/.test(raw)) return true;
    const compact = normalizeText(raw);
    if (!compact) return true;
    if (/^[0-9:：.-]+$/.test(raw.replace(/\s+/g, ''))) return true;
    return false;
  };

  const isDuplicate = (text='') => {
    const normalized = normalizeText(text);
    const now = Date.now();
    if (normalized && normalized === lastAcceptedText && now - lastAcceptedAt < 6000) return true;
    lastAcceptedText = normalized;
    lastAcceptedAt = now;
    return false;
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
    if (Date.now() < suppressUntil) return;
    processing = true;
    setState('正在识别语音…', 'warn');
    try {
      const fd = new FormData();
      const ext = mime.includes('mp4') ? 'm4a' : 'webm';
      fd.append('file', blob, `shengwang-voice.${ext}`);
      const provider = state?.provider || 'gemini';
      const r = await fetch(`/api/transcribe?provider=${encodeURIComponent(provider)}`, {method:'POST', body:fd});
      const raw = await r.text();
      let data = {};
      try { data = JSON.parse(raw); } catch {}
      if (!r.ok) throw new Error(data.detail || raw || `HTTP ${r.status}`);
      const text = String(data.text || '').trim();

      if (looksLikeJunk(text)) {
        setState('正在聆听', 'ok');
        if (els.recordingState) els.recordingState.textContent = '🎙 正在聆听';
        return;
      }
      if (isDuplicate(text)) {
        setState('正在聆听', 'ok');
        return;
      }

      if (els.recordingState) els.recordingState.textContent = `🎙 已识别：${text}`;
      setState('正在结合画面分析…', 'ok');

      const answer = await analyzeCurrentFrame(text);
      if (answer) {
        const answerChars = String(answer).replace(/\s+/g, '').length;
        const holdMs = Math.max(3500, Math.min(20000, 1800 + answerChars * 170));
        suppressUntil = Date.now() + holdMs;
        speechFrames = 0;
        silenceFrames = 0;
        speaking = false;
        if (els.recordingState) els.recordingState.textContent = `✅ 已结合当前画面回答：${text}`;
        setState('AI 正在回答', 'ok');
        await postAgent('speak', {text:answer});
        setTimeout(() => {
          if (Date.now() >= suppressUntil && running) {
            setState('正在聆听', 'ok');
            if (els.recordingState) els.recordingState.textContent = '🎙 正在聆听';
          }
        }, holdMs + 100);
      } else {
        addMessage('user', `🎙 ${text}`);
        setState('已识别 · 送入声网', 'ok');
        await postThink(text);
        if (els.recordingState) els.recordingState.textContent = `✅ 语音已识别并送入声网 Agent：${text}`;
        setState('正在等待回答', 'ok');
      }
    } catch (e) {
      console.warn('Shengwang browser ASR:', e);
      setState('语音处理失败', 'warn');
      if (els.recordingState) els.recordingState.textContent = `❌ 语音处理失败：${e.message}`;
    } finally {
      processing = false;
    }
  };

  const stopRecorder = (mode='discard') => {
    if (!recorder || recorder.state !== 'recording') return;
    recorderMode = mode;
    try { recorder.stop(); } catch {}
  };

  const startRollingRecorder = (mode='discard') => {
    if (!running || !stream || recorder?.state === 'recording' || processing || Date.now() < suppressUntil) return;
    const mime = ['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    recorderMime = mime || 'audio/webm';
    recorderMode = mode;
    recorderStartedAt = Date.now();
    chunks = [];
    const localRecorder = new MediaRecorder(stream, mime ? {mimeType:mime} : undefined);
    recorder = localRecorder;
    localRecorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    localRecorder.onstop = () => {
      const finalMode = recorderMode;
      const finalMime = recorderMime || 'audio/webm';
      const blob = new Blob(chunks, {type:finalMime});
      chunks = [];
      if (recorder === localRecorder) recorder = null;
      if (finalMode === 'utterance') {
        transcribe(blob, finalMime).finally(() => {
          if (running && !processing && Date.now() >= suppressUntil) startRollingRecorder('discard');
        });
      } else if (running && !processing && Date.now() >= suppressUntil) {
        setTimeout(() => startRollingRecorder('discard'), 0);
      }
    };
    localRecorder.start(250);
  };

  const tick = () => {
    if (!running || !analyser) return;
    const now = Date.now();
    if (now < suppressUntil) {
      speechFrames = 0;
      silenceFrames = 0;
      speaking = false;
      if (recorder?.state === 'recording') stopRecorder('discard');
      timer = setTimeout(tick, TICK_MS);
      return;
    }

    if (!processing && !recorder) startRollingRecorder('discard');

    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i=0;i<data.length;i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const threshold = 0.012;

    if (rms >= threshold) {
      speechFrames += 1;
      silenceFrames = 0;
      if (!speaking && speechFrames >= SPEECH_FRAMES_TO_START) {
        speaking = true;
        // Recorder has already been running during silence, so the utterance
        // contains up to PRE_ROLL_MS before VAD fired instead of clipping its first words.
        if (recorder?.state === 'recording') recorderMode = 'utterance';
        else startRollingRecorder('utterance');
        setState('听到你了…', 'ok');
      }
    } else {
      speechFrames = 0;
      if (speaking) {
        silenceFrames += 1;
        if (silenceFrames >= SILENCE_FRAMES_TO_END) {
          speaking = false;
          silenceFrames = 0;
          if (recorder?.state === 'recording') stopRecorder('utterance');
        }
      } else if (!processing && recorder?.state === 'recording' && recorderMode === 'discard' && now - recorderStartedAt >= PRE_ROLL_MS) {
        // Rotate the silent buffer so the next utterance carries ~1.1 s of prefix,
        // not an arbitrarily long silence recording.
        stopRecorder('discard');
      }
    }
    timer = setTimeout(tick, TICK_MS);
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
      setState('正在聆听', 'ok');
      startRollingRecorder('discard');
      tick();
    } catch (e) {
      running = false;
      setState('无法打开麦克风', 'warn');
      console.warn('browser ASR init:', e);
    }
  };

  const stop = async () => {
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
    speaking = false;
    speechFrames = 0;
    silenceFrames = 0;
    suppressUntil = 0;
    if (recorder?.state === 'recording') stopRecorder('discard');
    recorder = null;
    chunks = [];
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

  window.LabSightShengwangBrowserAsr = {
    start,
    stop,
    get running(){return running;},
    get preRollMs(){return PRE_ROLL_MS;},
  };
})();
