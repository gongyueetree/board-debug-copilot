(() => {
  const bar = document.querySelector('.capturebar');
  if (!bar || bar.dataset.organized === '1') return;

  const ids = {
    primary: ['captureBtn', 'analyzeBtn', 'deepVisionBtn'],
    tools: [
      'refOverlayBtn',
      'refOverlayRecalibrateBtn',
      'refOverlayAdjustBtn',
    ],
  };

  const byId = id => document.getElementById(id);
  const modeButtons = [...bar.querySelectorAll('.ref-overlay-mode')];
  const primaryNodes = ids.primary.map(byId).filter(Boolean);
  const toolNodes = [...ids.tools.map(byId).filter(Boolean), ...modeButtons.filter(x => !ids.tools.includes(x.id))];
  const optionNodes = [...bar.querySelectorAll(':scope > .toggle')];

  if (!primaryNodes.length) return;

  const primaryRow = document.createElement('div');
  primaryRow.className = 'capturebar-row capturebar-primary-row';

  const primaryActions = document.createElement('div');
  primaryActions.className = 'capturebar-primary-actions';
  primaryNodes.forEach(node => primaryActions.appendChild(node));

  const options = document.createElement('div');
  options.className = 'capturebar-options';
  optionNodes.forEach(node => options.appendChild(node));

  primaryRow.append(primaryActions, options);

  const toolRow = document.createElement('div');
  toolRow.className = 'capturebar-row capturebar-tool-row';
  const toolLabel = document.createElement('span');
  toolLabel.className = 'capturebar-tool-label';
  toolLabel.textContent = 'PCB 对齐';
  const tools = document.createElement('div');
  tools.className = 'capturebar-calibration-actions';
  toolNodes.forEach(node => tools.appendChild(node));
  toolRow.append(toolLabel, tools);

  [...bar.children].forEach(node => node.remove());
  bar.append(primaryRow, toolRow);
  bar.classList.add('capturebar-organized');
  bar.dataset.organized = '1';

  const updateToolRow = () => {
    const hasVisibleTool = [...tools.children].some(node => !node.classList.contains('hidden') && !node.hidden);
    toolRow.classList.toggle('capturebar-tools-empty', !hasVisibleTool);
  };

  updateToolRow();
  const observer = new MutationObserver(updateToolRow);
  observer.observe(tools, {subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'style']});

  window.addEventListener('beforeunload', () => observer.disconnect(), {once:true});
})();
