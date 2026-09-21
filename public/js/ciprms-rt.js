/*
 * CIPRMS page helpers, loaded once per page by views/partials/header.ejs (so every signed-in page has them):
 *
 *   CIPRMS.api(url, opts)        fetch() with a timeout, JSON in/out and a plain-language message for every failure
 *   CIPRMS.busy(button, fn)      run an action once at a time: the button is disabled and shows progress meanwhile
 *   CIPRMS.toast(message, kind)  small success / error message
 *   CIPRMS.on(type, handler)     listen for a live update pushed by the server (Server-Sent Events); returns an "off" function
 *   CIPRMS.live(types, fn, o)    call fn once (debounced) after any of those updates — and after a reconnect
 *
 * Live updates are hints ("request 12 changed"), never data: a page reacts by re-reading what it shows through the normal
 * endpoints, so what arrives is decided by the same permission checks as any page load. See services/realtime.js.
 *
 * One connection per browser, not per tab: the tab that holds a Web Lock owns the EventSource and relays events to the other
 * tabs of the same user over a BroadcastChannel (browsers allow only ~6 connections per site — a stream per tab would starve
 * ordinary requests). Where those APIs are missing the tab simply opens its own connection.
 */
(function () {
  'use strict';
  if (window.CIPRMS && window.CIPRMS.__ready) return;             // never initialise twice on one page
  var CIPRMS = window.CIPRMS = window.CIPRMS || {};
  CIPRMS.__ready = true;
  var USER = window.CIPRMS_USER || null;

  /* a table row that a live update just changed flashes once (rows opt in with class="rt-flash") */
  try {
    var css = document.createElement('style');
    css.textContent = '@keyframes rt-flash{0%{background-color:rgba(64,81,137,.22)}100%{background-color:transparent}}' +
      'tr.rt-flash>td{animation:rt-flash 2.4s ease-out 1}@media (prefers-reduced-motion:reduce){tr.rt-flash>td{animation:none}}';
    document.head.appendChild(css);
  } catch (_) { /* cosmetic only */ }

  /* ───────────── toast ───────────── */
  CIPRMS.toast = function (message, kind) {
    try {
      var host = document.getElementById('ciprms-toasts');
      if (!host) {
        host = document.createElement('div'); host.id = 'ciprms-toasts';
        host.setAttribute('role', 'status'); host.setAttribute('aria-live', 'polite');
        host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2000;display:flex;flex-direction:column;gap:8px;max-width:min(380px,calc(100vw - 32px));pointer-events:none;';
        document.body.appendChild(host);
      }
      var el = document.createElement('div');
      var color = kind === 'error' ? '#f06548' : kind === 'info' ? '#299cdb' : '#0ab39c';
      el.style.cssText = 'background:' + color + ';color:#fff;padding:10px 14px;border-radius:6px;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.2);pointer-events:auto;overflow-wrap:anywhere;';
      el.textContent = String(message == null ? '' : message);
      host.appendChild(el);
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, kind === 'error' ? 6500 : 3500);
    } catch (_) { /* a toast must never break the page */ }
  };

  /* ───────────── api ───────────── */
  var sessionEndedShown = false;
  function sessionEnded() {
    if (sessionEndedShown) return; sessionEndedShown = true;
    CIPRMS.toast('Your session has expired. Redirecting to sign in…', 'error');
    setTimeout(function () { window.location.href = '/'; }, 2500);
  }
  function messageFor(status, data, fallback) {
    var server = data && typeof data.error === 'string' ? data.error : '';
    if (status === 400) return server || 'That could not be saved — please check the details and try again.';
    if (status === 401) return 'Your session has expired. Please sign in again.';
    if (status === 403) return server || 'You do not have permission to do this.';
    if (status === 404) return server || 'That item no longer exists. The list has been refreshed.';
    if (status === 409) return server || 'This conflicts with a change that was already made. The list has been refreshed.';
    if (status === 429) return server || 'Too many requests. Please wait a moment and try again.';
    if (status >= 500) return 'Something went wrong on the server. Please try again in a moment.';
    return server || fallback || 'Something went wrong. Please try again.';
  }
  /**
   * @param {string} url
   * @param {{method?:string, json?:any, body?:BodyInit, headers?:object, timeout?:number, keepalive?:boolean, quiet?:boolean}} [o]
   *   json  -> sent as a JSON body;  body -> sent as is (FormData for uploads);  quiet -> do not toast a failure
   * @returns {Promise<{ok:boolean, status:number, data:any, error:string, network:boolean, timedOut:boolean}>} never rejects
   */
  CIPRMS.api = function (url, o) {
    o = o || {};
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timeout = o.timeout || (o.body instanceof FormData ? 60000 : 20000);
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeout) : null;
    var headers = Object.assign({ 'X-Requested-With': 'ciprms', Accept: 'application/json' }, o.headers || {});
    var body = o.body;
    if (o.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.json); }
    function done(r) { if (timer) clearTimeout(timer); if (!r.ok && !o.quiet && r.error) CIPRMS.toast(r.error, 'error'); return r; }
    return fetch(url, { method: o.method || 'GET', headers: headers, body: body, signal: ctrl ? ctrl.signal : undefined, keepalive: !!o.keepalive, credentials: 'same-origin' })
      .then(function (res) {
        var ct = res.headers.get('content-type') || '';
        var isJson = /json/i.test(ct);
        // a redirect to the sign-in page ("/") means the session is gone. Any other non-JSON answer (an HTML error page)
        // is just a failed request and is reported by its status below.
        var toLogin = false;
        try { toLogin = res.redirected && new URL(res.url, window.location.href).pathname === '/'; } catch (_) { toLogin = false; }
        if (toLogin) { sessionEnded(); return done({ ok: false, status: 401, data: null, error: messageFor(401), network: false, timedOut: false }); }
        return (isJson ? res.json().catch(function () { return null; }) : Promise.resolve(null)).then(function (data) {
          var ok = res.ok && !(data && data.success === false);
          if (res.status === 401) sessionEnded();
          return done({ ok: ok, status: res.status, data: data, error: ok ? '' : messageFor(res.status, data), network: false, timedOut: false });
        });
      }, function (err) {
        var timedOut = !!(err && err.name === 'AbortError');
        return done({ ok: false, status: 0, data: null, network: !timedOut, timedOut: timedOut,
          error: timedOut ? 'The server took too long to respond. Please try again.' : 'Network problem — check your connection and try again.' });
      });
  };

  /* ───────────── busy / double-click guard ───────────── */
  var inflight = new WeakSet();
  /**
   * Runs fn() unless this button is already running one. While it runs the button is disabled (and keeps its width) so a
   * double click cannot submit twice; afterwards it is restored. Returns fn's promise, or undefined when ignored.
   */
  CIPRMS.busy = function (el, fn, label) {
    if (!el) return Promise.resolve().then(fn);
    if (inflight.has(el)) return undefined;
    inflight.add(el);
    var html = el.innerHTML, width = el.offsetWidth, wasDisabled = el.disabled;
    if (width) el.style.minWidth = width + 'px';
    el.disabled = true; el.setAttribute('aria-busy', 'true');
    if (label !== false) el.innerHTML = '<span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>' + (label || 'Working…');
    function restore() { inflight.delete(el); el.disabled = wasDisabled; el.removeAttribute('aria-busy'); el.style.minWidth = ''; if (label !== false) el.innerHTML = html; }
    return Promise.resolve().then(fn).then(function (v) { restore(); return v; }, function (e) { restore(); throw e; });
  };

  /* ───────────── live updates (SSE) ───────────── */
  var handlers = {};
  function on(type, fn) {
    (handlers[type] = handlers[type] || new Set()).add(fn);
    return function off() { if (handlers[type]) handlers[type].delete(fn); };
  }
  function emit(type, data, id) {
    var set = [].concat(Array.from(handlers[type] || []), Array.from(handlers['*'] || []));
    set.forEach(function (fn) { try { fn(data || {}, { type: type, id: id }); } catch (e) { console.error('CIPRMS handler for ' + type + ' failed', e); } });
  }
  CIPRMS.on = on;
  /**
   * Calls fn(events) once, shortly after any of `types` arrives (bursts are merged), and after a reconnect / regained
   * connection ('rt.resync'). fn should re-read the data it shows and may return a promise: if that resolves to `false`
   * (the read failed) the refresh is tried again after 3s, 10s and 30s, so a failed refresh never leaves a stale screen.
   */
  CIPRMS.live = function (types, fn, o) {
    var wait = (o && o.debounce) || 300, timer = null, retryTimer = null, retries = 0, batch = [];
    var RETRY_AFTER = [3000, 10000, 30000];
    function run() {
      clearTimeout(retryTimer);
      var b = batch; batch = [];
      var out; try { out = fn(b); } catch (e) { console.error(e); return; }
      Promise.resolve(out).then(function (ok) {
        if (ok === false && retries < RETRY_AFTER.length) { retryTimer = setTimeout(run, RETRY_AFTER[retries++]); }
        else if (ok !== false) { retries = 0; }
      }, function () { /* the handler's own error handling has already run */ });
    }
    var offs = [].concat(types, ['rt.resync']).map(function (t) {
      return on(t, function (data, meta) {
        batch.push(Object.assign({ type: meta.type }, data));
        retries = 0; clearTimeout(timer);
        timer = setTimeout(run, wait);
      });
    });
    return function off() { clearTimeout(timer); clearTimeout(retryTimer); offs.forEach(function (x) { x(); }); };
  };

  var TYPES = ['request.updated', 'request.statusChanged', 'documentRequest.updated', 'documentRequest.statusChanged',
    'partnership.updated', 'partnership.statusChanged', 'notification.created', 'notification.read', 'notification.deleted',
    'calendar.updated', 'calendar.deleted'];
  var seen = [], SEEN_MAX = 200;
  function duplicate(id) {
    if (!id) return false;
    if (seen.indexOf(id) >= 0) return true;
    seen.push(id); if (seen.length > SEEN_MAX) seen.shift();
    return false;
  }
  function setState(s) { CIPRMS.rt.state = s; try { document.documentElement.setAttribute('data-ciprms-rt', s); } catch (_) {} }

  CIPRMS.rt = { state: 'off', role: 'none', connections: 0, events: 0, frames: 0 };
  if (!USER || typeof window.EventSource !== 'function') return;

  var es = null, retryTimer = null, attempt = 0, helloCount = 0, stopped = false, releaseLock = null, everLeader = false;
  var channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('ciprms-rt-' + USER.id) : null;

  function deliver(type, data, id) {
    if (duplicate(id)) return;
    CIPRMS.rt.events++;
    emit(type, data, id);
  }
  function relay(msg) { if (channel) { try { channel.postMessage(msg); } catch (_) {} } }

  function closeStream() { if (es) { try { es.close(); } catch (_) {} es = null; } clearTimeout(retryTimer); }

  function openStream() {
    closeStream();
    if (stopped) return;
    setState('connecting');
    es = new EventSource('/api/realtime/stream?uid=' + encodeURIComponent(USER.id));
    CIPRMS.rt.connections++;
    es.addEventListener('hello', function () {
      attempt = 0; helloCount++; setState('live');
      // a first connect needs no catch-up; a reconnect (or a promotion after another tab closed) may have missed events
      var resync = helloCount > 1 || everLeader === 'promoted';
      if (resync) { deliver('rt.resync', { reason: 'reconnected' }); relay({ kind: 'resync' }); }
    });
    TYPES.forEach(function (t) {
      es.addEventListener(t, function (ev) {
        CIPRMS.rt.frames++;
        var data = {}; try { data = JSON.parse(ev.data); } catch (_) {}
        deliver(t, data, ev.lastEventId);
        relay({ kind: 'event', type: t, data: data, id: ev.lastEventId });
      });
    });
    es.addEventListener('session.ended', function () { stopped = true; closeStream(); setState('ended'); });
    es.onerror = function () {
      if (stopped) return;
      if (es && es.readyState === EventSource.CONNECTING) { setState('reconnecting'); return; }   // the browser is retrying by itself
      // CLOSED: the server refused the connection (or the session ended). Find out which, then retry with a back-off.
      closeStream(); setState('reconnecting');
      CIPRMS.api('/api/me', { quiet: true }).then(function (r) {
        if (r.status === 401) { stopped = true; setState('ended'); return; }
        attempt++; retryTimer = setTimeout(openStream, Math.min(60000, 2000 * Math.pow(2, Math.min(attempt, 5))));
      });
    };
  }

  function becomeLeader() {
    if (everLeader === false) everLeader = true; else everLeader = 'promoted';
    CIPRMS.rt.role = 'leader';
    openStream();
  }

  if (channel) {
    channel.onmessage = function (m) {
      var d = m.data || {};
      if (d.kind === 'event') deliver(d.type, d.data, d.id);
      else if (d.kind === 'resync') deliver('rt.resync', { reason: 'reconnected' });
    };
  }

  function start() {
    stopped = false;
    if (navigator.locks && typeof navigator.locks.request === 'function' && channel) {
      CIPRMS.rt.role = 'follower'; setState('follower');
      navigator.locks.request('ciprms-rt-' + USER.id, function () {
        return new Promise(function (release) { releaseLock = release; becomeLeader(); });
      }).catch(function () { /* lock request aborted on unload */ });
    } else {
      becomeLeader();
    }
  }
  function stop() {
    stopped = true; closeStream();
    if (releaseLock) { releaseLock(); releaseLock = null; }
    CIPRMS.rt.role = 'none';
  }

  // clean up when the page goes away; a page restored from the back/forward cache reconnects and resyncs
  window.addEventListener('pagehide', function () { stop(); });
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) { helloCount = Math.max(helloCount, 1); everLeader = everLeader ? 'promoted' : false; start(); deliver('rt.resync', { reason: 'restored' }); }
  });
  // Drop this tab's connection and open a fresh one (the tab that owns the connection only). The new connection's hello
  // triggers a resync, so nothing that happened in between is missed. Never leaves two connections open.
  CIPRMS.rt.reconnect = function () { if (CIPRMS.rt.role === 'leader' && !stopped) openStream(); };
  // The browser regained its network connection: whatever was missed while offline (a failed refresh, a stream that never
  // noticed the outage) is re-read now.
  window.addEventListener('online', function () { if (!stopped) deliver('rt.resync', { reason: 'online' }); });
  CIPRMS.rt.stop = stop;
  start();
})();
