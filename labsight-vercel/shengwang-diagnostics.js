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

  const formatDuration = (seconds) => {
    const s = Math.max(0, Number(seconds || 0));
    if (!s) return '';
    const h = Math.floor(s / 3600);
    const m = Math.ceil((s % 3600) / 60);
    if (h && m) return `${h} 小时 ${m} 分`;
    if (h) return `${h} 小时`;
    return `${Math.max(1, m)} 分钟`;
  };

  const normalizeError = (status, data, fallbackText='') => {
    const detail = data?.detail;
    if (detail && typeof detail === 'object') {
      if (detail.code === 'gemini_tts_quota_exhausted') {
        const retry = formatDuration(detail.retry_after_seconds);
        const limit = detail.daily_limit ? `每日额度 ${detail.daily_limit} 次` : '';
        const model = detail.model || '';
        return {
          title: 'Gemini TTS 配额已耗尽',
          summary: [limit, model, retry ? `约 ${retry} 后恢复` : '等待配额恢复'].filter(Boolean).join(' · '),
          detail: detail.provider_message || '',
          quota: true,
        };
      }
      return {
        title: `Gemini TTS 请求失败（HTTP ${status}）`,
        summary: detail.message || '上游服务返回错误',
        detail: detail.provider_message || '',
      };
    }
    const text = typeof detail === 'string' ? detail : (fallbackText || JSON.stringify(data || {}));
    return {title:`Gemini TTS 请求失败（HTTP ${status}）`, summary:text, detail:''};
  };

  const showDiagnosticMessage = (diag) => {
    const recording = document.getElementById('recordingState');
    if (!recording) return;
    recording.textContent = `❌ ${diag.title}${diag.summary ? `：${diag.summary}` : ''}`;
    recording.title = diag.detail || diag.summary || diag.title;
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
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          input:'LabSight Gemini TTS 测试成功。',
          voice:'Kore',
          response_format:'pcm',
        }),
      });
      const elapsedMs = Math.round(performance.now() - started);
      const contentType = response.headers.get('content-type') || 'unknown';
      const sampleRate = Number(response.headers.get('x-sample-rate') || 24000);

      if (!response.ok) {
        let data = null;
        let text = '';
        try { data = await response.json(); }
        catch { try { text = await response.text(); } catch {} }
        const diag = normalizeError(response.status, data, text);
        setState(diag.quota ? 'TTS 配额耗尽' : 'Gemini TTS 失败', 'warn');
        showDiagnosticMessage(diag);
        console.warn('Gemini TTS diagnostics:', diag);
        return;
      }

      const pcm = await response.arrayBuffer();
      if (pcm.byteLength < 1000) throw new Error(`返回音频过短：${pcm.byteLength} bytes`);
      setState(`PCM ${Math.round(pcm.byteLength/1024)}KB · ${elapsedMs}ms`, 'ok');
      const recording = document.getElementById('recordingState');
      if (recording) {
        recording.textContent = `✅ Gemini TTS 正常：HTTP ${response.status} · ${contentType} · ${Math.round(pcm.byteLength/1024)}KB · ${sampleRate}Hz · ${elapsedMs}ms`;
        recording.title = '';
      }
      await playPcm(pcm, sampleRate);
      setState('Gemini TTS 正常', 'ok');
    } catch (e) {
      console.error('Gemini TTS test failed:', e);
      setState('Gemini TTS 失败', 'warn');
      showDiagnosticMessage({title:'Gemini TTS 测试失败', summary:e.message, detail:''});
    } finally {
      btn.disabled = false;
    }
  };

  btn.addEventListener('click', testGeminiTts);
  window.LabSightShengwangDiagnostics = {testGeminiTts};
})();
