(() => {
  // EVT0.16 wake-word cost guard.
  // Replaces the old fixed 4.2 s upload loop with browser-side energy VAD.
  // Silence never leaves the browser; only a detected utterance is sent to STT.
  // This intentionally reuses the already-open camera/mic MediaStream and does
  // not call getUserMedia again.
  if (!window.AudioContext && !window.webkitAudioContext) return;

  const originalStop = window.stopWakeListening;
  const vad = {
    running:false,
    ctx:null,
    analyser:null,
    source:null,
    timer:null,
    recorder:null,
    chunks:[],
    speaking:false,
    speechFrames:0,
    silenceFrames:0,
    startedAt:0,
    processing:false,
  };

  const TICK_MS = 100;
  const RMS_THRESHOLD = 0.012;
  const START_FRAMES = 2;       // ~200 ms voiced audio before recording
  const END_SILENCE_FRAMES = 8; // ~800 ms silence closes an utterance
  const MAX_UTTERANCE_MS = 7000;
  const MIN_BLOB_BYTES = 1200;

  function setWake(text, kind='neutral') {
    if (typeof setPill === 'function' && els?.wakeState) setPill(els.wakeState, text, kind);
  }

  function cleanupAudioGraph() {
    if (vad.timer) clearTimeout(vad.timer);
    vad.timer = null;
    try { vad.source?.disconnect(); } catch {}
    try { vad.analyser?.disconnect(); } catch {}
    vad.source = null;
    vad.analyser = null;
    const ctx = vad.ctx;
    vad.ctx = null;
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {});
  }

  function stopRecorder(discard=false) {
    const rec = vad.recorder;
    if (!rec || rec.state !== 'recording') return;
    if (discard) rec.onstop = null;
    try { rec.stop(); } catch {}
  }

  async function handleUtterance(blob) {
    if (!vad.running || !els?.wakeToggle?.checked || state?.listeningSuspended) return;
    if (!blob || blob.size < MIN_BLOB_BYTES) {
      setWake('自动唤醒 ON · 本地监听', 'ok');
      return;
    }
    vad.processing = true;
    setWake('听到语音 · 识别唤醒词…', 'neutral');
    try {
      const fd = new FormData();
      fd.append('file', blob, 'wake.webm');
      const r = await fetch(`/api/transcribe?provider=${encodeURIComponent(state.provider)}`, {
        method:'POST',
        body:fd,
      });
      const d = await readJsonResponse(r);
      const text = String(d.text || '').trim();
      if (!text) return;

      if (sessionActive() && !wakePhrase(text)) {
        extendSession();
        await askAI(text);
        return;
      }
      if (wakePhrase(text)) {
        extendSession();
        addMessage('assistant', '我在。');
        void speakAnswer('我在');
        setTimeout(() => recordOnce(12, true), 700);
        return;
      }
    } catch (e) {
      console.warn('wake VAD:', e);
    } finally {
      vad.processing = false;
      if (vad.running && els?.wakeToggle?.checked && !state?.listeningSuspended) {
        setWake('自动唤醒 ON · 本地监听', 'ok');
      }
    }
  }

  function startRecorder() {
    if (!vad.running || vad.processing || vad.recorder?.state === 'recording') return;
    const tracks = state?.stream?.getAudioTracks?.() || [];
    if (!tracks.length) return;
    const mime = ['audio/webm;codecs=opus', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    vad.chunks = [];
    const rec = new MediaRecorder(new MediaStream(tracks), mime ? {mimeType:mime} : undefined);
    vad.recorder = rec;
    vad.startedAt = Date.now();
    rec.ondataavailable = e => { if (e.data.size) vad.chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(vad.chunks, {type:mime || 'audio/webm'});
      vad.chunks = [];
      vad.recorder = null;
      void handleUtterance(blob);
    };
    rec.start(250);
  }

  function tick() {
    if (!vad.running || !vad.analyser) return;
    if (state?.listeningSuspended || vad.processing) {
      vad.speechFrames = 0;
      vad.silenceFrames = 0;
      if (vad.recorder?.state === 'recording') stopRecorder(true);
      vad.speaking = false;
      vad.timer = setTimeout(tick, TICK_MS);
      return;
    }

    const data = new Float32Array(vad.analyser.fftSize);
    vad.analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);

    if (rms >= RMS_THRESHOLD) {
      vad.speechFrames += 1;
      vad.silenceFrames = 0;
      if (!vad.speaking && vad.speechFrames >= START_FRAMES) {
        vad.speaking = true;
        startRecorder();
      }
    } else {
      vad.speechFrames = 0;
      if (vad.speaking) {
        vad.silenceFrames += 1;
        if (vad.silenceFrames >= END_SILENCE_FRAMES) {
          vad.speaking = false;
          vad.silenceFrames = 0;
          stopRecorder(false);
        }
      }
    }

    if (vad.recorder?.state === 'recording' && Date.now() - vad.startedAt >= MAX_UTTERANCE_MS) {
      vad.speaking = false;
      vad.silenceFrames = 0;
      stopRecorder(false);
    }
    vad.timer = setTimeout(tick, TICK_MS);
  }

  async function startWakeListeningV16() {
    if (!els?.wakeToggle?.checked || state?.listeningSuspended || vad.running) return;
    const tracks = state?.stream?.getAudioTracks?.() || [];
    if (!tracks.length) return;

    // Stop any legacy 4.2-second recorder before taking over.
    try { originalStop?.(); } catch {}
    vad.running = true;
    state.wakeEnabled = true;
    setWake('自动唤醒 ON · 本地监听', 'ok');

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      vad.ctx = new AudioCtx();
      await vad.ctx.resume();
      vad.source = vad.ctx.createMediaStreamSource(new MediaStream(tracks));
      vad.analyser = vad.ctx.createAnalyser();
      vad.analyser.fftSize = 1024;
      vad.source.connect(vad.analyser);
      tick();
    } catch (e) {
      console.warn('wake local VAD init:', e);
      vad.running = false;
      cleanupAudioGraph();
      setWake('自动唤醒不可用', 'warn');
    }
  }

  function stopWakeListeningV16() {
    vad.running = false;
    if (vad.timer) clearTimeout(vad.timer);
    vad.timer = null;
    stopRecorder(true);
    vad.recorder = null;
    vad.chunks = [];
    vad.speaking = false;
    vad.processing = false;
    vad.speechFrames = 0;
    vad.silenceFrames = 0;
    cleanupAudioGraph();
    try { originalStop?.(); } catch {}
  }

  window.startWakeListening = startWakeListeningV16;
  window.stopWakeListening = stopWakeListeningV16;
  window.LabSightWakeVAD = {
    start:startWakeListeningV16,
    stop:stopWakeListeningV16,
    get running(){ return vad.running; },
    config:{threshold:RMS_THRESHOLD, tickMs:TICK_MS, endSilenceMs:END_SILENCE_FRAMES*TICK_MS},
  };
})();
