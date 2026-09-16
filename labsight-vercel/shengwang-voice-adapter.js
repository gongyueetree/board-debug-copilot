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
  let activeTtsTarget = 'voice';
  let activeTtsVendor = 'generic_http';

  const bar = document.querySelector('.wakebar');
  if (!bar) return;

  const wrap = document.createElement('div');
  wrap.className = 'agora-mode-wrap';
  wrap.innerHTML = `
    <label class="agora-mode-label">语音模式</label>
    <select id="voiceModeSelect" class="agora-mode-select" aria-label="语音模式">
      <option value="legacy">普通语音</option>
      <option value="shengwang">声网实时语音 · A6</option>
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

  const voiceHealth = () => state.health?.shengwang || state.health?.agora || {};
  const configured = () => voiceHealth()?.configured !== false;
  const missing = () => voiceHealth()?.missing || [];
  const configuredTtsVendor = () => voiceHealth()?.tts_vendor || 'generic_http';
  const ttsLabel = (vendor=activeTtsVendor) => vendor === 'minimax' ? 'MiniMax TTS' : 'Gemini TTS';
  const projectId = () => {
    try {
      const q = new URLSearchParams(window.location.search);
      return (
        q.get('projectId') ||
        q.get('project_id') ||
        window.LABSIGHT_PROJECT_ID ||
        state.projectId ||
        state.projectContext?.projectId ||
        state.projectContext?.id ||
        localStorage.getItem('labsight-project-id') ||
        ''
      ).trim();
    } catch {
      return String(window.LABSIGHT_PROJECT_ID || '').trim();
    }
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
    else if (realtime && !projectId()) setState('缺少 Project Context', 'warn');
    else if (!active && !starting) setState('声网待机 · A6', 'neutral');
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
        project_id: projectId() || null,
        ...extra,
      }),
      keepalive: action === 'stop',
    });
    return readJsonResponse(r);
  };

  const checkGenericTtsBridge = async () => {
    if (configuredTtsVendor() === 'minimax') return {ok:true, configured:true};
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
      setState('已打断 · A6 正在聆听', 'ok');
      if (els.recordingState) els.recordingState.textContent = '🎙 已停止当前回答，你可以继续说';
    } catch (e) {
      if (!silent) {
        console.warn('声网打断失败:', e);
        if (els.recordingState) els.recordingState.textContent = `打断失败：${e.message}`;
      }
    }
  };

  const stop = async (userInitiated=true) => {
    if (!active && !starting && !session) return;
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
    if (userInitiated) {
      setState('声网已结束', 'neutral');
      if (els.recordingState) els.recordingState.textContent = '实时语音对话已结束';
    } else {
      setState('声网待机 · A6', 'neutral');
    }
  };

  const start = async () => {
    if (starting || active) return session;
    activeTtsTarget = 'voice';
    activeTtsVendor = configuredTtsVendor();
    const pid = projectId();

    if (!configured()) {
      const miss = missing();
      const msg = miss.length ? `缺少：${miss.join('、')}` : '请先配置声网环境变量';
      setState('声网未配置', 'warn');
      if (els.recordingState) els.recordingState.textContent = msg;
      addMessage('assistant', `声网实时语音尚未配置。${msg}`);
      throw new Error(msg);
    }
    if (!pid) {
      const msg = '声网实时语音必须绑定 ezPLM projectId，避免不同项目串上下文。';
      setState('缺少 Project Context', 'warn');
      if (els.recordingState) els.recordingState.textContent = msg;
      addMessage('assistant', msg);
      throw new Error(msg);
    }
    localStorage.setItem('labsight-project-id', pid);

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

    setState(`检查 ${ttsLabel()} / A6…`, 'warn');
    sessionBtn.disabled = true;
    if (els.recordingState) els.recordingState.textContent = `正在检查声网、${ttsLabel()} 与 A6 Project Context…`;

    try {
      const ttsHealth = await checkGenericTtsBridge();
      if (!ttsHealth?.ok || ttsHealth?.configured === false) {
        throw new Error('Gemini TTS Bridge 未就绪，请确认 GEMINI_API_KEY / Vercel Function');
      }

      setState('正在创建声网 A6 会话…', 'warn');
      session = await api('start', {tts_target:'gemini', project_id:pid});
      if (!session?.agent_id) throw new Error('声网未返回 agent_id');
      if (session.brain !== 'A6') throw new Error('语音会话没有绑定 A6 单一大脑');
      if (String(session.project_id || '') !== pid) throw new Error('声网返回的 projectId 与当前项目不一致');
      if (session.agent_status && !['RUNNING', 'STARTING'].includes(session.agent_status)) {
        throw new Error(`声网智能体状态异常：${session.agent_status}`);
      }
      activeTtsVendor = session.tts?.vendor || activeTtsVendor;

      client = RTC.createClient({mode:'rtc', codec:'vp8'});

      client.on('user-joined', (user) => {
        agentJoinedRtc = true;
        agentJoinedUid = user.uid;
        setState('A6 已入 RTC 频道', 'ok');
        if (els.recordingState) {
          els.recordingState.textContent = `✅ A6 已进入 RTC 频道（uid ${user.uid}），正在等待 ${ttsLabel()} 音频…`;
        }
      });

      client.on('user-left', (user, reason) => {
        if (String(user.uid) === String(agentJoinedUid)) {
          agentJoinedRtc = false;
          setState('A6 已离开 RTC', 'warn');
          if (els.recordingState) els.recordingState.textContent = `⚠️ A6 已离开 RTC（${reason || 'unknown'}）`;
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
            setState('A6 正在回答', 'ok');
            interruptBtn.classList.remove('hidden');
            if (els.recordingState) {
              els.recordingState.textContent = `🔊 A6 → ${ttsLabel()} 音轨已到达 · 可直接插话，或点击“打断当前回答”`;
            }
          }
        } catch (e) {
          console.warn('声网订阅音频失败:', e);
          setState('订阅 AI 音频失败', 'warn');
          if (els.recordingState) els.recordingState.textContent = `订阅 AI 音频失败：${e.message}`;
        }
      });

      client.on('user-unpublished', (_user, mediaType) => {
        if (mediaType === 'audio' && active) {
          setState('A6 正在聆听', 'ok');
          if (els.recordingState) els.recordingState.textContent = '🎙 A6 正在聆听';
        }
      });

      client.on('connection-state-change', (cur) => {
        if (!active && cur !== 'CONNECTED') return;
        if (cur === 'CONNECTED') setState('声网已连接 · A6', 'ok');
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
      setState('正在验证 A6 音频…', 'warn');
      if (els.recordingState) {
        const td = session.turn_detection || {};
        els.recordingState.textContent = `🎙 A6 已绑定项目 ${pid} · ${ttsLabel()} · SoS ${td.sos_mode || '?'} ${td.sos_ms || '?'}ms / speaking ${td.speaking_sos_ms || '?'}ms`;
      }

      await api('speak', {text:'LabSight A6 实时语音连接成功。你可以开始说话。'});

      audioWatchdog = setTimeout(() => {
        if (!active || receivedAgentAudio) return;
        setState('A6 音频未到达', 'warn');
        const msg = !agentJoinedRtc
          ? '⚠️ 浏览器已进入 RTC，但没有观察到 A6 Agent 加入频道。请检查 Agent RTC token / 任务状态。'
          : `⚠️ A6 已进入 RTC，但 ${ttsLabel()} 没有形成音轨。请检查声网任务日志与对应 TTS 配置。`;
        if (els.recordingState) els.recordingState.textContent = msg;
      }, 15000);

      return session;
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
      throw e;
    } finally {
      sessionBtn.disabled = false;
    }
  };

  const toggle = () => active || starting ? stop(true) : start().catch(()=>{});

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
          JSON.stringify({action:'stop', agent_id:session.agent_id, channel:session.channel, project_id:projectId() || null})
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
    get projectId(){ return projectId(); },
    get brain(){ return session?.brain || 'A6'; },
    get ttsTarget(){ return activeTtsTarget; },
    get ttsVendor(){ return activeTtsVendor; },
  };

  modeSelect.value = localStorage.getItem('labsight-voice-mode') === 'shengwang' ? 'shengwang' : 'legacy';
  applyUi();
  setTimeout(applyUi, 800);
  setTimeout(applyUi, 2000);
})();
