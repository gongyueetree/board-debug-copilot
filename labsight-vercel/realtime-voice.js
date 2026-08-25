(() => {
  // EVT0.6.1: continuous Gemini Live speech with jitter buffering,
  // long-silence compaction and interruptible playback.
  let liveSession = null;
  let liveAudioCtx = null;
  let liveNextStart = 0;
  let liveSources = new Set();
  let speechRunId = 0;
  let speaking = false;
  let liveDoneResolve = null;
  let liveTurnComplete = false;
  let sdkPromise = null;
  let firstLiveChunk = true;

  const SAMPLE_RATE = 24000;
  const INITIAL_BUFFER_SEC = 0.14;
  const RESUME_GUARD_SEC = 0.006;
  const LONG_SILENCE_SEC = 0.22;
  const KEPT_SILENCE_SEC = 0.085;
  const SILENCE_THRESHOLD = 0.0048;

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
    firstLiveChunk = true;
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
      liveAudioCtx = new AudioCtx({ sampleRate: SAMPLE_RATE });
    }
    if (liveAudioCtx.state === 'suspended') await liveAudioCtx.resume();
    return liveAudioCtx;
  };

  const base64ToFloat32 = (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
    const frames = Math.floor(bytes.byteLength / 2);
    const samples = new Float32Array(frames);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i=0;i<frames;i++) samples[i] = view.getInt16(i*2, true) / 32768;
    return samples;
  };

  // Gemini can occasionally synthesize a noticeably long pause between clauses.
  // Keep normal prosody, but cap only clearly-long near-silent runs.
  const compactLongSilence = (input) => {
    if (!input?.length) return input;
    const minRun = Math.round(SAMPLE_RATE * LONG_SILENCE_SEC);
    const keepRun = Math.round(SAMPLE_RATE * KEPT_SILENCE_SEC);
    const out = [];
    let i = 0;
    while (i < input.length) {
      if (Math.abs(input[i]) > SILENCE_THRESHOLD) {
        out.push(input[i++]);
        continue;
      }
      const start = i;
      while (i < input.length && Math.abs(input[i]) <= SILENCE_THRESHOLD) i++;
      const run = i - start;
      if (run >= minRun) {
        const keep = Math.min(run, keepRun);
        for (let j=0;j<keep;j++) out.push(input[start + j]);
      } else {
        for (let j=start;j<i;j++) out.push(input[j]);
      }
    }
    return Float32Array.from(out);
  };

  const schedulePcmChunk = async (b64, runId) => {
    if (runId !== speechRunId || !b64) return;
    const ctx = await ensureAudioContext();
    let samples = base64ToFloat32(b64);
    samples = compactLongSilence(samples);
    if (!samples.length) return;

    const buffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    // Only the first chunk gets a small jitter buffer. Subsequent chunks are
    // stitched directly onto the queued audio timeline; do not add 25 ms per chunk.
    const now = ctx.currentTime;
    let startAt;
    if (firstLiveChunk || !liveNextStart) {
      startAt = now + INITIAL_BUFFER_SEC;
      firstLiveChunk = false;
    } else if (liveNextStart >= now - 0.01) {
      startAt = Math.max(liveNextStart, now + RESUME_GUARD_SEC);
    } else {
      // Real network underrun: recover with the smallest safe guard rather than
      // creating another audible quarter-second gap.
      startAt = now + RESUME_GUARD_SEC;
    }
    liveNextStart = startAt + buffer.duration;

    liveSources.add(source);
    source.onended = () => {
      liveSources.delete(source);
      if (liveTurnComplete && !liveSources.size) finishLiveWait();
    };
    source.start(startAt);
    if (els.recordingState) els.recordingState.textContent = '🔊 连续实时语音播放中 · 点击“停止播放”可立即中断';
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
    firstLiveChunk = true;
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
          if (els.recordingState) els.recordingState.textContent = '已连接实时语音 · 正在缓冲首个音频片段…';
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
      '请把下面正文一次性、连续、自然地朗读完，整体语速略快于日常聊天。',
      '段落之间不要做明显停顿；句号停顿尽量控制在约 0.12 秒，逗号约 0.06 秒。',
      '不要把每个列表项读成独立播报段；相邻内容要像工程师连续讲话一样衔接。',
      '器件型号、数字和单位要读清楚。不要解释、不要改写、不要添加开场白，只朗读正文。',
      '',
      text,
    ].join('\n');
    liveSession.sendRealtimeInput({ text: prompt });
    await done;
    closeLiveSession();
  };

  const fetchSpeechBlob = async (url, piece, runId) => {
    if (runId !== speechRunId) return null;
    const r = await fetch(url, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ text:piece }),
    });
    if (!r.ok) throw new Error('TTS fallback 失败');
    if (runId !== speechRunId) return null;
    return r.blob();
  };

  const playBlob = async (blob, runId) => {
    if (!blob || runId !== speechRunId) return;
    const objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(objectUrl);
    state.speakingAudio = audio;
    audio.playbackRate = 1.1;
    await new Promise((resolve,reject) => {
      audio.onended=resolve; audio.onerror=reject;
      audio.play().catch(reject);
    });
    URL.revokeObjectURL(objectUrl);
  };

  // Fallback now prefetches ahead so sentence boundaries do not wait on the next HTTP request.
  const fallbackCloudSpeech = async (text, runId) => {
    const url = state.provider === 'gemini' ? '/api/gemini_speech' : '/api/speech';
    const rawChunks = String(text).match(/[^。！？；.!?]+[。！？；.!?]?/g)?.filter(Boolean) || [text];
    const chunks = [];
    let buf = '';
    for (const raw of rawChunks) {
      const s = raw.trim();
      if (!s) continue;
      if ((buf + s).length <= 180) buf += s;
      else { if (buf) chunks.push(buf); buf = s; }
    }
    if (buf) chunks.push(buf);
    const limited = chunks.slice(0,16);
    const promises = new Map();
    const prefetch = (idx) => {
      if (idx < limited.length && !promises.has(idx)) promises.set(idx, fetchSpeechBlob(url, limited[idx], runId));
    };
    prefetch(0); prefetch(1); prefetch(2);
    for (let i=0;i<limited.length;i++) {
      if (runId !== speechRunId) return;
      prefetch(i+3);
      const blob = await promises.get(i);
      await playBlob(blob, runId);
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
        u.lang='zh-CN'; if(zh)u.voice=zh; u.rate=1.1;u.pitch=1.02;
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
    setSpeakingUI(true, '正在连接连续实时语音…');
    try {
      if (els.cloudTts?.checked && state.provider === 'gemini' && state.health?.providers?.gemini?.configured) {
        try {
          await liveGeminiSpeech(clean, runId);
        } catch (e) {
          console.warn('Gemini Live fallback:', e);
          if (runId === speechRunId) {
            if (els.recordingState) els.recordingState.textContent='实时语音连接失败，切换预取式连续语音…';
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

  els.voiceBtn?.addEventListener('click', (e) => {
    if (!speaking) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cancelSpeech(true);
  }, true);

  els.sendBtn?.addEventListener('click', () => { if (speaking) cancelSpeech(false); }, true);
  els.analyzeBtn?.addEventListener('click', () => { if (speaking) cancelSpeech(false); }, true);
  els.deepVisionBtn?.addEventListener('click', () => { if (speaking) cancelSpeech(false); }, true);

  const ttsLabel=els.cloudTts?.closest('label')?.querySelector('span');
  if(ttsLabel) ttsLabel.textContent='连续实时语音';
})();
