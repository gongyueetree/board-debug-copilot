(() => {
  const bar = document.querySelector('.wakebar');
  if (!bar) return;

  const host = document.createElement('div');
  host.style.display = 'flex';
  host.style.flexWrap = 'wrap';
  host.style.gap = '8px';
  host.style.marginTop = '8px';
  host.innerHTML = `
    <button id="shengwangLlmTestBtn" class="secondary agora-session-btn" type="button">测试声网 LLM</button>
    <button id="shengwangMicTestBtn" class="secondary agora-session-btn" type="button">测试麦克风输入</button>
    <span id="shengwangTurnState" class="pill neutral">对话链未测试</span>
  `;
  bar.appendChild(host);

  const llmBtn = host.querySelector('#shengwangLlmTestBtn');
  const micBtn = host.querySelector('#shengwangMicTestBtn');
  const pill = host.querySelector('#shengwangTurnState');

  const setState = (text, kind='neutral') => {
    pill.textContent = text;
    pill.className = `pill ${kind}`;
  };

  const postControl = async (payload) => {
    const r = await fetch('/api/shengwang_control', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload),
    });
    const text = await r.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    if (!r.ok) throw new Error(data.detail || text || `HTTP ${r.status}`);
    return data;
  };

  llmBtn.addEventListener('click', async () => {
    const voice = window.LabSightShengwangVoice;
    const session = voice?.session;
    if (!voice?.active || !session?.agent_id) {
      setState('请先启动声网对话', 'warn');
      if (els.recordingState) els.recordingState.textContent = '先启动“声网实时语音”，再测试 LLM 链路。';
      return;
    }
    llmBtn.disabled = true;
    setState('正在注入 LLM 测试…', 'warn');
    if (els.recordingState) els.recordingState.textContent = '正在绕过 ASR，直接把测试文本注入声网 Agent。若能听到回答，则 LLM+TTS 正常，问题只剩麦克风/ASR。';
    try {
      await postControl({
        action:'think',
        agent_id:session.agent_id,
        text:'这是 LabSight 链路自检。请只回答一句：声网 LLM 链路正常。不要补充其它内容。',
      });
      setState('LLM 指令已送达', 'ok');
      if (els.recordingState) els.recordingState.textContent = '✅ 测试文本已送入声网 Agent。若现在听到“声网 LLM 链路正常”，说明 LLM→Gemini TTS→RTC 全部正常。';
    } catch (e) {
      setState('LLM 链路失败', 'warn');
      if (els.recordingState) els.recordingState.textContent = `❌ 声网 LLM 测试失败：${e.message}`;
    } finally {
      llmBtn.disabled = false;
    }
  });

  micBtn.addEventListener('click', async () => {
    micBtn.disabled = true;
    setState('正在测麦克风…', 'warn');
    let stream = null;
    let ctx = null;
    try {
      const deviceId = els.micSelect?.value || '';
      stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? {deviceId:{exact:deviceId}, echoCancellation:true, noiseSuppression:true, autoGainControl:true} : true,
        video:false,
      });
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      ctx = new AudioCtx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      let peak = 0;
      const end = performance.now() + 2200;
      while (performance.now() < end) {
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i=0;i<data.length;i++) sum += data[i]*data[i];
        peak = Math.max(peak, Math.sqrt(sum/data.length));
        await new Promise(r=>setTimeout(r,80));
      }
      const percent = Math.round(Math.min(1, peak * 8) * 100);
      if (peak < 0.006) {
        setState(`麦克风太弱 ${percent}%`, 'warn');
        if (els.recordingState) els.recordingState.textContent = `⚠️ 浏览器能打开麦克风，但 2 秒内输入电平很低（RMS peak ${peak.toFixed(4)}）。请确认选对麦克风并对着它说话。`;
      } else {
        setState(`麦克风正常 ${percent}%`, 'ok');
        if (els.recordingState) els.recordingState.textContent = `✅ 浏览器麦克风输入正常（RMS peak ${peak.toFixed(4)}）。若声网仍不响应，下一步重点查凤鸣 ASR/turn detection。`;
      }
    } catch (e) {
      setState('麦克风测试失败', 'warn');
      if (els.recordingState) els.recordingState.textContent = `❌ 麦克风测试失败：${e.message}`;
    } finally {
      try { stream?.getTracks().forEach(t=>t.stop()); } catch {}
      try { await ctx?.close(); } catch {}
      micBtn.disabled = false;
    }
  });
})();
