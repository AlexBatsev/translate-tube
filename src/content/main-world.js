// Runs in the page's own JavaScript world. YouTube signs caption requests,
// so we watch the player's own caption requests and remember their URLs.
// The isolated content script (youtube.js) asks for them via postMessage.
(() => {
  if (window.__translateTubeMain) return;
  window.__translateTubeMain = true;

  const captured = []; // { url, videoId }
  const remember = (url) => {
    try {
      const u = new URL(url, location.href);
      if (!u.pathname.includes('/api/timedtext')) return;
      captured.push({ url: u.href, videoId: u.searchParams.get('v') });
      if (captured.length > 20) captured.shift();
      window.postMessage({ source: 'translate-tube-main', type: 'captured', videoId: u.searchParams.get('v') }, location.origin);
    } catch {
      /* ignore */
    }
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    remember(String(url));
    return origOpen.call(this, method, url, ...rest);
  };
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    remember(typeof input === 'string' ? input : input?.url ?? String(input));
    return origFetch.call(this, input, init);
  };

  function playerResponse() {
    const player = document.getElementById('movie_player');
    try {
      return player?.getPlayerResponse?.() ?? window.ytInitialPlayerResponse;
    } catch {
      return window.ytInitialPlayerResponse;
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.source !== 'translate-tube-isolated') return;
    const { id, type } = ev.data;
    let payload = null;
    if (type === 'tracks') {
      const pr = playerResponse();
      payload = {
        videoId: pr?.videoDetails?.videoId ?? null,
        title: pr?.videoDetails?.title ?? document.title,
        tracks: (pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []).map((t) => ({
          baseUrl: t.baseUrl,
          lang: t.languageCode,
          kind: t.kind ?? '',
          name: t.name?.simpleText ?? t.name?.runs?.map((r) => r.text).join('') ?? t.languageCode
        }))
      };
    } else if (type === 'captured') {
      payload = captured.filter((c) => c.videoId === ev.data.videoId).map((c) => c.url);
    }
    window.postMessage({ source: 'translate-tube-main', type: 'reply', id, payload }, location.origin);
  });
})();
