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
  let receivedAgentAudio = false;
  let agentJoinedRtc = false;
  let agentJoinedUid = null;
  let audioWatchdog = null;

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

  const clearWatchdog = () => {
    if (audioWatchdog) clearTimeout(audioWatchdog);
    audioWatchdog = null;
  };

  const leaveRtc = async () => {
    clearWatchdog();
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

  const api = async (action, extra={}) => {
    const r = await fetch('/api/shengwang_session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        action,
        agent_id: session?.agent_id || null,
        channel: session?.channel || null,
        provider: state.provider,
        ...extra,
      }),
      keepalive: action === 'stop',
    });
    return readJsonResponse(r);
  };

  const readTtsBridgeState = async () => {
    try {
      const r = await fetch('/api/gemini_tts_openai', {cache:'no-store'});
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
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
    receivedAgentAudio = false;
    agentJoinedRtc = false;
    agentJoinedUid = null;
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
    receivedAgentAudio = false;
    agentJoinedRtc = false;
    agentJoinedUid = null;
    state.listeningSuspended = true;
    try { stopWakeListening(); } catch {}
    try { window.cancelLabSightSpeech?.(false); } catch {}
    if (els.autoSpeak) {
      savedAutoSpeak = els.autoSpeak.checked;
      els.autoSpeak.checked = false;
      els.autoSpeak.disabled = true;
    }

    setState('检查 TTS Bridge…', 'warn');
    sessionBtn.disabled = true;
    if (els.recordingState) els.recordingState.textContent = '正在检查 Gemini TTS Bridge 与声网配置…';

    try {
      const ttsHealth = await readTtsBridgeState();
      if (!ttsHealth?.ok || ttsHealth?.configured === false) {
        throw new Error('Gemini TTS Bridge 未就绪，请先确认 GEMINI_API_KEY / Vercel Function');
      }

      setState('正在创建声网智能体…', 'warn');
      session = await api('start');
      if (!session?.agent_id) throw new Error('声网未返回 agent_id');
      if (session.agent_status && !['RUNNING', 'STARTING'].includes(session.agent_status)) {
        throw new Error(`声网智能体状态异常：${session.agent_status}`);
      }

      client = RTC.createClient({mode:'rtc', codec:'vp8'});

      client.on('user-joined', (user) => {
        agentJoinedRtc = true;
        agentJoinedUid = user.uid;
        setState('AI 已入 RTC 频道', 'ok');
        if (els.recordingState) {
          els.recordingState.textContent = `✅ 声网 Agent 已进入 RTC 频道（uid ${user.uid}），正在等待 AI 音频…`;
        }
      });

      client.on('user-left', (user, reason) => {
        if (String(user.uid) === String(agentJoinedUid)) {
          agentJoinedRtc = false;
          setState('AI 已离开 RTC', 'warn');
          if (els.recordingState) els.recordingState.textContent = `⚠️ 声网 Agent 已离开 RTC（${reason || 'unknown'}）`;
        }
      });

      client.on('user-published', async (user, mediaType) => {
        try {
          await client.subscribe(user, mediaType);
          if (mediaType === 'audio') {
            agentJoinedRtc = true;
            agentJoinedUid = user.uid;
            receivedAgentAudio = true;
            clearWatchdog();
            user.audioTrack?.play();
            setState('AI 正在回答', 'ok');
            interruptBtn.classList.remove('hidden');
            if (els.recordingState) els.recordingState.textContent = '🔊 AI 音轨已到达 · 可直接插话，或点击“打断当前回答”';
          }
        } catch (e) {
          console.warn('声网订阅音频失败:', e);
          setState('订阅 AI 音频失败', 'warn');
          if (els.recordingState) els.recordingState.textContent = `订阅 AI 音频失败：${e.message}`;
        }
      });

      client.on('user-unpublished', (_user, mediaType) => {
        if (mediaType === 'audio' && active) {
          setState('正在聆听', 'ok');
          if (els.recordingState) els.recordingState.textContent = '🎙 正在聆听 · 正常说完即可，语义判停会自动判断';
        }
      });

      client.on('connection-state-change', (cur) => {
        if (!active && cur !== 'CONNECTED') return;
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
      setState('正在验证 AI 音频…', 'warn');
      if (els.recordingState) els.recordingState.textContent = `🎙 浏览器已加入 RTC · Agent ${session.agent_status || 'RUNNING'} · 正在触发自定义播报`; 

      try {
        await api('speak', {text:'LabSight 实时语音连接成功。你可以开始说话。'});
      } catch (e) {
        throw new Error(`AI 语音链路自检失败：${e.message}`);
      }

      audioWatchdog = setTimeout(async () => {
        if (!active || receivedAgentAudio) return;
        const tts = await readTtsBridgeState();
        const last = tts?.last_request || null;
        const freshTtsCall = Number.isFinite(last?.age_seconds) && last.age_seconds < 25;
        setState('AI 音频未到达', 'warn');

        let msg;
        if (!agentJoinedRtc) {
          msg = '⚠️ 浏览器已进入 RTC，但没有观察到声网 Agent 加入频道。优先检查 agent_rtc_uid / Agent RTC token / 声网任务状态。';
        } else if (!freshTtsCall) {
          msg = '⚠️ 声网 Agent 已进入 RTC，但 Gemini TTS Bridge 在本轮没有收到声网侧 HTTP 请求。高度怀疑声网云到当前 Vercel TTS URL 不可达，或 GenericTTS URL/headers 未被任务采用。';
        } else if (last?.status === 'error') {
          msg = `⚠️ 声网已调用 Gemini TTS Bridge，但 TTS 生成失败（${last.latency_ms ?? '?'}ms）。请点“测试 Gemini TTS”查看上游错误。`;
        } else if (last?.status === 'ok') {
          msg = `⚠️ 声网已调用 TTS，Bridge 已返回 PCM（${last.bytes ? Math.round(last.bytes/1024) + 'KB' : '已返回'}，${last.latency_ms ?? '?'}ms），但 RTC 未收到 AI 音轨。此时问题位于声网 GenericTTS 解码/发布音频这一段。`;
        } else {
          msg = '⚠️ 声网 Agent 已进入 RTC，但仍未收到 AI 音轨；请检查 TTS Bridge 与声网 Agent 日志。';
        }
        if (els.recordingState) els.recordingState.textContent = msg;
        console.warn('Shengwang audio watchdog', {agentJoinedRtc, agentJoinedUid, tts});
      }, 18000);
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
