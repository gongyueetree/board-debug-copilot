(() => {
  /**
   * Convert rich/markdown AI output into text that is pleasant to read aloud.
   * Kept as a global because both voice-upgrade.js and realtime-voice.js override
   * speakAnswer() and historically referenced plainForSpeech() as a shared helper.
   */
  window.plainForSpeech = function plainForSpeech(input) {
    let text = String(input ?? '').trim();
    if (!text) return '';

    text = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/^\s{0,3}#{1,6}\s*/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+[.)、]\s*/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/[|]+/g, '，')
      .replace(/[◆■●▪▫►▶✓✔✦⌕📷🎙🔊⚠️]/g, ' ')
      .replace(/\n{2,}/g, '。')
      .replace(/\n/g, '，')
      .replace(/\s+/g, ' ')
      .replace(/([。！？；，])\s+/g, '$1')
      .trim();

    // Avoid reading UI/model prefixes such as "[GEMINI · gemini-2.5-flash]".
    text = text.replace(/^\[[^\]]{1,100}\]\s*/g, '');
    return text.slice(0, 6000);
  };
})();
