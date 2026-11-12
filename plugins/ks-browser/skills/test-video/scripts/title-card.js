// Title cards for agent-browser test videos.
//
// The MCP server loads this into every page (AGENT_BROWSER_INIT_SCRIPTS),
// after every navigation too. It defines window.__ksVideo:
//
//   __ksVideo.start()                          mark the start of the recording; click marks and captions on
//   __ksVideo.stop()                           click marks and captions off (call before stopping the recording)
//   __ksVideo.card(title, subtitle, ms, step)  title card over the blurred page for ms (default 6000)
//   __ksVideo.verdict(pass, note, ms)          PASS/FAIL banner at the top for ms (default 6000)
//   __ksVideo.note(text)                       transcript line, shown as a caption while recording
//   __ksVideo.hold(ms)                         promise that resolves after ms (the card's wait, in the same eval)
//   __ksVideo.until(predicate, timeoutMs)      promise that resolves when predicate() is true (polls every 500 ms)
//   __ksVideo.chapters()                       JSON {t0, chapters[]} for finish-video.mjs
//
// Look (the "Test video title cards" design canvas): a card blurs and dims
// the page behind it and shows a rounded charcoal panel in the middle, with a
// small step label, a large title and a subtitle. A verdict is a compact
// charcoal pill near the top with a green check or red cross, over the page
// left sharp, so the result it's about stays visible.
//
// Click marks (Loom style), from start() to stop(): every real press
// (pointerdown) shows a yellow circle at the pointer that fades in, grows
// with an ease-out curve and fades out in 0.7 s; nothing stays on screen.
// A double-click shows two, each at its own press. A field focused without
// a click (a `fill`) gets the same mark, so the viewer sees where typing
// goes. Script clicks (element.click()) fire no pointer events and show
// nothing. agent-browser's own `--cursor` draws the pointer itself.
//
// Captions, from start() to stop(): each note shows at the bottom of the page
// as white text in a black box (at the bottom, or the top while the pointer
// or the field being typed in is in the bottom 30%), for its reading time (15 characters a second,
// 2 to 12 s; finish-video.mjs keeps the video at real speed for the same
// time). A note written while one is still up joins it as a second line in
// the same box, two lines at most.
// They're drawn into the page, so they're in the recording itself and look
// the same in every player. Captions still up survive a navigation.
//
// Cards, verdicts and notes all become lines of the video's VTT transcript.
// card() and verdict() return at once; follow them with `wait <ms>` so the
// next action happens after they're gone. They are inert (no clicks, no
// focus) and hidden from accessibility snapshots. A thin progress bar runs
// along the bottom of each, which keeps the frames changing, so cutting the
// video's still stretches leaves them whole. Chapters live in localStorage,
// so they survive navigation within one origin.
(() => {
  if (window.__ksVideo) return 'ks-video ready';

  const KEY = '__ksVideo';
  const CARD_MS = 6000;
  const VERDICT_MS = 6000;
  const FADE_MS = 200;

  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || { t0: null, chapters: [] };
    } catch {
      return { t0: null, chapters: [] };
    }
  };
  const save = (s) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {}
  };

  const CSS = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      animation: in ${FADE_MS}ms ease-out, out ${FADE_MS}ms ease-in forwards;
      animation-delay: 0ms, var(--out-at); }
    .backdrop { position: absolute; inset: 0; background: rgba(20, 22, 26, 0.10);
      -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
    .center { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
    .card { position: relative; overflow: hidden; min-width: 520px; max-width: min(760px, 86vw);
      box-sizing: border-box; padding: 52px 72px 60px; border-radius: 28px; background: #45474b;
      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.35), 0 4px 14px rgba(0, 0, 0, 0.18);
      display: flex; flex-direction: column; align-items: center; gap: 14px; text-align: center; }
    .step { font-size: 14px; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: #b9bcc2; }
    .title { font-size: 46px; font-weight: 650; line-height: 1.15; color: #fff; }
    .sub { font-size: 22px; line-height: 1.4; color: #d3d5d9; }
    .top { position: absolute; top: 32px; left: 0; right: 0; display: flex; justify-content: center; }
    .pill { position: relative; overflow: hidden; display: flex; align-items: center; gap: 18px;
      max-width: 86vw; box-sizing: border-box; padding: 18px 32px 22px 22px; border-radius: 22px;
      background: #45474b; box-shadow: 0 20px 50px rgba(0, 0, 0, 0.30), 0 3px 10px rgba(0, 0, 0, 0.16); }
    .icon { flex: none; width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
    .pass .icon, .pass .fill { background: #1f9d55; }
    .fail .icon, .fail .fill { background: #d4472f; }
    .label { font-size: 14px; font-weight: 700; letter-spacing: 0.16em; }
    .pass .label { color: #8fe0a8; }
    .fail .label { color: #ffb4a8; }
    .note { font-size: 22px; font-weight: 600; color: #fff; }
    .track { position: absolute; left: 0; right: 0; bottom: 0; height: 5px; background: rgba(255, 255, 255, 0.10); }
    .fill { height: 100%; width: 100%; transform-origin: left; background: rgba(255, 255, 255, 0.55);
      animation: shrink linear forwards; animation-duration: var(--ms); }
    @keyframes shrink { from { transform: scaleX(1); } to { transform: scaleX(0); } }
    @keyframes in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes out { from { opacity: 1; } to { opacity: 0; } }
  `;

  const CHECK = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const CROSS = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';

  const show = (html, ms) => {
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('inert', '');
    host.dataset.ksVideo = '';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style><div class="layer">${html}</div>`;
    const layer = root.querySelector('.layer');
    layer.style.setProperty('--ms', `${ms}ms`);
    layer.style.setProperty('--out-at', `${Math.max(0, ms - FADE_MS)}ms`);
    (document.body || document.documentElement).appendChild(host);
    setTimeout(() => host.remove(), ms);
  };

  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const record = (entry) => {
    const s = load();
    s.chapters.push(entry);
    save(s);
    return entry.t;
  };

  // --- Pointer highlight ----------------------------------------------------
  const ON_KEY = '__ksVideoHighlight';
  const CLICK_MS = 700;
  // One click: a yellow circle fades in fast, grows with an ease-out curve,
  // and fades out as it reaches full size; nothing stays on screen after.
  const POINTER_CSS = `
    :host { all: initial; }
    .wrap { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }
    .click { position: absolute; width: 56px; height: 56px; margin: -28px 0 0 -28px; border-radius: 50%;
      background: rgba(255, 204, 0, 0.38); box-shadow: 0 0 0 3px rgba(255, 159, 10, 0.9);
      animation: click ${CLICK_MS}ms cubic-bezier(0.22, 1, 0.36, 1) forwards; }
    @keyframes click {
      0% { transform: scale(0.35); opacity: 0; }
      18% { opacity: 1; }
      100% { transform: scale(1.7); opacity: 0; }
    }
  `;
  let pointerWrap = null;
  let lastPointerAt = 0;
  const highlightOn = () => {
    try {
      return localStorage.getItem(ON_KEY) === '1';
    } catch {
      return false;
    }
  };
  const ensurePointerLayer = () => {
    if (pointerWrap && pointerWrap.isConnected) return true;
    const parent = document.body || document.documentElement;
    if (!parent) return false;
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('inert', '');
    host.dataset.ksVideoPointer = '';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${POINTER_CSS}</style><div class="wrap"></div>`;
    pointerWrap = root.querySelector('.wrap');
    parent.appendChild(host);
    return true;
  };
  const clickAt = (x, y) => {
    if (!highlightOn() || !ensurePointerLayer()) return;
    const mark = document.createElement('div');
    mark.className = 'click';
    mark.style.left = `${x}px`;
    mark.style.top = `${y}px`;
    pointerWrap.appendChild(mark);
    setTimeout(() => mark.remove(), CLICK_MS + 50);
  };
  // Where the action is, for placing captions out of its way.
  const trackAction = (y) => {
    actionY = y;
    placeCaptions();
  };
  const listen = { capture: true, passive: true };
  addEventListener('pointermove', (e) => {
    lastPointerAt = Date.now();
    if (highlightOn()) trackAction(e.clientY);
  }, listen);
  // Each press gets its own mark at once, so a double-click shows two. If a
  // double-click arrives with only one press (some drivers send a single
  // press with clickCount 2), dblclick adds the second mark.
  let pressesForDouble = 0;
  let lastDownAt = 0;
  addEventListener('pointerdown', (e) => {
    const now = Date.now();
    pressesForDouble = now - lastDownAt < 500 ? pressesForDouble + 1 : 1;
    lastDownAt = now;
    lastPointerAt = now;
    if (!highlightOn()) return;
    trackAction(e.clientY);
    clickAt(e.clientX, e.clientY);
  }, listen);
  addEventListener('dblclick', (e) => {
    if (!highlightOn() || pressesForDouble >= 2) return;
    clickAt(e.clientX, e.clientY);
  }, listen);
  // A field filled without a click gets the same mark, so the viewer sees
  // where typing goes.
  addEventListener('focusin', (e) => {
    if (!highlightOn() || Date.now() - lastPointerAt < 400) return;
    const el = e.target;
    if (!(el instanceof Element) || !el.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = r.left + Math.min(r.width / 2, 60);
    const y = r.top + r.height / 2;
    trackAction(y);
    clickAt(x, y);
  }, listen);
  // --- Captions --------------------------------------------------------------
  const CAPTIONS_KEY = '__ksVideoCaptions';
  const CAPTION_CSS = `
    :host { all: initial; }
    .wrap { position: fixed; left: 0; right: 0; bottom: 12px; z-index: 2147483645; pointer-events: none;
      display: flex; flex-direction: column; align-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .wrap:empty { display: none; }
    .wrap.top { bottom: auto; top: 120px; }
    .cap { max-width: min(80vw, 1100px); box-sizing: border-box; padding: 9px 18px; border-radius: 8px;
      background: rgba(0, 0, 0, 0.86); color: #fff; font-size: 18px; line-height: 1.4; letter-spacing: 0.02em; text-align: center;
      animation: in 150ms ease-out; }
    @keyframes in { from { opacity: 0; } to { opacity: 1; } }
  `;
  const captionMs = (text) => Math.min(12000, Math.max(2000, (text.length / 15) * 1000));
  let captionWrap = null;
  // Captions sit at the bottom unless the action is down there: the pointer,
  // or the field being typed in, in the bottom 30% of the window. Then they
  // move to the top, below where verdict pills show.
  let actionY = null;
  const placeCaptions = () => {
    if (!captionWrap) return;
    let y = actionY;
    const el = document.activeElement;
    if (el && el !== document.body && el.matches?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) {
      y = Math.max(y ?? 0, el.getBoundingClientRect().bottom);
    }
    captionWrap.classList.toggle('top', y != null && y > innerHeight * 0.7);
  };
  const loadCaptions = () => {
    try {
      return (JSON.parse(sessionStorage.getItem(CAPTIONS_KEY)) || []).filter((c) => c.until > Date.now());
    } catch {
      return [];
    }
  };
  const drawCaptions = () => {
    const caps = loadCaptions();
    if (!caps.length && !captionWrap) return;
    if (!captionWrap || !captionWrap.isConnected) {
      const parent = document.body || document.documentElement;
      if (!parent) return;
      const host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      host.setAttribute('inert', '');
      host.dataset.ksVideoCaptions = '';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${CAPTION_CSS}</style><div class="wrap"></div>`;
      captionWrap = root.querySelector('.wrap');
      parent.appendChild(host);
    }
    // One box, a line per caption.
    captionWrap.innerHTML = caps.length ? `<div class="cap">${caps.map((c) => `<div>${esc(c.text)}</div>`).join('')}</div>` : '';
    placeCaptions();
    if (caps.length) setTimeout(drawCaptions, Math.min(...caps.map((c) => c.until)) - Date.now() + 20);
  };
  const caption = (text) => {
    if (!highlightOn() || !text) return;
    const caps = loadCaptions();
    caps.push({ text, until: Date.now() + captionMs(text) });
    try {
      sessionStorage.setItem(CAPTIONS_KEY, JSON.stringify(caps.slice(-2)));
    } catch {}
    drawCaptions();
  };

  // Captions still up are drawn again after a navigation, once there's a body.
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', drawCaptions, { once: true });
  else drawCaptions();

  window.__ksVideo = {
    start() {
      const s = { t0: Date.now(), chapters: [] };
      save(s);
      try {
        localStorage.setItem(ON_KEY, '1');
      } catch {}
      return s.t0;
    },
    stop() {
      try {
        localStorage.removeItem(ON_KEY);
      } catch {}
      try {
        sessionStorage.removeItem(CAPTIONS_KEY);
      } catch {}
      if (captionWrap) captionWrap.innerHTML = '';
      return 'highlight and captions off';
    },
    card(title, subtitle = '', ms = CARD_MS, step = '') {
      show(
        '<div class="backdrop"></div><div class="center"><div class="card">' +
          (step ? `<div class="step">${esc(step)}</div>` : '') +
          `<div class="title">${esc(title)}</div>` +
          (subtitle ? `<div class="sub">${esc(subtitle)}</div>` : '') +
          '<div class="track"><div class="fill"></div></div></div></div>',
        ms,
      );
      return record({ kind: 'card', title: String(title), subtitle: String(subtitle || ''), step: String(step || ''), t: Date.now() });
    },
    verdict(pass, note = '', ms = VERDICT_MS) {
      show(
        `<div class="top"><div class="pill ${pass ? 'pass' : 'fail'}">` +
          `<div class="icon">${pass ? CHECK : CROSS}</div>` +
          `<div><div class="label">${pass ? 'PASS' : 'FAIL'}</div>${note ? `<div class="note">${esc(note)}</div>` : ''}</div>` +
          '<div class="track"><div class="fill"></div></div></div></div>',
        ms,
      );
      return record({ kind: 'verdict', pass: !!pass, note: String(note || ''), t: Date.now() });
    },
    note(text) {
      const line = String(text ?? '');
      caption(line);
      return record({ kind: 'note', text: line, t: Date.now() });
    },
    hold(ms) {
      return new Promise((resolve) => setTimeout(() => resolve(`held ${ms} ms`), ms));
    },
    until(predicate, timeoutMs = 120000) {
      const started = Date.now();
      return new Promise((resolve, reject) => {
        const tick = () => {
          let ok = false;
          try {
            ok = !!predicate();
          } catch {}
          if (ok) return resolve(`ready after ${Date.now() - started} ms`);
          if (Date.now() - started >= timeoutMs) return reject(new Error(`not ready after ${timeoutMs} ms`));
          setTimeout(tick, 500);
        };
        tick();
      });
    },
    chapters() {
      return JSON.stringify(load());
    },
  };
  return 'ks-video ready';
})();
