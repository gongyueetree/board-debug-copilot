(() => {
  let assemblyCtx = null;

  const isAssemblyQuestion = q => /(未焊|没焊|没有焊|漏焊|漏装|未装|没装|少焊|缺件|哪些器件.*焊|哪些元件.*焊|unpopulated|missing\s+component)/i.test(String(q || ''));

  function balancedBlocks(text, token) {
    const out = [];
    let start = 0;
    while (true) {
      const i = text.indexOf(token, start);
      if (i < 0) break;
      let depth = 0, inStr = false, esc = false, done = false;
      for (let j = i; j < text.length; j++) {
        const c = text[j];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
        } else {
          if (c === '"') inStr = true;
          else if (c === '(') depth++;
          else if (c === ')') {
            depth--;
            if (depth === 0) {
              out.push(text.slice(i, j + 1));
              start = j + 1;
              done = true;
              break;
            }
          }
        }
      }
      if (!done) break;
    }
    return out;
  }

  const prop = (block, name) => {
    const m = block.match(new RegExp('\\(property\\s+"' + name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '"\\s+"([^"]*)"'));
    return m ? m[1] : '';
  };

  const firstAt = block => {
    const m = block.match(/^\s*\(at\s+([-\d.]+)\s+([-\d.]+)(?:\s+([-\d.]+))?/m);
    return m ? {x:+m[1], y:+m[2], r:+(m[3] || 0)} : null;
  };

  function boardBBox(text, footprints) {
    const pts = [];
    const edgeBlocks = [...balancedBlocks(text, '(gr_line '), ...balancedBlocks(text, '(gr_arc '), ...balancedBlocks(text, '(gr_rect ')];
    edgeBlocks.filter(b => /\(layer\s+"Edge\.Cuts"\)/.test(b)).forEach(b => {
      for (const m of b.matchAll(/\((?:start|end|mid)\s+([-\d.]+)\s+([-\d.]+)\)/g)) pts.push([+m[1], +m[2]]);
    });
    if (!pts.length) footprints.forEach(f => pts.push([f.x, f.y]));
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return {min_x:Math.min(...xs), max_x:Math.max(...xs), min_y:Math.min(...ys), max_y:Math.max(...ys)};
  }

  function parsePcb(text, filename='') {
    const footprints = [];
    for (const b of balancedBlocks(text, '(footprint ')) {
      const head = b.match(/^\(footprint\s+"([^"]+)"/);
      const at = firstAt(b);
      if (!at) continue;
      const reference = prop(b, 'Reference');
      if (!reference) continue;
      const value = prop(b, 'Value');
      const packageName = head ? head[1] : '';
      const layer = (b.match(/\(layer\s+"([^"]+)"\)/) || [])[1] || '';
      const attr = (b.match(/\(attr\s+([^\)]+)\)/) || [])[1] || '';
      // KiCad may contain footprints that intentionally remain bare copper contacts.
      // Pogo/test/card-edge contacts, mounting holes and test points are not "missing soldered parts".
      const bareContact = /PogoPin|TestPoint|MountingHole|CardEdge|Edge_Connector/i.test(packageName);
      const excluded = /exclude_from_pos_files|exclude_from_bom/.test(attr) || /^H\d+$/i.test(reference) || /^TP\d+$/i.test(reference) || bareContact;
      const rad = at.r * Math.PI / 180;
      const pads = [];
      for (const pb of balancedBlocks(b, '(pad ')) {
        const n = (pb.match(/^\(pad\s+"?([^"\s()]*)"?\s+/) || [])[1] || '';
        const pa = firstAt(pb);
        if (!pa) continue;
        const gx = at.x + pa.x * Math.cos(rad) - pa.y * Math.sin(rad);
        const gy = at.y + pa.x * Math.sin(rad) + pa.y * Math.cos(rad);
        pads.push({number:n, x:+gx.toFixed(4), y:+gy.toFixed(4)});
      }
      footprints.push({
        reference, value, package:packageName, layer,
        x:at.x, y:at.y, rotation:at.r, excluded, pads,
      });
    }
    const bbox = boardBBox(text, footprints);
    return {filename, footprints, board_bbox:bbox};
  }

  function placementMap(ctx) {
    const b = ctx.board_bbox;
    const bw = Math.max(1, b.max_x - b.min_x), bh = Math.max(1, b.max_y - b.min_y);
    const W = 1600, H = Math.round(W * bh / bw), pad = 55;
    const c = document.createElement('canvas'); c.width = W; c.height = Math.max(700, Math.min(1200, H));
    const g = c.getContext('2d');
    g.fillStyle = '#0b1117'; g.fillRect(0,0,c.width,c.height);
    const sx = (c.width - pad*2)/bw, sy = (c.height-pad*2)/bh, s = Math.min(sx,sy);
    const ox = (c.width-bw*s)/2, oy=(c.height-bh*s)/2;
    const X=x=>ox+(x-b.min_x)*s, Y=y=>oy+(y-b.min_y)*s;
    g.strokeStyle='#67d6cb'; g.lineWidth=3; g.strokeRect(X(b.min_x),Y(b.min_y),bw*s,bh*s);
    g.font='bold 18px ui-monospace,monospace'; g.textAlign='center'; g.textBaseline='middle';
    for(const fp of ctx.footprints){
      if(fp.excluded) continue;
      const px=fp.pads.map(p=>X(p.x)), py=fp.pads.map(p=>Y(p.y));
      const cx=X(fp.x), cy=Y(fp.y);
      g.strokeStyle='rgba(110,174,255,.8)'; g.fillStyle='rgba(110,174,255,.18)'; g.lineWidth=2;
      if(px.length){
        const minx=Math.min(...px)-7,maxx=Math.max(...px)+7,miny=Math.min(...py)-7,maxy=Math.max(...py)+7;
        g.fillRect(minx,miny,Math.max(14,maxx-minx),Math.max(14,maxy-miny)); g.strokeRect(minx,miny,Math.max(14,maxx-minx),Math.max(14,maxy-miny));
        for(let i=0;i<px.length;i++){g.beginPath();g.arc(px[i],py[i],4,0,Math.PI*2);g.fillStyle='#ffd36a';g.fill();}
      }
      g.fillStyle='#ffffff'; g.fillText(fp.reference,cx,cy-16);
    }
    g.textAlign='left'; g.fillStyle='#9fb4c5'; g.font='16px system-ui';
    g.fillText('KiCad placement / pad groups — 同一蓝框内焊盘属于同一器件',22,28);
    return c.toDataURL('image/jpeg', .88);
  }

  async function parseProjectFile(file) {
    if (!file || !window.JSZip) return;
    try {
      const zip = await JSZip.loadAsync(file);
      const names = Object.keys(zip.files).filter(n => /\.kicad_pcb$/i.test(n) && !/^__MACOSX\//.test(n));
      if (!names.length) return;
      const text = await zip.file(names[0]).async('string');
      assemblyCtx = parsePcb(text, names[0]);
      window.labsightAssemblyContext = assemblyCtx;
      const n = assemblyCtx.footprints.filter(f => !f.excluded).length;
      if (els.projectStatus) {
        const base = els.projectStatus.textContent.replace(/\s*·\s*装配定位.*$/, '');
        els.projectStatus.textContent = `${base} · 装配定位 ${n} 器件`;
      }
      console.debug('Assembly map ready:', assemblyCtx);
    } catch(e) { console.warn('KiCad assembly parser:', e); }
  }

  function renderResult(d) {
    const r = d.result || {};
    const missing = Array.isArray(r.missing) ? r.missing : [];
    const uncertain = Array.isArray(r.uncertain) ? r.uncertain : [];
    const wrap=document.createElement('div'); wrap.className='message assistant assembly-result-message';
    const bubble=document.createElement('div'); bubble.className='bubble assembly-result';
    const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const summary = r.summary || (missing.length ? `确认未焊接：${missing.map(x=>x.reference).join('、')}。` : '未发现可确认的漏装器件。');
    let html=`<div class="assembly-summary"><strong>${esc(summary)}</strong></div>`;
    if(missing.length){
      html += `<div class="assembly-title">确认未焊接</div><div class="assembly-list">` + missing.map(x=>`<div class="assembly-item missing"><b>${esc(x.reference)}</b>${x.value?` <span>${esc(x.value)}</span>`:''}<em>${Math.round((Number(x.confidence)||0)*100)}%</em><small>${esc(x.reason||'')}</small></div>`).join('') + `</div>`;
    }
    if(uncertain.length){
      html += `<div class="assembly-title muted">无法确认</div><div class="assembly-list">` + uncertain.slice(0,8).map(x=>`<div class="assembly-item uncertain"><b>${esc(x.reference)}</b>${x.value?` <span>${esc(x.value)}</span>`:''}<small>${esc(x.reason||'')}</small></div>`).join('') + `</div>`;
    }
    bubble.innerHTML=html; wrap.appendChild(bubble); els.chat.appendChild(wrap); els.chat.scrollTop=els.chat.scrollHeight;
    return summary;
  }

  async function assemblyInspect(question) {
    if (!assemblyCtx) {
      addMessage('assistant','请先上传包含 .kicad_pcb 的 KiCad 工程 ZIP；装配检查需要 PCB 中的 footprint 和 pad 坐标。');
      return;
    }
    const native = getNativeFrameCanvas();
    if (!native) { alert('请先连接摄像头。'); return; }
    addMessage('user', question);
    els.question.value='';
    const thinking=addMessage('assistant','正在按 KiCad 器件坐标逐个对照实物，只检查漏装器件…','thinking');
    els.sendBtn.disabled=els.analyzeBtn.disabled=true;
    try{
      const board = canvasScaledDataURL(native,2300,.90).data;
      const payload={provider:state.provider,board_image:board,placement_map_image:placementMap(assemblyCtx),footprints:assemblyCtx.footprints,board_bbox:assemblyCtx.board_bbox,question};
      const resp=await fetch('/api/assembly_inspect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const d=await readJsonResponse(resp); thinking.remove();
      const summary=renderResult(d);
      state.conversation.push({role:'user',content:question},{role:'assistant',content:summary});
      if(state.conversation.length>20) state.conversation=state.conversation.slice(-20);
      if(els.autoSpeak.checked) await speakAnswer(summary);
    }catch(e){thinking.remove();addMessage('assistant',`装配检查失败：${e.message}`);}
    finally{els.sendBtn.disabled=els.analyzeBtn.disabled=false;}
  }

  const legacyAskAI = askAI;
  askAI = async function(questionOverride=null){
    const q = String(questionOverride ?? els.question.value ?? '').trim();
    if(state.scene==='pcb' && isAssemblyQuestion(q)) return assemblyInspect(q || '检查哪些器件没有焊接。');
    return legacyAskAI(questionOverride);
  };

  els.projectFile?.addEventListener('change', e => parseProjectFile(e.target.files?.[0]));

  const quick = document.querySelector('.quickprompts');
  if (quick) {
    const b=document.createElement('button');
    b.textContent='检查漏装器件';
    b.dataset.prompt='对比我上传的 KiCad PCB 工程和当前真实板子，只告诉我哪些器件没有焊接。';
    b.addEventListener('click',()=>askAI(b.dataset.prompt));
    quick.appendChild(b);
  }
})();
