(() => {
  const viewer = document.querySelector('.viewer');
  const capturebar = document.querySelector('.capturebar');
  if (!viewer || !capturebar) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'footprint-overlay-canvas hidden';
  viewer.appendChild(canvas);

  const status = document.createElement('div');
  status.className = 'footprint-overlay-status hidden';
  viewer.appendChild(status);

  const button = document.createElement('button');
  button.id = 'refOverlayBtn';
  button.type = 'button';
  button.className = 'secondary big ref-overlay-btn';
  button.textContent = '⌖ 标注位号';
  button.disabled = true;

  const recalibrate = document.createElement('button');
  recalibrate.id = 'refOverlayRecalibrateBtn';
  recalibrate.type = 'button';
  recalibrate.className = 'secondary big ref-overlay-btn hidden';
  recalibrate.textContent = '↻ 重新配准';

  const firstToggle = capturebar.querySelector('.toggle');
  capturebar.insertBefore(button, firstToggle || null);
  capturebar.insertBefore(recalibrate, firstToggle || null);

  let registration = null;
  let visible = false;
  let drawing = false;

  const setStatus = (text, kind='ok') => {
    status.textContent = text;
    status.className = `footprint-overlay-status ${kind === 'warn' ? 'warn' : ''}`.trim();
  };

  const hideStatus = () => status.classList.add('hidden');

  const currentContext = () => window.LabSightAssembly?.getContext?.() || window.labsightAssemblyContext || null;

  const reset = (reason='') => {
    registration = null;
    visible = false;
    canvas.classList.add('hidden');
    recalibrate.classList.add('hidden');
    button.classList.remove('active');
    button.textContent = '⌖ 标注位号';
    button.disabled = !currentContext();
    if (reason) setStatus(reason, 'warn'); else hideStatus();
  };

  const videoContentRect = () => {
    const w = els.video.clientWidth || viewer.clientWidth;
    const h = els.video.clientHeight || viewer.clientHeight;
    const vw = els.video.videoWidth || 16;
    const vh = els.video.videoHeight || 9;
    const sourceRatio = vw / Math.max(1, vh);
    const boxRatio = w / Math.max(1, h);
    if (sourceRatio > boxRatio) {
      const dh = w / sourceRatio;
      return {x:0, y:(h-dh)/2, w, h:dh};
    }
    const dw = h * sourceRatio;
    return {x:(w-dw)/2, y:0, w:dw, h};
  };

  const normalizeRotation = value => {
    const n = ((Number(value) || 0) % 360 + 360) % 360;
    return [0,90,180,270].includes(n) ? n : 0;
  };

  const effectiveSide = reg => reg?.side_override || reg?.visible_side || 'unknown';

  const transformUV = (u, v, reg) => {
    let x = u, y = v;
    const mirrored = Boolean(reg?.orientation_mirrored ?? reg?.mirrored);
    const rotation = normalizeRotation(reg?.orientation_rotation ?? reg?.rotation_deg);
    if (mirrored) x = 1 - x;
    if (rotation === 90) return {u:1-y, v:x};
    if (rotation === 180) return {u:1-x, v:1-y};
    if (rotation === 270) return {u:y, v:1-x};
    return {u:x, v:y};
  };

  const squareToQuad = pts => {
    const [p0,p1,p2,p3] = pts;
    const dx1 = p1.x - p2.x;
    const dx2 = p3.x - p2.x;
    const dx3 = p0.x - p1.x + p2.x - p3.x;
    const dy1 = p1.y - p2.y;
    const dy2 = p3.y - p2.y;
    const dy3 = p0.y - p1.y + p2.y - p3.y;
    const den = dx1 * dy2 - dx2 * dy1;
    let g = 0, h = 0;
    if (Math.abs(den) > 1e-9) {
      g = (dx3 * dy2 - dx2 * dy3) / den;
      h = (dx1 * dy3 - dx3 * dy1) / den;
    }
    const a = p1.x - p0.x + g * p1.x;
    const b = p3.x - p0.x + h * p3.x;
    const c = p0.x;
    const d = p1.y - p0.y + g * p1.y;
    const e = p3.y - p0.y + h * p3.y;
    const f = p0.y;
    return (u,v) => {
      const q = g*u + h*v + 1;
      return {x:(a*u+b*v+c)/q, y:(d*u+e*v+f)/q};
    };
  };

  const colorFor = ref => {
    const p = String(ref || '').match(/^[A-Za-z]+/)?.[0]?.toUpperCase() || '';
    if (/^(U|Q)$/.test(p)) return '#2dd4a8';
    if (/^(J|P|CN)$/.test(p)) return '#ff7a1a';
    if (/^(R|RN)$/.test(p)) return '#ff9d00';
    if (/^(C)$/.test(p)) return '#f4c21d';
    if (/^(Y|X)$/.test(p)) return '#39d8d0';
    if (/^(L|FB)$/.test(p)) return '#8bc34a';
    if (/^(D|LED)$/.test(p)) return '#ffcb35';
    return '#8ea4bc';
  };

  const roundedRect = (g,x,y,w,h,r=4) => {
    const rr = Math.min(r,w/2,h/2);
    g.beginPath();
    g.moveTo(x+rr,y); g.arcTo(x+w,y,x+w,y+h,rr); g.arcTo(x+w,y+h,x,y+h,rr);
    g.arcTo(x,y+h,x,y,rr); g.arcTo(x,y,x+w,y,rr); g.closePath();
  };

  const overlaps = (a,b,pad=2) => !(a.x+a.w+pad < b.x || b.x+b.w+pad < a.x || a.y+a.h+pad < b.y || b.y+b.h+pad < a.y);

  function draw() {
    if (!registration || !visible || state.scene !== 'pcb') {
      canvas.classList.add('hidden');
      return;
    }
    const ctx = currentContext();
    if (!ctx?.footprints?.length || !els.video.videoWidth) return;

    const cssW = viewer.clientWidth;
    const cssH = viewer.clientHeight;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.round(cssW*dpr);
    canvas.height = Math.round(cssH*dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.classList.remove('hidden');

    const g = canvas.getContext('2d');
    g.setTransform(dpr,0,0,dpr,0,0);
    g.clearRect(0,0,cssW,cssH);

    const vr = videoContentRect();
    const quad = registration.image_quad.map(p => ({x:vr.x+p.x*vr.w, y:vr.y+p.y*vr.h}));
    const project = squareToQuad(quad);
    const b = ctx.board_bbox;
    const bw = Math.max(1e-6, b.max_x-b.min_x);
    const bh = Math.max(1e-6, b.max_y-b.min_y);

    // Board outline from registration.
    g.save();
    g.strokeStyle = 'rgba(82,224,210,.90)';
    g.lineWidth = 1.5;
    g.setLineDash([6,5]);
    g.beginPath(); g.moveTo(quad[0].x,quad[0].y);
    for(let i=1;i<quad.length;i++) g.lineTo(quad[i].x,quad[i].y);
    g.closePath(); g.stroke(); g.restore();

    const side = effectiveSide(registration);
    const footprints = ctx.footprints.filter(fp => {
      if (fp.excluded) return false;
      if (side === 'front') return !/^B\./i.test(fp.layer || '');
      if (side === 'back') return /^B\./i.test(fp.layer || '');
      return true;
    });

    const labels = [];
    const fontSize = cssW < 650 ? 9 : 11;
    g.font = `700 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    g.textBaseline = 'middle';

    for (const fp of footprints) {
      const u = (fp.x-b.min_x)/bw;
      const v = (fp.y-b.min_y)/bh;
      if (!Number.isFinite(u) || !Number.isFinite(v) || u < -.05 || u > 1.05 || v < -.05 || v > 1.05) continue;
      const oriented = transformUV(u,v,registration);
      const p = project(oriented.u,oriented.v);
      const color = colorFor(fp.reference);
      const text = fp.reference;
      const tw = Math.ceil(g.measureText(text).width);
      const boxW = tw + 8, boxH = fontSize + 7;
      const candidates = [
        {x:p.x+7,y:p.y-boxH-4}, {x:p.x+7,y:p.y+4},
        {x:p.x-boxW-7,y:p.y-boxH-4}, {x:p.x-boxW-7,y:p.y+4},
        {x:p.x-boxW/2,y:p.y-boxH-8}, {x:p.x-boxW/2,y:p.y+8},
      ];
      let box = null;
      for (const c of candidates) {
        const candidate={x:Math.max(vr.x+2,Math.min(vr.x+vr.w-boxW-2,c.x)),y:Math.max(vr.y+2,Math.min(vr.y+vr.h-boxH-2,c.y)),w:boxW,h:boxH};
        if (!labels.some(old=>overlaps(candidate,old))) { box=candidate; break; }
      }
      if (!box) {
        const c=candidates[0]; box={x:Math.max(vr.x+2,Math.min(vr.x+vr.w-boxW-2,c.x)),y:Math.max(vr.y+2,Math.min(vr.y+vr.h-boxH-2,c.y)),w:boxW,h:boxH};
      }
      labels.push(box);

      g.beginPath(); g.arc(p.x,p.y,2.5,0,Math.PI*2); g.fillStyle=color; g.fill();
      const anchorX = Math.max(box.x, Math.min(box.x+box.w, p.x));
      const anchorY = Math.max(box.y, Math.min(box.y+box.h, p.y));
      if (Math.hypot(anchorX-p.x, anchorY-p.y) > 5) {
        g.beginPath(); g.moveTo(p.x,p.y); g.lineTo(anchorX,anchorY); g.strokeStyle=color+'aa'; g.lineWidth=1; g.stroke();
      }
      roundedRect(g,box.x,box.y,box.w,box.h,4); g.fillStyle='rgba(5,12,18,.82)'; g.fill();
      g.strokeStyle=color; g.lineWidth=1; g.stroke();
      g.fillStyle='#f5fbff'; g.fillText(text,box.x+4,box.y+box.h/2+.2);
    }

    const rotation = normalizeRotation(registration.orientation_rotation ?? registration.rotation_deg);
    const mirrored = Boolean(registration.orientation_mirrored ?? registration.mirrored);
    setStatus(`KiCad 位号 ${footprints.length} · 配准 ${Math.round(registration.confidence*100)}% · ${side==='front'?'正面':side==='back'?'背面':'面别未确认'} · 方向 ${rotation}°${mirrored?' · 镜像':''} · 板子移动后请重新配准`, registration.confidence < .75 ? 'warn' : 'ok');
  }

  const anchorList = ctx => ctx.footprints
    .filter(fp => !fp.excluded)
    .map(fp => {
      const pkg = String(fp.package || '');
      const score = (/Connector|USB|SMA|PinHeader|Socket|QFP|QFN|BGA|SOIC|TSSOP|Crystal/i.test(pkg) ? 50 : 0) + Math.min(40,(fp.pads?.length||0)*2);
      return {score,ref:fp.reference,value:fp.value,package:fp.package,layer:fp.layer,x:fp.x,y:fp.y,pads:fp.pads?.length||0};
    })
    .sort((a,b)=>b.score-a.score)
    .slice(0,40)
    .map(({score,...x})=>x);

  async function registerBoard(force=false) {
    if (drawing) return;
    const ctx = currentContext();
    if (!ctx) {
      alert('请先上传包含 .kicad_pcb 的 KiCad 工程 ZIP。');
      return;
    }
    if (!state.stream || !els.video.videoWidth) {
      alert('请先连接摄像头，并让整块 PCB 清楚地出现在画面中。');
      return;
    }
    if (!force && registration) {
      visible = true;
      button.textContent = '隐藏位号';
      button.classList.add('active');
      recalibrate.classList.remove('hidden');
      draw();
      return;
    }

    drawing = true;
    button.disabled = true;
    recalibrate.disabled = true;
    button.textContent = '正在配准…';
    setStatus('正在将 KiCad 板框 / 安装孔 / 连接器与实物 PCB 自动配准…');
    try {
      const native = getNativeFrameCanvas();
      const board = canvasScaledDataURL(native, 2000, .88).data;
      const map = window.LabSightAssembly?.placementMap?.(ctx);
      if (!map) throw new Error('无法生成 KiCad placement map');
      const payload = {
        provider: state.provider,
        board_image: board,
        placement_map_image: map,
        board_bbox: ctx.board_bbox,
        anchors: anchorList(ctx),
      };
      const r = await fetch('/api/board_register', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const d = await readJsonResponse(r);
      const result = d.result || {};
      if (!result.matched || !Array.isArray(result.image_quad) || result.image_quad.length !== 4) {
        throw new Error(`未能可靠对应当前实物板与 KiCad 工程${result.evidence?.length ? '：'+result.evidence.join('；') : ''}`);
      }
      const area = Math.abs(result.image_quad.reduce((sum,p,i,arr)=>{
        const q=arr[(i+1)%arr.length]; return sum + p.x*q.y - q.x*p.y;
      },0))/2;
      if (area < .005) throw new Error('识别到的 PCB 区域过小，请让整块板更清楚地出现在画面中');
      const detectedSide = result.visible_side || 'unknown';
      const detectedRotation = normalizeRotation(result.rotation_deg);
      const detectedMirror = typeof result.mirrored === 'boolean' ? result.mirrored : detectedSide === 'back';
      registration = {
        image_quad: result.image_quad.map(p=>({x:Number(p.x),y:Number(p.y)})),
        confidence: Number(result.confidence)||0,
        visible_side: detectedSide,
        rotation_deg: detectedRotation,
        mirrored: detectedMirror,
        orientation_confidence: Number(result.orientation_confidence)||0,
        orientation_rotation: detectedRotation,
        orientation_mirrored: detectedMirror,
        side_override: '',
        model: d.model,
        provider: d.provider,
        evidence: result.evidence || [],
      };
      visible = true;
      button.textContent = '隐藏位号';
      button.classList.add('active');
      recalibrate.classList.remove('hidden');
      draw();
      try {
        window.LabSightSession?.record?.('board_registration', {
          confidence: registration.confidence,
          visible_side: registration.visible_side,
          rotation_deg: registration.orientation_rotation,
          mirrored: registration.orientation_mirrored,
          orientation_confidence: registration.orientation_confidence,
          model: registration.model,
          footprint_count: ctx.footprints.filter(x=>!x.excluded).length,
        });
      } catch {}
    } catch (e) {
      registration = null;
      visible = false;
      canvas.classList.add('hidden');
      button.textContent = '⌖ 标注位号';
      button.classList.remove('active');
      recalibrate.classList.add('hidden');
      setStatus(`位号配准失败：${e.message}`, 'warn');
      console.warn('KiCad footprint overlay registration:', e);
    } finally {
      drawing = false;
      button.disabled = !currentContext();
      recalibrate.disabled = false;
    }
  }

  button.addEventListener('click', () => {
    if (visible) {
      visible = false;
      canvas.classList.add('hidden');
      hideStatus();
      button.textContent = '⌖ 标注位号';
      button.classList.remove('active');
      return;
    }
    registerBoard(false);
  });
  recalibrate.addEventListener('click', () => registerBoard(true));

  window.addEventListener('resize', () => requestAnimationFrame(draw));
  els.video?.addEventListener('loadedmetadata', () => requestAnimationFrame(draw));
  els.startCamera?.addEventListener('click', () => {
    if (registration) reset('摄像头重新连接后需要重新配准位号。');
  });
  els.cameraSelect?.addEventListener('change', () => {
    if (registration) reset('摄像头已切换，请重新配准位号。');
  });
  window.addEventListener('labsight:kicad-placement-ready', e => {
    reset();
    button.disabled = false;
    const n = e.detail?.count || currentContext()?.footprints?.length || 0;
    setStatus(`KiCad 已提取 ${n} 个器件位置 · 点击“标注位号”与当前 PCB 自动配准`);
  });

  document.querySelectorAll('.scene').forEach(tab => tab.addEventListener('click', () => {
    setTimeout(() => {
      if (state.scene !== 'pcb') canvas.classList.add('hidden');
      else if (visible) draw();
    }, 0);
  }));

  button.disabled = !currentContext();
  window.LabSightFootprintOverlay = {
    register: () => registerBoard(true),
    show: () => {visible=true; draw();},
    hide: () => {visible=false; canvas.classList.add('hidden'); hideStatus();},
    reset,
    get registration(){return registration;},
    transformUV: (u,v) => transformUV(u,v,registration),
    get effectiveSide(){return effectiveSide(registration);},
  };
})();
