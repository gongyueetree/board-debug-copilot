(() => {
  const waitForViewer = (attempt = 0) => {
    const panel = document.querySelector('.pcb-project-preview');
    if (!panel && attempt < 40) {
      setTimeout(() => waitForViewer(attempt + 1), 150);
      return;
    }
    if (!panel) return;

    const tabs = [...panel.querySelectorAll('[data-view]')];
    const tabF = panel.querySelector('[data-view="F"]');
    const tabFB = panel.querySelector('[data-view="FB"]');
    const tabB = panel.querySelector('[data-view="B"]');
    const legend = panel.querySelector('.pcb-preview-layer-legend');
    const status = panel.querySelector('.pcb-preview-status');

    if (tabF) {
      tabF.textContent = 'F';
      tabF.title = '正面：只显示 F 面器件/铜层；底层器件不会在此视图显示';
      tabF.setAttribute('aria-label', '正面');
    }
    if (tabFB) {
      tabFB.textContent = 'FB';
      tabFB.title = '双面：同时显示正面和背面器件/焊盘；背面使用半透明虚线显示';
      tabFB.setAttribute('aria-label', '双面');
    }
    if (tabB) {
      tabB.textContent = 'B';
      tabB.title = '背面：镜像查看 B 面器件、焊盘和铜层';
      tabB.setAttribute('aria-label', '背面');
    }

    const note = document.createElement('button');
    note.type = 'button';
    note.className = 'pcb-preview-side-note';
    note.title = '底层焊接的连接器/器件在 F 正面视图中会被隐藏；点击切换到 FB 双面视图';
    note.textContent = '底层器件：用 FB / B 查看';
    (legend || panel.querySelector('.pcb-preview-toolbar'))?.appendChild(note);

    const style = document.createElement('style');
    style.textContent = `
      .pcb-preview-side-note{margin-left:auto;border:1px solid rgba(88,166,255,.35);background:rgba(42,93,150,.14);color:#9ec8ff;border-radius:999px;padding:3px 9px;font-size:10px;cursor:pointer;white-space:nowrap}
      .pcb-preview-side-note:hover{background:rgba(42,93,150,.25);color:#d6e9ff}
      .pcb-preview-side-note.warn{border-color:rgba(255,176,46,.52);background:rgba(150,91,18,.18);color:#ffd58a}
      .pcb-preview-viewtabs button[data-view="FB"].active{box-shadow:inset 0 0 0 1px rgba(82,224,210,.45)}
    `;
    document.head.appendChild(style);

    let preferDualSide = true;

    const ctx = () => window.LabSightPCBViewerV2?.getContext?.() || null;
    const bottomStats = () => {
      const fps = ctx()?.footprints || [];
      const bottom = fps.filter(fp => /^B\./i.test(fp.layer || '') && !fp.excluded);
      const connectors = bottom.filter(fp => /^(J|P|CN)/i.test(fp.reference || '') || /Connector|PinHeader|Socket|Samtec/i.test(fp.package || ''));
      const pads = bottom.reduce((n, fp) => n + (fp.pads?.length || 0), 0);
      const connectorPads = connectors.reduce((n, fp) => n + (fp.pads?.length || 0), 0);
      return {bottom: bottom.length, connectors: connectors.length, pads, connectorPads};
    };

    const activeView = () => tabs.find(b => b.classList.contains('active'))?.dataset.view || 'F';

    const updateHint = () => {
      const s = bottomStats();
      if (!ctx()) {
        note.textContent = '底层器件：加载工程后自动切 FB';
        note.classList.remove('warn');
        return;
      }
      if (!s.bottom) {
        note.textContent = '未检测到 B 面器件';
        note.classList.remove('warn');
        return;
      }
      const v = activeView();
      if (v === 'F') {
        note.textContent = `当前仅正面 · B 面 ${s.bottom} 器件/${s.pads} 焊盘已隐藏 · 点此看双面`;
        note.classList.add('warn');
      } else if (v === 'FB') {
        note.textContent = `双面显示 · B 面 ${s.bottom} 器件/${s.pads} 焊盘${s.connectors ? ` · ${s.connectors} 个连接器` : ''}`;
        note.classList.remove('warn');
      } else {
        note.textContent = `背面显示 · ${s.bottom} 器件/${s.pads} 焊盘${s.connectorPads ? ` · 连接器焊盘 ${s.connectorPads}` : ''}`;
        note.classList.remove('warn');
      }
    };

    const switchToDualSide = () => {
      if (!tabFB) return;
      if (!tabFB.classList.contains('active')) tabFB.click();
      requestAnimationFrame(updateHint);
    };

    note.addEventListener('click', switchToDualSide);
    tabs.forEach(b => b.addEventListener('click', () => {
      preferDualSide = false; // honor an explicit user choice afterwards
      setTimeout(updateHint, 0);
    }));

    const autoDualSideIfUseful = () => {
      const s = bottomStats();
      if (!ctx()) {
        updateHint();
        return;
      }
      if (!s.bottom) {
        updateHint();
        return;
      }
      // iBOM-style default: when a board has back-side assembly, start in FB so
      // bottom-mounted connectors and their pads are not silently missing.
      if (preferDualSide && tabFB) switchToDualSide();
      updateHint();
    };

    document.getElementById('projectFile')?.addEventListener('change', () => {
      preferDualSide = true;
      setTimeout(autoDualSideIfUseful, 180);
      setTimeout(autoDualSideIfUseful, 700);
      setTimeout(autoDualSideIfUseful, 1400);
    });
    window.addEventListener('labsight:kicad-placement-ready', () => {
      preferDualSide = true;
      setTimeout(autoDualSideIfUseful, 220);
      setTimeout(autoDualSideIfUseful, 900);
    });

    const observer = new MutationObserver(() => {
      if (status?.textContent?.includes('已解析')) autoDualSideIfUseful();
    });
    if (status) observer.observe(status, {childList:true, characterData:true, subtree:true});

    setTimeout(autoDualSideIfUseful, 50);
    setTimeout(autoDualSideIfUseful, 500);
    window.addEventListener('beforeunload', () => observer.disconnect(), {once:true});
  };

  waitForViewer();
})();
