/* Tischlein – Verbindung zum Backend (Google Apps Script).
 * Ohne eingetragene Backend-Adresse und Google-Client-ID läuft die App im Demo-Modus (nur dieses Gerät).
 * Hier liegen keine Geheimnisse: Backend-Adresse und Client-ID sind öffentlich. Die Gerätesitzung
 * gilt nur für dieses Backend und kann vom Besitzer jederzeit durch Sperren wirkungslos gemacht werden. */
var Net = (function () {
  'use strict';
  var CONN_KEY = 'tisch-conn', SESSION_KEY = 'tisch-session', CACHE_KEY = 'tisch-cache-';

  function read(k, def) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function write(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

  function conf() {
    var c = read(CONN_KEY, {}), d = window.TISCH_CONFIG || {};
    // Auf dem Gerät gespeicherte Werte haben Vorrang – auch leere (= bewusst Demo-Modus).
    return { backendUrl: 'backendUrl' in c ? c.backendUrl : d.backendUrl || '', clientId: 'clientId' in c ? c.clientId : d.googleClientId || '', env: c.env || d.env || 'TEST' };
  }
  function setConf(patch) { var c = read(CONN_KEY, {}); Object.keys(patch).forEach(function (k) { c[k] = patch[k]; }); write(CONN_KEY, c); }
  function live() { var c = conf(); return !!(c.backendUrl && c.clientId); }
  // Sitzung zusätzlich als Cookie: iOS übernimmt beim „Zum Home-Bildschirm“ die Cookies aus Safari,
  // nicht aber den übrigen Gerätespeicher. So bleibt man nach dem Hinzufügen angemeldet.
  var COOKIE = 'tisch_s';
  function cookiePath() { return location.pathname.replace(/[^/]*$/, '') || '/'; }
  function readCookie() { var m = document.cookie.match(new RegExp('(?:^|; )' + COOKIE + '=([^;]*)')); if (!m) return null; try { return JSON.parse(decodeURIComponent(m[1])); } catch (e) { return null; } }
  function writeCookie(s) {
    var secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = COOKIE + '=' + (s ? encodeURIComponent(JSON.stringify(s)) + '; Max-Age=' + 60 * 864e2 : '; Max-Age=0') + '; Path=' + cookiePath() + '; SameSite=Strict' + secure;
  }
  function session() {
    var s = read(SESSION_KEY, null);
    if (!s) { s = readCookie(); if (s) write(SESSION_KEY, s); }
    return s;
  }
  function setSession(s) { write(SESSION_KEY, s); writeCookie(s); }

  /** Ruft das Backend auf. Liefert immer ein Objekt {ok, …}; Netzfehler → {ok:false, code:'OFFLINE'}. */
  function call(action, body, opts) {
    var c = conf(), s = session();
    var payload = Object.assign({ action: action, env: c.env, session: s ? s.token : '' }, body || {});
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, (opts && opts.timeout) || 45000) : null;
    return fetch(c.backendUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { return r.text(); })
      .then(function (t) {
        var res; try { res = JSON.parse(t); } catch (e) { return { ok: false, code: 'BACKEND', message: 'Antwort des Servers nicht lesbar – ist die Backend-Adresse richtig?' }; }
        if (res && res.code === 'AUTH' && action !== 'login') setSession(null);
        return res;
      })
      .catch(function (e) {
        return { ok: false, code: 'OFFLINE', message: e && e.name === 'AbortError' ? 'Server antwortet nicht. Es wurde nichts gespeichert.' : 'Keine Verbindung. Es wurde nichts gespeichert.' };
      })
      .then(function (res) { if (timer) clearTimeout(timer); return res; });
  }

  // ---------------------------------------------------------- Google-Anmeldung
  var gisLoading = null;
  function loadGis() {
    if (window.google && google.accounts && google.accounts.id) return Promise.resolve();
    if (gisLoading) return gisLoading;
    gisLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = function () { resolve(); }; s.onerror = function () { gisLoading = null; reject(new Error('Google-Anmeldung konnte nicht geladen werden')); };
      document.head.appendChild(s);
    });
    return gisLoading;
  }
  /** Zeigt den Google-Knopf im Element; onToken(idToken) wird nach erfolgreicher Anmeldung aufgerufen. */
  function renderGoogleButton(el, onToken) {
    return loadGis().then(function () {
      google.accounts.id.initialize({ client_id: conf().clientId, callback: function (resp) { if (resp && resp.credential) onToken(resp.credential); }, ux_mode: 'popup', auto_select: false, cancel_on_tap_outside: true, itp_support: true });
      el.innerHTML = '';
      google.accounts.id.renderButton(el, { type: 'standard', theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', locale: 'de', width: Math.min(320, el.clientWidth || 300) });
    });
  }
  /** Ersatzweg ohne Popup: Weiterleitung zu Google und zurück (für Home-Bildschirm-Apps). */
  function redirectLogin() {
    var nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    write('tisch-nonce', nonce);
    var back = location.origin + location.pathname;
    location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + [
      'client_id=' + encodeURIComponent(conf().clientId), 'redirect_uri=' + encodeURIComponent(back), 'response_type=id_token',
      'scope=' + encodeURIComponent('openid email profile'), 'nonce=' + nonce, 'prompt=select_account'
    ].join('&');
  }
  /** Holt ein ID-Token aus der Rücksprungadresse (#id_token=…), entfernt es sofort aus der Adresse. */
  function takeRedirectToken() {
    var m = /[#&]id_token=([^&]+)/.exec(location.hash || '');
    if (!m) return null;
    history.replaceState(null, '', location.pathname + location.search);
    var tok = decodeURIComponent(m[1]);
    try {
      var payload = JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload.nonce !== read('tisch-nonce', '')) return null;
    } catch (e) { return null; }
    write('tisch-nonce', null);
    return tok;
  }

  /** Anmeldung beim Backend mit Google-ID-Token → Gerätesitzung */
  function login(idToken) {
    return call('login', { idToken: idToken }).then(function (r) {
      if (r.ok && r.session) setSession({ token: r.session, email: r.email, name: r.name });
      return r;
    });
  }
  function logout() {
    var p = call('logout', {});
    setSession(null);
    try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch (e) {}
    return p;
  }

  // ---------------------------------------------------------- Zwischenspeicher (nur Anzeige, nie Quelle für Buchungen)
  function cacheKey() { var c = conf(); return CACHE_KEY + c.env; }
  function cachedStore() { return read(cacheKey(), null); }
  function cacheStore(store, rev) { var copy = { tables: store.tables, rev: rev, at: new Date().toISOString() }; write(cacheKey(), copy); }
  function clearCache() { write(CACHE_KEY + 'TEST', null); write(CACHE_KEY + 'PROD', null); }

  return {
    conf: conf, setConf: setConf, live: live, session: session, call: call, login: login, logout: logout,
    renderGoogleButton: renderGoogleButton, redirectLogin: redirectLogin, takeRedirectToken: takeRedirectToken,
    cachedStore: cachedStore, cacheStore: cacheStore, clearCache: clearCache
  };
})();
