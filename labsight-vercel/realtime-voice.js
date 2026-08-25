(() => {
  // EVT0.6: true streaming speech for Gemini via Live API.
  // The browser only receives a short-lived Live-only token from our backend.
  let liveSession = null;
  let liveAudioCtx = null;
  let liveNextStart = 0;
  let liveSources = new Set();
  let speechRunId = 0;
  let speaking = false;
  let liveDoneResolve = null;
  let liveTurnComplete = false;
  let sdkPromise = null;

  const voiceSpan = () => els.voiceBtn?.querySelector('span');

  const setSpeakingUI = (on, status='') => {
    speaking = on;
    els.voiceBtn?.classList.toggle('speaking', on);
    if (voiceSpan()) voiceSpan().textContent = on ? '停止播放' : '语音提问';
    if (els.recordingState && status !== null) els.recordingState.textContent = status;
  };

  const closeLiveSession = () => {
    try { liveSession?.close?.(); } catch {}
    liveSession = null;
  };

  const clearScheduledAudio = () => {
    for (const source of [...liveSources]) {
      try { source.stop(); } catch {}
    }
    liveSources.clear();
    liveNextStart = liveAudioCtx?.currentTime || 0;
  };

  const finishLiveWait = () => {
    if (liveDoneResolve) {
      const resolve = liveDoneResolve;
      liveDoneResolve = null;
      resolve();
    }
  };

  const cancelSpeech = (userInitiated=true) => {
    speechRunId += 1;
    clearScheduledAudio();
    closeLiveSession();
    try {
      if (state.speakingAudio) {
        state.speakingAudio.pause();
        state.speakingAudio.currentTime = 0;
        state.speakingAudio = null;
      }
    } catch {}
    try { window.speechSynthesis?.cancel(); } catch {}
    finishLiveWait();
    state.listeningSuspended = false;
    setSpeakingUI(false, userInitiated ? '已停止语音播放' : '');
    if (els.wakeToggle?.checked) setTimeout(startWakeListening, 180);
  };
  window.cancelLabSightSpeech = cancelSpeech;

  const ensureAudioContext = async () => {
    if (!liveAudioCtx || liveAudioCtx.state === 'closed') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) throw new Error('浏览器不支持 Web Audio');
      liveAudioCtx = new AudioCtx({ sampleRate: 24000 });
    }
    if (liveAudioCtx.state === 'suspended') await liveAudioCtx.resume();
    return liveAudioCtx;
  };

  const base64ToPcm16 = (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };

  const schedulePcmChunk = async (b64, runId) => {
    if (runId !== speechRunId || !b64) return;
    const ctx = await ensureAudioContext();
    const bytes = base64ToPcm16(b64);
    const frames = Math.floor(bytes.byteLength / 2);
    if (!frames) return;
    const buffer = ctx.createBuffer(1, frames, 24000);
    const out = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i=0;i<frames;i++) out[i] = view.getInt16(i*2, true) / 32768;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.025, liveNextStart || 0);
    liveNextStart = startAt + buffer.duration;
    liveSources.add(source);
    source.onended = () => {
      liveSources.delete(source);
      if (liveTurnComplete && !liveSources.size) finishLiveWait();
    };
    source.start(startAt);
    if (els.recordingState) els.recordingState.textContent = '🔊 实时语音播放中 · 点击“停止播放”可立即中断';
  };

  const loadGeminiSdk = async () => {
    if (!sdkPromise) {
      sdkPromise = import('https://esm.sh/@google/genai?bundle').catch(e => {
        sdkPromise = null;
        throw e;
      });
    }
    return sdkPromise;
  };

  const getLiveToken = async () => {
    const r = await fetch('/api/gemini_live_token', { cache: 'no-store' });
    const d = await readJsonResponse(r);
    if (!d.token) throw new Error('没有拿到 Gemini Live 临时令牌');
    return d;
  };

  const liveGeminiSpeech = async (text, runId) => {
    const [{ GoogleGenAI, Modality }, auth] = await Promise.all([
      loadGeminiSdk(),
      getLiveToken(),
    ]);
    if (runId !== speechRunId) return;

    const ai = new GoogleGenAI({ apiKey: auth.token });
    liveTurnComplete = false;
    liveNextStart = 0;
    await ensureAudioContext();

    const done = new Promise(resolve => { liveDoneResolve = resolve; });
    liveSession = await ai.live.connect({
      model: auth.model,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: auth.voice || 'Kore' },
          },
        },
        thinkingConfig: { thinkingLevel: 'minimal' },
      },
      callbacks: {
        onopen: () => {
          if (els.recordingState) els.recordingState.textContent = '已连接实时语音 · 等待首个音频片段…';
        },
        onmessage: (message) => {
          if (runId !== speechRunId) return;
          const content = message.serverContent;
          if (content?.interrupted) {
            clearScheduledAudio();
            if (els.recordingState) els.recordingState.textContent = '语音已被中断';
          }
          const parts = content?.modelTurn?.parts || [];
          for (const part of parts) {
            const inline = part.inlineData;
            if (inline?.data) schedulePcmChunk(inline.data, runId).catch(console.warn);
          }
          if (content?.turnComplete) {
            liveTurnComplete = true;
            if (!liveSources.size) finishLiveWait();
          }
        },
        onerror: (e) => {
          console.warn('Gemini Live error:', e);
          finishLiveWait();
        },
        onclose: () => finishLiveWait(),
      },
    });

    if (runId !== speechRunId) { closeLiveSession(); return; }
    const prompt = [
      '你是 LabSight 的中文语音助手。',
      '请自然、温暖、专业地朗读下面正文，语速略快于日常聊天，器件型号、数字和单位读清楚。',
      '不要解释、不要改写、不要添加开场白，只朗读正文。',
      '',
      text,
    ].join('\n');
    liveSession.sendRealtimeInput({ text: prompt });
    await done;
    closeLiveSession();
  };

  // Fast fallback remains useful if Live API / SDK is temporarily unavailable.
  const fallbackCloudSpeech = async (text, runId) => {
    const url = state.provider === 'gemini' ? '/api/gemini_speech' : '/api/speech';
    const chunks = String(text).match(/[^。！？；.!?]+[。！？；.!?]?/g)?.filter(Boolean) || [text];
    for (const raw of chunks.slice(0,20)) {
      if (runId !== speechRunId) return;
      const piece = raw.trim().slice(0,100);
      if (!piece) continue;
      const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ text:piece }) });
      if (!r.ok) throw new Error('TTS fallback 失败');
      if (runId !== speechRunId) return;
      const blob = await r.blob();
      const objectUrl = URL.createObjectURL(blob);
      const audio = new Audio(objectUrl);
      state.speakingAudio = audio;
      audio.playbackRate = 1.08;
      await new Promise((resolve,reject) => {
        audio.onended=resolve; audio.onerror=reject;
        audio.play().catch(reject);
      });
      URL.revokeObjectURL(objectUrl);
    }
  };

  const browserSpeech = async (text, runId) => {
    if (!('speechSynthesis' in window)) return;
    const synth=window.speechSynthesis;
    synth.cancel();
    const voices=synth.getVoices();
    const zh=voices.find(v=>/zh-CN|cmn-CN/i.test(v.lang)&&/natural|premium|xiaoxiao|ting|meijia/i.test(v.name))
      || voices.find(v=>/^zh/i.test(v.lang));
    const chunks=String(text).match(/[^。！？；.!?]+[。！？；.!?]?/g)?.filter(Boolean)||[text];
    for(const chunk of chunks.slice(0,20)){
      if(runId!==speechRunId)return;
      await new Promise(resolve=>{
        const u=new SpeechSynthesisUtterance(chunk);
        u.lang='zh-CN'; if(zh)u.voice=zh; u.rate=1.08;u.pitch=1.03;
        u.onend=resolve;u.onerror=resolve;synth.speak(u);
      });
    }
  };

  speakAnswer = async function(text) {
    const clean = plainForSpeech(text);
    if (!clean) return;
    cancelSpeech(false);
    const runId = ++speechRunId;
    state.listeningSuspended = true;
    stopWakeListening();
    setSpeakingUI(true, '正在连接实时语音…');
    try {
      if (els.cloudTts?.checked && state.provider === 'gemini' && state.health?.providers?.gemini?.configured) {
        try {
          await liveGeminiSpeech(clean, runId);
        } catch (e) {
          console.warn('Gemini Live fallback:', e);
          if (runId === speechRunId) {
            if (els.recordingState) els.recordingState.textContent='实时语音连接失败，切换快速分段语音…';
            await fallbackCloudSpeech(clean, runId);
          }
        }
      } else if (els.cloudTts?.checked && state.health?.providers?.openai?.configured) {
        await fallbackCloudSpeech(clean, runId);
      } else {
        await browserSpeech(clean, runId);
      }
    } catch (e) {
      console.warn('speech pipeline:', e);
      if (runId === speechRunId) await browserSpeech(clean, runId);
    } finally {
      if (runId === speechRunId) {
        closeLiveSession();
        clearScheduledAudio();
        state.listeningSuspended=false;
        setSpeakingUI(false, '');
        if(els.wakeToggle?.checked)setTimeout(startWakeListening,220);
      }
    }
  };

  // Capture-phase interception: while speech is playing/connecting, the existing
  // microphone button becomes an immediate stop button instead of starting a recording.
  els.voiceBtn?.addEventListener('click', (e) => {
    if (!speaking) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cancelSpeech(true);
  }, true);

  // A new question should also stop the previous spoken answer immediately.
  els.sendBtn?.addEventListener('click', () => { if (speaking) cancelSpeech(false); }, true);
  els.analyzeBtn?.addEventListener('click', () => { if (speaking) cancelSpeech(false); }, true);
  els.deepVisionBtn?.addEventListener('click', () => { if (speaking) cancelSpeech(false); }, true);

  const ttsLabel=els.cloudTts?.closest('label')?.querySelector('span');
  if(ttsLabel) ttsLabel.textContent='实时语音';
})();
