(() => {
  const RTC = window.AgoraRTC;
  if (!RTC) {
    console.warn('声网 RTC Web SDK 未加载，实时语音不可用');
    return;
  }

  let client = null;
  let micTrack = null;
  let session = null;
  let starting = false;
  let active = false;
  let savedAutoSpeak = null;

  const bar = document.querySelector('.wakebar');
  if (!bar) return;

  const wrap = document.createElement('div');
  wrap.className = 'agora-mode-wrap';
  wrap.innerHTML = `
    <label class="agora-mode-label">语音模式</label>
    <select id="voiceModeSelect" class="agora-mode-select" aria-label="语音模式">
      <option value="legacy">普通语音</option>
      <option value="shengwang">声网实时语音</option>
    </select>
    <button id="shengwangSessionBtn" class="secondary agora-session-btn" type="button">启动声网对话</button>
    <button id="shengwangInterruptBtn" class="secondary agora-session-btn hidden" type="button">打断当前回答</button>
    <span id="shengwangState" class="pill neutral">声网待机</span>
  `;
  bar.appendChild(wrap);

  const modeSelect = document.getElementById('voiceModeSelect');
  const sessionBtn = document.getElementById('shengwangSessionBtn');
  const interruptBtn = document.getElementById('shengwangInterruptBtn');
  const stateEl = document.getElementById('shengwangState');

  const setState = (text, kind='neutral') => {
    stateEl.textContent = text;
    stateEl.className = `pill ${kind}`;
  };

  const configured = () => {
    const h = state.health?.shengwang || state.health?.agora;
    return h?.configured !== false;
  };

  const missing = () => {
    const h = state.health?.shengwang || state.health?.agora;
    return h?.missing || [];
  };

  const applyUi = () => {
    const realtime = modeSelect.value === 'shengwang';
    sessionBtn.classList.toggle('hidden', !realtime);
    interruptBtn.classList.toggle('hidden', !realtime || !active);
    if (els.wakeToggle) {
      els.wakeToggle.disabled = realtime;
      if (realtime && els.wakeToggle.checked) {
        els.wakeToggle.checked = false;
        try { stopWakeListening(); } catch {}
        setPill(els.wakeState, '自动唤醒 OFF', 'neutral');
      }
    }
    const span = els.voiceBtn?.querySelector('span');
    if (span && !active) span.textContent = realtime ? '启动实时对话' : '语音提问';
    if (realtime && !configured()) setState('声网未配置', 'warn');
    else if (!active && !starting) setState('声网待机', 'neutral');
    localStorage.setItem('labsight-voice-mode', modeSelect.value);
  };

  const leaveRtc = async () => {
    try { micTrack?.stop(); } catch {}
    try { micTrack?.close(); } catch {}
    micTrack = null;
    try { await client?.leave(); } catch {}
    client = null;
  };

  const restoreLegacyAudio = () => {
    if (savedAutoSpeak !== null && els.autoSpeak) {
      els.autoSpeak.checked = savedAutoSpeak;
      els.autoSpeak.disabled = false;
    }
    savedAutoSpeak = null;
  };

  const api = async (action) => {
    const r = await fetch('/api/shengwang_session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        action,
        agent_id: session?.agent_id || null,
        channel: session?.channel || null,
        provider: state.provider,
      }),
      keepalive: action === 'stop',
    });
    return readJsonResponse(r);
  };

  const interrupt = async (silent=false) => {
    if (!session?.agent_id) return;
    try {
      await api('interrupt');
      setState('已打断 · 正在聆听', 'ok');
      if (els.recordingState) els.recordingState.textContent = '🎙 已停止当前回答，你可以继续说';
    } catch (e) {
      if (!silent) {
        console.warn('声网打断失败:', e);
        if (els.recordingState) els.recordingState.textContent = `打断失败：${e.message}`;
      }
    }
  };

  const stop = async (userInitiated=true) => {
    if (!active && !starting) return;
    const current = session;
    active = false;
    starting = false;
    try { window.cancelLabSightSpeech?.(false); } catch {}
    await leaveRtc();
    session = current;
    if (current?.agent_id) {
      try { await api('stop'); } catch (e) { console.warn('停止声网智能体失败:', e); }
    }
    session = null;
    state.listeningSuspended = false;
    restoreLegacyAudio();
    sessionBtn.textContent = '启动声网对话';
    interruptBtn.classList.add('hidden');
    els.voiceBtn?.classList.remove('speaking', 'recording', 'agora-live');
    const span = els.voiceBtn?.querySelector('span');
    if (span) span.textContent = '启动实时对话';
    setState(userInitiated ? '声网已结束' : '声网待机', 'neutral');
    if (els.recordingState) els.recordingState.textContent = userInitiated ? '实时语音对话已结束' : '';
  };

  const start = async () => {
    if (starting || active) return;
    if (!configured()) {
      const miss = missing();
      const msg = miss.length ? `缺少：${miss.join('、')}` : '请先配置声网环境变量';
      setState('声网未配置', 'warn');
      if (els.recordingState) els.recordingState.textContent = msg;
      addMessage('assistant', `声网实时语音尚未配置。${msg}`);
      return;
    }

    starting = true;
    state.listeningSuspended = true;
    try { stopWakeListening(); } catch {}
    try { window.cancelLabSightSpeech?.(false); } catch {}
    if (els.autoSpeak) {
      savedAutoSpeak = els.autoSpeak.checked;
      els.autoSpeak.checked = false;
      els.autoSpeak.disabled = true;
    }

    setState('正在创建声网智能体…', 'warn');
    sessionBtn.disabled = true;
    if (els.recordingState) els.recordingState.textContent = '正在启动声网实时语音…';

    try {
      session = await api('start');
      client = RTC.createClient({mode:'rtc', codec:'vp8'});

      client.on('user-published', async (user, mediaType) => {
        try {
          await client.subscribe(user, mediaType);
          if (mediaType === 'audio') {
            user.audioTrack?.play();
            setState('AI 正在回答', 'ok');
            interruptBtn.classList.remove('hidden');
            if (els.recordingState) els.recordingState.textContent = '🔊 AI 正在回答 · 可直接插话，或点击“打断当前回答”';
          }
        } catch (e) {
          console.warn('声网订阅音频失败:', e);
        }
      });

      client.on('user-unpublished', (_user, mediaType) => {
        if (mediaType === 'audio' && active) {
          setState('正在聆听', 'ok');
          if (els.recordingState) els.recordingState.textContent = '🎙 正在聆听 · 正常说完即可，语义判停会自动判断';
        }
      });

      client.on('connection-state-change', (cur) => {
        if (!active) return;
        if (cur === 'CONNECTED') setState('声网已连接', 'ok');
        else if (cur === 'RECONNECTING') setState('网络重连中…', 'warn');
        else if (cur === 'DISCONNECTED') setState('声网已断开', 'warn');
      });

      await client.join(session.app_id, session.channel, session.rtc_token, session.uid);
      const selectedMic = els.micSelect?.value || undefined;
      micTrack = await RTC.createMicrophoneAudioTrack({
        microphoneId: selectedMic,
        AEC: true,
        AGC: true,
        ANS: true,
        encoderConfig: 'speech_standard',
      });
      await client.publish([micTrack]);

      active = true;
      starting = false;
      sessionBtn.textContent = '结束声网对话';
      interruptBtn.classList.remove('hidden');
      els.voiceBtn?.classList.add('agora-live');
      const span = els.voiceBtn?.querySelector('span');
      if (span) span.textContent = '结束实时对话';
      setState('正在聆听', 'ok');
      if (els.recordingState) {
        const td = session.turn_detection || {};
        els.recordingState.textContent = `🎙 声网实时语音已启动 · 语义判停 ${td.silence_ms || 240}ms · 可直接插话打断 AI`;
      }
    } catch (e) {
      console.error('声网启动失败:', e);
      await leaveRtc();
      session = null;
      active = false;
      starting = false;
      state.listeningSuspended = false;
      restoreLegacyAudio();
      setState('启动失败', 'warn');
      if (els.recordingState) els.recordingState.textContent = `声网启动失败：${e.message}`;
      addMessage('assistant', `声网实时语音启动失败：${e.message}`);
    } finally {
      sessionBtn.disabled = false;
    }
  };

  const toggle = () => active || starting ? stop(true) : start();

  sessionBtn.addEventListener('click', toggle);
  interruptBtn.addEventListener('click', () => interrupt(false));

  modeSelect.addEventListener('change', async () => {
    if (active || starting) await stop(false);
    applyUi();
  });

  els.voiceBtn?.addEventListener('click', (e) => {
    if (modeSelect.value !== 'shengwang') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toggle();
  }, true);

  window.addEventListener('beforeunload', () => {
    try { micTrack?.close(); } catch {}
    try { client?.leave(); } catch {}
    if (session?.agent_id) {
      try {
        navigator.sendBeacon?.('/api/shengwang_session', new Blob([
          JSON.stringify({action:'stop', agent_id:session.agent_id, channel:session.channel})
        ], {type:'application/json'}));
      } catch {}
    }
  });

  window.LabSightShengwangVoice = {
    start,
    stop,
    interrupt,
    get active(){ return active; },
    get session(){ return session; },
  };

  modeSelect.value = localStorage.getItem('labsight-voice-mode') === 'shengwang' ? 'shengwang' : 'legacy';
  applyUi();
  setTimeout(applyUi, 800);
  setTimeout(applyUi, 2000);
})();
