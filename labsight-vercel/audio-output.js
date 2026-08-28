(() => {
  const toolbar = document.querySelector('.camera-toolbar');
  if (!toolbar || !navigator.mediaDevices) return;

  const outputSelect = document.createElement('select');
  outputSelect.id = 'audioOutputSelect';
  outputSelect.setAttribute('aria-label', '音频输出设备');
  outputSelect.title = 'AI 语音输出设备';

  const mic = document.getElementById('micSelect');
  if (mic?.nextSibling) toolbar.insertBefore(outputSelect, mic.nextSibling);
  else toolbar.appendChild(outputSelect);

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

  // Route cloud TTS playback through the selected output device without
  // coupling the voice adapters to audio-output selection logic.
  const nativePlay = HTMLMediaElement.prototype.play;
  if (!HTMLMediaElement.prototype.__labsightSinkWrapped) {
    Object.defineProperty(HTMLMediaElement.prototype, '__labsightSinkWrapped', { value: true });
    HTMLMediaElement.prototype.play = async function(...args) {
      await applyToElement(this);
      return nativePlay.apply(this, args);
    };
  }

  outputSelect.addEventListener('change', () => {
    selectedId = outputSelect.value || 'default';
    localStorage.setItem('labsight-audio-output', selectedId);
  });
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
