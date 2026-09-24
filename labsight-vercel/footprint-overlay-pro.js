(() => {
  const viewer = document.querySelector('.viewer');
  const capturebar = document.querySelector('.capturebar');
  const refButton = document.getElementById('refOverlayBtn');
  const adjustButton = document.getElementById('refOverlayAdjustBtn');
  const legacyCanvas = viewer?.querySelector('.footprint-overlay-canvas');
  if (!viewer || !capturebar || !refButton) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'footprint-overlay-pro-canvas hidden';
  viewer.appendChild(canvas);

  const badge = document.createElement('div');
  badge.className = 'footprint-pro-badge hidden';
  viewer.appendChild(badge);

  const detail = document.createElement('div');
  detail.className = 'footprint-pro-detail hidden';
  viewer.appendChild(detail);

  const originalBtn = document.createElement('button');
  originalBtn.type = 'button';
  originalBtn.className = 'secondary big ref-overlay-mode hidden';
  originalBtn.textContent = '原图标注';
  originalBtn.title = '在当前实拍画面上按 KiCad 坐标精确投影位号；文字标签自动避让，锚点保持准确';

  const focusBtn = document.createElement('button');
  focusBtn.type = 'button';
  focusBtn.className = 'secondary big ref-overlay-mode hidden';
  focusBtn.textContent = '局部放大';
  focusBtn.title = '保持实拍板卡原始形状，只裁切 PCB 周边并放大；适合板子在整幅画面中占比较小时使用';

  const rectifiedBtn = document.createElement('button');
  rectifiedBtn.type = 'button';
  rectifiedBtn.className = 'secondary big ref-overlay-mode hidden';
  rectifiedBtn.textContent = '透视校正';
  rectifiedBtn.title = '按 PCB 四角做透视校正；只有四角可靠且原始像素足够时才启用';

  const zoom1Btn = document.createElement('button');
  zoom1Btn.type = 'button';
  zoom1Btn.className = 'secondary big ref-overlay-mode ref-overlay-zoom hidden';
  zoom1Btn.textContent = '1×';

  const zoom2Btn = document.createElement('button');
  zoom2Btn.type = 'button';
  zoom2Btn.className = 'secondary big ref-overlay-mode ref-overlay-zoom hidden';
  zoom2Btn.textContent = '2×';

  const zoom4Btn = document.createElement('button');
  zoom4Btn.type = 'button';
  zoom4Btn.className = 'secondary big ref-overlay-mode ref-overlay-zoom hidden';
  zoom4Btn.textContent = '4×';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'secondary big ref-overlay-mode hidden';
  refreshBtn.textContent = '↻ 更新高清帧';
  refreshBtn.title = '重新抓取当前原始高清帧，刷新局部放大或透视校正视图';

  const insertAfter = adjustButton || document.getElementById('refOverlayRecalibrateBtn') || refButton;
  insertAfter.insertAdjacentElement('afterend', originalBtn);
  originalBtn.insertAdjacentElement('afterend', focusBtn);
  focusBtn.insertAdjacentElement('afterend', rectifiedBtn);
  rectifiedBtn.insertAdjacentElement('afterend', zoom1Btn);
  zoom1Btn.insertAdjacentElement('afterend', zoom2Btn);
  zoom2Btn.insertAdjacentElement('afterend', zoom4Btn);
  zoom4Btn.insertAdjacentElement('afterend', refreshBtn);

  let mode = 'focus';
  let focusZoom = 1;
  let snapshot = null;
  let selectedRef = '';
  let hitTargets = [];
  let wasActive = false;
  let lastSignature = '';
  let returnModeAfterAdjust = null;

  const currentContext = () => window.LabSightAssembly?.getContext?.() || window.labsightAssemblyContext || null;
  const overlay = () => window.LabSightFootprintOverlay;
  const registration = () => overlay()?.registration || null;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const clamp01 = n => clamp(Number(n) || 0, 0, 1);

  const active = () => {
    if (state?.scene !== 'pcb') return false;
    return refButton.classList.contains('active') || /隐藏位号/.test(refButton.textContent || '');
  };

  function videoContentRect() {
    const w = viewer.clientWidth;
    const h = viewer.clientHeight;
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

  function squareToQuad(pts) {
    const [p0,p1,p2,p3] = pts;
    const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x;
    const dx3 = p0.x - p1.x + p2.x - p3.x;
    const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
    const dy3 = p0.y - p1.y + p2.y - p3.y;
    const den = dx1 * dy2 - dx2 * dy1;
    let gg = 0, hh = 0;
    if (Math.abs(den) > 1e-9) {
      gg = (dx3 * dy2 - dx2 * dy3) / den;
      hh = (dx1 * dy3 - dx3 * dy1) / den;
    }
    const a = p1.x - p0.x + gg*p1.x;
    const b = p3.x - p0.x + hh*p3.x;
    const c = p0.x;
    const d = p1.y - p0.y + gg*p1.y;
    const e = p3.y - p0.y + hh*p3.y;
    const f = p0.y;
    return (u,v) => {
      const q = gg*u + hh*v + 1;
      return {x:(a*u+b*v+c)/q, y:(d*u+e*v+f)/q};
    };
  }

  function colorFor(ref) {
    const p = String(ref || '').match(/^[A-Za-z]+/)?.[0]?.toUpperCase() || '';
    if (/^(U|Q)$/.test(p)) return '#2dd4a8';
    if (/^(J|P|CN)$/.test(p)) return '#ff7a1a';
    if (/^(R|RN)$/.test(p)) return '#ff9d00';
    if (/^C$/.test(p)) return '#f4c21d';
    if (/^(Y|X)$/.test(p)) return '#39d8d0';
    if (/^(L|FB)$/.test(p)) return '#8bc34a';
    if (/^(D|LED)$/.test(p)) return '#ffcb35';
    return '#9aadc0';
  }

  function roundedRect(g,x,y,w,h,r=4) {
    const rr = Math.min(r,w/2,h/2);
    g.beginPath();
    g.moveTo(x+rr,y); g.arcTo(x+w,y,x+w,y+h,rr); g.arcTo(x+w,y+h,x,y+h,rr);
    g.arcTo(x,y+h,x,y,rr); g.arcTo(x,y,x+w,y,rr); g.closePath();
  }

  const overlaps = (a,b,pad=2) => !(a.x+a.w+pad < b.x || b.x+b.w+pad < a.x || a.y+a.h+pad < b.y || b.y+b.h+pad < a.y);

  function pointInPoly(p, poly) {
    let inside = false;
    for (let i=0,j=poly.length-1;i<poly.length;j=i++) {
      const a=poly[i], b=poly[j];
      const hit=((a.y>p.y)!==(b.y>p.y)) && (p.x < (b.x-a.x)*(p.y-a.y)/(b.y-a.y+1e-9)+a.x);
      if (hit) inside=!inside;
    }
    return inside;
  }

  function rectCorners(r) {
    return [
      {x:r.x,y:r.y},{x:r.x+r.w,y:r.y},{x:r.x+r.w,y:r.y+r.h},{x:r.x,y:r.y+r.h}
    ];
  }

  function boundsOf(poly) {
    const xs=poly.map(p=>p.x), ys=poly.map(p=>p.y);
    return {x:Math.min(...xs),y:Math.min(...ys),w:Math.max(...xs)-Math.min(...xs),h:Math.max(...ys)-Math.min(...ys)};
  }

  function polygonArea(poly) {
    if (!Array.isArray(poly) || poly.length < 3) return 0;
    let s=0;
    for (let i=0;i<poly.length;i++) {
      const a=poly[i],b=poly[(i+1)%poly.length];
      s += a.x*b.y-b.x*a.y;
    }
    return Math.abs(s)/2;
  }

  function orient(a,b,c) {
    return (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  }

  function segmentsCross(a,b,c,d) {
    const o1=orient(a,b,c),o2=orient(a,b,d),o3=orient(c,d,a),o4=orient(c,d,b);
    return o1*o2 < -1e-9 && o3*o4 < -1e-9;
  }

  function validateQuad(quad) {
    if (!Array.isArray(quad) || quad.length !== 4 || quad.some(p=>!Number.isFinite(p?.x)||!Number.isFinite(p?.y))) {
      return {ok:false,reason:'配准四角数据不完整'};
    }
    const b=boundsOf(quad);
    if (b.w < 0.008 || b.h < 0.008) return {ok:false,reason:'配准板框过小'};
    if (segmentsCross(quad[0],quad[1],quad[2],quad[3]) || segmentsCross(quad[1],quad[2],quad[3],quad[0])) {
      return {ok:false,reason:'配准四角顺序交叉'};
    }
    const area=polygonArea(quad);
    if (area < 0.00008) return {ok:false,reason:'配准板框面积异常'};
    const edges=quad.map((p,i)=>Math.hypot(p.x-quad[(i+1)%4].x,p.y-quad[(i+1)%4].y));
    if (Math.min(...edges) < 0.006) return {ok:false,reason:'配准板框边长异常'};
    return {ok:true,area,bounds:b};
  }

  function preferredMode(reg) {
    const q=(reg?.image_quad || []).map(p=>({x:clamp01(p.x),y:clamp01(p.y)}));
    const v=validateQuad(q);
    // PCB 在整幅图中占比小于约 24% 时默认进入局部放大，避免强行透视拉伸。
    return !v.ok || v.area < 0.24 ? 'focus' : 'original';
  }

  function chooseLabel(anchor, boxW, boxH, poly, placed, canvasW, canvasH) {
    const candidates = [
      {x:anchor.x+8,y:anchor.y-boxH-6}, {x:anchor.x+8,y:anchor.y+6},
      {x:anchor.x-boxW-8,y:anchor.y-boxH-6}, {x:anchor.x-boxW-8,y:anchor.y+6},
      {x:anchor.x-boxW/2,y:anchor.y-boxH-11}, {x:anchor.x-boxW/2,y:anchor.y+11},
      {x:anchor.x+13,y:anchor.y-boxH/2}, {x:anchor.x-boxW-13,y:anchor.y-boxH/2},
    ];
    let best=null, bestScore=Infinity;
    for (const c of candidates) {
      const r={x:clamp(c.x,2,Math.max(2,canvasW-boxW-2)),y:clamp(c.y,2,Math.max(2,canvasH-boxH-2)),w:boxW,h:boxH};
      const corners=rectCorners(r);
      const outside=corners.reduce((n,p)=>n+(pointInPoly(p,poly)?0:1),0);
      const ov=placed.reduce((n,o)=>n+(overlaps(r,o,1)?1:0),0);
      const center={x:r.x+r.w/2,y:r.y+r.h/2};
      const distance=Math.hypot(center.x-anchor.x,center.y-anchor.y);
      const score=outside*1200+ov*450+distance;
      if (score<bestScore) {bestScore=score;best=r;}
    }
    return best;
  }

  function copyCurrentFrame() {
    let native = null;
    try { native = typeof getNativeFrameCanvas === 'function' ? getNativeFrameCanvas() : null; } catch {}
    if (!native || !native.width || !native.height) {
      if (!els?.video?.videoWidth) return null;
      native=document.createElement('canvas');
      native.width=els.video.videoWidth; native.height=els.video.videoHeight;
      native.getContext('2d').drawImage(els.video,0,0,native.width,native.height);
    }
    const c=document.createElement('canvas');
    c.width=native.width; c.height=native.height;
    c.getContext('2d').drawImage(native,0,0);
    snapshot=c;
    return c;
  }

  function affineFromTriangles(s0,s1,s2,d0,d1,d2) {
    const den=s0.x*(s1.y-s2.y)+s1.x*(s2.y-s0.y)+s2.x*(s0.y-s1.y);
    if (Math.abs(den)<1e-9) return null;
    const a=(d0.x*(s1.y-s2.y)+d1.x*(s2.y-s0.y)+d2.x*(s0.y-s1.y))/den;
    const c=(d0.x*(s2.x-s1.x)+d1.x*(s0.x-s2.x)+d2.x*(s1.x-s0.x))/den;
    const e=(d0.x*(s1.x*s2.y-s2.x*s1.y)+d1.x*(s2.x*s0.y-s0.x*s2.y)+d2.x*(s0.x*s1.y-s1.x*s0.y))/den;
    const b=(d0.y*(s1.y-s2.y)+d1.y*(s2.y-s0.y)+d2.y*(s0.y-s1.y))/den;
    const d=(d0.y*(s2.x-s1.x)+d1.y*(s0.x-s2.x)+d2.y*(s1.x-s0.x))/den;
    const f=(d0.y*(s1.x*s2.y-s2.x*s1.y)+d1.y*(s2.x*s0.y-s0.x*s2.y)+d2.y*(s0.x*s1.y-s1.x*s0.y))/den;
    return {a,b,c,d,e,f};
  }

  function drawTriangle(g,img,s0,s1,s2,d0,d1,d2) {
    const m=affineFromTriangles(s0,s1,s2,d0,d1,d2);
    if (!m) return;
    g.save();
    g.beginPath(); g.moveTo(d0.x,d0.y); g.lineTo(d1.x,d1.y); g.lineTo(d2.x,d2.y); g.closePath(); g.clip();
    g.setTransform(m.a,m.b,m.c,m.d,m.e,m.f);
    g.drawImage(img,0,0);
    g.restore();
  }

  function drawPerspectiveMesh(g,img,srcProject,dstRect,steps=18) {
    for (let j=0;j<steps;j++) {
      const v0=j/steps, v1=(j+1)/steps;
      for (let i=0;i<steps;i++) {
        const u0=i/steps, u1=(i+1)/steps;
        const s00=srcProject(u0,v0), s10=srcProject(u1,v0), s11=srcProject(u1,v1), s01=srcProject(u0,v1);
        const d00={x:dstRect.x+u0*dstRect.w,y:dstRect.y+v0*dstRect.h};
        const d10={x:dstRect.x+u1*dstRect.w,y:dstRect.y+v0*dstRect.h};
        const d11={x:dstRect.x+u1*dstRect.w,y:dstRect.y+v1*dstRect.h};
        const d01={x:dstRect.x+u0*dstRect.w,y:dstRect.y+v1*dstRect.h};
        drawTriangle(g,img,s00,s10,s11,d00,d10,d11);
        drawTriangle(g,img,s00,s11,s01,d00,d11,d01);
      }
    }
  }

  function fitRect(aspect,w,h,pad=24) {
    const aw=Math.max(10,w-pad*2), ah=Math.max(10,h-pad*2);
    if (aw/ah>aspect) {
      const hh=ah, ww=hh*aspect;
      return {x:(w-ww)/2,y:(h-hh)/2,w:ww,h:hh};
    }
    const ww=aw, hh=ww/aspect;
    return {x:(w-ww)/2,y:(h-hh)/2,w:ww,h:hh};
  }

  function visibleFootprints(ctx, reg) {
    const side=reg?.visible_side || 'unknown';
    return ctx.footprints.filter(fp => {
      if (fp.excluded) return false;
      if (side==='front') return !/^B\./i.test(fp.layer || '');
      if (side==='back') return /^B\./i.test(fp.layer || '');
      return true;
    });
  }

  function drawSelection(g, fp, projector, board) {
    if (!fp || fp.reference!==selectedRef) return;
    const padPts=(fp.pads || []).map(p => {
      const u=(p.x-board.min_x)/(board.max_x-board.min_x || 1);
      const v=(p.y-board.min_y)/(board.max_y-board.min_y || 1);
      return projector(u,v);
    }).filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y));
    if (padPts.length) {
      const xs=padPts.map(p=>p.x), ys=padPts.map(p=>p.y);
      const x=Math.min(...xs)-7,y=Math.min(...ys)-7,w=Math.max(...xs)-Math.min(...xs)+14,h=Math.max(...ys)-Math.min(...ys)+14;
      g.save(); g.strokeStyle='#52e0d2'; g.lineWidth=2; g.setLineDash([5,4]); g.strokeRect(x,y,w,h); g.setLineDash([]);
      for (const p of padPts) {g.beginPath();g.arc(p.x,p.y,4,0,Math.PI*2);g.fillStyle='#ffd36a';g.fill();g.strokeStyle='#161c22';g.lineWidth=1;g.stroke();}
      g.restore();
    }
  }

  function drawFootprints(g, ctx, reg, projector, boardPoly, canvasW, canvasH) {
    const b=ctx.board_bbox;
    const bw=Math.max(1e-6,b.max_x-b.min_x), bh=Math.max(1e-6,b.max_y-b.min_y);
    const fps=visibleFootprints(ctx,reg);
    const placed=[];
    let drawn=0;
    hitTargets=[];
    const fontSize=canvasW<700?9:11;
    g.font=`700 ${fontSize}px ui-monospace,SFMono-Regular,Menlo,monospace`;
    g.textBaseline='middle';

    for (const fp of fps) {
      const u=(fp.x-b.min_x)/bw, v=(fp.y-b.min_y)/bh;
      if (!Number.isFinite(u)||!Number.isFinite(v)||u<-.03||u>1.03||v<-.03||v>1.03) continue;
      const p=projector(u,v);
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < -24 || p.y < -24 || p.x > canvasW+24 || p.y > canvasH+24) continue;
      const color=colorFor(fp.reference);
      const text=fp.reference;
      const tw=Math.ceil(g.measureText(text).width), boxW=tw+8, boxH=fontSize+7;
      const box=chooseLabel(p,boxW,boxH,boardPoly,placed,canvasW,canvasH);
      placed.push(box);

      g.save();
      g.beginPath(); g.arc(p.x,p.y,selectedRef===fp.reference?4:2.7,0,Math.PI*2);
      g.fillStyle=color; g.fill();
      if (selectedRef===fp.reference) {g.strokeStyle='#fff';g.lineWidth=1.5;g.stroke();}
      const ax=clamp(p.x,box.x,box.x+box.w), ay=clamp(p.y,box.y,box.y+box.h);
      if (Math.hypot(ax-p.x,ay-p.y)>5) {g.beginPath();g.moveTo(p.x,p.y);g.lineTo(ax,ay);g.strokeStyle=color+'cc';g.lineWidth=1;g.stroke();}
      roundedRect(g,box.x,box.y,box.w,box.h,4); g.fillStyle='rgba(5,12,18,.86)';g.fill();
      g.strokeStyle=selectedRef===fp.reference?'#ffffff':color;g.lineWidth=selectedRef===fp.reference?1.7:1;g.stroke();
      g.fillStyle='#f5fbff';g.fillText(text,box.x+4,box.y+box.h/2+.2);g.restore();

      hitTargets.push({ref:fp.reference,box,anchor:p,fp});
      drawSelection(g,fp,projector,b);
      drawn++;
    }
    return drawn;
  }

  function setDetail(fp) {
    if (!fp) {detail.classList.add('hidden');detail.textContent='';return;}
    const bits=[fp.reference];
    if (fp.value) bits.push(fp.value);
    if (fp.package) bits.push(fp.package.split(':').pop());
    if (fp.pads?.length) bits.push(`${fp.pads.length} pads`);
    detail.textContent=bits.join(' · ');
    detail.classList.remove('hidden');
  }

  function sizeCanvas() {
    const w=Math.max(1,Math.round(viewer.clientWidth)),h=Math.max(1,Math.round(viewer.clientHeight));
    if (canvas.width!==w||canvas.height!==h) {canvas.width=w;canvas.height=h;canvas.style.width=`${w}px`;canvas.style.height=`${h}px`;}
    return {w,h};
  }

  function drawOriginal(ctx,reg) {
    const {w,h}=sizeCanvas();
    const g=canvas.getContext('2d');g.setTransform(1,0,0,1,0,0);g.clearRect(0,0,w,h);
    const vr=videoContentRect();
    const quad=reg.image_quad.map(p=>({x:vr.x+clamp01(p.x)*vr.w,y:vr.y+clamp01(p.y)*vr.h}));
    const projector=squareToQuad(quad);
    g.save();g.strokeStyle='rgba(82,224,210,.95)';g.lineWidth=1.6;g.setLineDash([6,5]);
    g.beginPath();g.moveTo(quad[0].x,quad[0].y);for(let i=1;i<4;i++)g.lineTo(quad[i].x,quad[i].y);g.closePath();g.stroke();g.restore();
    const count=drawFootprints(g,ctx,reg,projector,quad,w,h);
    badge.textContent=`原图标注 · ${count} 位号 · 锚点=KiCad footprint 中心 · 点击位号查看 pads`;
  }

  function cropAroundBoard(srcQuad, image, zoom=1, focusPoint=null) {
    const raw=boundsOf(srcQuad);
    const pad=Math.max(18,Math.max(raw.w,raw.h)*0.18);
    let base={
      x:clamp(raw.x-pad,0,image.width),
      y:clamp(raw.y-pad,0,image.height),
      w:Math.min(image.width,raw.w+pad*2),
      h:Math.min(image.height,raw.h+pad*2),
    };
    base.w=Math.min(base.w,image.width-base.x);
    base.h=Math.min(base.h,image.height-base.y);
    const z=clamp(Number(zoom)||1,1,4);
    if (z<=1.001) return base;
    const cx=clamp(focusPoint?.x ?? (raw.x+raw.w/2),0,image.width);
    const cy=clamp(focusPoint?.y ?? (raw.y+raw.h/2),0,image.height);
    const w=Math.max(32,base.w/z),h=Math.max(32,base.h/z);
    return {
      x:clamp(cx-w/2,0,Math.max(0,image.width-w)),
      y:clamp(cy-h/2,0,Math.max(0,image.height-h)),
      w:Math.min(w,image.width),
      h:Math.min(h,image.height),
    };
  }

  function drawFocus(ctx,reg,notice='') {
    const {w,h}=sizeCanvas();
    const g=canvas.getContext('2d');g.setTransform(1,0,0,1,0,0);g.clearRect(0,0,w,h);g.fillStyle='#071018';g.fillRect(0,0,w,h);
    if (!snapshot && !copyCurrentFrame()) {
      g.fillStyle='#b9cad8';g.font='14px system-ui';g.fillText('无法抓取当前帧，请确认摄像头已连接。',20,30);return;
    }
    g.imageSmoothingEnabled=true;
    try { g.imageSmoothingQuality='high'; } catch {}
    const srcQuad=reg.image_quad.map(p=>({x:clamp01(p.x)*snapshot.width,y:clamp01(p.y)*snapshot.height}));
    const normalizedQuad=reg.image_quad.map(p=>({x:clamp01(p.x),y:clamp01(p.y)}));
    const valid=validateQuad(normalizedQuad);
    const srcProject=valid.ok ? squareToQuad(srcQuad) : null;
    let selectedPoint=null;
    if (srcProject && selectedRef) {
      const fp=visibleFootprints(ctx,reg).find(x=>x.reference===selectedRef);
      const b=ctx.board_bbox;
      if (fp && b) {
        selectedPoint=srcProject(
          (fp.x-b.min_x)/(b.max_x-b.min_x || 1),
          (fp.y-b.min_y)/(b.max_y-b.min_y || 1)
        );
      }
    }
    const crop=cropAroundBoard(srcQuad,snapshot,focusZoom,selectedPoint);
    const dst=fitRect(crop.w/Math.max(1,crop.h),w,h,18);
    g.drawImage(snapshot,crop.x,crop.y,crop.w,crop.h,dst.x,dst.y,dst.w,dst.h);

    const toDst=p=>({
      x:dst.x+(p.x-crop.x)/Math.max(1,crop.w)*dst.w,
      y:dst.y+(p.y-crop.y)/Math.max(1,crop.h)*dst.h,
    });
    const boardPoly=srcQuad.map(toDst);
    g.save();g.strokeStyle=valid.ok?'rgba(82,224,210,.98)':'rgba(255,176,46,.95)';g.lineWidth=2;g.setLineDash(valid.ok?[]:[6,5]);
    g.beginPath();g.moveTo(boardPoly[0].x,boardPoly[0].y);for(let i=1;i<4;i++)g.lineTo(boardPoly[i].x,boardPoly[i].y);g.closePath();g.stroke();g.restore();

    let count=0;
    if (valid.ok && srcProject) {
      const projector=(u,v)=>toDst(srcProject(u,v));
      count=drawFootprints(g,ctx,reg,projector,boardPoly,w,h);
    } else {
      hitTargets=[];
    }
    const sourcePct=Math.max(0,Math.min(100,polygonArea(normalizedQuad)*100));
    const suffix=notice || (!valid.ok ? `${valid.reason}，暂不绘制位号，请重新校准四角` : `保持实拍形状 · ${count} 位号`);
    badge.textContent=`局部放大 ${focusZoom}× · PCB 原图占比约 ${sourcePct.toFixed(1)}% · ${suffix}`;
  }

  function drawRectified(ctx,reg) {
    const {w,h}=sizeCanvas();
    const g=canvas.getContext('2d');g.setTransform(1,0,0,1,0,0);g.clearRect(0,0,w,h);g.fillStyle='#071018';g.fillRect(0,0,w,h);
    if (!snapshot && !copyCurrentFrame()) {
      g.fillStyle='#b9cad8';g.font='14px system-ui';g.fillText('无法抓取当前帧，请确认摄像头已连接。',20,30);return;
    }
    const normalizedQuad=reg.image_quad.map(p=>({x:clamp01(p.x),y:clamp01(p.y)}));
    const valid=validateQuad(normalizedQuad);
    const srcQuad=normalizedQuad.map(p=>({x:p.x*snapshot.width,y:p.y*snapshot.height}));
    const sb=boundsOf(srcQuad);
    // 对很小的 PCB 强行做大幅透视拉伸会制造条纹/形变。此时保持原始形状的 ROI 放大更可靠。
    if (!valid.ok || Math.min(sb.w,sb.h) < 96 || polygonArea(normalizedQuad) < 0.002) {
      drawFocus(ctx,reg,!valid.ok ? `${valid.reason}，已自动回退到无形变局部放大` : '原始 PCB 像素过少，已自动回退到无形变局部放大');
      return;
    }
    const b=ctx.board_bbox;
    const bw=Math.max(1e-6,b.max_x-b.min_x),bh=Math.max(1e-6,b.max_y-b.min_y);
    const aspect=bw/bh;
    const rect=fitRect(aspect,w,h,28);
    const srcProject=squareToQuad(srcQuad);
    drawPerspectiveMesh(g,snapshot,srcProject,rect,18);
    g.save();g.strokeStyle='rgba(82,224,210,.98)';g.lineWidth=2;g.strokeRect(rect.x,rect.y,rect.w,rect.h);g.restore();
    const projector=(u,v)=>({x:rect.x+u*rect.w,y:rect.y+v*rect.h});
    const poly=rectCorners(rect);
    const count=drawFootprints(g,ctx,reg,projector,poly,w,h);
    badge.textContent=`校正视图 · ${count} 位号 · 已恢复 KiCad 板框比例 ${bw.toFixed(1)}×${bh.toFixed(1)} · 点击位号查看 pads`;
  }

  function render(force=false) {
    const reg=registration(),ctx=currentContext();
    const isActive=active();
    if (!reg||!ctx||!isActive) {
      canvas.classList.add('hidden');badge.classList.add('hidden');detail.classList.add('hidden');
      originalBtn.classList.add('hidden');focusBtn.classList.add('hidden');rectifiedBtn.classList.add('hidden');
      zoom1Btn.classList.add('hidden');zoom2Btn.classList.add('hidden');zoom4Btn.classList.add('hidden');refreshBtn.classList.add('hidden');
      legacyCanvas?.classList.remove('pro-suppressed');
      lastSignature='';
      return;
    }
    legacyCanvas?.classList.add('pro-suppressed');
    canvas.classList.remove('hidden');badge.classList.remove('hidden');
    originalBtn.classList.remove('hidden');focusBtn.classList.remove('hidden');rectifiedBtn.classList.remove('hidden');
    const focusMode=mode==='focus';
    zoom1Btn.classList.toggle('hidden',!focusMode);zoom2Btn.classList.toggle('hidden',!focusMode);zoom4Btn.classList.toggle('hidden',!focusMode);
    refreshBtn.classList.toggle('hidden',mode==='original');
    originalBtn.classList.toggle('active',mode==='original');focusBtn.classList.toggle('active',focusMode);rectifiedBtn.classList.toggle('active',mode==='rectified');
    zoom1Btn.classList.toggle('active',focusMode&&focusZoom===1);zoom2Btn.classList.toggle('active',focusMode&&focusZoom===2);zoom4Btn.classList.toggle('active',focusMode&&focusZoom===4);
    const sig=[mode,focusZoom,viewer.clientWidth,viewer.clientHeight,selectedRef,JSON.stringify(reg.image_quad),snapshot?.width||0,snapshot?.height||0].join('|');
    if (!force&&sig===lastSignature) return;
    lastSignature=sig;
    if (mode==='rectified') drawRectified(ctx,reg); else if (mode==='focus') drawFocus(ctx,reg); else drawOriginal(ctx,reg);
    if (selectedRef) setDetail(ctx.footprints.find(x=>x.reference===selectedRef)); else setDetail(null);
  }

  function selectAt(e) {
    if (!active()) return;
    const r=canvas.getBoundingClientRect();
    const p={x:(e.clientX-r.left)*(canvas.width/Math.max(1,r.width)),y:(e.clientY-r.top)*(canvas.height/Math.max(1,r.height))};
    let best=null,bestD=Infinity;
    for (const h of hitTargets) {
      const inBox=p.x>=h.box.x&&p.x<=h.box.x+h.box.w&&p.y>=h.box.y&&p.y<=h.box.y+h.box.h;
      const d=Math.hypot(p.x-h.anchor.x,p.y-h.anchor.y);
      if (inBox||d<12) {const score=inBox?0:d;if(score<bestD){best=h;bestD=score;}}
    }
    selectedRef=best?.ref===selectedRef?'':(best?.ref||'');
    lastSignature='';render(true);
    if (selectedRef) {
      try {window.LabSightSession?.record?.('footprint_selected',{reference:selectedRef,value:best.fp?.value,package:best.fp?.package});} catch {}
    }
  }

  originalBtn.addEventListener('click',()=>{mode='original';lastSignature='';render(true);});
  focusBtn.addEventListener('click',()=>{mode='focus';copyCurrentFrame();lastSignature='';render(true);});
  rectifiedBtn.addEventListener('click',()=>{mode='rectified';copyCurrentFrame();lastSignature='';render(true);});
  zoom1Btn.addEventListener('click',()=>{focusZoom=1;mode='focus';lastSignature='';render(true);});
  zoom2Btn.addEventListener('click',()=>{focusZoom=2;mode='focus';lastSignature='';render(true);});
  zoom4Btn.addEventListener('click',()=>{focusZoom=4;mode='focus';lastSignature='';render(true);});
  refreshBtn.addEventListener('click',()=>{copyCurrentFrame();lastSignature='';render(true);});
  canvas.addEventListener('click',selectAt);

  refButton.addEventListener('click',()=>setTimeout(()=>{
    if (active() && registration()) {
      if (!wasActive) {mode=preferredMode(registration());focusZoom=1;copyCurrentFrame();selectedRef='';}
      render(true);
    } else render(true);
  },30));

  if (adjustButton) {
    adjustButton.addEventListener('click',()=>setTimeout(()=>{
      const editing=adjustButton.classList.contains('active');
      if (editing) {
        if (returnModeAfterAdjust===null) returnModeAfterAdjust=mode;
        mode='original';lastSignature='';render(true);
      } else if (returnModeAfterAdjust) {
        mode=returnModeAfterAdjust;returnModeAfterAdjust=null;
        if (mode==='rectified'||mode==='focus') copyCurrentFrame();
        lastSignature='';render(true);
      }
    },20));
  }

  // Keep the legacy API for other modules, but ensure the improved overlay wins visually.
  const ov=overlay();
  if (ov && !ov.__proWrapped) {
    const oldShow=ov.show?.bind(ov),oldHide=ov.hide?.bind(ov),oldReset=ov.reset?.bind(ov);
    if (oldShow) ov.show=(...args)=>{const out=oldShow(...args);setTimeout(()=>render(true),0);return out;};
    if (oldHide) ov.hide=(...args)=>{const out=oldHide(...args);setTimeout(()=>render(true),0);return out;};
    if (oldReset) ov.reset=(...args)=>{const out=oldReset(...args);snapshot=null;selectedRef='';setTimeout(()=>render(true),0);return out;};
    ov.__proWrapped=true;
  }

  window.addEventListener('resize',()=>{lastSignature='';requestAnimationFrame(()=>render(true));});
  els?.video?.addEventListener('loadedmetadata',()=>{snapshot=null;lastSignature='';requestAnimationFrame(()=>render(true));});
  window.addEventListener('labsight:kicad-placement-ready',()=>{snapshot=null;selectedRef='';lastSignature='';setTimeout(()=>render(true),0);});
  document.querySelectorAll('.scene').forEach(b=>b.addEventListener('click',()=>setTimeout(()=>render(true),0)));

  const timer=setInterval(()=>{
    const nowActive=active()&&!!registration();
    if (nowActive&&!wasActive) {mode=preferredMode(registration());focusZoom=1;copyCurrentFrame();lastSignature='';}
    if (!nowActive&&wasActive) {snapshot=null;selectedRef='';}
    wasActive=nowActive;
    render(false);
  },250);
  window.addEventListener('beforeunload',()=>clearInterval(timer),{once:true});

  window.LabSightFootprintPro={
    render:()=>render(true),
    setMode:m=>{if(m==='original'||m==='focus'||m==='rectified'){mode=m;if(m!=='original')copyCurrentFrame();lastSignature='';render(true);}},
    setZoom:z=>{focusZoom=[1,2,4].includes(Number(z))?Number(z):1;mode='focus';copyCurrentFrame();lastSignature='';render(true);},
    refresh:()=>{copyCurrentFrame();lastSignature='';render(true);},
    get mode(){return mode;},
    get selectedRef(){return selectedRef;},
    get canvas(){return canvas;},
  };
})();