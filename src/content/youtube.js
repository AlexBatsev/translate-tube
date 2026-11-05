// Isolated content script on youtube.com. Answers the side panel: video
// position, play/pause/seek, and the caption track of the video.
(() => {
  if (window.__translateTube) return;
  window.__translateTube = true;

  let seq = 0;
  const pending = new Map();
  const waiters = new Set();

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.source !== 'translate-tube-main') return;
    if (ev.data.type === 'reply' && pending.has(ev.data.id)) {
      pending.get(ev.data.id)(ev.data.payload);
      pending.delete(ev.data.id);
    } else if (ev.data.type === 'captured') {
      for (const w of waiters) w(ev.data.videoId);
    }
  });

  function askMain(type, extra = {}) {
    const id = ++seq;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      window.postMessage({ source: 'translate-tube-isolated', id, type, ...extra }, location.origin);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve(null);
        }
      }, 2000);
    });
  }

  const video = () => document.querySelector('#movie_player video') ?? document.querySelector('video');
  const currentVideoId = () => new URL(location.href).searchParams.get('v');

  function info() {
    const v = video();
    return {
      videoId: currentVideoId(),
      title: document.querySelector('h1.ytd-watch-metadata')?.textContent?.trim() || document.title.replace(/ - YouTube$/, ''),
      ms: v ? Math.round(v.currentTime * 1000) : 0,
      paused: v ? v.paused : true,
      duration: v ? Math.round((v.duration || 0) * 1000) : 0
    };
  }

  async function fetchJson3(url) {
    const u = new URL(url, location.href);
    u.searchParams.set('fmt', 'json3');
    const res = await fetch(u.href, { credentials: 'include' });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trim()) return null;
    try {
      const json = JSON.parse(text);
      return json.events?.length ? json : null;
    } catch {
      return null;
    }
  }

  function pickTrack(tracks, lang) {
    const base = (l) => (l || '').toLowerCase().split('-')[0];
    const same = tracks.filter((t) => base(t.lang) === base(lang));
    return same.find((t) => t.kind !== 'asr') ?? same[0] ?? null;
  }

  function waitForCapture(videoId, ms) {
    return new Promise((resolve) => {
      const done = (id) => {
        if (id && id !== videoId) return;
        waiters.delete(done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => done(videoId), ms);
      waiters.add(done);
    });
  }

  // YouTube signs caption URLs (the "pot" parameter). If the plain URL comes
  // back empty, turn captions on for a moment so the player makes a signed
  // request, then reuse that URL for the language we want.
  async function transcript(lang) {
    const meta = await askMain('tracks');
    const videoId = currentVideoId();
    if (!meta || !meta.tracks?.length || meta.videoId !== videoId) {
      return { ok: false, reason: meta && meta.videoId === videoId ? 'no-captions' : 'not-ready' };
    }
    const track = pickTrack(meta.tracks, lang);
    if (!track) {
      return { ok: false, reason: 'no-language', available: meta.tracks.map((t) => `${t.name} (${t.lang})`) };
    }
    const retarget = (signedUrl) => {
      const u = new URL(signedUrl, location.href);
      const t = new URL(track.baseUrl, location.href);
      u.searchParams.set('lang', t.searchParams.get('lang') ?? track.lang);
      if (track.kind) u.searchParams.set('kind', track.kind);
      else u.searchParams.delete('kind');
      u.searchParams.delete('tlang');
      return u.href;
    };

    let json = await fetchJson3(track.baseUrl);
    if (!json) {
      let urls = await askMain('captured', { videoId });
      if (!urls?.length) {
        const btn = document.querySelector('.ytp-subtitles-button');
        const wasOn = btn?.getAttribute('aria-pressed') === 'true';
        if (btn) {
          const wait = waitForCapture(videoId, 4000);
          if (wasOn) {
            btn.click();
            await new Promise((r) => setTimeout(r, 150));
          }
          btn.click();
          await wait;
          if (!wasOn) btn.click();
        }
        urls = await askMain('captured', { videoId });
      }
      for (const url of [...(urls ?? [])].reverse()) {
        json = await fetchJson3(retarget(url));
        if (json) break;
      }
    }
    if (!json) return { ok: false, reason: 'blocked' };
    return { ok: true, json, track: { lang: track.lang, kind: track.kind, name: track.name }, videoId, title: meta.title };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const v = video();
    switch (msg?.type) {
      case 'tt:info':
        sendResponse(info());
        return false;
      case 'tt:seek':
        if (v) v.currentTime = msg.ms / 1000;
        sendResponse(info());
        return false;
      case 'tt:pause':
        v?.pause();
        sendResponse(info());
        return false;
      case 'tt:play':
        v?.play();
        sendResponse(info());
        return false;
      case 'tt:transcript':
        transcript(msg.lang).then(sendResponse, (e) => sendResponse({ ok: false, reason: 'error', error: String(e) }));
        return true;
      default:
        return false;
    }
  });
})();
