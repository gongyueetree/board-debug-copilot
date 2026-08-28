(() => {
  const toolbar = document.querySelector('.camera-toolbar');
  if (!toolbar || !navigator.mediaDevices) return;

  const outputSelect = document.createElement('select');
  outputSelect.id = 'audioOutputSelect';
  outputSelect.setAttribute('aria-label', '音频输出设备');
  outputSelect.title = 'AI 语音输出设备';

  const testBtn = document.createElement('button');
  testBtn.id = 'testAudioOutput';
  testBtn.className = 'secondary';
  testBtn.textContent = '测试声音';
  testBtn.title = '播放测试音确认输出设备';

  const mic = document.getElementById('micSelect');
  if (mic?.nextSibling) toolbar.insertBefore(outputSelect, mic.nextSibling);
  else toolbar.appendChild(outputSelect);
  toolbar.insertBefore(testBtn, document.getElementById('refreshDevices'));

  let selectedId = localStorage.getItem('labsight-audio-output') || 'default';

  async function refreshOutputs() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter(d => d.kind === 'audiooutput');
      outputSelect.innerHTML = '';
      if (!outputs.length) {
        outputSelect.add(new Option('系统默认扬声器', 'default'));
        outputSelect.disabled = true;
        return;
      }
      outputs.forEach((d, i) => outputSelect.add(new Option(d.label || `音频输出 ${i + 1}`, d.deviceId)));
      if (![...outputSelect.options].some(o => o.value === selectedId)) selectedId = outputs[0]?.deviceId || 'default';
      outputSelect.value = selectedId;
      outputSelect.disabled = false;
    } catch (e) {
      console.warn('audio outputs:', e);
      outputSelect.innerHTML = '';
      outputSelect.add(new Option('系统默认扬声器', 'default'));
      outputSelect.disabled = true;
    }
  }

  async function applyToElement(mediaEl) {
    const id = selectedId || 'default';
    if (mediaEl?.setSinkId && id) {
      try { await mediaEl.setSinkId(id); }
      catch (e) { console.warn('setSinkId media:', e); }
    }
    return mediaEl;
  }

  async function applyToAudioContext(ctx) {
    const id = selectedId || 'default';
    if (ctx?.setSinkId && id) {
      try { await ctx.setSinkId(id); }
      catch (e) { console.warn('setSinkId context:', e); }
    }
    return ctx;
  }

  // All cloud-TTS fallbacks in LabSight ultimately call HTMLMediaElement.play().
  // Route them through the chosen sink without every voice adapter having to know about the selector.
  const nativePlay = HTMLMediaElement.prototype.play;
  if (!HTMLMediaElement.prototype.__labsightSinkWrapped) {
    Object.defineProperty(HTMLMediaElement.prototype, '__labsightSinkWrapped', { value: true });
    HTMLMediaElement.prototype.play = async function(...args) {
      await applyToElement(this);
      return nativePlay.apply(this, args);
    };
  }

  async function testTone() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) throw new Error('浏览器不支持 Web Audio');
      const ctx = new AudioCtx();
      await applyToAudioContext(ctx);
      if (ctx.state === 'suspended') await ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 660;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.42);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.45);
      testBtn.textContent = '正在播放…';
      setTimeout(async () => { testBtn.textContent = '测试声音'; try { await ctx.close(); } catch {} }, 650);
    } catch (e) {
      alert(`无法播放测试音：${e.message}`);
      testBtn.textContent = '测试声音';
    }
  }

  outputSelect.addEventListener('change', () => {
    selectedId = outputSelect.value || 'default';
    localStorage.setItem('labsight-audio-output', selectedId);
  });
  testBtn.addEventListener('click', testTone);
  navigator.mediaDevices.addEventListener?.('devicechange', refreshOutputs);

  window.LabSightAudioOutput = {
    refreshOutputs,
    applyToElement,
    applyToAudioContext,
    get deviceId() { return selectedId; },
    get label() { return outputSelect.selectedOptions?.[0]?.textContent || '系统默认扬声器'; }
  };

  refreshOutputs();
})();
