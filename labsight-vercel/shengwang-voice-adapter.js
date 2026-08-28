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
  let activeTtsTarget = 'gemini';
  let diagnosticWaiter = null;

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

  const settleDiagnostic = (result, isError=false) => {
    if (!diagnosticWaiter) return;
    const waiter = diagnosticWaiter;
    diagnosticWaiter = null;
    if (isError) waiter.reject(result instanceof Error ? result : new Error(String(result)));
    else waiter.resolve(result);
  };

  const waitForAudio = (timeoutMs=15000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (diagnosticWaiter) diagnosticWaiter = null;
      reject(new Error('等待声网 AI 音轨超时'));
    }, timeoutMs);
    diagnosticWaiter = {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    };
  });

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

  const endpointHealth = async (target) => {
    const url = target === 'probe' ? '/api/tts_probe' : '/api/gemini_tts_openai';
    try {
      const r = await fetch(url, {cache:'no-store'});
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
      setState('声网待机', 'neutral');
    }
  };

  const start = async (options={}) => {
    if (starting || active) return session;
    const ttsTarget = options.ttsTarget === 'probe' ? 'probe' : 'gemini';
    activeTtsTarget = ttsTarget;

    if (!configured()) {
      const miss = missing();
      const msg = miss.length ? `缺少：${miss.join('、')}` : '请先配置声网环境变量';
      setState('声网未配置', 'warn');
      if (els.recordingState) els.recordingState.textContent = msg;
      if (!options.quiet) addMessage('assistant', `声网实时语音尚未配置。${msg}`);
      throw new Error(msg);
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

    setState(ttsTarget === 'probe' ? '检查 GenericTTS Probe…' : '检查 Gemini TTS Bridge…', 'warn');
    sessionBtn.disabled = true;
    if (els.recordingState) els.recordingState.textContent = ttsTarget === 'probe'
      ? '正在启动声网 → 固定 PCM Probe 诊断…'
      : '正在检查 Gemini TTS Bridge 与声网配置…';

    try {
      const ttsHealth = await endpointHealth(ttsTarget);
      if (!ttsHealth?.ok || (ttsTarget === 'gemini' && ttsHealth?.configured === false)) {
        throw new Error(ttsTarget === 'probe'
          ? 'GenericTTS Probe endpoint 未就绪'
          : 'Gemini TTS Bridge 未就绪，请先确认 GEMINI_API_KEY / Vercel Function');
      }

      setState('正在创建声网智能体…', 'warn');
      session = await api('start', {tts_target: ttsTarget});
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
          els.recordingState.textContent = `✅ 声网 Agent 已进入 RTC 频道（uid ${user.uid}），正在等待 ${activeTtsTarget === 'probe' ? 'Probe' : 'Gemini'} 音频…`;
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
            const label = activeTtsTarget === 'probe' ? 'Probe 音轨已到达' : 'AI 正在回答';
            setState(label, 'ok');
            interruptBtn.classList.remove('hidden');
            if (els.recordingState) {
              els.recordingState.textContent = activeTtsTarget === 'probe'
                ? '✅ 声网 GenericTTS Probe 成功：固定 PCM 已经通过声网发布为 RTC 音轨。'
                : '🔊 AI 音轨已到达 · 可直接插话，或点击“打断当前回答”';
            }
            settleDiagnostic({target:activeTtsTarget, audio:true, uid:user.uid});
          }
        } catch (e) {
          console.warn('声网订阅音频失败:', e);
          setState('订阅 AI 音频失败', 'warn');
          if (els.recordingState) els.recordingState.textContent = `订阅 AI 音频失败：${e.message}`;
          settleDiagnostic(e, true);
        }
      });

      client.on('user-unpublished', (_user, mediaType) => {
        if (mediaType === 'audio' && active) {
          setState('正在聆听', 'ok');
          if (els.recordingState && activeTtsTarget !== 'probe') {
            els.recordingState.textContent = '🎙 正在聆听 · 正常说完即可，语义判停会自动判断';
          }
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
      setState(ttsTarget === 'probe' ? '正在触发 Probe…' : '正在验证 AI 音频…', 'warn');
      if (els.recordingState) els.recordingState.textContent = `🎙 浏览器已加入 RTC · Agent ${session.agent_status || 'RUNNING'} · 正在触发 ${ttsTarget === 'probe' ? '固定 PCM Probe' : 'Gemini TTS'} 播报`;

      await api('speak', {text: ttsTarget === 'probe' ? 'probe' : 'LabSight 实时语音连接成功。你可以开始说话。'});

      audioWatchdog = setTimeout(() => {
        if (!active || receivedAgentAudio) return;
        setState('AI 音频未到达', 'warn');
        let msg;
        if (!agentJoinedRtc) {
          msg = '⚠️ 浏览器已进入 RTC，但没有观察到声网 Agent 加入频道。优先检查 agent_rtc_uid / Agent RTC token / 声网任务状态。';
        } else if (activeTtsTarget === 'probe') {
          msg = '⚠️ Agent 已进入 RTC，但固定 PCM Probe 也没有形成音轨。说明问题在 GenericTTS 配置被采用/声网云访问该 HTTP endpoint 这一层，尚未进入 Gemini。';
        } else {
          msg = '⚠️ Agent 已进入 RTC，但 Gemini TTS 没有形成音轨。请先运行“声网→Probe”诊断：若 Probe 成功，则问题锁定在 Gemini Bridge 协议/响应；若 Probe 也失败，则问题在 GenericTTS/网络。';
        }
        if (els.recordingState) els.recordingState.textContent = msg;
        settleDiagnostic(new Error(msg), true);
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
      if (!options.quiet) addMessage('assistant', `声网实时语音启动失败：${e.message}`);
      settleDiagnostic(e, true);
      throw e;
    } finally {
      sessionBtn.disabled = false;
    }
  };

  const diagnoseGenericTts = async () => {
    if (active || starting || session) await stop(false);
    modeSelect.value = 'shengwang';
    applyUi();
    const recording = els.recordingState;

    try {
      if (recording) recording.textContent = '① 正在测试：声网 GenericTTS → 固定 PCM Probe…';
      await start({ttsTarget:'probe', quiet:true});
      await waitForAudio(16000);
      await new Promise(r => setTimeout(r, 600));
      await stop(false);

      if (recording) recording.textContent = '✅ ① Probe 成功。GenericTTS 配置、声网云访问 Vercel、PCM→RTC 均已打通。② 正在测试 Gemini Bridge…';
      await start({ttsTarget:'gemini', quiet:true});
      await waitForAudio(18000);
      if (recording) recording.textContent = '✅ GenericTTS → Probe → Gemini 全链路通过。Gemini 可继续作为声网实时 TTS。';
      return {probe:true, gemini:true};
    } catch (e) {
      const failedTarget = activeTtsTarget;
      if (failedTarget === 'probe') {
        if (recording) recording.textContent = `❌ Probe 阶段失败：${e.message}。问题在 Gemini 之前，优先查声网 GenericTTS 配置/公网 URL 可达性。`;
        return {probe:false, gemini:false, error:e.message};
      }
      if (recording) recording.textContent = `❌ Probe 已通过，但 Gemini 阶段失败：${e.message}。这证明声网→Vercel 可达，问题锁定到 Gemini Bridge 的 OpenAI TTS 兼容请求/PCM 响应。`;
      return {probe:true, gemini:false, error:e.message};
    } finally {
      if (active || starting || session) await stop(false);
    }
  };

  const toggle = () => active || starting ? stop(true) : start({ttsTarget:'gemini'}).catch(()=>{});

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
    startProbe: () => start({ttsTarget:'probe'}),
    startGemini: () => start({ttsTarget:'gemini'}),
    diagnoseGenericTts,
    stop,
    interrupt,
    get active(){ return active; },
    get session(){ return session; },
    get ttsTarget(){ return activeTtsTarget; },
  };

  modeSelect.value = localStorage.getItem('labsight-voice-mode') === 'shengwang' ? 'shengwang' : 'legacy';
  applyUi();
  setTimeout(applyUi, 800);
  setTimeout(applyUi, 2000);
})();
