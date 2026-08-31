(() => {
  // IMX415 / generic 8MP motorized UVC profile.
  // The camera already works through the existing generic UVC adapter; this file
  // adds a product profile, capability readout, and standard UVC zoom/focus controls
  // when the browser exposes those controls through MediaTrackCapabilities.
  const sourceSelect = document.getElementById('cameraSourceSelect');
  const cameraSelect = document.getElementById('cameraSelect');
  const toolbar = document.querySelector('.camera-toolbar');
  if (!sourceSelect || !cameraSelect || !toolbar) return;

  if (![...sourceSelect.options].some(o => o.value === 'imx415')) {
    sourceSelect.add(new Option('IMX415 8MP UVC（变焦/自动对焦）', 'imx415'), 1);
  }

  const panel = document.createElement('div');
  panel.id = 'imx415Panel';
  panel.className = 'camera-adapter-panel';
  panel.innerHTML = `
    <div class="camera-adapter-help">
      <span id="imx415State" class="bridge-state">IMX415 8MP · USB2.0 UVC · 目标 3840×2160</span>
      <span>视频直接走浏览器 UVC；相机本体不要求音频，麦克风可继续单独选择 Insta360 / Mac / 其它 USB 麦克风。</span>
    </div>
    <label id="imx415ZoomWrap" style="display:none">光学/电动变焦
      <input id="imx415Zoom" type="range" step="0.01">
      <span id="imx415ZoomValue"></span>
    </label>
    <label id="imx415FocusWrap" style="display:none">手动焦距
      <input id="imx415Focus" type="range" step="0.01">
      <span id="imx415FocusValue"></span>
    </label>`;

  const recameraPanel = document.querySelector('.camera-adapter-panel');
  if (recameraPanel?.parentElement) recameraPanel.insertAdjacentElement('afterend', panel);
  else toolbar.insertAdjacentElement('afterend', panel);

  const stateEl = panel.querySelector('#imx415State');
  const zoomWrap = panel.querySelector('#imx415ZoomWrap');
  const zoomEl = panel.querySelector('#imx415Zoom');
  const zoomValue = panel.querySelector('#imx415ZoomValue');
  const focusWrap = panel.querySelector('#imx415FocusWrap');
  const focusEl = panel.querySelector('#imx415Focus');
  const focusValue = panel.querySelector('#imx415FocusValue');

  function selected() { return sourceSelect.value === 'imx415'; }
  function currentVideoTrack() { return state?.stream?.getVideoTracks?.()[0] || null; }
  function rangeFromCapability(input, cap, current, valueEl) {
    if (!cap || !Number.isFinite(cap.min) || !Number.isFinite(cap.max)) return false;
    input.min = String(cap.min);
    input.max = String(cap.max);
    input.step = String(cap.step || Math.max((cap.max - cap.min) / 100, 0.01));
    input.value = String(Number.isFinite(current) ? current : cap.min);
    valueEl.textContent = Number(input.value).toFixed(2);
    return true;
  }

  async function refreshCapabilities() {
    if (!selected()) { panel.classList.remove('show'); return; }
    panel.classList.add('show');
    const track = currentVideoTrack();
    if (!track) {
      stateEl.textContent = 'IMX415 8MP · 等待连接';
      stateEl.className = 'bridge-state';
      zoomWrap.style.display = 'none';
      focusWrap.style.display = 'none';
      return;
    }

    const settings = track.getSettings?.() || {};
    const caps = track.getCapabilities?.() || {};
    const width = settings.width || '?', height = settings.height || '?', fps = settings.frameRate ? Math.round(settings.frameRate) : '?';
    const is4k = Number(settings.width) >= 3800 && Number(settings.height) >= 2100;
    stateEl.textContent = `IMX415/UVC · ${width}×${height} @ ${fps}fps${is4k ? ' · 4K 已启用' : ' · 当前未到 4K'}`;
    stateEl.className = `bridge-state ${is4k ? 'ok' : 'warn'}`;

    zoomWrap.style.display = rangeFromCapability(zoomEl, caps.zoom, settings.zoom, zoomValue) ? '' : 'none';
    focusWrap.style.display = rangeFromCapability(focusEl, caps.focusDistance, settings.focusDistance, focusValue) ? '' : 'none';

    const modes = Array.isArray(caps.focusMode) ? caps.focusMode : [];
    if (modes.includes('continuous')) {
      try { await track.applyConstraints({advanced:[{focusMode:'continuous'}]}); } catch {}
    }
  }

  async function applyAdvanced(name, raw, valueEl) {
    const track = currentVideoTrack();
    if (!track) return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    try {
      await track.applyConstraints({advanced:[{[name]:value}]});
      valueEl.textContent = value.toFixed(2);
    } catch (e) {
      console.warn(`IMX415 ${name}:`, e);
      stateEl.textContent = `${name} 控制未被当前浏览器/UVC 驱动暴露`;
      stateEl.className = 'bridge-state warn';
    }
  }

  zoomEl.addEventListener('input', e => applyAdvanced('zoom', e.target.value, zoomValue));
  focusEl.addEventListener('input', e => applyAdvanced('focusDistance', e.target.value, focusValue));

  sourceSelect.addEventListener('change', () => {
    const on = selected();
    panel.classList.toggle('show', on);
    if (on) {
      // Keep the normal UVC path: camera-adapters treats every non-reCamera source as UVC.
      document.getElementById('startCamera').textContent = '连接 IMX415 8MP';
      setTimeout(refreshCapabilities, 0);
    }
  });

  // After the existing UVC adapter establishes a stream, inspect the negotiated mode.
  const video = document.getElementById('video');
  video?.addEventListener('loadedmetadata', () => setTimeout(refreshCapabilities, 80));
  document.getElementById('startCamera')?.addEventListener('click', () => {
    if (selected()) setTimeout(refreshCapabilities, 1200);
  });

  // If the OS exposes a recognizable label, make the profile discoverable but do not
  // forcibly change the user's selected camera when multiple cameras exist.
  function hintKnownCamera() {
    const option = [...cameraSelect.options].find(o => /imx\s*415|8mp|3840|usb\s*camera|uvc/i.test(o.textContent || ''));
    if (option && selected()) cameraSelect.value = option.value;
  }
  cameraSelect.addEventListener('change', refreshCapabilities);
  document.getElementById('refreshDevices')?.addEventListener('click', () => setTimeout(hintKnownCamera, 500));

  window.LabSightIMX415 = { refresh:refreshCapabilities };
})();
