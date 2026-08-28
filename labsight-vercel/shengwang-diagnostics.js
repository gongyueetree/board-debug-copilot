(() => {
  const bar = document.querySelector('.wakebar');
  if (!bar) return;

  const host = document.createElement('div');
  host.className = 'shengwang-diagnostics';
  host.style.display = 'flex';
  host.style.flexWrap = 'wrap';
  host.style.gap = '8px';
  host.style.alignItems = 'center';
  host.style.marginTop = '8px';
  host.innerHTML = `
    <button id="geminiTtsTestBtn" class="secondary agora-session-btn" type="button">测试 Gemini TTS</button>
    <span id="geminiTtsTestState" class="pill neutral">TTS 未测试</span>
  `;
  bar.appendChild(host);

  const btn = document.getElementById('geminiTtsTestBtn');
  const pill = document.getElementById('geminiTtsTestState');

  const setState = (text, kind='neutral') => {
    pill.textContent = text;
    pill.className = `pill ${kind}`;
  };

  const pcm16ToAudioBuffer = (arrayBuffer, sampleRate=24000) => {
    const bytes = new Uint8Array(arrayBuffer);
    const usable = bytes.byteLength - (bytes.byteLength % 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
    const samples = new Float32Array(usable / 2);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = view.getInt16(i * 2, true) / 32768;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('浏览器不支持 AudioContext');
    const ctx = new AudioCtx({sampleRate});
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    return {ctx, buffer};
  };

  const playPcm = async (arrayBuffer, sampleRate) => {
    const {ctx, buffer} = pcm16ToAudioBuffer(arrayBuffer, sampleRate);
    await ctx.resume();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();
    await new Promise((resolve) => {
      source.onended = resolve;
      setTimeout(resolve, Math.max(1500, buffer.duration * 1000 + 500));
    });
    try { await ctx.close(); } catch {}
  };

  const testGeminiTts = async () => {
    btn.disabled = true;
    setState('正在生成…', 'warn');
    const started = performance.now();
    try {
      const response = await fetch('/api/gemini_tts_openai', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          model: 'gemini-3.1-flash-tts-preview',
          input: 'LabSight Gemini TTS 测试成功。',
          voice: 'Kore',
          response_format: 'pcm',
        }),
      });
      const elapsedMs = Math.round(performance.now() - started);
      const contentType = response.headers.get('content-type') || 'unknown';
      const sampleRate = Number(response.headers.get('x-sample-rate') || 24000);
      if (!response.ok) {
        let detail = '';
        try {
          const data = await response.json();
          detail = data?.detail || JSON.stringify(data);
        } catch {
          detail = await response.text();
        }
        throw new Error(`HTTP ${response.status} · ${detail || response.statusText}`);
      }
      const pcm = await response.arrayBuffer();
      if (pcm.byteLength < 1000) {
        throw new Error(`返回音频过短：${pcm.byteLength} bytes`);
      }
      setState(`PCM ${Math.round(pcm.byteLength/1024)}KB · ${elapsedMs}ms`, 'ok');
      if (window.els?.recordingState) {
        window.els.recordingState.textContent = `✅ Gemini TTS：HTTP ${response.status} · ${contentType} · ${pcm.byteLength} bytes · ${sampleRate}Hz · ${elapsedMs}ms；正在本机播放测试音频。`;
      }
      await playPcm(pcm, sampleRate);
      setState('Gemini TTS 正常', 'ok');
    } catch (e) {
      console.error('Gemini TTS test failed:', e);
      setState('Gemini TTS 失败', 'warn');
      const msg = `❌ Gemini TTS 测试失败：${e.message}`;
      const recording = document.getElementById('recordingState');
      if (recording) recording.textContent = msg;
      try { window.addMessage?.('assistant', msg); } catch {}
    } finally {
      btn.disabled = false;
    }
  };

  btn.addEventListener('click', testGeminiTts);
  window.LabSightShengwangDiagnostics = { testGeminiTts };
})();
