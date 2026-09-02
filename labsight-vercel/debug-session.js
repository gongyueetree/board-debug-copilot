(() => {
  'use strict';

  const STORAGE_KEY = 'labsight-debug-session-v1';
  const MAX_EVENTS = 120;
  const nowIso = () => new Date().toISOString();
  const uid = (p='EV') => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;

  const load = () => {
    try {
      const x = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (x && x.version === 1) return x;
    } catch {}
    return {
      version: 1,
      id: uid('DBG'),
      created_at: nowIso(),
      status: 'OBSERVATION',
      identity: { project: '', board: '', revision: '', variant: '', status: 'pending', confidence: null },
      devices: [],
      events: [],
      hypotheses: [],
      next_test: null,
    };
  };

  let session = load();
  const save = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(session));

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function record(type, payload={}, source='browser') {
    const event = { id: uid(), time: nowIso(), type, source, payload };
    session.events.push(event);
    if (session.events.length > MAX_EVENTS) session.events = session.events.slice(-MAX_EVENTS);
    save(); render();
    window.dispatchEvent(new CustomEvent('labsight:evidence', { detail: event }));
    return event;
  }

  function setIdentity(patch, evidence='local') {
    session.identity = {...session.identity, ...patch};
    const i = session.identity;
    i.status = (i.board || i.project) ? (i.revision ? 'confirmed_candidate' : 'partial') : 'pending';
    save();
    record('identity_update', { ...i, evidence }, 'project');
  }

  function refreshDevices() {
    const list = [];
    try {
      const st = window.state;
      const stream = st?.stream;
      if (stream) {
        for (const t of stream.getTracks()) {
          const s = t.getSettings?.() || {};
          list.push({
            id: t.id,
            type: t.kind === 'video' ? 'rgb_camera' : 'microphone',
            label: t.label || t.kind,
            connection: 'browser_media',
            settings: t.kind === 'video' ? {width:s.width,height:s.height,frameRate:s.frameRate} : {sampleRate:s.sampleRate,channelCount:s.channelCount},
            state: t.readyState,
          });
        }
      }
    } catch {}
    session.devices = list;
    save(); render();
  }

  function parseProjectIdentity(file) {
    if (!file) return;
    const name = file.name.replace(/\.zip$/i,'');
    const rev = name.match(/(?:rev(?:ision)?|版本|版)[-_ .]*([A-Za-z0-9.]+)/i)?.[1] || '';
    setIdentity({ project:name, board:name, revision:rev }, 'kicad_zip_filename');

    // assembly-inspection.js publishes richer PCB context after parsing.
    setTimeout(() => {
      const ctx = window.labsightAssemblyContext;
      if (!ctx) return;
      const pcb = String(ctx.filename || '').split('/').pop()?.replace(/\.kicad_pcb$/i,'') || name;
      setIdentity({ board: pcb }, 'kicad_pcb');
      record('project_context_ready', {
        pcb_file: ctx.filename || '',
        footprint_count: Array.isArray(ctx.footprints) ? ctx.footprints.filter(x=>!x.excluded).length : 0,
        board_bbox: ctx.board_bbox || null,
      }, 'kicad');
    }, 700);
  }

  function extractReasoningCandidate(text) {
    const s = String(text || '').trim();
    if (!s || s.length < 20) return;
    const hypothesisWords = /(可能|怀疑|候选|假设|原因|根因|suspect|hypothesis)/i;
    const nextWords = /(下一步|建议|先检查|请测量|应检查|next step)/i;
    if (hypothesisWords.test(s)) {
      const short = s.replace(/\s+/g,' ').slice(0,260);
      if (!session.hypotheses.some(h => h.statement === short)) {
        session.hypotheses.unshift({id:uid('H'), statement:short, status:'candidate', evidence_event_ids:session.events.slice(-4).map(e=>e.id), created_at:nowIso()});
        session.hypotheses = session.hypotheses.slice(0,6);
      }
    }
    if (nextWords.test(s)) {
      const lines = s.split(/\n+/).map(x=>x.trim()).filter(Boolean);
      const line = lines.find(x=>nextWords.test(x)) || lines[0];
      session.next_test = { id:uid('T'), instruction:String(line).slice(0,220), risk:'unclassified', status:'candidate', created_at:nowIso() };
    }
    save(); render();
  }

  function observeChat() {
    const chat = document.getElementById('chat');
    if (!chat) return;
    const seen = new WeakSet();
    const scan = node => {
      if (!(node instanceof HTMLElement)) return;
      const msg = node.matches('.message') ? node : node.querySelector?.('.message');
      if (!msg || seen.has(msg) || msg.classList.contains('thinking')) return;
      seen.add(msg);
      const text = msg.innerText?.trim();
      if (!text) return;
      const role = msg.classList.contains('user') ? 'user' : 'assistant';
      record(role === 'user' ? 'operator_question' : 'ai_response', {text:text.slice(0,4000)}, role);
      if (role === 'assistant') extractReasoningCandidate(text);
    };
    chat.querySelectorAll('.message').forEach(scan);
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(scan))).observe(chat,{childList:true,subtree:true});
  }

  function bindEvidenceHooks() {
    const capture = document.getElementById('captureBtn');
    capture?.addEventListener('click', () => setTimeout(() => {
      const meta = document.getElementById('captureMeta')?.textContent || '';
      record('camera_capture', { meta, scene: window.state?.scene || 'unknown' }, 'camera');
    }, 120));

    document.getElementById('startCamera')?.addEventListener('click', () => setTimeout(() => {
      refreshDevices();
      if (session.devices.length) record('device_discovery', {devices:session.devices}, 'browser');
    }, 1300));

    document.getElementById('projectFile')?.addEventListener('change', e => parseProjectIdentity(e.target.files?.[0]));

    document.querySelectorAll('.scene').forEach(b => b.addEventListener('click', () => {
      record('scene_change', {scene:b.dataset.scene || 'unknown'}, 'ui');
    }));
  }

  function startNewSession() {
    if (!confirm('创建新的调试 Session？当前 Session 会从页面视图中结束，但仍可先导出保存。')) return;
    session = {
      version:1,id:uid('DBG'),created_at:nowIso(),status:'OBSERVATION',
      identity:{project:'',board:'',revision:'',variant:'',status:'pending',confidence:null},
      devices:[],events:[],hypotheses:[],next_test:null,
    };
    save(); refreshDevices(); render();
  }

  function exportSession() {
    const blob = new Blob([JSON.stringify(session,null,2)], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${session.id}.json`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }

  function render() {
    const root = document.getElementById('debugSessionPanel');
    if (!root) return;
    const i = session.identity;
    const identityText = i.board || i.project || '未确认';
    const events = session.events.slice(-8).reverse();
    const deviceText = session.devices.length ? session.devices.map(d => `${d.type==='rgb_camera'?'Camera':'Mic'} · ${d.label}`).join('<br>') : '尚未发现设备';
    root.innerHTML = `
      <div class="ds-head">
        <div><h2>Debug Session</h2><p>${esc(session.id)} · ${esc(session.status)}</p></div>
        <div class="ds-actions"><button id="dsExport">导出证据</button><button id="dsNew">新 Session</button></div>
      </div>
      <div class="ds-grid">
        <section class="ds-card">
          <label>Board Identity</label>
          <strong>${esc(identityText)}</strong>
          <span>${i.revision ? `Revision ${esc(i.revision)} · ` : ''}${esc(i.status)}</span>
        </section>
        <section class="ds-card">
          <label>Devices</label>
          <div>${deviceText}</div>
        </section>
        <section class="ds-card ds-wide">
          <label>Evidence Timeline</label>
          <div class="ds-timeline">${events.length ? events.map(e=>`<div><time>${new Date(e.time).toLocaleTimeString()}</time><b>${esc(e.type)}</b><span>${esc(summaryEvent(e))}</span></div>`).join('') : '<em>还没有证据事件。连接设备、抓图或提问后会自动记录。</em>'}</div>
        </section>
        <section class="ds-card">
          <label>Hypothesis Candidates</label>
          <div class="ds-hyp">${session.hypotheses.length ? session.hypotheses.slice(0,3).map(h=>`<div><span class="ds-dot"></span>${esc(h.statement)}</div>`).join('') : '<em>等待证据，不提前猜根因。</em>'}</div>
        </section>
        <section class="ds-card">
          <label>Next Test Candidate</label>
          <div>${session.next_test ? esc(session.next_test.instruction) : '<em>等待 AI 基于证据提出下一步测试。</em>'}</div>
        </section>
      </div>`;
    document.getElementById('dsExport')?.addEventListener('click', exportSession);
    document.getElementById('dsNew')?.addEventListener('click', startNewSession);
  }

  function summaryEvent(e) {
    const p=e.payload||{};
    if (e.type==='camera_capture') return p.meta || p.scene || '';
    if (e.type==='operator_question'||e.type==='ai_response') return String(p.text||'').replace(/\s+/g,' ').slice(0,100);
    if (e.type==='identity_update') return p.board || p.project || '';
    if (e.type==='device_discovery') return `${p.devices?.length||0} devices`;
    if (e.type==='project_context_ready') return `${p.footprint_count||0} footprints`;
    if (e.type==='scene_change') return p.scene || '';
    return '';
  }

  function mount() {
    const project = document.querySelector('.project-panel');
    if (!project) return;
    const panel = document.createElement('div');
    panel.id='debugSessionPanel';
    panel.className='panel debug-session-panel';
    project.insertAdjacentElement('afterend', panel);
    render();
    bindEvidenceHooks();
    observeChat();
    refreshDevices();

    // Public, intentionally small integration surface for later instrument adapters.
    window.LabSightSession = {
      get: () => JSON.parse(JSON.stringify(session)),
      record,
      setIdentity,
      refreshDevices,
      setHypothesis(statement,status='candidate',evidence_event_ids=[]) {
        session.hypotheses.unshift({id:uid('H'),statement,status,evidence_event_ids,created_at:nowIso()});
        session.hypotheses=session.hypotheses.slice(0,12);save();render();
      },
      setNextTest(test) { session.next_test={id:uid('T'),risk:'unclassified',status:'candidate',created_at:nowIso(),...test};save();render(); },
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
