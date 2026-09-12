(() => {
  const projectPanel = document.querySelector('.project-panel');
  const projectSummary = document.getElementById('projectSummary');
  const projectInput = document.getElementById('projectFile');
  if (!projectPanel || !projectSummary || !projectInput || !window.JSZip) return;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]));
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const num = (v, d=0) => Number.isFinite(Number(v)) ? Number(v) : d;

  document.querySelectorAll('.pcb-project-preview').forEach(el => el.remove());

  const panel = document.createElement('div');
  panel.className = 'pcb-project-preview hidden';
  panel.innerHTML = `
    <div class="pcb-preview-head">
      <div>
        <div class="pcb-preview-title">KiCad PCB 交互预览</div>
        <div class="pcb-preview-subtitle">本地解析 F/B.Cu · vias · Silk · Edge.Cuts · Fab · Courtyard · 类 iBOM 交互</div>
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
      <button type="button" class="pcb-preview-tool refs active" data-toggle="refs">位号</button>
      <button type="button" class="pcb-preview-tool pads active" data-toggle="pads">焊盘</button>
      <button type="button" class="pcb-preview-tool copper active" data-toggle="copper">铜层</button>
      <button type="button" class="pcb-preview-tool vias active" data-toggle="vias">过孔</button>
      <button type="button" class="pcb-preview-tool silk active" data-toggle="silk">丝印</button>
      <button type="button" class="pcb-preview-tool fab" data-toggle="fab">Fab</button>
      <button type="button" class="pcb-preview-tool courtyard" data-toggle="courtyard">Courtyard</button>
      <button type="button" class="pcb-preview-tool edges active" data-toggle="edges">板框</button>
      <button type="button" class="pcb-preview-tool fit">适应窗口</button>
      <button type="button" class="pcb-preview-tool ibom hidden">打开原始 iBOM</button>
    </div>
    <div class="pcb-preview-layer-legend">
      <span class="front">F.Cu / F.SilkS</span><span class="back">B.Cu / B.SilkS</span><span class="via">Via</span><span class="fab">Fab</span><span class="courtyard">Courtyard</span>
    </div>
    <div class="pcb-preview-stage" tabindex="0">
      <canvas class="pcb-preview-canvas"></canvas>
      <div class="pcb-preview-empty">上传包含 <b>.kicad_pcb</b> 的 KiCad ZIP 后显示 PCB</div>
      <aside class="pcb-preview-drawer hidden" aria-live="polite"></aside>
      <div class="pcb-preview-hud">滚轮缩放 · 拖动平移 · 双击复位 · 点击器件</div>
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
  const fitBtn = panel.querySelector('.fit');
  const ibomBtn = panel.querySelector('.ibom');
  const viewBtns = [...panel.querySelectorAll('[data-view]')];
  const toggleBtns = [...panel.querySelectorAll('[data-toggle]')];

  const state = {
    ctx: null,
    view: 'F',
    layers: {refs:true,pads:true,copper:true,vias:true,silk:true,fab:false,courtyard:false,edges:true},
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

  function balancedSpans(text, token) {
    const out=[]; let start=0;
    while (true) {
      const i=text.indexOf(token,start); if(i<0) break;
      let depth=0,inStr=false,escp=false,done=false;
      for(let j=i;j<text.length;j++){
        const c=text[j];
        if(inStr){
          if(escp)escp=false; else if(c==='\\')escp=true; else if(c==='"')inStr=false;
        }else{
          if(c==='"')inStr=true;
          else if(c==='(')depth++;
          else if(c===')' && --depth===0){out.push({start:i,end:j+1,text:text.slice(i,j+1)});start=j+1;done=true;break;}
        }
      }
      if(!done)break;
    }
    return out;
  }
  const balancedBlocks=(text,token)=>balancedSpans(text,token).map(x=>x.text);
  const prop=(block,name)=>{const m=block.match(new RegExp('\\(property\\s+"'+name.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')+'"\\s+"([^"]*)"'));return m?m[1]:'';};
  const fpText=(block,kind)=>{const m=block.match(new RegExp('\\(fp_text\\s+'+kind+'\\s+"([^"]*)"','i'));return m?m[1]:'';};
  const firstAt=block=>{const m=block.match(/\(at\s+([-\d.]+)\s+([-\d.]+)(?:\s+([-\d.]+))?/);return m?{x:+m[1],y:+m[2],r:+(m[3]||0)}:null;};
  const layerOf=block=>(block.match(/\(layer\s+"([^"]+)"\)/)||[])[1]||'';
  const strokeWidth=block=>num((block.match(/\(stroke\s+\(width\s+([-\d.]+)\)/)||block.match(/\(width\s+([-\d.]+)\)/)||[])[1],0.2);
  const xyPair=(block,key)=>{const m=block.match(new RegExp('\\('+key+'\\s+([-\\d.]+)\\s+([-\\d.]+)\\)'));return m?{x:+m[1],y:+m[2]}:null;};
  const sizePair=block=>{const m=block.match(/\(size\s+([-\d.]+)\s+([-\d.]+)\)/);return m?{x:+m[1],y:+m[2]}:{x:1,y:1};};
  const drillSize=block=>num((block.match(/\(drill(?:\s+oval)?\s+([-\d.]+)/)||[])[1],0.4);

  function boardOnlyText(text){
    const spans=balancedSpans(text,'(footprint'); if(!spans.length)return text;
    let out='',pos=0;
    for(const s of spans){out+=text.slice(pos,s.start)+' '.repeat(s.end-s.start);pos=s.end;}
    return out+text.slice(pos);
  }

  function localToGlobal(pt,at){
    const rad=at.r*Math.PI/180,cs=Math.cos(rad),sn=Math.sin(rad);
    return {x:at.x+pt.x*cs-pt.y*sn,y:at.y+pt.x*sn+pt.y*cs};
  }
  const mapPts=(pts,at)=>pts.map(p=>localToGlobal(p,at));

  function parsePrimitive(block,prefix,at=null){
    const layer=layerOf(block); if(!layer)return null;
    const width=strokeWidth(block);
    const tx=p=>at?localToGlobal(p,at):p;
    if(prefix.endsWith('line')){
      const a=xyPair(block,'start'),b=xyPair(block,'end'); if(!a||!b)return null;
      return {kind:'line',layer,width,a:tx(a),b:tx(b)};
    }
    if(prefix.endsWith('arc')){
      const a=xyPair(block,'start'),m=xyPair(block,'mid'),b=xyPair(block,'end'); if(!a||!m||!b)return null;
      return {kind:'arc',layer,width,a:tx(a),m:tx(m),b:tx(b)};
    }
    if(prefix.endsWith('rect')){
      const a=xyPair(block,'start'),b=xyPair(block,'end'); if(!a||!b)return null;
      const raw=[{x:a.x,y:a.y},{x:b.x,y:a.y},{x:b.x,y:b.y},{x:a.x,y:b.y}];
      return {kind:'poly',layer,width,pts:at?mapPts(raw,at):raw,closed:true};
    }
    if(prefix.endsWith('circle')){
      const c=xyPair(block,'center'),e=xyPair(block,'end'); if(!c||!e)return null;
      return {kind:'circle',layer,width,c:tx(c),e:tx(e)};
    }
    if(prefix.endsWith('poly')){
      const pts=[...block.matchAll(/\(xy\s+([-\d.]+)\s+([-\d.]+)\)/g)].map(m=>({x:+m[1],y:+m[2]}));
      if(pts.length<2)return null;
      return {kind:'poly',layer,width,pts:at?mapPts(pts,at):pts,closed:true};
    }
    return null;
  }

  function parseTextPrimitive(block,prefix,at=null,fp=null){
    const layer=layerOf(block); if(!layer)return null;
    const re=new RegExp('^\\('+prefix+'(?:\\s+[^\\s"]+)?\\s+"((?:\\\\.|[^"])*)"');
    const m=block.match(re); if(!m)return null;
    const p=firstAt(block); if(!p)return null;
    let text=m[1].replace(/\\n/g,' ').replace(/\\"/g,'"');
    if(fp){text=text.replace(/\$\{REFERENCE\}/g,fp.reference).replace(/\$\{VALUE\}/g,fp.value);}
    const pos=at?localToGlobal({x:p.x,y:p.y},at):{x:p.x,y:p.y};
    const size=(block.match(/\(font\s+\(size\s+([-\d.]+)\s+([-\d.]+)\)/)||[]);
    return {kind:'text',layer,pos,text,size:num(size[2]||size[1],1),rotation:(at?at.r:0)+p.r,hidden:/\shide(?:\s|\))/i.test(block)};
  }

  function parseFootprint(block){
    const head=block.match(/^\(footprint\s+"([^"]+)"/); const at=firstAt(block); if(!at)return null;
    const reference=prop(block,'Reference')||fpText(block,'reference'); if(!reference)return null;
    const value=prop(block,'Value')||fpText(block,'value'); const packageName=head?head[1]:'';
    const layer=layerOf(block); const attr=(block.match(/\(attr\s+([^\)]+)\)/)||[])[1]||'';
    const excluded=/exclude_from_pos_files|exclude_from_bom|\bdnp\b/.test(attr)||/^H\d+$/i.test(reference)||/^TP\d+$/i.test(reference);
    const pads=[];
    for(const pb of balancedBlocks(block,'(pad')){
      const n=(pb.match(/^\(pad\s+"?([^"\s()]*)"?\s+/)||[])[1]||'';
      const pa=firstAt(pb); if(!pa)continue; const p=localToGlobal({x:pa.x,y:pa.y},at);
      const sz=sizePair(pb); const shape=(pb.match(/^\(pad\s+"?[^"\s()]*"?\s+\S+\s+(\S+)/)||[])[1]||'circle';
      const layers=[...(pb.match(/\(layers\s+([^\)]+)\)/)||['',''])[1].matchAll(/"([^"]+)"/g)].map(x=>x[1]);
      pads.push({number:n,x:p.x,y:p.y,size_x:sz.x,size_y:sz.y,shape,layers,rotation:at.r+pa.r});
    }
    const fp={reference,value,package:packageName,layer,x:at.x,y:at.y,rotation:at.r,excluded,pads,graphics:[]};
    for(const kind of ['fp_line','fp_arc','fp_rect','fp_circle','fp_poly']){
      for(const gb of balancedBlocks(block,`(${kind}`)){const q=parsePrimitive(gb,kind,at);if(q)fp.graphics.push(q);}
    }
    for(const tb of balancedBlocks(block,'(fp_text')){const q=parseTextPrimitive(tb,'fp_text',at,fp);if(q&&!q.hidden)fp.graphics.push(q);}
    return fp;
  }

  function geometryBBox(edge,footprints){
    const pts=[];
    for(const q of edge){
      if(q.kind==='line')pts.push(q.a,q.b); else if(q.kind==='arc')pts.push(q.a,q.m,q.b); else if(q.kind==='poly')pts.push(...q.pts); else if(q.kind==='circle')pts.push(q.c,q.e);
    }
    if(!pts.length)footprints.forEach(f=>pts.push({x:f.x,y:f.y}));
    const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y);
    return {min_x:Math.min(...xs),max_x:Math.max(...xs),min_y:Math.min(...ys),max_y:Math.max(...ys)};
  }

  function parsePcbText(text,filename=''){
    const footprints=balancedBlocks(text,'(footprint').map(parseFootprint).filter(Boolean);
    const boardText=boardOnlyText(text);
    const graphics=[];
    for(const kind of ['gr_line','gr_arc','gr_rect','gr_circle','gr_poly']){
      for(const b of balancedBlocks(boardText,`(${kind}`)){const q=parsePrimitive(b,kind);if(q)graphics.push(q);}
    }
    for(const b of balancedBlocks(boardText,'(gr_text')){const q=parseTextPrimitive(b,'gr_text');if(q&&!q.hidden)graphics.push(q);}
    const segments=[];
    for(const b of balancedBlocks(boardText,'(segment')){
      const a=xyPair(b,'start'),c=xyPair(b,'end'),layer=layerOf(b); if(a&&c&&layer)segments.push({kind:'line',layer,width:num((b.match(/\(width\s+([-\d.]+)\)/)||[])[1],0.25),a,b:c});
    }
    for(const b of balancedBlocks(boardText,'(arc')){
      const a=xyPair(b,'start'),m=xyPair(b,'mid'),c=xyPair(b,'end'),layer=layerOf(b); if(a&&m&&c&&layer)segments.push({kind:'arc',layer,width:num((b.match(/\(width\s+([-\d.]+)\)/)||[])[1],0.25),a,m,b:c});
    }
    const vias=[];
    for(const b of balancedBlocks(boardText,'(via')){
      const p=firstAt(b); if(!p)continue;
      const layers=[...(b.match(/\(layers\s+([^\)]+)\)/)||['',''])[1].matchAll(/"([^"]+)"/g)].map(x=>x[1]);
      vias.push({x:p.x,y:p.y,size:num((b.match(/\(size\s+([-\d.]+)\)/)||[])[1],0.8),drill:drillSize(b),layers});
    }
    const allGraphics=[...graphics,...footprints.flatMap(f=>f.graphics)];
    const edge=allGraphics.filter(q=>q.layer==='Edge.Cuts');
    const board_bbox=geometryBBox(edge,footprints);
    return {filename,footprints,board_bbox,geometry:{graphics:allGraphics,segments,vias,edge}};
  }

  const colorFor = ref => {
    const p=String(ref||'').match(/^[A-Za-z]+/)?.[0]?.toUpperCase()||'';
    if(/^(U|Q)$/.test(p))return '#32d6ac'; if(/^(J|P|CN)$/.test(p))return '#ff8a30';
    if(/^(R|RN)$/.test(p))return '#ffb11a'; if(/^C$/.test(p))return '#efd04a';
    if(/^(L|FB)$/.test(p))return '#9dcc59'; if(/^(D|LED)$/.test(p))return '#ffcf3c';
    if(/^(Y|X)$/.test(p))return '#4dd8d0'; return '#8ea6bb';
  };
  const layerSide=layer=>/^B\./i.test(layer||'')?'B':/^F\./i.test(layer||'')?'F':'N';
  const sideVisible=layer=>{const s=layerSide(layer);return s==='N'||state.view==='FB'||state.view===s;};
  const sideAlpha=layer=>state.view==='FB'&&layerSide(layer)==='B'?.42:1;

  function matches(fp){const q=state.query.trim().toLowerCase();return !q||[fp.reference,fp.value,fp.package,fp.layer].some(v=>String(v||'').toLowerCase().includes(q));}
  function visibleFootprints(){return (state.ctx?.footprints||[]).filter(fp=>{const b=/^B\./i.test(fp.layer||'');return state.view==='F'?!b:state.view==='B'?b:true;});}
  function canvasSize(){
    const rect=stage.getBoundingClientRect(),dpr=Math.max(1,Math.min(2,window.devicePixelRatio||1));
    const w=Math.max(1,Math.round(rect.width)),h=Math.max(340,Math.round(rect.height));
    const pw=Math.round(w*dpr),ph=Math.round(h*dpr);
    if(canvas.width!==pw||canvas.height!==ph){canvas.width=pw;canvas.height=ph;canvas.style.width=`${w}px`;canvas.style.height=`${h}px`;}
    return {w,h,dpr};
  }
  function transformFor(w,h){
    const b=state.ctx?.board_bbox;if(!b)return null; const bw=Math.max(1e-6,b.max_x-b.min_x),bh=Math.max(1e-6,b.max_y-b.min_y);
    const pad=38,fit=Math.min((w-pad*2)/bw,(h-pad*2)/bh),s=fit*state.zoom,mx=(b.min_x+b.max_x)/2,my=(b.min_y+b.max_y)/2,cx=w/2+state.panX,cy=h/2+state.panY;
    return {b,bw,bh,s,cx,cy,xy(x,y){const xx=state.view==='B'?(b.max_x-(x-b.min_x)):x;return{x:cx+(xx-mx)*s,y:cy+(y-my)*s};}};
  }
  function roundedRect(g,x,y,w,h,r=4){const rr=Math.min(r,w/2,h/2);g.beginPath();g.moveTo(x+rr,y);g.arcTo(x+w,y,x+w,y+h,rr);g.arcTo(x+w,y+h,x,y+h,rr);g.arcTo(x,y+h,x,y,rr);g.arcTo(x,y,x+w,y,rr);g.closePath();}

  function circleFrom3(a,m,b){
    const d=2*(a.x*(m.y-b.y)+m.x*(b.y-a.y)+b.x*(a.y-m.y)); if(Math.abs(d)<1e-9)return null;
    const aa=a.x*a.x+a.y*a.y,mm=m.x*m.x+m.y*m.y,bb=b.x*b.x+b.y*b.y;
    const cx=(aa*(m.y-b.y)+mm*(b.y-a.y)+bb*(a.y-m.y))/d;
    const cy=(aa*(b.x-m.x)+mm*(a.x-b.x)+bb*(m.x-a.x))/d;
    const r=Math.hypot(a.x-cx,a.y-cy); return {x:cx,y:cy,r};
  }
  const normAng=a=>{while(a<0)a+=Math.PI*2;while(a>=Math.PI*2)a-=Math.PI*2;return a;};
  function ccwContains(a,m,b){a=normAng(a);m=normAng(m);b=normAng(b);const span=normAng(b-a),mid=normAng(m-a);return mid<=span+1e-6;}

  function drawPrimitive(g,q,t,color,alpha=1,dash=null){
    if(!q||!sideVisible(q.layer))return; g.save();g.globalAlpha*=alpha*sideAlpha(q.layer);g.strokeStyle=color;g.fillStyle=color;g.lineWidth=clamp((q.width||.2)*t.s,.65,5);if(dash)g.setLineDash(dash);
    if(q.kind==='line'){const a=t.xy(q.a.x,q.a.y),b=t.xy(q.b.x,q.b.y);g.beginPath();g.moveTo(a.x,a.y);g.lineTo(b.x,b.y);g.stroke();}
    else if(q.kind==='poly'){const pts=q.pts.map(p=>t.xy(p.x,p.y));if(pts.length){g.beginPath();g.moveTo(pts[0].x,pts[0].y);for(let i=1;i<pts.length;i++)g.lineTo(pts[i].x,pts[i].y);if(q.closed)g.closePath();g.stroke();}}
    else if(q.kind==='circle'){const c=t.xy(q.c.x,q.c.y),e=t.xy(q.e.x,q.e.y);g.beginPath();g.arc(c.x,c.y,Math.hypot(e.x-c.x,e.y-c.y),0,Math.PI*2);g.stroke();}
    else if(q.kind==='arc'){
      const a=t.xy(q.a.x,q.a.y),m=t.xy(q.m.x,q.m.y),b=t.xy(q.b.x,q.b.y),c=circleFrom3(a,m,b);
      if(c){const aa=Math.atan2(a.y-c.y,a.x-c.x),ma=Math.atan2(m.y-c.y,m.x-c.x),ba=Math.atan2(b.y-c.y,b.x-c.x);g.beginPath();g.arc(c.x,c.y,c.r,aa,ba,!ccwContains(aa,ma,ba));g.stroke();}
    }else if(q.kind==='text'){
      const p=t.xy(q.pos.x,q.pos.y);const fs=clamp(q.size*t.s*.85,7,18);g.font=`600 ${fs}px ui-sans-serif,system-ui`;g.textAlign='center';g.textBaseline='middle';g.fillText(q.text,p.x,p.y);
    }
    g.restore();
  }

  function drawSubstrate(g,t){
    const tl=t.xy(t.b.min_x,t.b.min_y),br=t.xy(t.b.max_x,t.b.max_y),x=Math.min(tl.x,br.x),y=Math.min(tl.y,br.y),w=Math.abs(br.x-tl.x),h=Math.abs(br.y-tl.y);
    g.save();roundedRect(g,x,y,w,h,Math.min(16,Math.max(4,w*.015)));g.fillStyle='#0f382f';g.fill();g.strokeStyle='rgba(105,190,169,.35)';g.lineWidth=1;g.stroke();g.restore();
  }
  function drawCopper(g,t){if(!state.layers.copper)return;for(const q of state.ctx.geometry.segments){if(!/^([FB])\.Cu$/i.test(q.layer)||!sideVisible(q.layer))continue;drawPrimitive(g,q,t,layerSide(q.layer)==='F'?'#c97432':'#4678c6',.88);}}
  function drawVias(g,t){if(!state.layers.vias)return;for(const v of state.ctx.geometry.vias){const p=t.xy(v.x,v.y),r=clamp(v.size*t.s/2,2,9),dr=clamp(v.drill*t.s/2,.8,r*.72);g.save();g.globalAlpha=.92;g.beginPath();g.arc(p.x,p.y,r,0,Math.PI*2);g.fillStyle='#b78a52';g.fill();g.beginPath();g.arc(p.x,p.y,dr,0,Math.PI*2);g.fillStyle='#071019';g.fill();g.restore();}}
  function drawLayerGraphics(g,t){
    for(const q of state.ctx.geometry.graphics){
      if(q.layer==='Edge.Cuts')continue;
      if(/\.SilkS$/i.test(q.layer)){if(state.layers.silk)drawPrimitive(g,q,t,layerSide(q.layer)==='F'?'#f4f0db':'#cfd7e3',.9);continue;}
      if(/\.Fab$/i.test(q.layer)){if(state.layers.fab)drawPrimitive(g,q,t,layerSide(q.layer)==='F'?'#69c9d0':'#7298c9',.68,[5,3]);continue;}
      if(/\.CrtYd$/i.test(q.layer)){if(state.layers.courtyard)drawPrimitive(g,q,t,layerSide(q.layer)==='F'?'#d279c6':'#9a82d7',.65,[7,4]);continue;}
    }
  }
  function drawEdges(g,t){if(!state.layers.edges)return;for(const q of state.ctx.geometry.edge)drawPrimitive(g,q,t,'#81dfcf',1);}

  function footprintBox(fp,t){
    const points=(fp.pads||[]).map(p=>t.xy(p.x,p.y));const c=t.xy(fp.x,fp.y);
    if(!points.length)return{x:c.x-8,y:c.y-8,w:16,h:16,c}; const xs=points.map(p=>p.x),ys=points.map(p=>p.y),grow=Math.max(4,Math.min(12,t.s*.3));
    return{x:Math.min(...xs)-grow,y:Math.min(...ys)-grow,w:Math.max(14,Math.max(...xs)-Math.min(...xs)+grow*2),h:Math.max(14,Math.max(...ys)-Math.min(...ys)+grow*2),c};
  }
  function drawPad(g,p,t,selected=false){
    const c=t.xy(p.x,p.y),sx=clamp((p.size_x||1)*t.s,3,26),sy=clamp((p.size_y||1)*t.s,3,26),rot=(state.view==='B'?-1:1)*num(p.rotation)*Math.PI/180;
    g.save();g.translate(c.x,c.y);g.rotate(rot);g.fillStyle=selected?'#ffe17a':'#c9aa57';g.strokeStyle=selected?'#fff5ba':'rgba(20,12,4,.6)';g.lineWidth=1;
    if(/circle|oval/i.test(p.shape)){g.beginPath();g.ellipse(0,0,sx/2,sy/2,0,0,Math.PI*2);g.fill();g.stroke();}
    else{const rr=/roundrect/i.test(p.shape)?Math.min(sx,sy)*.18:1.5;roundedRect(g,-sx/2,-sy/2,sx,sy,rr);g.fill();g.stroke();}
    g.restore();
  }

  function drawFootprints(g,t,w,h){
    state.hits=[];const fps=visibleFootprints(),q=state.query.trim();let shown=0,matched=0;
    for(const fp of fps){if(fp.excluded)continue;shown++;const hit=matches(fp);if(hit)matched++;const back=/^B\./i.test(fp.layer||''),box=footprintBox(fp,t),c=box.c,selected=fp.reference===state.selectedRef,hover=fp.reference===state.hoverRef,color=colorFor(fp.reference),dim=q&&!hit;
      g.save();g.globalAlpha=dim?.11:(back&&state.view==='FB'?.42:1);
      if(state.layers.pads)for(const p of fp.pads||[])drawPad(g,p,t,selected);
      g.fillStyle=selected?'rgba(82,224,210,.18)':hover?'rgba(255,255,255,.09)':'rgba(24,51,58,.18)';g.strokeStyle=selected?'#fff':hover?'#dffdfa':color;g.lineWidth=selected?2.2:hover?1.7:.9;if(back&&state.view==='FB')g.setLineDash([4,3]);roundedRect(g,box.x,box.y,box.w,box.h,3);g.fill();g.stroke();g.setLineDash([]);
      if(state.layers.refs&&t.s*2.8>7){const font=Math.max(8,Math.min(13,9+Math.log2(Math.max(.6,state.zoom)))),text=fp.reference;g.font=`700 ${font}px ui-monospace,SFMono-Regular,Menlo,monospace`;const tw=g.measureText(text).width,tx=clamp(c.x-tw/2,2,w-tw-2),ty=clamp(box.y-5,10,h-4);g.fillStyle='rgba(3,11,15,.86)';roundedRect(g,tx-3,ty-font+1,tw+6,font+5,3);g.fill();g.fillStyle='#f6fbff';g.fillText(text,tx,ty);}
      g.restore();state.hits.push({fp,box,center:c});
    }
    return {shown,matched};
  }

  function render(){
    if(!state.ctx)return;panel.classList.remove('hidden');empty.classList.add('hidden');const {w,h,dpr}=canvasSize(),g=canvas.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);g.fillStyle='#071019';g.fillRect(0,0,w,h);const t=transformFor(w,h);if(!t)return;
    drawSubstrate(g,t);drawCopper(g,t);drawVias(g,t);drawLayerGraphics(g,t);const stat=drawFootprints(g,t,w,h);drawEdges(g,t);
    const geo=state.ctx.geometry;status.textContent=`${state.view==='F'?'正面':state.view==='B'?'背面':'双面'} · ${stat.shown} footprint · ${geo.segments.length} tracks · ${geo.vias.length} vias · ${(t.b.max_x-t.b.min_x).toFixed(1)} × ${(t.b.max_y-t.b.min_y).toFixed(1)} mm`;
    count.textContent=state.query?`匹配 ${stat.matched} / ${stat.shown}`:`缩放 ${Math.round(state.zoom*100)}%`;
  }

  function hitAt(x,y){let best=null,bestScore=Infinity;for(const h of state.hits){const inside=x>=h.box.x&&x<=h.box.x+h.box.w&&y>=h.box.y&&y<=h.box.y+h.box.h,d=Math.hypot(x-h.center.x,y-h.center.y);if(inside||d<14){const s=inside?d*.1:d;if(s<bestScore){bestScore=s;best=h;}}}return best;}
  function showDrawer(fp){
    state.selectedRef=fp?.reference||'';if(!fp){drawer.classList.add('hidden');drawer.innerHTML='';render();return;}const padNums=[...new Set((fp.pads||[]).map(p=>p.number).filter(Boolean))];
    drawer.innerHTML=`<div class="pcb-drawer-head"><div><b>${esc(fp.reference)}</b><span>${esc(fp.value||'未标注 Value')}</span></div><button type="button" class="pcb-drawer-close">×</button></div><div class="pcb-drawer-grid"><label>封装</label><div>${esc(fp.package||'—')}</div><label>层</label><div>${esc(fp.layer||'—')}</div><label>位置</label><div>X ${num(fp.x).toFixed(2)} · Y ${num(fp.y).toFixed(2)} mm</div><label>旋转</label><div>${num(fp.rotation).toFixed(1)}°</div><label>焊盘</label><div>${(fp.pads||[]).length}${padNums.length?` · ${esc(padNums.slice(0,18).join(', '))}${padNums.length>18?'…':''}`:''}</div></div><div class="pcb-drawer-actions"><button type="button" class="pcb-open-photo-overlay">在实物画面显示位号</button><button type="button" class="pcb-copy-ref">复制 ${esc(fp.reference)}</button></div>`;
    drawer.classList.remove('hidden');drawer.querySelector('.pcb-drawer-close')?.addEventListener('click',()=>showDrawer(null));drawer.querySelector('.pcb-copy-ref')?.addEventListener('click',()=>navigator.clipboard?.writeText(fp.reference));drawer.querySelector('.pcb-open-photo-overlay')?.addEventListener('click',()=>{const ov=window.LabSightFootprintOverlay;if(!ov?.registration){document.querySelector('.viewer')?.scrollIntoView({behavior:'smooth',block:'center'});document.getElementById('refOverlayBtn')?.click();return;}ov.show?.();window.LabSightFootprintPro?.setMode?.('original');document.querySelector('.viewer')?.scrollIntoView({behavior:'smooth',block:'center'});});render();
  }

  function updateSearchResults(){
    state.query=search.value.trim();const q=state.query.toLowerCase();if(!q){searchResults.classList.add('hidden');searchResults.innerHTML='';render();return;}
    const list=(state.ctx?.footprints||[]).filter(fp=>[fp.reference,fp.value,fp.package,fp.layer].some(v=>String(v||'').toLowerCase().includes(q))).slice(0,18);
    searchResults.innerHTML=list.length?list.map(fp=>`<button type="button" data-ref="${esc(fp.reference)}"><b>${esc(fp.reference)}</b><span>${esc(fp.value||fp.package||'')}</span></button>`).join(''):'<div class="empty">没有匹配器件</div>';searchResults.classList.remove('hidden');
    searchResults.querySelectorAll('button[data-ref]').forEach(b=>b.addEventListener('click',()=>{const fp=(state.ctx?.footprints||[]).find(x=>x.reference===b.dataset.ref);if(fp){state.query='';search.value='';searchResults.classList.add('hidden');showDrawer(fp);}}));render();
  }

  function resetView(){state.zoom=1;state.panX=state.panY=0;render();}

  stage.addEventListener('wheel',e=>{if(!state.ctx)return;e.preventDefault();const before=state.zoom;state.zoom=clamp(state.zoom*(e.deltaY<0?1.13:.885),.35,8);if(Math.abs(state.zoom-before)>.001)render();},{passive:false});
  stage.addEventListener('pointerdown',e=>{if(e.button!==0)return;state.dragging=true;state.dragMoved=false;state.dragStartX=e.clientX;state.dragStartY=e.clientY;state.panStartX=state.panX;state.panStartY=state.panY;stage.classList.add('dragging');try{stage.setPointerCapture(e.pointerId);}catch{}});
  stage.addEventListener('pointermove',e=>{if(state.dragging){const dx=e.clientX-state.dragStartX,dy=e.clientY-state.dragStartY;if(Math.hypot(dx,dy)>3)state.dragMoved=true;state.panX=state.panStartX+dx;state.panY=state.panStartY+dy;render();return;}const r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top,h=hitAt(x,y),ref=h?.fp?.reference||'';if(ref!==state.hoverRef){state.hoverRef=ref;render();}});
  stage.addEventListener('pointerup',e=>{if(!state.dragging)return;state.dragging=false;stage.classList.remove('dragging');try{stage.releasePointerCapture(e.pointerId);}catch{}if(!state.dragMoved){const r=canvas.getBoundingClientRect(),h=hitAt(e.clientX-r.left,e.clientY-r.top);showDrawer(h?.fp||null);}});
  stage.addEventListener('pointercancel',()=>{state.dragging=false;stage.classList.remove('dragging');});stage.addEventListener('dblclick',resetView);

  viewBtns.forEach(b=>b.addEventListener('click',()=>{state.view=b.dataset.view;viewBtns.forEach(x=>x.classList.toggle('active',x===b));state.selectedRef='';drawer.classList.add('hidden');resetView();}));
  toggleBtns.forEach(b=>b.addEventListener('click',()=>{const k=b.dataset.toggle;state.layers[k]=!state.layers[k];b.classList.toggle('active',state.layers[k]);render();}));
  fitBtn.addEventListener('click',resetView);search.addEventListener('input',updateSearchResults);search.addEventListener('keydown',e=>{if(e.key==='Escape'){search.value='';state.query='';searchResults.classList.add('hidden');render();}});
  document.addEventListener('click',e=>{if(!panel.contains(e.target))searchResults.classList.add('hidden');});
  ibomBtn.addEventListener('click',()=>{if(state.ibomUrl)window.open(state.ibomUrl,'_blank','noopener');});
  window.addEventListener('resize',()=>requestAnimationFrame(render));

  async function loadProject(file){
    if(!file)return; status.textContent='正在本地解析 KiCad PCB 图层…';panel.classList.remove('hidden');empty.classList.remove('hidden');
    try{
      const zip=await JSZip.loadAsync(file);const names=Object.keys(zip.files).filter(n=>/\.kicad_pcb$/i.test(n)&&!/^__MACOSX\//.test(n));if(!names.length)throw new Error('ZIP 中没有 .kicad_pcb');
      const name=names[0],text=await zip.file(name).async('string'),ctx=parsePcbText(text,name);state.ctx=ctx;state.selectedRef=state.hoverRef='';state.query='';search.value='';resetView();panel.classList.remove('hidden');empty.classList.add('hidden');
      if(state.ibomUrl){URL.revokeObjectURL(state.ibomUrl);state.ibomUrl='';}
      const htmlNames=Object.keys(zip.files).filter(n=>/\.html?$/i.test(n)&&(/ibom/i.test(n)||/interactivehtmlbom/i.test(n))&&!/^__MACOSX\//.test(n));
      if(htmlNames.length){const html=await zip.file(htmlNames[0]).async('string');state.ibomUrl=URL.createObjectURL(new Blob([html],{type:'text/html'}));state.ibomName=htmlNames[0];ibomBtn.classList.remove('hidden');ibomBtn.title=`打开 ${htmlNames[0]}`;}else ibomBtn.classList.add('hidden');
      const geom=ctx.geometry;status.textContent=`已解析 ${name}：${ctx.footprints.length} footprints · ${geom.segments.length} tracks · ${geom.vias.length} vias · ${geom.graphics.filter(x=>/SilkS$/.test(x.layer)).length} silk primitives`;
      try{window.LabSightSession?.record?.('pcb_viewer_loaded',{filename:name,footprints:ctx.footprints.length,tracks:geom.segments.length,vias:geom.vias.length});}catch{}
      window.LabSightPCBViewerV2={getContext:()=>state.ctx,parsePcbText,render,fit:resetView};
      render();
    }catch(err){console.warn('PCB viewer parser:',err);state.ctx=null;empty.classList.remove('hidden');empty.innerHTML=`PCB 预览解析失败：<b>${esc(err.message)}</b>`;status.textContent='PCB 图层解析失败';}
  }
  projectInput.addEventListener('change',e=>loadProject(e.target.files?.[0]));
  window.addEventListener('labsight:kicad-placement-ready',()=>{const f=projectInput.files?.[0];if(f&&!state.ctx)setTimeout(()=>loadProject(f),0);});
  window.addEventListener('beforeunload',()=>{if(state.ibomUrl)URL.revokeObjectURL(state.ibomUrl);},{once:true});
})();