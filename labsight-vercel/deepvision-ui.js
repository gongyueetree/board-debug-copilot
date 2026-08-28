(() => {
  const esc = (v='') => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]));
  const pct = v => Number.isFinite(Number(v)) ? `${Math.round(Number(v) * 100)}%` : '';
  const chip = (text, cls='') => `<span class="dv-chip ${cls}">${esc(text)}</span>`;
  const kindZh = {
    board_title: '板名', silkscreen: '丝印', pin_label: '引脚标记', frequency: '频率标记',
    chip_marking: '芯片顶标', testpoint: '测试点', other: '其他标记'
  };

  function tryParseEmbeddedJson(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    const s = String(value).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
    const start = s.indexOf('{'), end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const candidate = s.slice(start, end + 1);
    try { return JSON.parse(candidate); } catch {}
    try { return JSON.parse(candidate.replace(/,\s*([}\]])/g,'$1')); } catch {}
    return null;
  }

  function normalizedResult(d) {
    const r = d?.result || {};
    if (r.board_identity || r.visible_texts || r.components || r.connectors) return r;
    return tryParseEmbeddedJson(r.raw_model_output) || tryParseEmbeddedJson(r.summary) || r;
  }

  function looksLikeJsonText(value) {
    const s = String(value || '').trim();
    return s.startsWith('{') || s.startsWith('[') || /"board_identity"|"visible_texts"|"components"/.test(s);
  }

  function section(title, icon, body, extra='') {
    if (!body) return '';
    return `<section class="dv-section ${extra}"><div class="dv-section-title"><span>${icon}</span><strong>${esc(title)}</strong></div>${body}</section>`;
  }

  function list(items, mapper) {
    if (!Array.isArray(items) || !items.length) return '';
    return `<div class="dv-list">${items.map(mapper).join('')}</div>`;
  }

  function renderUncertainItem(x) {
    if (x == null) return '';
    if (typeof x === 'string') return `<li>${esc(x)}</li>`;
    if (typeof x !== 'object') return `<li>${esc(String(x))}</li>`;
    const target = x.object || x.target || x.item || x.reference || x.region || '具体对象待补充';
    const reason = x.reason || x.why || x.uncertainty || '';
    const observed = x.observed || x.evidence || x.current_evidence || '';
    const how = x.how_to_confirm || x.confirmation || x.action || x.next_step || '';
    return `<li><strong>${esc(target)}</strong>${reason?`：${esc(reason)}`:''}${observed?`<div class="dv-evidence"><b>当前证据：</b>${esc(Array.isArray(observed)?observed.join('；'):observed)}</div>`:''}${how?`<div class="dv-infer"><b>确认方法：</b>${esc(how)}</div>`:''}</li>`;
  }

  function renderActionItem(x) {
    if (x == null) return '';
    if (typeof x === 'string') return `<li>${esc(x)}</li>`;
    if (typeof x !== 'object') return `<li>${esc(String(x))}</li>`;
    const target = x.object || x.target || x.item || x.reference || '';
    const action = x.action || x.step || x.how_to_confirm || '';
    const purpose = x.purpose || x.reason || x.goal || '';
    const main = [target, action].filter(Boolean).join('：') || '执行下一步检查';
    return `<li><strong>${esc(main)}</strong>${purpose?`<div class="dv-desc">目的：${esc(purpose)}</div>`:''}</li>`;
  }

  function renderDeepReport(d) {
    const r = normalizedResult(d), b = r.board_identity || {};
    const wrap = document.createElement('div');
    wrap.className = 'message assistant deepvision-report-message';
    const bubble = document.createElement('div');
    bubble.className = 'bubble dv-report';

    const facts = [];
    if (b.name) facts.push(chip(b.name, 'strong'));
    if (b.type) facts.push(chip(b.type));
    if (Number.isFinite(Number(b.confidence))) facts.push(chip(`置信度 ${pct(b.confidence)}`, Number(b.confidence) >= .85 ? 'good' : 'warn'));

    const texts = list((r.visible_texts || []).slice(0, 36), x => {
      const kind = kindZh[x.kind] || x.kind || '';
      const meta = [kind, x.region, Number.isFinite(Number(x.confidence)) ? pct(x.confidence) : ''].filter(Boolean);
      return `<div class="dv-row"><div class="dv-main"><strong>${esc(x.text || '未识别')}</strong></div><div class="dv-meta">${meta.map(m=>chip(m)).join('')}</div></div>`;
    });

    const comps = list((r.components || []).slice(0, 24), x => {
      const candidateList = Array.isArray(x.candidates) ? x.candidates.filter(Boolean) : [];
      const marking = x.marking || '';
      const likelyPart = x.likely_part || candidateList[0] || '';
      const title = [x.reference, likelyPart || marking || x.category || '型号待确认'].filter(Boolean).join(' · ');
      const desc = x.role || x.category || '';
      const observed = Array.isArray(x.observed) ? x.observed.filter(Boolean).slice(0,4) : [];
      const inferred = Array.isArray(x.inferred) ? x.inferred.filter(Boolean).slice(0,4) : [];
      const markingLine = marking ? `<div class="dv-evidence"><b>器件印字：</b>${esc(marking)}</div>` : '';
      const inferenceLine = likelyPart ? `<div class="dv-infer"><b>推断型号：</b>${esc(likelyPart)}${desc?` · <b>功能：</b>${esc(desc)}`:''}</div>` : (desc?`<div class="dv-infer"><b>功能判断：</b>${esc(desc)}</div>`:'');
      const candidates = candidateList.length > 1 ? `<div class="dv-candidates">其它候选：${candidateList.slice(1).map(c=>chip(c)).join('')}</div>` : '';
      return `<div class="dv-card"><div class="dv-card-head"><strong>${esc(title || '器件')}</strong>${Number.isFinite(Number(x.confidence)) ? chip(pct(x.confidence), Number(x.confidence)>=.8?'good':'warn') : ''}</div>${markingLine}${inferenceLine}${candidates}${observed.length?`<div class="dv-evidence"><b>识别依据：</b>${esc(observed.join('；'))}</div>`:''}${inferred.length?`<div class="dv-infer"><b>工程判断：</b>${esc(inferred.join('；'))}</div>`:''}</div>`;
    });

    const conns = list((r.connectors || []).slice(0, 16), x => {
      const labels = Array.isArray(x.labels) ? x.labels.filter(Boolean) : [];
      return `<div class="dv-card compact"><div class="dv-card-head"><strong>${esc(x.region || '接口')}</strong>${Number.isFinite(Number(x.confidence))?chip(pct(x.confidence)):''}</div>${labels.length?`<div class="dv-pinset">${labels.map(v=>chip(v,'pin')).join('')}</div>`:''}${x.function?`<div class="dv-desc">${esc(x.function)}</div>`:''}</div>`;
    });

    const chain = Array.isArray(r.signal_chain) ? r.signal_chain.filter(Boolean) : [];
    const uncertain = Array.isArray(r.uncertain_items) ? r.uncertain_items.filter(Boolean) : [];
    const next = Array.isArray(r.next_actions) ? r.next_actions.filter(Boolean) : [];
    const cleanSummary = (!r.parse_error && !looksLikeJsonText(r.summary)) ? r.summary : '';

    let html = `<div class="dv-header"><div><div class="dv-kicker">PCB 深度视觉</div><h3>${esc(b.name || 'PCB 深度视觉分析')}</h3></div><div class="dv-provider">${esc(String(d?.provider||'AI').toUpperCase())} · ${esc(d?.model||'')}</div></div>`;
    if (facts.length) html += `<div class="dv-chips">${facts.join('')}</div>`;
    if (r.parse_error || r.truncated) {
      html += `<div class="dv-summary" style="border-color:rgba(242,190,92,.45);background:rgba(242,190,92,.08)">本次模型输出的结构化结果不完整，已隐藏原始内容。请重新执行一次 PCB 深度视觉分析。</div>`;
    } else if (cleanSummary) {
      html += `<div class="dv-summary">${esc(cleanSummary)}</div>`;
    }
    html += section('可见丝印与标记','Aa',texts);
    html += section('关键器件 · 印字→型号→功能','▣',comps);
    html += section('接口与引脚','↔',conns);
    if (chain.length) html += section('信号链','→',`<ol class="dv-steps">${chain.map(x=>`<li>${esc(typeof x==='string'?x:JSON.stringify(x))}</li>`).join('')}</ol>`);
    if (r.board_function) html += section('整板功能','◎',`<div class="dv-prose">${esc(r.board_function)}</div>`);
    if (uncertain.length) html += section('仍需确认','?',`<ul class="dv-bullets">${uncertain.slice(0,12).map(renderUncertainItem).join('')}</ul>`,'uncertain');
    if (next.length) html += section('下一步建议','✓',`<ol class="dv-steps action">${next.slice(0,10).map(renderActionItem).join('')}</ol>`,'actions');

    const raw = r.raw_model_output || d?.result;
    if (raw) html += `<details class="dv-raw"><summary>技术诊断：查看原始模型输出</summary><pre>${esc(typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2))}</pre></details>`;

    bubble.innerHTML = html;
    wrap.appendChild(bubble);
    els.chat.appendChild(wrap);
    els.chat.scrollTop = els.chat.scrollHeight;
    return {wrap, result:r};
  }

  async function readableDeepVisionAnalyze(ev) {
    ev?.preventDefault?.();
    ev?.stopImmediatePropagation?.();
    if (els.deepVisionBtn?.dataset.running === '1') return;
    if (state.scene !== 'pcb') {
      state.scene='pcb';
      document.querySelectorAll('.scene').forEach(x=>x.classList.toggle('active',x.dataset.scene==='pcb'));
      if (typeof updateSceneUI === 'function') updateSceneUI();
    }
    const pack = buildDeepVisionPack();
    if (!pack) return;
    const q = (els.question.value || '').trim() || '深度识别这块 PCB：逐个读取主要器件顶标/印字，结合封装、周围电路和 KiCad 工程信息，推断最可能的完整型号及功能；对不能唯一确定的器件列出候选型号和置信度。然后读取板名、接口、测试点、时钟/频率标记，并给出整板功能。所有说明和建议请使用中文。';
    addMessage('user', `【PCB 深度视觉】${q}`);
    els.question.value='';
    const thinking=addMessage('assistant','正在进行 PCB 深度视觉分析：读取器件印字，并据此推断型号和功能…','thinking');
    els.deepVisionBtn.dataset.running='1';
    els.deepVisionBtn.disabled=true;
    els.analyzeBtn.disabled=els.sendBtn.disabled=true;
    els.deepVisionState.classList.remove('hidden');
    els.deepVisionState.textContent=`正在分析 1 张整板 + 6 个高清局部区域 · ${state.provider==='gemini'?'Gemini':'OpenAI'}…`;
    try {
      const payload={provider:state.provider,overview_image:pack.overview_image,tile_images:pack.tile_images,question:q,project_context:state.projectContext,source_width:pack.source_width,source_height:pack.source_height};
      const resp=await fetch('/api/pcb_deep_analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const d=await readJsonResponse(resp);
      thinking.remove();
      const rendered=renderDeepReport(d);
      const summary=(!rendered.result.parse_error && !looksLikeJsonText(rendered.result.summary)) ? (rendered.result.summary || rendered.result.board_function || `已完成 ${rendered.result.board_identity?.name || 'PCB'} 深度识别`) : 'PCB 深度视觉分析已完成，但本次结构化输出不完整。';
      state.conversation.push({role:'user',content:`PCB 深度视觉：${q}`},{role:'assistant',content:String(summary).slice(0,2500)});
      if(state.conversation.length>20) state.conversation=state.conversation.slice(-20);
      els.deepVisionState.textContent=`完成 · ${d.model} · ${d.source?.images||7} 张图 · 原始 ${d.source?.width||'?'}×${d.source?.height||'?'}`;
      extendSession();
      // Do not keep the analysis controls disabled while TTS is playing/falling back.
      // Voice can fail or wait on a remote realtime session; Deep Vision must remain independently clickable.
      els.deepVisionBtn.disabled=false;
      els.deepVisionBtn.dataset.running='0';
      els.analyzeBtn.disabled=els.sendBtn.disabled=false;
      if(els.autoSpeak.checked && summary) Promise.resolve(speakAnswer(String(summary))).catch(e=>console.warn('deep vision TTS:',e));
    } catch(e) {
      thinking.remove();
      addMessage('assistant',`PCB 深度视觉分析失败：${e.message}`);
      els.deepVisionState.textContent=`失败：${e.message}`;
    } finally {
      els.deepVisionBtn.disabled=false;
      els.deepVisionBtn.dataset.running='0';
      els.analyzeBtn.disabled=els.sendBtn.disabled=false;
    }
  }

  if (els?.deepVisionBtn) {
    els.deepVisionBtn.disabled=false;
    els.deepVisionBtn.dataset.running='0';
    els.deepVisionBtn.addEventListener('click', readableDeepVisionAnalyze, true);
  }
})();
