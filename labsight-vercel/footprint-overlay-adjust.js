(() => {
  const viewer = document.querySelector('.viewer');
  const capturebar = document.querySelector('.capturebar');
  const refButton = document.getElementById('refOverlayBtn');
  const recalibrateButton = document.getElementById('refOverlayRecalibrateBtn');
  const projectInput = document.getElementById('projectFile');
  const dropzone = document.getElementById('dropzone');
  if (!viewer || !capturebar || !refButton) return;

  // The normal file-input path already wakes every KiCad consumer. Previously the
  // drag/drop path only called app.js::uploadProject(), so the assembly parser never
  // received the File and the ref-overlay button stayed disabled even though the
  // general KiCad summary looked loaded. Route drag/drop through the same change
  // event so app.js, assembly-inspection.js and debug-session.js all see one file.
  if (dropzone && projectInput) {
    dropzone.addEventListener('drop', e => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      dropzone.classList.remove('drag');
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        projectInput.files = dt.files;
        projectInput.dispatchEvent(new Event('change', {bubbles:true}));
      } catch (err) {
        console.warn('KiCad drop sync failed:', err);
        // Fall back to the old loader for the general project context. The overlay
        // will explain that placement data is not ready instead of silently staying grey.
        if (typeof uploadProject === 'function') uploadProject(file);
      }
    }, true);
  }

  refButton.title = '上传并解析含 .kicad_pcb 的 KiCad ZIP 后启用；点击后自动配准实物 PCB 与 footprint 位号';

  const adjustButton = document.createElement('button');
  adjustButton.id = 'refOverlayAdjustBtn';
  adjustButton.type = 'button';
  adjustButton.className = 'secondary big ref-overlay-btn hidden';
  adjustButton.textContent = '✥ 微调四角';
  adjustButton.title = '自动配准后拖动 PCB 四角，实时校正全部 KiCad 位号位置';
  (recalibrateButton || refButton).insertAdjacentElement('afterend', adjustButton);

  const handleLayer = document.createElement('div');
  handleLayer.className = 'footprint-corner-layer hidden';
  const handleNames = ['1','2','3','4'];
  const handles = handleNames.map((name, index) => {
    const h = document.createElement('button');
    h.type = 'button';
    h.className = 'footprint-corner-handle';
    h.dataset.index = String(index);
    h.textContent = name;
    h.title = ['画面中 PCB 左上角','画面中 PCB 右上角','画面中 PCB 右下角','画面中 PCB 左下角'][index];
    handleLayer.appendChild(h);
    return h;
  });
  viewer.appendChild(handleLayer);

  const help = document.createElement('div');
  help.className = 'footprint-corner-help hidden';
  help.textContent = '拖动 1–4 依次对准画面中的 PCB 左上 / 右上 / 右下 / 左下 · 若位号方向不对，请用“方向 / 镜像 / 面别”修正';
  viewer.appendChild(help);

  let editing = false;
  let dragIndex = -1;
  let pointerId = null;

  const overlay = () => window.LabSightFootprintOverlay;
  const registration = () => overlay()?.registration || null;

  function videoContentRect() {
    const box = viewer.getBoundingClientRect();
    const w = box.width;
    const h = box.height;
    const vw = els?.video?.videoWidth || 16;
    const vh = els?.video?.videoHeight || 9;
    const sourceRatio = vw / Math.max(1, vh);
    const boxRatio = w / Math.max(1, h);
    if (sourceRatio > boxRatio) {
      const dh = w / sourceRatio;
      return {x:0, y:(h-dh)/2, w, h:dh};
    }
    const dw = h * sourceRatio;
    return {x:(w-dw)/2, y:0, w:dw, h};
  }

  const clamp01 = n => Math.max(0, Math.min(1, n));

  function syncControls() {
    const ctx = window.LabSightAssembly?.getContext?.() || window.labsightAssemblyContext || null;
    const reg = registration();
    // Keep the original disabled affordance, but make the reason explicit. The
    // button becomes active only after .kicad_pcb footprint coordinates exist.
    refButton.disabled = !ctx;
    refButton.title = ctx
      ? `KiCad footprint 已就绪：${ctx.footprints?.filter?.(x=>!x.excluded)?.length || ctx.footprints?.length || 0} 个器件位置，可进行位号配准`
      : '尚未提取 KiCad footprint 坐标：请上传包含 .kicad_pcb 的工程 ZIP；拖拽上传也已支持';
    adjustButton.classList.toggle('hidden', !reg);
    if (!reg && editing) stopEditing();
    if (editing) syncHandles();
  }

  function syncHandles() {
    const reg = registration();
    if (!editing || !reg?.image_quad?.length) return;
    const vr = videoContentRect();
    handles.forEach((h, i) => {
      const p = reg.image_quad[i];
      if (!p) return;
      h.style.left = `${vr.x + clamp01(Number(p.x)) * vr.w}px`;
      h.style.top = `${vr.y + clamp01(Number(p.y)) * vr.h}px`;
    });
  }

  function redraw() {
    overlay()?.show?.();
    requestAnimationFrame(syncHandles);
  }

  function startEditing() {
    const reg = registration();
    if (!reg?.image_quad || reg.image_quad.length !== 4) return;
    editing = true;
    adjustButton.textContent = '✓ 完成微调';
    adjustButton.classList.add('active');
    handleLayer.classList.remove('hidden');
    help.classList.remove('hidden');
    redraw();
  }

  function stopEditing() {
    editing = false;
    dragIndex = -1;
    pointerId = null;
    adjustButton.textContent = '✥ 微调四角';
    adjustButton.classList.remove('active');
    handleLayer.classList.add('hidden');
    help.classList.add('hidden');
  }

  function updateCornerFromPointer(e) {
    if (!editing || dragIndex < 0) return;
    const reg = registration();
    if (!reg?.image_quad?.[dragIndex]) return;
    const rect = viewer.getBoundingClientRect();
    const vr = videoContentRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    reg.image_quad[dragIndex].x = clamp01((x - vr.x) / Math.max(1, vr.w));
    reg.image_quad[dragIndex].y = clamp01((y - vr.y) / Math.max(1, vr.h));
    // A manual adjustment is more trustworthy than the model's original corner
    // pixels but keep the original confidence visible rather than fabricating 100%.
    reg.manual_adjusted = true;
    redraw();
  }

  handles.forEach((h, index) => {
    h.addEventListener('pointerdown', e => {
      if (!editing) return;
      e.preventDefault();
      e.stopPropagation();
      dragIndex = index;
      pointerId = e.pointerId;
      h.classList.add('dragging');
      try { h.setPointerCapture(e.pointerId); } catch {}
    });
    h.addEventListener('pointermove', e => {
      if (dragIndex !== index || (pointerId !== null && e.pointerId !== pointerId)) return;
      e.preventDefault();
      updateCornerFromPointer(e);
    });
    const end = e => {
      if (dragIndex !== index) return;
      h.classList.remove('dragging');
      try { h.releasePointerCapture(e.pointerId); } catch {}
      dragIndex = -1;
      pointerId = null;
      try {
        const reg = registration();
        window.LabSightSession?.record?.('board_registration_manual_adjust', {
          image_quad: reg?.image_quad,
          visible_side: reg?.visible_side,
          rotation_deg: reg?.orientation_rotation ?? reg?.rotation_deg,
          mirrored: reg?.orientation_mirrored ?? reg?.mirrored,
          side_override: reg?.side_override || null,
        });
      } catch {}
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
  });

  adjustButton.addEventListener('click', () => editing ? stopEditing() : startEditing());

  // Keep manual handles attached to the same pixels when the browser is resized.
  window.addEventListener('resize', () => requestAnimationFrame(syncHandles));
  els?.video?.addEventListener('loadedmetadata', () => requestAnimationFrame(syncHandles));

  // Placement readiness is the precise condition for enabling “标注位号”.
  window.addEventListener('labsight:kicad-placement-ready', () => setTimeout(syncControls, 0));

  // Auto registration is asynchronous. Poll only UI state (no API calls) so the
  // adjustment button appears as soon as a registration exists.
  const uiTimer = setInterval(syncControls, 500);
  window.addEventListener('beforeunload', () => clearInterval(uiTimer), {once:true});
  syncControls();
})();
