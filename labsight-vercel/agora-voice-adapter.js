(() => {
  const Agora = window.AgoraRTC;
  if (!Agora) {
    console.warn('AgoraRTC SDK 未加载，EVT0.8 Agora Voice Adapter 不可用');
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

  const modeWrap = document.createElement('div');
  modeWrap.className = 'agora-mode-wrap';
  modeWrap.innerHTML = `
    <label class="agora-mode-label">语音模式</label>
    <select id="voiceModeSelect" class="agora-mode-select" aria-label="语音模式">
      <option value="legacy">Legacy Voice</option>
      <option value="agora">Agora 实时语音</option>
    </select>
    <button id="agoraSessionBtn" class="secondary agora-session-btn" type="button">启动 Agora 对话</button>
    <span id="agoraState" class="pill neutral">Agora 待机</span>
  `;
  bar.appendChild(modeWrap);

  const modeSelect = document.getElementById('voiceModeSelect');
  const sessionBtn = document.getElementById('agoraSessionBtn');
  const agoraState = document.getElementById('agoraState');

  const setAgoraState = (text, kind='neutral') => {
    agoraState.textContent = text;
    agoraState.className = `pill ${kind}`;
  };

  const applyModeUi = () => {
    const agoraMode = modeSelect.value === 'agora';
    sessionBtn.classList.toggle('hidden', !agoraMode);
    if (els.wakeToggle) {
      els.wakeToggle.disabled = agoraMode;
      if (agoraMode && els.wakeToggle.checked) {
        els.wakeToggle.checked = false;
        try { stopWakeListening(); } catch {}
        setPill(els.wakeState, '自动唤醒 OFF', 'neutral');
      }
    }
    const span = els.voiceBtn?.querySelector('span');
    if (span && !active) span.textContent = agoraMode ? '启动实时对话' : '语音提问';
    if (agoraMode && state.health?.agora?.configured === false) {
      setAgoraState('Agora 未配置', 'warn');
    } else if (!active && !starting) {
      setAgoraState('Agora 待机', 'neutral');
    }
    localStorage.setItem('labsight-voice-mode', modeSelect.value);
  };

  const stopRemoteAudio = () => {
    try { window.cancelLabSightSpeech?.(false); } catch {}
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

  const stopAgora = async (userInitiated=true) => {
    if (!active && !starting) return;
    starting = false;
    const current = session;
    active = false;
    stopRemoteAudio();
    await leaveRtc();
    if (current?.agent_id) {
      try {
        await fetch('/api/agora_session', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({action:'stop', agent_id:current.agent_id, channel:current.channel}),
          keepalive: true,
        });
      } catch (e) {
        console.warn('停止 Agora Agent 失败:', e);
      }
    }
    session = null;
    state.listeningSuspended = false;
    restoreLegacyAudio();
    sessionBtn.textContent = '启动 Agora 对话';
    els.voiceBtn?.classList.remove('speaking', 'recording', 'agora-live');
    const span = els.voiceBtn?.querySelector('span');
    if (span) span.textContent = '启动实时对话';
    setAgoraState(userInitiated ? 'Agora 已结束' : 'Agora 待机', 'neutral');
    if (els.recordingState) els.recordingState.textContent = userInitiated ? '实时语音对话已结束' : '';
  };

  const startAgora = async () => {
    if (starting || active) return;
    if (state.health?.agora?.configured === false) {
      const missing = state.health.agora.missing || [];
      const msg = missing.length ? `缺少：${missing.join('、')}` : '请先配置 Agora 凭据';
      setAgoraState('Agora 未配置', 'warn');
      if (els.recordingState) els.recordingState.textContent = msg;
      addMessage('assistant', `Agora 实时语音尚未配置。${msg}`);
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
    setAgoraState('正在创建会话…', 'warn');
    sessionBtn.disabled = true;
    if (els.recordingState) els.recordingState.textContent = '正在启动 Agora 实时语音…';

    try {
      const r = await fetch('/api/agora_session', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'start', provider:state.provider}),
      });
      const d = await readJsonResponse(r);
      session = d;

      client = Agora.createClient({mode:'rtc', codec:'vp8'});
      client.on('user-published', async (user, mediaType) => {
        try {
          await client.subscribe(user, mediaType);
          if (mediaType === 'audio') {
            user.audioTrack?.play();
            setAgoraState('AI 正在说话', 'ok');
            if (els.recordingState) els.recordingState.textContent = '🔊 AI 正在回答 · 你可以直接插话打断';
          }
        } catch (e) {
          console.warn('Agora subscribe:', e);
        }
      });
      client.on('user-unpublished', (_user, mediaType) => {
        if (mediaType === 'audio' && active) {
          setAgoraState('正在聆听', 'ok');
          if (els.recordingState) els.recordingState.textContent = '🎙 正在聆听 · 说完即可，无需点击发送';
        }
      });
      client.on('connection-state-change', (cur) => {
        if (!active) return;
        if (cur === 'CONNECTED') setAgoraState('Agora 已连接', 'ok');
        else if (cur === 'RECONNECTING') setAgoraState('网络重连中…', 'warn');
        else if (cur === 'DISCONNECTED') setAgoraState('Agora 已断开', 'warn');
      });

      await client.join(d.app_id, d.channel, d.rtc_token, d.uid);
      const selectedMic = els.micSelect?.value || undefined;
      micTrack = await Agora.createMicrophoneAudioTrack({
        microphoneId: selectedMic,
        AEC: true,
        AGC: true,
        ANS: true,
        encoderConfig: 'speech_standard',
      });
      await client.publish([micTrack]);

      active = true;
      starting = false;
      sessionBtn.textContent = '结束 Agora 对话';
      els.voiceBtn?.classList.add('agora-live');
      const span = els.voiceBtn?.querySelector('span');
      if (span) span.textContent = '结束实时对话';
      setAgoraState('正在聆听', 'ok');
      if (els.recordingState) els.recordingState.textContent = '🎙 Agora 实时语音已启动 · 直接说话即可，可随时插话打断 AI';
      addMessage('assistant', `Agora 实时语音已启动。ASR：${d.asr?.model || '—'}；LLM：${d.llm?.model || '—'}；TTS：${d.tts?.model || '—'}。`);
    } catch (e) {
      console.error('Agora start:', e);
      await leaveRtc();
      session = null;
      active = false;
      starting = false;
      state.listeningSuspended = false;
      restoreLegacyAudio();
      setAgoraState('启动失败', 'warn');
      if (els.recordingState) els.recordingState.textContent = `Agora 启动失败：${e.message}`;
      addMessage('assistant', `Agora 实时语音启动失败：${e.message}`);
    } finally {
      sessionBtn.disabled = false;
    }
  };

  const toggleAgora = () => active || starting ? stopAgora(true) : startAgora();

  sessionBtn.addEventListener('click', toggleAgora);
  modeSelect.addEventListener('change', async () => {
    if (active || starting) await stopAgora(false);
    applyModeUi();
  });

  // Capture-phase interception lets the existing mic button become a hands-free
  // Agora session button without touching the legacy voice code.
  els.voiceBtn?.addEventListener('click', (e) => {
    if (modeSelect.value !== 'agora') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toggleAgora();
  }, true);

  window.addEventListener('beforeunload', () => {
    try { micTrack?.close(); } catch {}
    try { client?.leave(); } catch {}
    if (session?.agent_id) {
      try {
        navigator.sendBeacon?.('/api/agora_session', new Blob([
          JSON.stringify({action:'stop', agent_id:session.agent_id, channel:session.channel})
        ], {type:'application/json'}));
      } catch {}
    }
  });

  // Health loads asynchronously in app.js; refresh the status once it is likely available.
  setTimeout(applyModeUi, 800);
  setTimeout(applyModeUi, 2000);
  modeSelect.value = localStorage.getItem('labsight-voice-mode') || 'legacy';
  applyModeUi();
})();
