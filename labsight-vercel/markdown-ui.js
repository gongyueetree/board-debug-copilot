(() => {
  const escapeHtml = (value='') => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function renderInline(value='') {
    let s = escapeHtml(value);
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, code) => {
      const token = `@@CODE_${codes.length}@@`;
      codes.push(`<code>${code}</code>`);
      return token;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
    codes.forEach((html, i) => { s = s.replace(`@@CODE_${i}@@`, html); });
    return s;
  }

  function renderMarkdown(markdown='') {
    const text = String(markdown || '').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      if (/^```/.test(line.trim())) {
        const lang = line.trim().slice(3).trim();
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i++]);
        if (i < lines.length) i++;
        out.push(`<pre class="md-code"><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`);
        continue;
      }

      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      if (heading) {
        const level = Math.min(4, heading[1].length + 2);
        out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        i++;
        continue;
      }

      if (/^\s*[-*_]{3,}\s*$/.test(line)) {
        out.push('<hr>'); i++; continue;
      }

      if (/^\s*>\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${quote.map(renderInline).join('<br>')}</blockquote>`);
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ''));
        out.push(`<ul>${items.map(v => `<li>${renderInline(v)}</li>`).join('')}</ul>`);
        continue;
      }

      if (/^\s*\d+[.)]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
        out.push(`<ol>${items.map(v => `<li>${renderInline(v)}</li>`).join('')}</ol>`);
        continue;
      }

      const paragraph = [line.trim()];
      i++;
      while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s+/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) && !/^```/.test(lines[i].trim()) && !/^\s*[-*_]{3,}\s*$/.test(lines[i])) {
        paragraph.push(lines[i].trim()); i++;
      }
      out.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
    }
    return out.join('');
  }

  function markdownAddMessage(role, text, klass='') {
    const wrap = document.createElement('div');
    wrap.className = `message ${role} ${klass}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (role === 'assistant' && !klass.includes('thinking')) {
      bubble.classList.add('markdown-body');
      bubble.innerHTML = renderMarkdown(text);
    } else {
      bubble.textContent = text;
    }
    wrap.appendChild(bubble);
    els.chat.appendChild(wrap);
    els.chat.scrollTop = els.chat.scrollHeight;
    return wrap;
  }

  window.renderLabSightMarkdown = renderMarkdown;
  window.addMessage = markdownAddMessage;
})();
