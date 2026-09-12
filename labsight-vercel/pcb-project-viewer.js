(() => {
  const projectPanel = document.querySelector('.project-panel');
  const projectSummary = document.getElementById('projectSummary');
  const projectInput = document.getElementById('projectFile');
  if (!projectPanel || !projectSummary || !projectInput) return;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  const panel = document.createElement('div');
  panel.className = 'pcb-project-preview hidden';
  panel.innerHTML = `
    <div class="pcb-preview-head">
      <div>
        <div class="pcb-preview-title">PCB 交互预览</div>
        <div class="pcb-preview-subtitle">本地解析 .kicad_pcb · 类 iBOM 交互 · 点击器件查看详细信息</div>
      </div>
      <div class="pcb-preview-viewtabs" role="group" aria-label="PCB side">
        <button type="button" data-view="F" class="active">F</button>
        <button type="button" data-view="FB">FB</button>
        <button type="button" data-view="B">B</button>
      </div>
    </div>
    <div class="pcb-preview-toolbar">
      <div class="pcb-preview-search-wrap">
        <span>⌕</span>
        <input class="pcb-preview-search" type="search" placeholder="搜索 R12 / AD9834 / QFN…" autocomplete="off" />
        <div class="pcb-preview-search-results hidden"></div>
      </div>
      <button type="button" class="pcb-preview-tool refs active">位号</button>
      <button type="button" class="pcb-preview-tool pads active">焊盘</button>
      <button type="button" class="pcb-preview-tool fit">适应窗口</button>
      <button type="button" class="pcb-preview-tool ibom hidden">打开原始 iBOM</button>
    </div>
    <div class="pcb-preview-stage" tabindex="0">
      <canvas class="pcb-preview-canvas"></canvas>
      <div class="pcb-preview-empty">上传包含 <b>.kicad_pcb</b> 的 KiCad ZIP 后显示 PCB</div>
      <aside class="pcb-preview-drawer hidden" aria-live="polite"></aside>
      <div class="pcb-preview-hud">滚轮缩放 · 拖动平移 · 点击器件</div>
    </div>
    <div class="pcb-preview-footer">
      <span class="pcb-preview-status">等待 KiCad PCB…</span>
      <span class="pcb-preview-count"></span>
    </div>`;
  projectSummary.insertAdjacentElement('afterend', panel);

  const canvas = panel.querySelector('.pcb-preview-canvas');
  const stage = panel.querySelector('.pcb-preview-stage');
  const empty = panel.querySelector('.pcb-preview-empty');
  const drawer = panel.querySelector('.pcb-preview-drawer');
  const status = panel.querySelector('.pcb-preview-status');
  const count = panel.querySelector('.pcb-preview-count');
  const search = panel.querySelector('.pcb-preview-search');
  const searchResults = panel.querySelector('.pcb-preview-search-results');
  const refsBtn = panel.querySelector('.refs');
  const padsBtn = panel.querySelector('.pads');
  const fitBtn = panel.querySelector('.fit');
  const ibomBtn = panel.querySelector('.ibom');
  const viewBtns = [...panel.querySelectorAll('[data-view]')];

  const state = {
    ctx: null,
    view: 'F',
    showRefs: true,
    showPads: true,
    zoom: 1,
    panX: 0,
    panY: 0,
    selectedRef: '',
    hoverRef: '',
    hits: [],
    query: '',
    dragging: false,
    dragMoved: false,
    dragStartX: 0,
    dragStartY: 0,
    panStartX: 0,
    panStartY: 0,
    ibomUrl: '',
    ibomName: '',
  };

  const colorFor = ref => {
    const p = String(ref || '').match(/^[A-Za-z]+/)?.[0]?.toUpperCase() || '';
    if (/^(U|Q)$/.test(p)) return '#32d6ac';
    if (/^(J|P|CN)$/.test(p)) return '#ff8a30';
    if (/^(R|RN)$/.test(p)) return '#ffb11a';
    if (/^C$/.test(p)) return '#efd04a';
    if (/^(L|FB)$/.test(p)) return '#9dcc59';
    if (/^(D|LED)$/.test(p)) return '#ffcf3c';
    if (/^(Y|X)$/.test(p)) return '#4dd8d0';
    return '#8ea6bb';
  };

  function visibleFootprints() {
    const fps = state.ctx?.footprints || [];
    return fps.filter(fp => {
      const back = /^B\./i.test(fp.layer || '');
      if (state.view === 'F') return !back;
      if (state.view === 'B') return back;
      return true;
    });
  }

  function matches(fp) {
    const q = state.query.trim().toLowerCase();
    if (!q) return true;
    return [fp.reference, fp.value, fp.package, fp.layer]
      .some(v => String(v || '').toLowerCase().includes(q));
  }

  function canvasSize() {
    const rect = stage.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(340, Math.round(rect.height));
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw; canvas.height = ph;
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    }
    return {w, h, dpr};
  }

  function transformFor(w, h) {
    const b = state.ctx?.board_bbox;
    if (!b) return null;
    const bw = Math.max(1e-6, b.max_x - b.min_x);
    const bh = Math.max(1e-6, b.max_y - b.min_y);
    const pad = 34;
    const fit = Math.min((w - pad*2) / bw, (h - pad*2) / bh);
    const s = fit * state.zoom;
    const mx = (b.min_x + b.max_x) / 2;
    const my = (b.min_y + b.max_y) / 2;
    const cx = w/2 + state.panX;
    const cy = h/2 + state.panY;
    return {
      b, bw, bh, s, cx, cy,
      xy(x, y) {
        const xx = state.view === 'B' ? (b.max_x - (x - b.min_x)) : x;
        return {x: cx + (xx - mx) * s, y: cy + (y - my) * s};
      }
    };
  }

  function roundedRect(g, x, y, w, h, r=4) {
    const rr = Math.min(r, w/2, h/2);
    g.beginPath();
    g.moveTo(x+rr,y); g.arcTo(x+w,y,x+w,y+h,rr); g.arcTo(x+w,y+h,x,y+h,rr);
    g.arcTo(x,y+h,x,y,rr); g.arcTo(x,y,x+w,y,rr); g.closePath();
  }

  function footprintBox(fp, t) {
    const points = (fp.pads || []).map(p => t.xy(p.x, p.y));
    const c = t.xy(fp.x, fp.y);
    if (!points.length) return {x:c.x-8,y:c.y-8,w:16,h:16,c};
    const xs = points.map(p=>p.x), ys=points.map(p=>p.y);
    const grow = Math.max(5, Math.min(14, t.s * 0.35));
    const minx=Math.min(...xs)-grow,maxx=Math.max(...xs)+grow,miny=Math.min(...ys)-grow,maxy=Math.max(...ys)+grow;
    return {x:minx,y:miny,w:Math.max(14,maxx-minx),h:Math.max(14,maxy-miny),c};
  }

  function drawBoard(g, t) {
    const tl=t.xy(t.b.min_x,t.b.min_y), br=t.xy(t.b.max_x,t.b.max_y);
    const x=Math.min(tl.x,br.x), y=Math.min(tl.y,br.y), ww=Math.abs(br.x-tl.x), hh=Math.abs(br.y-tl.y);
    g.save();
    roundedRect(g,x,y,ww,hh,Math.min(16,Math.max(4,ww*.015)));
    g.fillStyle='#143f34'; g.fill();
    g.strokeStyle='#80d0be'; g.lineWidth=1.5; g.stroke();
    g.clip();
    const step=Math.max(18,Math.min(70,t.s*5));
    g.strokeStyle='rgba(151,210,196,.07)';g.lineWidth=1;
    for(let xx=x;xx<x+ww;xx+=step){g.beginPath();g.moveTo(xx,y);g.lineTo(xx,y+hh);g.stroke();}
    for(let yy=y;yy<y+hh;yy+=step){g.beginPath();g.moveTo(x,yy);g.lineTo(x+ww,yy);g.stroke();}
    g.restore();
  }

  function render() {
    if (!state.ctx) return;
    panel.classList.remove('hidden'); empty.classList.add('hidden');
    const {w,h,dpr}=canvasSize();
    const g=canvas.getContext('2d');
    g.setTransform(dpr,0,0,dpr,0,0); g.clearRect(0,0,w,h);
    g.fillStyle='#081019';g.fillRect(0,0,w,h);
    const t=transformFor(w,h); if(!t) return;
    drawBoard(g,t);
    state.hits=[];
    const fps=visibleFootprints();
    const q=state.query.trim();
    let shown=0, matched=0;
    for(const fp of fps){
      if(fp.excluded) continue;
      shown++;
      const hit=matches(fp); if(hit) matched++;
      const back=/^B\./i.test(fp.layer || '');
      const box=footprintBox(fp,t); const c=box.c;
      const selected=fp.reference===state.selectedRef, hover=fp.reference===state.hoverRef;
      const color=colorFor(fp.reference);
      const dim=q&&!hit;
      g.save(); g.globalAlpha=dim?.13:(back&&state.view==='FB'?.46:1);
      g.fillStyle=selected?'rgba(82,224,210,.22)':hover?'rgba(255,255,255,.12)':'rgba(30,54,60,.34)';
      g.strokeStyle=selected?'#ffffff':hover?'#dffdfa':color;
      g.lineWidth=selected?2.3:hover?1.8:1;
      if(back&&state.view==='FB')g.setLineDash([4,3]);
      roundedRect(g,box.x,box.y,box.w,box.h,3);g.fill();g.stroke();g.setLineDash([]);
      if(state.showPads){
        for(const p of fp.pads || []){
          const s=t.xy(p.x,p.y); const rr=selected?3.6:2.5;
          g.beginPath();g.arc(s.x,s.y,rr,0,Math.PI*2);g.fillStyle=selected?'#ffe17a':'#d7ba5b';g.fill();
        }
      }
      if(state.showRefs && t.s*3.0>8){
        const font=Math.max(8,Math.min(13,9+Math.log2(Math.max(.6,state.zoom))));
        g.font=`700 ${font}px ui-monospace,SFMono-Regular,Menlo,monospace`;
        const text=fp.reference, tw=g.measureText(text).width;
        const tx=clamp(c.x-tw/2,2,w-tw-2), ty=clamp(box.y-5,10,h-4);
        g.fillStyle='rgba(3,11,15,.86)'; roundedRect(g,tx-3,ty-font+1,tw+6,font+5,3);g.fill();
        g.fillStyle='#f6fbff';g.fillText(text,tx,ty);
      }
      g.restore();
      state.hits.push({fp,box,center:c});
    }
    status.textContent=`${state.view==='F'?'正面':state.view==='B'?'背面':'双面'} · ${shown} 个 footprint · ${(t.b.max_x-t.b.min_x).toFixed(1)} × ${(t.b.max_y-t.b.min_y).toFixed(1)} mm`;
    count.textContent=q?`匹配 ${matched} / ${shown}`:`缩放 ${Math.round(state.zoom*100)}%`;
  }

  function hitAt(x,y){
    let best=null,bestScore=Infinity;
    for(const h of state.hits){
      const inside=x>=h.box.x&&x<=h.box.x+h.box.w&&y>=h.box.y&&y<=h.box.y+h.box.h;
      const d=Math.hypot(x-h.center.x,y-h.center.y);
      if(inside||d<14){const score=inside?d*.1:d;if(score<bestScore){bestScore=score;best=h;}}
    }
    return best;
  }

  function showDrawer(fp){
    state.selectedRef=fp?.reference||'';
    if(!fp){drawer.classList.add('hidden');drawer.innerHTML='';render();return;}
    const padNums=[...new Set((fp.pads||[]).map(p=>p.number).filter(Boolean))];
    drawer.innerHTML=`
      <div class="pcb-drawer-head"><div><b>${esc(fp.reference)}</b><span>${esc(fp.value || '未标注 Value')}</span></div><button type="button" class="pcb-drawer-close">×</button></div>
      <div class="pcb-drawer-grid">
        <label>封装</label><div>${esc(fp.package || '—')}</div>
        <label>层</label><div>${esc(fp.layer || '—')}</div>
        <label>位置</label><div>X ${Number(fp.x).toFixed(2)} · Y ${Number(fp.y).toFixed(2)} mm</div>
        <label>旋转</label><div>${Number(fp.rotation||0).toFixed(1)}°</div>
        <label>焊盘</label><div>${(fp.pads||[]).length}${padNums.length?` · ${esc(padNums.slice(0,18).join(', '))}${padNums.length>18?'…':''}`:''}</div>
      </div>
      <div class="pcb-drawer-actions">
        <button type="button" class="pcb-open-photo-overlay">在实物画面显示位号</button>
        <button type="button" class="pcb-copy-ref">复制 ${esc(fp.reference)}</button>
      </div>`;
    drawer.classList.remove('hidden');
    drawer.querySelector('.pcb-drawer-close')?.addEventListener('click',()=>showDrawer(null));
    drawer.querySelector('.pcb-copy-ref')?.addEventListener('click',()=>navigator.clipboard?.writeText(fp.reference));
    drawer.querySelector('.pcb-open-photo-overlay')?.addEventListener('click',()=>{
      const ov=window.LabSightFootprintOverlay;
      if(!ov?.registration){
        document.querySelector('.viewer')?.scrollIntoView({behavior:'smooth',block:'center'});
        document.getElementById('refOverlayBtn')?.click();
        return;
      }
      ov.show?.(); window.LabSightFootprintPro?.setMode?.('original');
      document.querySelector('.viewer')?.scrollIntoView({behavior:'smooth',block:'center'});
    });
    render();
  }

  function updateSearchResults(){
    state.query=search.value.trim();
    const q=state.query.toLowerCase();
    if(!q){searchResults.classList.add('hidden');searchResults.innerHTML='';render();return;}
    const matchesList=(state.ctx?.footprints||[]).filter(fp=>
      [fp.reference,fp.value,fp.package].some(v=>String(v||'').toLowerCase().includes(q))
    ).slice(0,10);
    searchResults.innerHTML=matchesList.length?matchesList.map(fp=>`<button type="button" data-ref="${esc(fp.reference)}"><b>${esc(fp.reference)}</b><span>${esc(fp.value||fp.package||'')}</span></button>`).join(''):'<div class="empty">没有匹配器件</div>';
    searchResults.classList.remove('hidden');
    searchResults.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
      const fp=(state.ctx?.footprints||[]).find(x=>x.reference===b.dataset.ref); if(fp){search.value=fp.reference;state.query=fp.reference;searchResults.classList.add('hidden');showDrawer(fp);}
    }));
    render();
  }

  function resetView(){state.zoom=1;state.panX=0;state.panY=0;render();}

  viewBtns.forEach(btn=>btn.addEventListener('click',()=>{
    state.view=btn.dataset.view;viewBtns.forEach(x=>x.classList.toggle('active',x===btn));state.selectedRef='';drawer.classList.add('hidden');resetView();
  }));
  refsBtn.addEventListener('click',()=>{state.showRefs=!state.showRefs;refsBtn.classList.toggle('active',state.showRefs);render();});
  padsBtn.addEventListener('click',()=>{state.showPads=!state.showPads;padsBtn.classList.toggle('active',state.showPads);render();});
  fitBtn.addEventListener('click',resetView);
  ibomBtn.addEventListener('click',()=>{if(state.ibomUrl)window.open(state.ibomUrl,'_blank','noopener,noreferrer');});
  search.addEventListener('input',updateSearchResults);
  search.addEventListener('keydown',e=>{
    if(e.key==='Escape'){searchResults.classList.add('hidden');search.blur();}
    if(e.key==='Enter'){
      const first=searchResults.querySelector('button');if(first){e.preventDefault();first.click();}
    }
  });
  document.addEventListener('click',e=>{if(!panel.querySelector('.pcb-preview-search-wrap')?.contains(e.target))searchResults.classList.add('hidden');});

  stage.addEventListener('wheel',e=>{
    if(!state.ctx)return;e.preventDefault();
    const rect=canvas.getBoundingClientRect();const mx=e.clientX-rect.left,my=e.clientY-rect.top;
    const old=state.zoom;const next=clamp(old*Math.exp(-e.deltaY*.0012),.35,8);const ratio=next/old;
    state.panX=mx-rect.width/2-(mx-rect.width/2-state.panX)*ratio;
    state.panY=my-rect.height/2-(my-rect.height/2-state.panY)*ratio;
    state.zoom=next;render();
  },{passive:false});

  stage.addEventListener('pointerdown',e=>{
    if(!state.ctx||e.button!==0)return;
    const rect=canvas.getBoundingClientRect();const x=e.clientX-rect.left,y=e.clientY-rect.top;
    const hit=hitAt(x,y);
    if(hit){showDrawer(hit.fp);return;}
    state.dragging=true;state.dragMoved=false;state.dragStartX=e.clientX;state.dragStartY=e.clientY;state.panStartX=state.panX;state.panStartY=state.panY;
    try{stage.setPointerCapture(e.pointerId);}catch{}
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove',e=>{
    const rect=canvas.getBoundingClientRect();const x=e.clientX-rect.left,y=e.clientY-rect.top;
    if(state.dragging){const dx=e.clientX-state.dragStartX,dy=e.clientY-state.dragStartY;if(Math.abs(dx)+Math.abs(dy)>3)state.dragMoved=true;state.panX=state.panStartX+dx;state.panY=state.panStartY+dy;render();return;}
    const hit=hitAt(x,y);const ref=hit?.fp?.reference||'';if(ref!==state.hoverRef){state.hoverRef=ref;stage.style.cursor=ref?'pointer':'grab';render();}
  });
  const endDrag=e=>{if(!state.dragging)return;state.dragging=false;stage.classList.remove('dragging');try{stage.releasePointerCapture(e.pointerId);}catch{}stage.style.cursor=state.hoverRef?'pointer':'grab';};
  stage.addEventListener('pointerup',endDrag);stage.addEventListener('pointercancel',endDrag);stage.addEventListener('dblclick',resetView);

  async function detectIbom(file){
    if(state.ibomUrl){URL.revokeObjectURL(state.ibomUrl);state.ibomUrl='';}
    state.ibomName='';ibomBtn.classList.add('hidden');
    if(!file||!window.JSZip)return;
    try{
      const zip=await JSZip.loadAsync(file);
      const names=Object.keys(zip.files).filter(n=>/\.html?$/i.test(n)&&!zip.files[n].dir);
      const name=names.find(n=>/(interactive.?html.?bom|ibom)/i.test(n))||'';
      if(!name)return;
      const html=await zip.file(name).async('string');
      state.ibomUrl=URL.createObjectURL(new Blob([html],{type:'text/html'}));state.ibomName=name;
      ibomBtn.textContent='打开原始 iBOM';ibomBtn.title=`工程 ZIP 中检测到 ${name}`;ibomBtn.classList.remove('hidden');
    }catch(e){console.debug('iBOM detect:',e);}
  }

  projectInput.addEventListener('change',e=>detectIbom(e.target.files?.[0]));
  window.addEventListener('labsight:kicad-placement-ready',e=>{
    state.ctx=e.detail?.context||window.LabSightAssembly?.getContext?.()||null;
    if(!state.ctx)return;
    panel.classList.remove('hidden');empty.classList.add('hidden');state.selectedRef='';state.query='';search.value='';drawer.classList.add('hidden');resetView();
    try{window.LabSightSession?.record?.('pcb_preview_ready',{footprints:state.ctx.footprints?.length||0,filename:state.ctx.filename||''},'browser');}catch{}
  });
  window.addEventListener('resize',()=>requestAnimationFrame(render));
  window.addEventListener('beforeunload',()=>{if(state.ibomUrl)URL.revokeObjectURL(state.ibomUrl);},{once:true});

  window.LabSightPcbPreview={
    select(ref){const fp=(state.ctx?.footprints||[]).find(x=>x.reference===ref);if(fp)showDrawer(fp);},
    fit:resetView,
    render,
    get context(){return state.ctx;}
  };
})();
