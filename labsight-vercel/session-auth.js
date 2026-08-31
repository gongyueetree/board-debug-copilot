(() => {
  // LabSight browser API session guard. Must load before app.js and other
  // feature scripts so same-origin /api/* calls automatically carry the token.
  const nativeFetch = window.fetch.bind(window);
  let token = '';
  let refreshing = null;

  const refreshToken = () => {
    if (!refreshing) {
      refreshing = nativeFetch('/api/session', {cache:'no-store'})
        .then(async r => {
          const d = await r.json();
          if (!r.ok) throw new Error(d?.detail || `HTTP ${r.status}`);
          token = d?.token || '';
          if (d?.auth === 'disabled') {
            console.warn('[LabSight] API 会话保护未启用：请在 Vercel 配置 LABSIGHT_SESSION_SECRET');
          }
          return token;
        })
        .catch(e => {
          console.warn('[LabSight] 获取会话令牌失败:', e);
          token = '';
          return '';
        })
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  };

  const apiPath = input => {
    const raw = typeof input === 'string' ? input : (input?.url || '');
    try {
      const url = new URL(raw, window.location.href);
      if (url.origin !== window.location.origin) return '';
      return url.pathname;
    } catch {
      return '';
    }
  };

  window.fetch = async (input, init) => {
    const path = apiPath(input);
    if (!path.startsWith('/api/') || path === '/api/session') return nativeFetch(input, init);
    if (!token) await refreshToken();

    const send = () => {
      const options = {...(init || {})};
      const headers = new Headers(options.headers || (typeof input !== 'string' ? input?.headers : undefined) || {});
      if (token) headers.set('X-LabSight-Session', token);
      options.headers = headers;
      return nativeFetch(input, options);
    };

    let response = await send();
    if (response.status === 401) {
      token = '';
      await refreshToken();
      if (token) response = await send();
    }
    return response;
  };

  void refreshToken();
})();
