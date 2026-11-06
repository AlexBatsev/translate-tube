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

  // The watch page and Shorts use different players; take the one that is
  // playing the video in the address bar.
  function playerResponse(videoId) {
    const players = [document.getElementById('movie_player'), document.getElementById('shorts-player')];
    let fallback = null;
    for (const p of players) {
      try {
        const pr = p?.getPlayerResponse?.();
        if (!pr) continue;
        if (!videoId || pr.videoDetails?.videoId === videoId) return pr;
        fallback ??= pr;
      } catch {
        /* player not ready */
      }
    }
    const initial = window.ytInitialPlayerResponse;
    if (initial && (!videoId || initial.videoDetails?.videoId === videoId)) return initial;
    return fallback ?? initial;
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.source !== 'translate-tube-isolated') return;
    const { id, type } = ev.data;
    let payload = null;
    if (type === 'tracks') {
      const pr = playerResponse(ev.data.videoId);
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
