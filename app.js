/* Tischlein – Web-App.
 * Alle Änderungen sind Befehle an die Fachlogik (core/domain.js):
 *  - Demo-Modus: Fachlogik läuft im Browser, Daten nur auf diesem Gerät.
 *  - Online: Befehl geht an das Backend (Apps Script), das ihn unter Sperre gegen die Google-Tabelle bucht.
 *    Erfolg wird erst nach Bestätigung des Servers angezeigt. */
(function () {
  'use strict';

  var STORE_KEY = 'ep-demo-v1';
  var DEPT_ORDER = ['Obst & Gemüse', 'Brot & Backwaren', 'Kühlregal', 'Tiefkühl', 'Vorrat', 'Haushalt', 'Sonstiges', 'Unklar'];
  var TITLES = { today: 'Heute', week: 'Woche', cookbook: 'Kochbuch', shopping: 'Einkauf', offers: 'Angebote', pantry: 'Vorrat', settings: 'Einstellungen' };
  var EVENT_LABEL = { purchase: 'Einkauf', cook: 'Gekocht', manual_delta: 'Korrektur', set_total: 'Gesetzt', inventory: 'Inventur', open: 'Geöffnet', correction: 'Korrektur', discard: 'Entsorgt' };

  var store, engine;
  var state = { tab: 'today', loc: 'all', search: '', weekOffset: 0 };
  var auth = { phase: 'demo' }, rev = 0, busy = 0, ai = { configured: false }, users = null;
  var media = null; // laufende Aufnahme (MediaRecorder)
  var sheet = null;
  var recognition = null;

  // ------------------------------------------------------------ Grundlagen
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function uuid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'k' + Date.now() + Math.random().toString(16).slice(2); }
  function today() { return Seed.iso(new Date()); }
  function addDays(isoDate, n) { var d = new Date(isoDate + 'T12:00:00'); d.setDate(d.getDate() + n); return Seed.iso(d); }
  function daysUntil(isoDate) { return Math.round((new Date(isoDate + 'T12:00:00') - new Date(today() + 'T12:00:00')) / 864e5); }
  var WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  var WD_LONG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  function dShort(isoDate) { if (!isoDate) return ''; var d = new Date(isoDate + 'T12:00:00'); return WD[d.getDay()] + ', ' + d.getDate() + '.' + (d.getMonth() + 1) + '.'; }
  function dNum(isoDate) { var d = new Date(isoDate + 'T12:00:00'); return d.getDate() + '.' + (d.getMonth() + 1) + '.'; }
  function niceOrigin(t) { return String(t || '').replace(/(\d{4}-\d{2}-\d{2})/g, function (d) { return WD[new Date(d + 'T12:00:00').getDay()]; }); }
  function forDays(t) {
    var days = []; String(t || '').replace(/(\d{4}-\d{2}-\d{2})/g, function (d) { var w = WD[new Date(d + 'T12:00:00').getDay()]; if (days.indexOf(w) < 0) days.push(w); });
    if (!days.length) return '';
    return 'für ' + (days.length > 1 ? days.slice(0, -1).join(', ') + ' und ' + days[days.length - 1] : days[0]);
  }
  function fmtNum(n) { if (n == null || isNaN(n)) return '–'; var r = Math.round(n * 100) / 100; return String(r).replace('.', ','); }

  function T() { return store.tables; }
  function product(id) { return T().Product.filter(function (p) { return p.product_id === id; })[0]; }
  function pkgOf(p) { return p && p.default_package_id ? T().PackageProfile.filter(function (k) { return k.package_id === p.default_package_id; })[0] : null; }
  function pkgContent(p) { var k = pkgOf(p); if (!k) return null; var r = EP.toBase(store, p.product_id, 1, 'Pkg'); return r.ok ? r.qty_base : null; }
  function locName(id) { var l = T().Location.filter(function (x) { return x.location_id === id; })[0]; return l ? l.name : (id || '–'); }
  function recipe(id) { return T().Recipe.filter(function (r) { return r.recipe_id === id; })[0]; }

  function fmtQty(pid, q, withPkg) {
    var p = product(pid); if (!p) return fmtNum(q);
    var s;
    if (p.base_unit === 'g') s = q >= 1000 ? fmtNum(q / 1000) + ' kg' : fmtNum(q) + ' g';
    else if (p.base_unit === 'ml') s = q >= 1000 ? fmtNum(q / 1000) + ' l' : fmtNum(q) + ' ml';
    else s = fmtNum(q) + ' Stk';
    if (withPkg !== false) {
      var c = pkgContent(p);
      if (c && q >= c - 1e-9 && p.base_unit !== 'Stk') {
        var n = q / c;
        s += Math.abs(n - Math.round(n)) < 1e-6 ? ' · ' + Math.round(n) + ' Pkg' : ' · ≈ ' + fmtNum(n) + ' Pkg';
      }
    }
    return s;
  }
  function mhdPill(bb) {
    if (!bb) return '';
    var d = daysUntil(bb);
    var cls = d < 0 ? 'bad' : d <= 3 ? 'warn' : 'plain';
    var txt = d < 0 ? 'abgelaufen ' + dNum(bb) : d === 0 ? 'MHD heute' : d === 1 ? 'MHD morgen' : 'MHD ' + dNum(bb);
    return '<span class="tag ' + cls + '">' + txt + '</span>';
  }

  // ------------------------------------------------------- Speicher & Buchung
  function ensureTables() { Object.keys(EP.SCHEMA).forEach(function (k) { if (!store.tables[k]) store.tables[k] = []; }); }
  function load() {
    if (Net.live()) {
      var c = Net.cachedStore();
      store = c && c.tables ? { tables: c.tables } : EP.newStore();
      rev = c ? c.rev || 0 : 0;
      ensureTables(); engine = null;
      auth = { phase: Net.session() ? 'checking' : 'login', hasCache: !!c };
      return;
    }
    try { var raw = localStorage.getItem(STORE_KEY); if (raw) store = JSON.parse(raw); } catch (e) { store = null; }
    if (!store || !store.tables || !store.tables.Product) store = Seed.build();
    Object.keys(EP.SCHEMA).forEach(function (k) { if (!store.tables[k]) store.tables[k] = []; });
    engine = new EP.Engine(store, {});
    save(true);
  }
  function save(silent) {
    if (Net.live()) return true; // online: der Server speichert, nicht der Browser
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); return true; }
    catch (e) { if (!silent) toast('Im Browser konnte nicht gespeichert werden', true); return false; }
  }
  /**
   * Führt einen Befehl über die Fachlogik aus. Liefert ein Promise mit dem Ergebnis oder null (Fehler wurde angezeigt).
   * Erfolg erst, wenn gespeichert: im Demo-Modus im Browser, online nach Bestätigung des Servers.
   * Derselbe Schlüssel bei Wiederholung (Doppelklick, Netz) bucht nie doppelt.
   */
  function run(cmd, key) {
    key = key || uuid();
    if (!Net.live()) {
      try {
        var r = engine.execute(cmd, { idempotencyKey: key, user: 'Demo' });
        if (!save()) throw new Error('Nicht gespeichert');
        render();
        return Promise.resolve(r);
      } catch (e) { toast(e.message || String(e), true); return Promise.resolve(null); }
    }
    // Online: sofort lokal mit derselben Fachlogik vorrechnen (gleiche IDs wie auf dem Server),
    // dann in Reihenfolge an den Server. „Gespeichert ✓“ erst nach dessen Bestätigung.
    var preview;
    if (!sync.pending) sync.base = JSON.stringify(store.tables); // bestätigter Stand, falls etwas scheitert
    try { preview = new EP.Engine(store, { keyedIds: true }).execute(cmd, { idempotencyKey: key, user: auth.email || 'ich' }); }
    catch (e) { toast(e.message || String(e), true); return Promise.resolve(null); }
    sync.pending++; sync.label = ''; showSync();
    render();
    var attempt = 0;
    function send() {
      return Net.call('exec', { command: cmd, key: key }).then(function (res) {
        if (!res.ok && (res.code === 'BUSY' || res.code === 'OFFLINE') && attempt++ < 2) {
          return new Promise(function (ok) { setTimeout(ok, 1500 * attempt); }).then(send); // gleicher Schlüssel → nie doppelt
        }
        return res;
      });
    }
    sync.queue = sync.queue.then(send).then(function (res) {
      sync.pending--;
      if (!res.ok) { sync.failed = sync.failed || res; }
      else { Object.keys(res.tables || {}).forEach(function (k) { sync.server[k] = res.tables[k]; }); rev = res.rev; sync.ms = res.ms; sync.fast = res.fast; }
      if (!sync.pending) settle();
    });
    return Promise.resolve(preview);
  }
  function doneTitle() { return sync.pending ? 'Wird gebucht …' : 'Gebucht ✓'; }
  var sync = { pending: 0, queue: Promise.resolve(), server: {}, failed: null, label: '', ms: null, fast: null };
  /** Alle ausstehenden Buchungen sind beim Server angekommen (oder gescheitert). */
  function settle() {
    if (sync.failed) {
      var f = sync.failed; sync.failed = null;
      // Vorschau zurücknehmen: bestätigter Stand + was der Server inzwischen bestätigt hat
      store = { tables: JSON.parse(sync.base) }; ensureTables();
      Object.keys(sync.server).forEach(function (k) { store.tables[k] = sync.server[k]; });
      sync.server = {};
      render(); if (sheet) renderSheet();
      showSync('');
      if (f.code === 'AUTH' || f.code === 'NO_ACCESS') { netError(f); return; }
      if (f.code === 'OFFLINE') { toast('Nicht gespeichert: ' + (f.message || 'keine Verbindung'), true); return; }
      toast('Nicht gespeichert: ' + (f.message || 'Fehler') + '. Ich habe den Stand vom Server neu geladen.', true);
      refresh(); return;
    }
    Object.keys(sync.server).forEach(function (k) { store.tables[k] = sync.server[k]; });
    sync.server = {};
    Net.cacheStore(store, rev);
    render();
    if (sheet && sheet.result) renderSheet();
    showSync('ok');
  }
  var syncTimer;
  function showSync(state) {
    var el = $('sync'); if (!el) return;
    clearTimeout(syncTimer);
    if (sync.pending) { el.className = 'sync on'; el.innerHTML = '<i class="spin"></i>' + esc(sync.label ? sync.label + ' · ' : '') + 'Wird gespeichert …'; return; }
    if (state === 'ok') {
      el.className = 'sync on ok'; el.innerHTML = '✓ ' + esc(sync.label || 'Gespeichert') + (sync.label ? ' – gespeichert' : '');
      sync.label = '';
      syncTimer = setTimeout(function () { el.className = 'sync'; }, 2200);
      return;
    }
    el.className = 'sync';
  }
  function upsert(table, rows) { return run({ type: 'upsert_rows', table: table, rows: rows.map(clean) }); }
  function clean(row) { var o = {}; Object.keys(row).forEach(function (k) { if (k.charAt(0) !== '_') o[k] = row[k]; }); return o; }
  function setBusy(d) { busy = Math.max(0, busy + d); var b = $('busy'); if (b) b.className = 'busy' + (busy ? ' on' : ''); }
  function netError(res) {
    if (res.code === 'AUTH') { auth.phase = 'login'; toast(res.message || 'Bitte erneut anmelden', true); render(); return; }
    if (res.code === 'NO_ACCESS') { lockOut(); Net.call('hello').then(afterHello); return; }
    toast(res.message || 'Fehler – nichts gespeichert', true);
  }

  // ------------------------------------------------------------- Online: Anmeldung & Abgleich
  function boot() {
    if (!Net.live()) return;
    var tok = Net.takeRedirectToken();
    if (tok) { auth.phase = 'checking'; render(); Net.login(tok).then(afterHello); return; }
    if (auth.phase === 'checking') Net.call('hello').then(afterHello);
  }
  function onGoogleToken(idToken) { auth.phase = 'checking'; render(); Net.login(idToken).then(afterHello); }
  function afterHello(r) {
    if (!r.ok) {
      if (r.code === 'AUTH') { auth.phase = 'login'; auth.error = r.message; }
      else if (auth.hasCache) { auth.phase = 'ready'; auth.offline = true; toast(r.message || 'Offline – nur Ansicht', true); }
      else { auth.phase = 'error'; auth.error = r.message; }
      render(); return;
    }
    auth.email = r.email; auth.name = r.name; auth.owner = r.owner; auth.status = r.status; auth.error = ''; auth.offline = false;
    if (!r.allowed) { lockOut(); render(); return; }
    if (r.rev !== rev || !auth.hasCache) refresh(); else { auth.phase = 'ready'; render(); }
    Net.call('ai_status').then(function (a) { if (a.ok) ai = a; });
  }
  /** Kein Zugriff (mehr): Fenster schließen, Daten von diesem Gerät entfernen. */
  function lockOut() {
    auth.phase = 'pending';
    Net.clearCache(); store = EP.newStore(); rev = 0; auth.hasCache = false; users = null;
    if (sheet) { sheet = null; $('sheet').classList.remove('open'); $('backdrop').classList.remove('open'); }
    render();
  }
  function refresh() {
    setBusy(1);
    return Net.call('bootstrap').then(function (r) {
      setBusy(-1);
      if (!r.ok) { netError(r); if (auth.phase === 'checking') { auth.phase = auth.hasCache ? 'ready' : 'error'; auth.error = r.message; render(); } return; }
      store = { tables: r.tables }; ensureTables(); rev = r.rev; Net.cacheStore(store, rev);
      auth.phase = 'ready'; auth.hasCache = true; auth.owner = r.owner;
      render();
    });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !Net.live() || auth.phase !== 'ready' || busy || sync.pending) return;
    Net.call('hello').then(function (r) { if (r.ok && r.allowed && r.rev !== rev) refresh(); else if (r.ok && !r.allowed) { auth.status = r.status; lockOut(); } });
  });
  function viewAuth() {
    var h = '<div class="auth">' + Illus.scene('today');
    if (auth.phase === 'login') {
      h += '<h2>Willkommen bei Tischlein</h2><p>Melde dich mit deinem Google-Konto an. Beim ersten Mal fragt die App den Besitzer nach einer Freigabe.</p>' +
        '<div id="gbtn" class="gbtn"><button class="btn primary block" data-action="login-redirect">Mit Google anmelden</button></div>' +
        '<button class="link" data-action="login-redirect" style="margin-top:14px">Anmeldefenster öffnet nicht? Über die Google-Seite anmelden</button>' +
        (auth.error ? '<p class="small" style="color:var(--bad)">' + esc(auth.error) + '</p>' : '');
    } else if (auth.phase === 'checking') {
      h += '<h2>Einen Moment …</h2><p>Verbinde mit deiner Datenbasis.</p>';
    } else if (auth.phase === 'pending') {
      var st = auth.status;
      h += '<h2>' + (st === 'angefragt' ? 'Anfrage ist unterwegs' : st === 'abgelehnt' ? 'Kein Zugang' : 'Fast geschafft') + '</h2>' +
        '<p>Angemeldet als <b>' + esc(auth.email || '') + '</b>.</p>' +
        (st === 'angefragt' ? '<p>Der Besitzer hat eine E-Mail bekommen. Sobald er dich freigibt, geht es hier los.</p><button class="btn primary block" data-action="auth-check">Erneut prüfen</button>' :
          st === 'abgelehnt' ? '<p>Der Besitzer hat den Zugang nicht freigegeben.</p>' :
          '<p>Damit du die Daten der Familie sehen und ändern kannst, muss der Besitzer dich einmal freigeben.</p><button class="btn primary block" data-action="access-request">Zugang anfragen</button>') +
        '<button class="link" data-action="logout" style="margin-top:16px">Mit anderem Konto anmelden</button>';
    } else {
      h += '<h2>Keine Verbindung</h2><p>' + esc(auth.error || 'Der Server ist gerade nicht erreichbar.') + '</p><button class="btn primary block" data-action="auth-check">Erneut versuchen</button>';
    }
    return h + '</div>';
  }

  var toastTimer;
  function toast(msg, err) {
    if (!err && sync && sync.pending) { sync.label = String(msg).replace(/\s*✓\s*$/, ''); showSync(); return; }
    var t = $('toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = 'toast'; }, err ? 4200 : 2400);
  }

  // ------------------------------------------------------------- Rendering
  var SUBTITLE = {
    today: function () { var e = entryFor(today()); return e && e.recipe_id ? 'Heute Abend gibt es was Gutes' : 'Heute Abend ist noch offen'; },
    week: function () { return 'Abendessen für sieben Tage'; },
    cookbook: function () { return T().Recipe.length + ' Rezepte'; },
    shopping: function () { var n = shoppingItems().filter(function (i) { return !i.checked && !i.unclear_reason; }).length; return n ? n + ' Dinge fehlen noch' : 'Alles im Haus'; },
    offers: function () { return 'Nur geprüfte Preise'; },
    pantry: function () { var n = {}; T().StockLot.forEach(function (l) { if (Number(l.qty_base) > 1e-9) n[l.product_id] = 1; }); return Object.keys(n).length + ' Produkte eingelagert'; },
    settings: function () { return 'Regeln, Orte, Daten'; }
  };
  var SCENE_OF = { today: 'today', week: 'week', cookbook: 'cookbook', shopping: 'shopping', offers: 'offers', pantry: 'pantry' };
  var TAB_ORDER = ['today', 'week', 'cookbook', 'shopping', 'offers', 'pantry'];
  function renderChrome() {
    $('tabbar').innerHTML = TAB_ORDER.map(function (t) { return '<button data-action="tab" data-tab="' + t + '" aria-label="' + TITLES[t] + '">' + Illus.tab(t) + '<span>' + TITLES[t] + '</span></button>'; }).join('');
    $('fab').innerHTML = Illus.tab('mic');
  }
  function render() {
    var locked = Net.live() && auth.phase !== 'ready';
    document.body.classList.toggle('locked', locked);
    if (locked) {
      if (sheet && auth.phase !== 'ready') { sheet = null; $('sheet').classList.remove('open'); $('backdrop').classList.remove('open'); }
      $('masthead').innerHTML = '<div><div class="brand">' + Illus.tab('pantry') + 'Tischlein</div></div>';
      $('view').innerHTML = viewAuth();
      if (auth.phase === 'login') { var gb = $('gbtn'); if (gb) Net.renderGoogleButton(gb, onGoogleToken).catch(function () { /* Ersatzknopf bleibt sichtbar */ }); }
      return;
    }
    var now = new Date();
    var dateTxt = WD_LONG[now.getDay()] + ', ' + now.getDate() + '. ' + now.toLocaleString('de-DE', { month: 'long' });
    $('masthead').innerHTML = '<div><div class="brand">' + Illus.tab('pantry') + 'Tischlein' + envFlag() + '<span id="busy" class="busy' + (busy ? ' on' : '') + '">Speichert …</span></div>' +
      '<h1>' + TITLES[state.tab] + '</h1><div class="date">' + (state.tab === 'today' ? dateTxt : esc(SUBTITLE[state.tab]())) + '</div></div>' +
      (SCENE_OF[state.tab] ? Illus.scene(SCENE_OF[state.tab]) : '<div></div>') +
      (state.tab === 'settings' ? '' : '<button class="gear" data-action="tab" data-tab="settings" aria-label="Einstellungen">' + Illus.tab('settings') + '</button>');
    document.querySelectorAll('.tabbar button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === state.tab); b.setAttribute('aria-current', b.getAttribute('data-tab') === state.tab ? 'page' : 'false'); });
    var fn = VIEWS[state.tab];
    $('view').innerHTML = fn();
    document.title = TITLES[state.tab] + ' – Tischlein';
  }

  function envFlag() {
    if (!Net.live()) return '<span class="demo-flag">Demo</span>';
    if (auth.offline) return '<span class="demo-flag">Offline</span>';
    return Net.conf().env === 'TEST' ? '<span class="demo-flag">Test</span>' : '';
  }
  function weekStart(offset) { return addDays(Seed.monday(new Date()), 7 * (offset || 0)); }
  function ensureWeek(ws) {
    for (var i = 0; i < 7; i++) {
      var d = addDays(ws, i);
      if (!T().MealPlanEntry.some(function (e) { return e.date === d; })) {
        // nur angezeigt; gespeichert wird die Zeile erst, wenn jemand sie ändert (feste ID je Datum → keine Dubletten zwischen Geräten)
        T().MealPlanEntry.push({ entry_id: 'MP-' + d, week_start: ws, date: d, persons: defaultPersons(), recipe_id: '', status: '', note: '', updated_at: '', _virtual: true });
      }
    }
  }
  function defaultPersons() { var s = T().Settings.filter(function (x) { return x.key === 'default_persons'; })[0]; return s ? Number(s.value) : 2; }
  function entryFor(dateIso) { return T().MealPlanEntry.filter(function (e) { return e.date === dateIso; })[0]; }

  /** Rezeptbild (aus dem Import) oder passende Illustration */
  function recipePic(r, cls) {
    if (r && /^https:\/\//.test(r.image_url || '')) return '<span class="pic recipe-photo ' + (cls || 'dish') + '"><img src="' + esc(r.image_url) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add(\'fail\')">' + Illus.dishSvg(r, 'fb') + '</span>';
    return Illus.dish(r, cls);
  }
  function ingredientPills(pv) {
    return pv.lines.map(function (l) {
      if (l.status === 'unklar') return '<span class="tag unclear" title="' + esc(l.reason) + '">' + esc(l.text) + '?</span>';
      if (l.status !== 'ok') return '';
      if (l.missing > 1e-9) return '<span class="tag missing">' + esc(l.text) + ' fehlt</span>';
      return '<span class="tag">' + esc(l.text) + '</span>';
    }).join('');
  }

  // ---- Heute
  function viewToday() {
    var t = today(), e = entryFor(t), h = '';
    if (e && e.recipe_id && recipe(e.recipe_id)) {
      var r = recipe(e.recipe_id), pv = EP.previewCook(store, r.recipe_id, e.persons);
      var cooked = e.status === 'gekocht';
      var missing = pv.lines.filter(function (l) { return l.status === 'ok' && l.missing > 1e-9; }).length;
      h += '<section class="tonight">' + recipePic(r, 'dish lg') +
        '<div class="when">' + (cooked ? 'Heute gekocht' : e.status === 'Vorschlag' ? 'Vorschlag für heute Abend' : 'Heute Abend') + '</div>' +
        '<h2>' + esc(r.name) + '</h2><div class="facts"><span>' + e.persons + ' Personen</span><span>' + esc(r.minutes) + ' Minuten</span><span>' + (missing ? missing + ' Zutat' + (missing > 1 ? 'en fehlen' : ' fehlt') : 'Alles da') + '</span></div>' +
        '<div class="ing">' + ingredientPills(pv) + '</div>' +
        '<div class="btn-row"><button class="btn" data-action="recipe" data-id="' + r.recipe_id + '" data-persons="' + e.persons + '">Rezept</button>' +
        '<button class="btn primary" data-action="cook" data-id="' + r.recipe_id + '" data-entry="' + e.entry_id + '">' + (cooked ? 'Nochmal gekocht' : 'Gekocht') + '</button></div></section>';
    } else {
      h += '<div class="panel"><div class="empty">' + Illus.scene('today') + '<p>Für heute Abend steht noch nichts im Plan.</p><button class="btn primary" data-action="tab" data-tab="week">Woche planen</button></div></div>';
    }
    var tm = entryFor(addDays(t, 1));
    if (tm && tm.recipe_id && recipe(tm.recipe_id)) {
      h += '<div class="panel" style="margin-top:12px"><div class="row tap" data-action="tab" data-tab="week">' + Illus.dish(recipe(tm.recipe_id)) + '<div class="grow"><div class="sub">Morgen</div><div class="title">' + esc(recipe(tm.recipe_id).name) + '</div></div><span class="muted">' + tm.persons + ' Pers.</span></div></div>';
    }
    var soon = T().StockLot.filter(function (l) { return Number(l.qty_base) > 1e-9 && l.best_before && daysUntil(l.best_before) <= 4; })
      .sort(function (a, b) { return a.best_before < b.best_before ? -1 : 1; }).slice(0, 8);
    h += '<div class="sec">Bald aufbrauchen<span class="aside">' + (soon.length ? 'innerhalb von 4 Tagen' : '') + '</span></div>';
    h += soon.length ? '<div class="strip">' + soon.map(function (l) {
      var p = product(l.product_id);
      return '<div class="item" data-action="product" data-id="' + l.product_id + '" role="button" tabindex="0">' + Illus.dept(p.category) + '<div class="n">' + esc(p.name) + '</div><div class="q">' + esc(fmtQty(l.product_id, Number(l.qty_base), false)) + (l.opened_at ? ', offen' : '') + '</div><div style="margin-top:8px">' + mhdPill(l.best_before) + '</div></div>';
    }).join('') + '</div>' : '<div class="panel"><div class="row"><span class="dot ok"></span><div class="grow">Nichts läuft in den nächsten Tagen ab.</div></div></div>';
    var items = shoppingItems();
    var open = items.filter(function (i) { return !i.checked && !i.unclear_reason; }).length;
    var unclear = items.filter(function (i) { return i.unclear_reason; }).length;
    h += '<div class="sec">Einkauf</div><div class="panel"><div class="row tap" data-action="tab" data-tab="shopping">' + Illus.dept('Obst & Gemüse') + '<div class="grow"><div class="title">' + (open ? open + ' Artikel auf der Liste' : 'Nichts zu kaufen') + '</div><div class="sub">' + (unclear ? unclear + ' Zutaten ohne Menge im Rezept' : 'für diese Woche') + '</div></div><span class="muted">›</span></div></div>';
    return h;
  }

  // ---- Woche
  function viewWeek() {
    var ws = weekStart(state.weekOffset);
    ensureWeek(ws);
    var entries = T().MealPlanEntry.filter(function (e) { return e.date >= ws && e.date <= addDays(ws, 6); }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var recipes = T().Recipe.filter(function (r) { return !r.disliked; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    var t = today();
    var proposals = entries.filter(function (e) { return e.status === 'Vorschlag'; }).length;
    var h = '<div class="btn-row" style="margin-bottom:14px;align-items:center"><button class="mini" data-action="week-nav" data-d="-1" aria-label="Vorherige Woche">‹</button>' +
      '<div style="flex:1;text-align:center;font-weight:650">' + dNum(ws) + ' bis ' + dNum(addDays(ws, 6)) + '</div>' +
      '<button class="mini" data-action="week-nav" data-d="1" aria-label="Nächste Woche">›</button></div>';
    if (proposals) h += '<div class="note">' + proposals + (proposals > 1 ? ' Tage sind Vorschläge' : ' Tag ist ein Vorschlag') + '. Erst nach dem Bestätigen kommen sie auf die Einkaufsliste. Der Vorrat ändert sich erst beim Kochen.</div>';
    h += '<div class="panel">' + entries.map(function (e) {
      var d = new Date(e.date + 'T12:00:00');
      var past = e.date < t;
      var r = e.recipe_id ? recipe(e.recipe_id) : null;
      var state2 = e.status === 'gekocht' ? '<span class="state k">gekocht</span>' : e.status === 'Vorschlag' ? '<span class="state v">Vorschlag' + (e.note ? ', ' + esc(e.note) : '') + '</span>' : r ? '<span class="state">' + esc(r.minutes) + ' Min.</span>' : '<span class="state">frei</span>';
      return '<div class="row day' + (e.date === t ? ' today' : '') + '"><div class="d"><small>' + WD[d.getDay()] + '</small><b>' + d.getDate() + '</b></div>' +
        (r ? Illus.dish(r) : '<span></span>') +
        '<div class="grow pick"><div class="title">' + (r ? esc(r.name) : '<span class="muted">Gericht wählen</span>') + '</div>' + state2 +
        '<select data-change="plan-recipe" data-entry="' + e.entry_id + '" aria-label="Gericht am ' + WD_LONG[d.getDay()] + '"' + (past || e.status === 'gekocht' ? ' disabled' : '') + '><option value="">Nichts geplant</option>' +
        recipes.map(function (x) { return '<option value="' + x.recipe_id + '"' + (x.recipe_id === e.recipe_id ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="stepper" aria-label="Personen"><button data-action="persons" data-entry="' + e.entry_id + '" data-d="-1" aria-label="Eine Person weniger">−</button><span>' + e.persons + '</span><button data-action="persons" data-entry="' + e.entry_id + '" data-d="1" aria-label="Eine Person mehr">+</button></div></div>';
    }).join('') + '</div>';
    h += '<div class="btn-row"><button class="btn" data-action="suggest">Freie Tage füllen</button><button class="btn primary" data-action="confirm-plan"' + (proposals ? '' : ' disabled') + '>Plan bestätigen</button></div>';
    h += '<p class="small muted" style="margin:12px 6px">Vorschläge nehmen bevorzugt, was bald abläuft oder schon offen ist, dann Favoriten und schnelle Gerichte. Wiederholungen in derselben Woche werden vermieden.</p>';
    return h;
  }

  function suggestWeek() {
    var ws = weekStart(state.weekOffset), t = today();
    var entries = T().MealPlanEntry.filter(function (e) { return e.date >= ws && e.date <= addDays(ws, 6); });
    var used = {}; entries.forEach(function (e) { if (e.recipe_id) used[e.recipe_id] = (used[e.recipe_id] || 0) + 1; });
    var filled = 0, rows = [];
    entries.sort(function (a, b) { return a.date < b.date ? -1 : 1; }).forEach(function (e) {
      if (e.recipe_id || e.date < t) return;
      var best = null, bestScore = -1e9;
      T().Recipe.forEach(function (r) {
        if (r.disliked) return;
        var score = 0, why = [];
        var pv = EP.previewCook(store, r.recipe_id, e.persons);
        pv.lines.forEach(function (l) {
          if (l.status !== 'ok') return;
          var lots = EP.lotsOf(store, l.product_id);
          if (lots.length) score += 1;
          if (lots.some(function (x) { return x.best_before && daysUntil(x.best_before) <= 5; })) { score += 3; why.push(l.text); }
          if (lots.some(function (x) { return x.opened_at; })) score += 1;
        });
        if (r.favorite) score += 1;
        if (Number(r.minutes) <= 20) score += 1;
        score -= 6 * (used[r.recipe_id] || 0);
        if (score > bestScore) { bestScore = score; best = { r: r, why: why }; }
      });
      if (best) { rows.push(Object.assign({}, e, { recipe_id: best.r.recipe_id, status: 'Vorschlag', note: best.why.length ? 'nutzt ' + best.why.join(', ') : '' })); used[best.r.recipe_id] = (used[best.r.recipe_id] || 0) + 1; filled++; }
    });
    if (!rows.length) { toast('Keine freien Tage'); return; }
    upsert('MealPlanEntry', rows).then(function (r) { if (r) toast(filled + (filled > 1 ? ' Vorschläge' : ' Vorschlag') + ' eingetragen'); });
  }

  // ---- Kochbuch
  function viewCookbook() {
    var q = state.search.toLowerCase();
    var rs = T().Recipe.filter(function (r) { return !q || r.name.toLowerCase().indexOf(q) >= 0; })
      .sort(function (a, b) { return (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || a.name.localeCompare(b.name); });
    var h = '<div class="inline-add"><input type="search" placeholder="Rezept suchen" aria-label="Rezept suchen" value="' + esc(state.search) + '" data-input="cb-search"><button class="btn primary" data-action="new-recipe">Neu</button></div>';
    if (Net.live()) h += '<button class="import-cta" data-action="import-recipe">' + Illus.tab('cookbook') + '<span><b>Rezept aus Link übernehmen</b><small>Chefkoch & Co. – Zutaten werden vor dem Speichern geprüft</small></span><span class="muted">›</span></button>';
    h += '<div class="recipes">' + rs.map(function (r) {
      return '<div class="rcard-wrap"><button class="rcard" data-action="recipe" data-id="' + r.recipe_id + '">' + recipePic(r) + '<b>' + esc(r.name) + '</b>' +
        '<span class="m">' + esc(r.minutes) + ' Min., für ' + esc(r.servings_base) + '</span>' +
        (r.disliked ? '<span class="tag bad">unerwünscht</span>' : '') + '</button>' +
        (r.favorite ? '<span class="star" aria-label="Favorit">★</span>' : '') + '</div>';
    }).join('') + '</div>';
    if (!rs.length) h += '<div class="empty">Kein Rezept mit „' + esc(state.search) + '“. Leg es mit „Neues Rezept“ an.</div>';
    return h;
  }

  // ---- Einkauf
  var lastItems = {};
  /** Position (gespeichert oder nur berechnet) als vollständige Zeile */
  function itemRow(id) { return lastItems[id] || T().ShoppingItem.filter(function (x) { return x.item_id === id; })[0]; }
  function shoppingItems() {
    var ws = weekStart(0);
    var existing = T().ShoppingItem.filter(function (i) { return i.week_start === ws; });
    var items = EP.computeShoppingList(store, ws, existing, today());
    items.forEach(function (i) {
      if (!i.item_id) i.item_id = 'SI-' + (i.product_id || EP.normalizeName(i.text)) + '-' + (i.origin || '').slice(0, 4);
      i.week_start = ws;
    });
    lastItems = {}; items.forEach(function (i) { lastItems[i.item_id] = i; });
    return items;
  }
  function itemQty(i) {
    if (i.unclear_reason) return '<span class="tag unclear">Menge unklar</span>';
    if (i.manual_override !== undefined && i.manual_override !== '' && i.manual_override != null) return esc(fmtQty(i.product_id, Number(i.manual_override)));
    if (i.packages) return esc(i.packages + ' × ' + (i.package_label || 'Pkg'));
    if (i.qty_to_buy == null) return '';
    return i.product_id ? esc(fmtQty(i.product_id, i.qty_to_buy)) : esc(fmtNum(i.qty_to_buy));
  }
  function viewShopping() {
    var items = shoppingItems();
    var h = '<div class="inline-add"><input type="text" id="addItem" placeholder="Was fehlt? z. B. 2 Gurken" aria-label="Artikel hinzufügen" enterkeyhint="done"><button class="btn primary" data-action="add-item" aria-label="Hinzufügen">+</button></div>';
    if (!items.length) return h + '<div class="panel"><div class="empty">' + Illus.scene('shopping') + '<p>Alles im Haus. Die Liste füllt sich aus dem bestätigten Wochenplan und aus Mindestbeständen.</p></div></div>';
    var done = items.filter(function (i) { return i.checked || i.purchase_id; }).length;
    h += '<div class="progress" role="progressbar" aria-valuenow="' + done + '" aria-valuemax="' + items.length + '"><i style="width:' + Math.round(done / items.length * 100) + '%"></i></div><div class="small muted" style="margin:0 6px 4px">' + done + ' von ' + items.length + ' im Korb</div>';
    var groups = {};
    items.forEach(function (i) { (groups[i.department || 'Sonstiges'] = groups[i.department || 'Sonstiges'] || []).push(i); });
    var depts = Object.keys(groups).sort(function (a, b) { var x = DEPT_ORDER.indexOf(a), y = DEPT_ORDER.indexOf(b); return (x < 0 ? 50 : x) - (y < 0 ? 50 : y); });
    depts.forEach(function (d) {
      h += '<div class="dept-head">' + Illus.dept(d) + '<b>' + esc(d) + '</b><span class="n">' + groups[d].length + '</span></div><div class="panel">' + groups[d].map(function (i) {
        var booked = !!i.purchase_id;
        var sub = i.unclear_reason ? esc(i.unclear_reason) + (i.origin_detail ? ', ' + esc(forDays(i.origin_detail)) : '') :
          i.origin === 'Mindestbestand' ? 'Mindestbestand, vorhanden ' + esc(fmtQty(i.product_id, i.qty_available || 0, false)) :
          i.origin === 'manuell' ? 'von Hand ergänzt' + (i.product_id ? '' : ', kein Produkt zugeordnet') :
          esc(forDays(i.origin_detail)) + (i.qty_available > 0 ? ', ' + esc(fmtQty(i.product_id, i.qty_available, false)) + ' noch da' : '');
        return '<div class="row' + (i.checked || booked ? ' done' : '') + '"><button class="check' + (i.checked || booked ? ' on' : '') + '" data-action="shop-check" data-item="' + esc(i.item_id) + '" aria-label="' + esc(i.text) + ' abhaken"' + (booked ? ' disabled' : '') + '><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>' +
          '<div class="grow tap" data-action="shop-edit" data-item="' + esc(i.item_id) + '"><div class="title">' + esc(i.text) + '</div><div class="sub">' + sub + '</div></div>' +
          '<div class="qty">' + (booked ? '<span class="tag ok">im Vorrat</span>' : itemQty(i)) + '</div></div>';
      }).join('') + '</div>';
    });
    var n = items.filter(function (i) { return i.checked && !i.purchase_id; }).length;
    if (n) h += '<button class="btn primary block sticky-cta" data-action="book-checked">' + n + ' abgehakte Artikel einräumen</button>';
    h += '<p class="small muted" style="margin:14px 6px">Abhaken ändert den Vorrat noch nicht. Eingeräumt wird erst mit dem Knopf oder später über den Kassenbon, und nie doppelt.</p>';
    return h;
  }

  // ---- Angebote
  function viewOffers() {
    var ph = T().PriceHistory.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).slice(0, 20);
    var h = '<div class="card"><h3>Keine geprüften Angebote</h3><p class="muted small" style="margin:6px 0 0">Angebote erscheinen hier nur mit echter Quelle und Datum. Es gibt keine Schätzungen und keine erfundenen Rabatte. Eine verlässliche Angebotsquelle ist noch nicht angebunden.</p></div>';
    h += '<div class="sec">Eigene Preise (historisch)</div>';
    h += ph.length ? '<div class="panel">' + ph.map(function (p) {
      var pr = product(p.product_id);
      return '<div class="row"><div class="grow"><div class="title">' + esc(pr ? pr.name : p.product_id) + '</div><div class="sub">' + esc(p.market) + ' · ' + esc(dShort(p.date)) + ' · historischer Preis</div></div><div class="qty">' + fmtNum(p.unit_price) + ' €</div></div>';
    }).join('') + '</div>' : '<div class="card muted small">Noch keine Kassenbons erfasst. Sobald Bons gebucht sind, siehst du hier deine bezahlten Preise. Sie sind als historisch gekennzeichnet und gelten nicht als aktuelle Angebote.</div>';
    return h;
  }

  // ---- Vorrat
  var CAT_CLASS = { 'Obst & Gemüse': 'c-obst', 'Brot & Backwaren': 'c-brot', 'Kühlregal': 'c-kuehl', 'Tiefkühl': 'c-tk', 'Vorrat': 'c-vorrat', 'Haushalt': 'c-haus' };
  function jarLevel(pid, total) {
    var p = product(pid);
    var min = T().MinStock.filter(function (m) { return m.product_id === pid; })[0];
    var ref = min ? Number(min.min_qty_base) * 1.5 : (pkgContent(p) || (p.base_unit === 'Stk' ? 6 : p.base_unit === 'g' ? 500 : 1000));
    return Math.max(0.08, Math.min(1, total / ref));
  }
  function jarHtml(pid, lots) {
    var p = product(pid);
    var total = lots.reduce(function (s, l) { return s + Number(l.qty_base); }, 0);
    var first = lots.filter(function (l) { return l.best_before; }).sort(function (a, b) { return a.best_before < b.best_before ? -1 : 1; })[0];
    var d = first ? daysUntil(first.best_before) : 99;
    var flag = d < 0 ? 'bad' : d <= 3 ? 'warn' : '';
    var opened = lots.some(function (l) { return l.opened_at; });
    var lvl = Math.round(jarLevel(pid, total) * 100);
    return '<button class="jar' + (opened ? ' opened' : '') + '" data-action="product" data-id="' + pid + '" aria-label="' + esc(p.name) + ', ' + esc(fmtQty(pid, total, false)) + (flag ? ', MHD bald' : '') + (opened ? ', angebrochen' : '') + '">' +
      '<span class="lid">' + (flag ? '<i class="' + flag + '"></i>' : '') + '</span><span class="body"><span class="fill ' + (CAT_CLASS[p.category] || 'c-sonst') + '" style="height:' + lvl + '%"></span><span class="label">' + esc(fmtQty(pid, total, false)) + '</span></span>' +
      '<span class="name">' + esc(p.name) + '</span></button>';
  }
  function viewPantry() {
    var locs = T().Location.slice().sort(function (a, b) { return a.sort - b.sort; });
    var view = state.pantryView || 'shelf';
    var h = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:10px"><div class="view-toggle" role="tablist"><button class="' + (view === 'shelf' ? 'on' : '') + '" data-action="pview" data-v="shelf">Regal</button><button class="' + (view === 'list' ? 'on' : '') + '" data-action="pview" data-v="list">Liste</button></div>' +
      '<button class="link" data-action="new-product">Produkt anlegen</button></div>';
    var byLoc = {};
    T().StockLot.forEach(function (l) { if (Number(l.qty_base) > 1e-9) { var m = (byLoc[l.location_id] = byLoc[l.location_id] || {}); (m[l.product_id] = m[l.product_id] || []).push(l); } });
    if (view === 'shelf') {
      h += '<div class="legend"><span><span class="dot warn"></span>MHD bald</span><span><span class="dot bad"></span>abgelaufen</span><span>Deckel schief: angebrochen</span></div>';
      locs.forEach(function (loc) {
        var m = byLoc[loc.location_id] || {};
        var pids = Object.keys(m).sort(function (a, b) { return product(a).name.localeCompare(product(b).name); });
        h += '<section class="shelf' + (/tief|frost|kühltruhe/i.test(loc.name) ? ' frost' : '') + '"><div class="shelf-head"><b>' + esc(loc.name) + '</b><span><span class="count">' + pids.length + ' Produkte</span> <button class="inv" data-action="inventory" data-loc="' + loc.location_id + '">Inventur</button></span></div>';
        if (!pids.length) h += '<div class="small muted" style="margin:0 10px 8px">Leer.</div><div class="board"></div></section>';
        else {
          // Bretter: je 4 Gläser eine Reihe (iPhone-Breite)
          var perRow = 4, rows = [];
          for (var i = 0; i < pids.length; i += perRow) rows.push(pids.slice(i, i + perRow));
          h += rows.map(function (r) { return '<div class="jars">' + r.map(function (pid) { return jarHtml(pid, m[pid]); }).join('') + '</div><div class="board" style="margin-bottom:18px"></div>'; }).join('') + '</section>';
        }
      });
    } else {
      h += '<div class="chips"><button class="chip' + (state.loc === 'all' ? ' on' : '') + '" data-action="loc" data-id="all">Alle</button>' +
        locs.map(function (l) { return '<button class="chip' + (state.loc === l.location_id ? ' on' : '') + '" data-action="loc" data-id="' + l.location_id + '">' + esc(l.name) + '</button>'; }).join('') + '</div>';
      var locFilter = state.loc === 'all' ? null : state.loc;
      var byProduct = {};
      T().StockLot.forEach(function (l) { if (Number(l.qty_base) <= 1e-9 || (locFilter && l.location_id !== locFilter)) return; (byProduct[l.product_id] = byProduct[l.product_id] || []).push(l); });
      var pids = Object.keys(byProduct).sort(function (a, b) { return product(a).name.localeCompare(product(b).name); });
      if (!pids.length) h += '<div class="panel"><div class="empty">Hier ist nichts eingelagert.</div></div>';
      else h += '<div class="panel">' + pids.map(function (pid) {
        var lots = EP.fefoSort(byProduct[pid]);
        var total = lots.reduce(function (s, l) { return s + Number(l.qty_base); }, 0);
        var first = lots.filter(function (l) { return l.best_before; })[0];
        var opened = lots.filter(function (l) { return l.opened_at; })[0];
        var sub = [];
        if (!locFilter) sub.push(Array.from(new Set(lots.map(function (l) { return locName(l.location_id); }))).join(', '));
        if (lots.length > 1) sub.push(lots.length + ' Chargen');
        if (opened) sub.push('offen seit ' + dNum(opened.opened_at));
        return '<div class="row indent tap" data-action="product" data-id="' + pid + '">' + Illus.dept(product(pid).category) + '<div class="grow"><div class="title">' + esc(product(pid).name) + '</div><div class="sub">' + esc(sub.join(', ')) + '</div></div>' +
          '<div style="text-align:right"><div class="qty">' + esc(fmtQty(pid, total)) + '</div>' + (first ? '<div style="margin-top:4px">' + mhdPill(first.best_before) + '</div>' : '') + '</div></div>';
      }).join('') + '</div>';
    }
    var low = T().MinStock.filter(function (m) { return EP.totalStock(store, m.product_id, m.location_id || null) < Number(m.min_qty_base) - 1e-9; });
    if (low.length) h += '<div class="sec">Unter Mindestbestand</div><div class="panel">' + low.map(function (m) {
      return '<div class="row indent tap" data-action="product" data-id="' + m.product_id + '">' + Illus.dept(product(m.product_id).category) + '<div class="grow"><div class="title">' + esc(product(m.product_id).name) + '</div><div class="sub">Mindestens ' + esc(fmtQty(m.product_id, Number(m.min_qty_base), false)) + '</div></div><div class="qty">' + esc(fmtQty(m.product_id, EP.totalStock(store, m.product_id, m.location_id || null), false)) + '</div></div>';
    }).join('') + '</div>';
    return h;
  }

  // ---- Einstellungen
  function viewSettings() {
    var check = EP.verifyLedger(store);
    var h = viewConnection();
    h += '<div class="sec">Produkte & Packungsregeln</div><div class="panel">' + T().Product.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (p) {
      var k = pkgOf(p);
      return '<div class="row tap" data-action="edit-product" data-id="' + p.product_id + '"><div class="grow"><div class="title">' + esc(p.name) + '</div><div class="sub">' + esc(p.category) + ' · Basiseinheit ' + esc(p.base_unit) + '</div></div><div class="small ' + (k ? '' : 'muted') + '">' + (k ? esc(k.label) : 'keine Packung') + '</div></div>';
    }).join('') + '</div>';
    var aliases = T().ProductAlias;
    h += '<div class="sec">Produktzuordnungen <button class="link" data-action="new-alias">+ Regel</button></div>';
    h += aliases.length ? '<div class="panel">' + aliases.map(function (a) {
      return '<div class="row"><div class="grow"><div class="title">„' + esc(a.alias_original) + '“ → ' + esc((product(a.product_id) || {}).name) + '</div><div class="sub">' + esc(a.status) + ' · Quelle ' + esc(a.source) + '</div></div></div>';
    }).join('') + '</div>' : '<div class="card small muted">Noch keine Regeln.</div>';
    h += '<div class="sec">Lagerorte <button class="link" data-action="new-location">+ Ort</button></div><div class="panel">' + T().Location.map(function (l) {
      return '<div class="row"><div class="grow"><div class="title">' + esc(l.name) + '</div></div><span class="muted small">' + esc(l.location_id) + '</span></div>';
    }).join('') + '</div>';
    h += '<div class="sec">Daten & Nachvollziehbarkeit</div><div class="panel">' +
      '<div class="row"><div class="grow"><div class="title">Bestand = Summe aller Buchungen</div><div class="sub">' + T().StockEvent.length + ' Buchungen im Journal</div></div>' + (check.ok ? '<span class="tag ok">geprüft ✓</span>' : '<span class="tag bad">' + check.problems.length + ' Abweichung(en)</span>') + '</div>' +
      '<div class="row tap" data-action="journal"><div class="grow"><div class="title">Buchungsjournal ansehen</div></div><span class="muted">›</span></div>' +
      '<div class="row tap" data-action="export"><div class="grow"><div class="title">Daten exportieren (JSON)</div></div><span class="muted">›</span></div>' +
      (Net.live() ? '<div class="row tap" data-action="resync"><div class="grow"><div class="title">Neu laden</div><div class="sub">Stand ' + rev + '</div></div><span class="muted">›</span></div></div>' :
      '<div class="row tap" data-action="reset"><div class="grow"><div class="title" style="color:var(--bad)">Beispieldaten zurücksetzen</div></div></div></div>');
    h += viewFamily();
    h += '<div class="sec">Sprache</div><div class="card small">' + (useAI() ? 'Diktat mit KI: Aufnahme wird von OpenAI (' + esc(ai.transcribe_model) + ') verschriftet und von ' + esc(ai.text_model) + ' in Aktionen zerlegt. Du bestätigst immer selbst; die KI bucht nie. Kosten: etwa 0,1 Cent je Satz.' :
      (speechSupported() ? 'Spracheingabe über die Spracherkennung des Browsers.' : 'Dieser Browser bietet keine direkte Spracherkennung. Nutze das Mikrofon der Tastatur (Diktat).') + ' Verstandener Text wird regelbasiert ausgewertet. Es fallen keine KI-Kosten an.' + (Net.live() && !ai.configured ? ' KI-Diktat lässt sich im Backend mit einem OpenAI-Schlüssel einschalten.' : '')) + '</div>';
    h += '<p class="small muted" style="margin:16px 4px">Tischlein 1.0 (Claude-Variante des Familien-Einkaufsplaners)</p>';
    return h;
  }

  function viewConnection() {
    var c = Net.conf();
    if (!Net.live()) {
      return '<div class="note">Demo-Modus: Beispieldaten nur auf diesem Gerät. Deine echten Bestände und die ChatGPT-Version werden nicht berührt.</div>' +
        '<div class="sec">Mit Google-Tabelle verbinden</div><div class="card">' +
        '<div class="field"><label for="connUrl">Backend-Adresse (Apps Script, endet auf /exec)</label><input id="connUrl" type="url" inputmode="url" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec" value="' + esc(c.backendUrl) + '"></div>' +
        '<div class="field"><label for="connCid">Google-Client-ID</label><input id="connCid" type="text" autocomplete="off" placeholder="…apps.googleusercontent.com" value="' + esc(c.clientId) + '"></div>' +
        '<button class="btn primary block" data-action="conn-save">Verbinden</button></div>';
    }
    return '<div class="sec">Konto & Datenbasis</div><div class="panel">' +
      '<div class="row"><div class="grow"><div class="title">' + esc(auth.name || auth.email || '') + '</div><div class="sub">' + esc(auth.email || '') + ' · ' + (auth.owner ? 'Besitzer' : 'Mitnutzer') + '</div></div><button class="link" data-action="logout">Abmelden</button></div>' +
      '<div class="row"><div class="grow"><div class="title">Datenbasis</div><div class="sub">' + (c.env === 'TEST' ? 'Testdaten – zum Ausprobieren' : 'Echte Daten') + '</div></div>' +
      '<div class="seg" style="width:170px"><button class="' + (c.env === 'TEST' ? 'on' : '') + '" data-action="conn-env" data-v="TEST">Test</button><button class="' + (c.env === 'PROD' ? 'on' : '') + '" data-action="conn-env" data-v="PROD">Echt</button></div></div>' +
      (auth.owner ? '<div class="row tap" data-action="conn-demo"><div class="grow"><div class="title">Verbindung trennen (Demo-Modus)</div></div></div>' : '') + '</div>';
  }
  function viewFamily() {
    if (!Net.live()) return '<div class="sec">Familienzugang</div><div class="card small">Nach dem Verbinden: Anmeldung mit Google, Zugangsanfrage per E-Mail an den Besitzer, Zugriff erst nach Freigabe.</div>';
    if (!auth.owner) return '';
    var h = '<div class="sec">Familienzugang</div>';
    if (!users) return h + '<div class="panel"><div class="row tap" data-action="users-load"><div class="grow"><div class="title">Personen & Anfragen anzeigen</div></div><span class="muted">›</span></div></div>';
    var order = { angefragt: 0, freigegeben: 1, abgelehnt: 2 };
    return h + '<div class="panel">' + users.slice().sort(function (a, b) { return (a.role === 'owner' ? -1 : order[a.status] || 0) - (b.role === 'owner' ? -1 : order[b.status] || 0); }).map(function (u) {
      var right = u.role === 'owner' ? '<span class="tag ok">Besitzer</span>' :
        u.status === 'angefragt' ? '<button class="mini" data-action="user-decide" data-email="' + esc(u.email) + '" data-v="0">Ablehnen</button> <button class="mini primary" data-action="user-decide" data-email="' + esc(u.email) + '" data-v="1">Freigeben</button>' :
        u.status === 'freigegeben' ? '<button class="link" data-action="user-decide" data-email="' + esc(u.email) + '" data-v="0">Entziehen</button>' :
        '<button class="link" data-action="user-decide" data-email="' + esc(u.email) + '" data-v="1">Doch freigeben</button>';
      var who = '<div class="grow" style="min-width:0"><div class="title">' + esc(u.name || u.email) + '</div><div class="sub" style="overflow-wrap:anywhere">' + esc(u.email) + (u.status === 'angefragt' ? ' · wartet auf Freigabe' : u.status === 'abgelehnt' ? ' · kein Zugang' : '') + '</div></div>';
      if (u.role !== 'owner' && u.status === 'angefragt') return '<div class="row" style="flex-wrap:wrap">' + who + '<div class="btn-row" style="width:100%;margin-top:8px">' + right.replace(/class="mini/g, 'class="btn') + '</div></div>';
      return '<div class="row">' + who + '<div style="white-space:nowrap">' + right + '</div></div>';
    }).join('') + '</div><p class="small muted" style="margin:8px 6px">Neue Person: App-Link schicken, sie meldet sich mit Google an und tippt „Zugang anfragen“. Du bekommst eine E-Mail.</p>';
  }

  var VIEWS = { today: viewToday, week: viewWeek, cookbook: viewCookbook, shopping: viewShopping, offers: viewOffers, pantry: viewPantry, settings: viewSettings };

  // ------------------------------------------------------------- Sheets
  function openSheet(s) { sheet = s; renderSheet(); $('sheet').classList.add('open'); $('backdrop').classList.add('open'); }
  function closeSheet() {
    if (recognition) { try { recognition.stop(); } catch (e) {} recognition = null; }
    if (media) { try { media.rec.onstop = null; media.rec.stop(); media.stream.getTracks().forEach(function (t) { t.stop(); }); clearTimeout(media.timer); } catch (e) {} media = null; }
    sheet = null; $('sheet').classList.remove('open'); $('backdrop').classList.remove('open'); render();
  }
  function head(title) { return '<div class="grab"></div><div class="sheet-head"><h3 id="sheetTitle">' + title + '</h3><button class="x" data-action="close-sheet" aria-label="Schließen"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>'; }
  function renderSheet() { if (!sheet) return; $('sheet').innerHTML = SHEETS[sheet.type](); }
  function locOptions(sel, allowEmpty) {
    return (allowEmpty ? '<option value="">Ort wählen…</option>' : '') + T().Location.map(function (l) { return '<option value="' + l.location_id + '"' + (l.location_id === sel ? ' selected' : '') + '>' + esc(l.name) + '</option>'; }).join('');
  }
  function unitOptions(p, sel) {
    var u = [p.base_unit]; if (p.base_unit === 'g') u.push('kg'); if (p.base_unit === 'ml') u.push('l'); if (pkgOf(p)) u.push('Pkg');
    return u.map(function (x) { return '<option' + (x === sel ? ' selected' : '') + '>' + x + '</option>'; }).join('');
  }
  function lastLocation(pid) { var l = T().StockLot.filter(function (x) { return x.product_id === pid; }); return l.length ? l[l.length - 1].location_id : ''; }

  var RECIPE_UNITS = ['g', 'kg', 'ml', 'l', 'Stk', 'Pkg', 'EL', 'TL', 'Prise', 'Msp', 'Bund', 'Zehe', 'Scheibe', 'Tasse', 'Handvoll', 'Schuss', 'Knolle', 'Stange', 'Zweig', 'Blatt', 'Würfel', 'Kopf'];
  /** Was beim Kochen mit dieser Zutat passiert – ehrlich, ohne zu raten */
  function ingCheck(x) {
    if (x.pid === '') return { cls: 'unclear', text: 'Ohne Zuordnung – wird beim Kochen nicht abgebucht' };
    if (x.qty === '' || x.qty == null) return { cls: 'unclear', text: 'Ohne Menge – wird nicht abgebucht' };
    var p = x.pid === '__new' ? { base_unit: x.newUnit } : product(x.pid);
    if (!p) return { cls: 'unclear', text: 'Produkt fehlt' };
    if (x.pid === '__new') {
      var u = x.unit || x.newUnit;
      var okU = u === x.newUnit || (x.newUnit === 'g' && u === 'kg') || (x.newUnit === 'ml' && (u === 'l' || u === 'cl'));
      return okU ? { cls: 'ok', text: 'Neues Produkt „' + x.newName + '“ (' + x.newUnit + ')' } : { cls: 'unclear', text: u + ' lässt sich nicht in ' + x.newUnit + ' umrechnen – wird nicht abgebucht' };
    }
    var r = EP.toBase(store, x.pid, Number(x.qty), x.unit || p.base_unit);
    return r.ok ? { cls: 'ok', text: '→ ' + p.name + (x.unit && x.unit !== p.base_unit ? ' (' + fmtNum(r.qty_base) + ' ' + p.base_unit + ')' : '') } : { cls: 'unclear', text: r.reason + ' – wird nicht abgebucht' };
  }
  function importIngCard(x, i) {
    var c = ingCheck(x);
    var opts = '<option value="">Ohne Zuordnung</option><option value="__new"' + (x.pid === '__new' ? ' selected' : '') + '>+ Neu anlegen: ' + esc(x.newName) + '</option>';
    if (x.candidates && x.candidates.length) opts += '<optgroup label="Vorschläge">' + x.candidates.map(function (cd) { return '<option value="' + cd.product_id + '"' + (cd.product_id === x.pid ? ' selected' : '') + '>' + esc(cd.name) + '</option>'; }).join('') + '</optgroup>';
    opts += '<optgroup label="Alle Produkte">' + T().Product.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (p) { return '<option value="' + p.product_id + '"' + (p.product_id === x.pid ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</optgroup>';
    var units = RECIPE_UNITS.slice(); if (x.unit && units.indexOf(x.unit) < 0) units.unshift(x.unit);
    var h = '<div class="action-card ing-card ' + c.cls + '"><div class="raw">' + esc(x.text_original) + (x.note && String(x.text_original).indexOf(x.note) < 0 ? ' <span class="muted">· ' + esc(x.note) + '</span>' : '') + '</div>' +
      '<div class="field"><select data-ing="pid" data-idx="' + i + '" aria-label="Produkt">' + opts + '</select></div>' +
      '<div class="grid2"><input type="number" inputmode="decimal" step="any" min="0" placeholder="Menge" value="' + esc(x.qty == null ? '' : x.qty) + '" data-ing="qty" data-idx="' + i + '" aria-label="Menge">' +
      '<select data-ing="unit" data-idx="' + i + '" aria-label="Einheit"><option value="">' + (x.pid && x.pid !== '__new' && product(x.pid) ? product(x.pid).base_unit : 'Einheit') + '</option>' + units.map(function (u) { return '<option' + (u === x.unit ? ' selected' : '') + '>' + u + '</option>'; }).join('') + '</select></div>';
    if (x.pid === '__new') h += '<div class="grid2" style="margin-top:8px"><select data-ing="newUnit" data-idx="' + i + '" aria-label="Gezählt in">' + [['g', 'in Gramm'], ['ml', 'in Milliliter'], ['Stk', 'in Stück']].map(function (u) { return '<option value="' + u[0] + '"' + (u[0] === x.newUnit ? ' selected' : '') + '>' + u[1] + '</option>'; }).join('') + '</select>' +
      '<select data-ing="newCat" data-idx="' + i + '" aria-label="Abteilung">' + DEPT_ORDER.filter(function (d) { return d !== 'Unklar'; }).map(function (d) { return '<option' + (d === x.newCat ? ' selected' : '') + '>' + d + '</option>'; }).join('') + '</select></div>';
    return h + '<div class="small ing-check ' + c.cls + '">' + esc(c.text) + '</div></div>';
  }
  function guessBase(unit) { return /^(g|kg)$/.test(unit) ? 'g' : /^(ml|l|cl)$/.test(unit) ? 'ml' : 'Stk'; }
  function guessDept(name) {
    var n = String(name).toLowerCase();
    if (/salat|tomate|gurke|zwiebel|knoblauch|kartoffel|möhre|karotte|paprika|zucchini|petersilie|basilikum|schnittlauch|apfel|zitrone|banane|lauch|spinat|pilz|champignon|ingwer|kräuter|avocado|aubergine|brokkoli/.test(n)) return 'Obst & Gemüse';
    if (/milch|sahne|joghurt|quark|käse|feta|mozzarella|parmesan|butter|ei$|eier|schmand|frischkäse|gnocchi|maultasche|speck|schinken|wurst|hähnchen|hackfleisch|tofu/.test(n)) return 'Kühlregal';
    if (/brot|brötchen|bun|toast|baguette|wrap|tortilla/.test(n)) return 'Brot & Backwaren';
    if (/tiefkühl|tk |erbsen|pommes/.test(n)) return 'Tiefkühl';
    return 'Vorrat';
  }

  var SHEETS = {
    importRecipe: function () {
      var st = sheet;
      if (!st.data) {
        var h = head('Rezept übernehmen');
        h += '<div class="seg" style="margin-bottom:12px"><button class="' + (st.mode === 'link' ? 'on' : '') + '" data-action="imp-mode" data-v="link">Link</button><button class="' + (st.mode === 'text' ? 'on' : '') + '" data-action="imp-mode" data-v="text">Text einfügen</button></div>';
        h += st.mode === 'link' ? '<div class="field"><label for="impUrl">Link zur Rezeptseite</label><input id="impUrl" type="url" inputmode="url" autocomplete="off" placeholder="https://www.chefkoch.de/rezepte/…" value="' + esc(st.url) + '" data-impin="url"></div>' :
          '<div class="field"><label for="impText">Rezepttext (Name, Zutaten, Zubereitung)</label><textarea id="impText" data-impin="text" placeholder="Name in der ersten Zeile, dann Zutaten …">' + esc(st.text) + '</textarea></div>';
        h += '<button class="btn primary block" data-action="imp-load"' + (st.loading ? ' disabled' : '') + '>' + (st.loading ? 'Lade und prüfe …' : 'Rezept holen') + '</button>';
        h += '<p class="small muted" style="margin-top:12px">Ich lese Name, Portionen, Zeit, Zutaten und Schritte aus. Gespeichert wird erst, wenn du die Zutaten geprüft hast.' + (ai.configured ? ' Seiten ohne Rezeptdaten wertet die KI aus.' : '') + '</p>';
        return h;
      }
      var d = st.data, r = d.recipe;
      var dup = r.source_url && T().Recipe.filter(function (x) { return x.source_url === r.source_url; })[0];
      var open = d.ingredients.filter(function (x) { return ingCheck(x).cls !== 'ok'; }).length;
      var h2 = head('Prüfen & speichern');
      if (r.image_url) h2 += '<img class="imp-photo" src="' + esc(r.image_url) + '" alt="" referrerpolicy="no-referrer" onerror="this.remove()">';
      if (dup) h2 += '<div class="note">„' + esc(dup.name) + '“ mit diesem Link ist schon im Kochbuch. Speichern legt eine zweite Fassung an.</div>';
      h2 += '<div class="field"><label>Name</label><input type="text" data-impr="name" value="' + esc(r.name) + '"></div>';
      h2 += '<div class="grid2"><div class="field"><label>Portionen (Rezept ist für …)</label><input type="number" inputmode="numeric" min="1" data-impr="servings" value="' + esc(r.servings || '') + '" placeholder="fehlt" style="' + (r.servings ? '' : 'outline:2px solid var(--warn)') + '"></div>' +
        '<div class="field"><label>Minuten</label><input type="number" inputmode="numeric" data-impr="minutes" value="' + esc(r.minutes || '') + '"></div></div>';
      h2 += '<div class="sec">Zutaten <span class="aside">' + (open ? open + ' noch offen' : 'alles zugeordnet') + '</span></div>';
      h2 += '<p class="small muted" style="margin:-4px 4px 10px">Gelb: wird beim Kochen nicht abgebucht, bis es geklärt ist. Speichern geht trotzdem; zuordnen kannst du auch später. Zuordnungen gelten künftig für alle Rezepte, Bons und Sprache.</p>';
      h2 += d.ingredients.map(importIngCard).join('');
      h2 += '<div class="sec">Zubereitung</div><div class="field"><textarea data-impr="steps" rows="6">' + esc(r.steps) + '</textarea></div>';
      h2 += '<p class="small muted">Quelle: ' + esc(d.source) + (r.source_url ? ' · <a href="' + esc(r.source_url) + '" target="_blank" rel="noopener">Seite öffnen</a>' : '') + '</p>';
      h2 += '<button class="btn primary block" data-action="imp-save"' + (r.name && r.servings ? '' : ' disabled') + '>Ins Kochbuch</button>';
      if (!r.servings) h2 += '<p class="small muted" style="text-align:center">Bitte Portionen angeben – sonst lässt sich nicht richtig umrechnen.</p>';
      return h2;
    },
    cook: function () {
      var r = recipe(sheet.recipe_id);
      if (sheet.result) {
        return head(doneTitle()) + '<div class="panel">' + sheet.result.lines.map(function (l) {
          var p = l.product_id ? product(l.product_id) : null;
          var right = l.status === 'ok' ? '<span class="qty">−' + esc(fmtQty(l.product_id, l.booked, false)) + '</span>' :
            l.status === 'teilweise' ? '<span class="tag warn">−' + esc(fmtQty(l.product_id, l.booked, false)) + ', fehlte ' + esc(fmtQty(l.product_id, l.missing, false)) + '</span>' :
            '<span class="tag unclear">nicht gebucht</span>';
          return '<div class="row"><div class="grow"><div class="title">' + esc(p ? p.name : l.text) + '</div>' + (l.reason ? '<div class="sub">' + esc(l.reason) + '</div>' : '') + '</div>' + right + '</div>';
        }).join('') + '</div><p class="small muted">Vorgang ' + esc(sheet.result.cook_id) + ' · ' + sheet.result.events.length + ' Buchungen im Journal</p><button class="btn primary block" data-action="close-sheet">Fertig</button>';
      }
      var pv = EP.previewCook(store, sheet.recipe_id, sheet.persons, sheet.overrides);
      var h = head(esc(r.name) + ' gekocht?');
      h += '<div class="sheet-hero">' + Illus.dish(r) + '<div class="muted">Prüf kurz die Mengen. Abgebucht wird erst mit dem Knopf unten.</div></div>';
      h += '<div class="row" style="padding:0 2px 12px;border:0"><div class="grow muted">Personen</div><div class="stepper"><button data-action="cook-persons" data-d="-1">−</button><span>' + sheet.persons + '</span><button data-action="cook-persons" data-d="1">+</button></div></div>';
      h += '<div class="panel">' + pv.lines.map(function (l) {
        if (l.status === 'unklar') return '<div class="row"><span class="dot unclear"></span><div class="grow"><div class="title">' + esc(l.text) + '</div><div class="sub">' + esc(l.reason) + ' · wird nicht abgebucht</div></div></div>';
        if (l.status === 'übersprungen') return '<div class="row"><span class="dot"></span><div class="grow"><div class="title muted">' + esc(l.text) + '</div><div class="sub">nicht verwendet</div></div><button class="mini" data-action="cook-skip" data-line="' + l.line_no + '">Doch</button></div>';
        var p = product(l.product_id);
        return '<div class="row"><span class="dot ' + (l.missing > 1e-9 ? 'warn' : 'ok') + '"></span><div class="grow"><div class="title">' + esc(p.name) + '</div><div class="sub">Vorrat ' + esc(fmtQty(l.product_id, l.in_stock, false)) + (l.missing > 1e-9 ? ' · fehlt ' + esc(fmtQty(l.product_id, l.missing, false)) : '') + '</div></div>' +
          '<input type="number" inputmode="decimal" step="any" min="0" style="width:84px" value="' + fmtNum(l.qty_base).replace(',', '.') + '" data-change="cook-qty" data-line="' + l.line_no + '"><span class="small muted" style="width:26px">' + esc(p.base_unit) + '</span>' +
          '<button class="mini" data-action="cook-skip" data-line="' + l.line_no + '" aria-label="nicht verwendet">✕</button></div>';
      }).join('') + '</div>';
      h += '<p class="small muted">Mengen sind änderbar, falls du tatsächlich mehr oder weniger verwendet hast. Abgezogen wird zuerst die Ware mit dem frühesten MHD, angebrochene Packungen zuerst.</p>';
      h += '<button class="btn primary block" data-action="cook-confirm">Zutaten abbuchen</button>';
      return h;
    },

    recipe: function () {
      var r = recipe(sheet.id), p = sheet.persons;
      var ings = T().RecipeIngredient.filter(function (i) { return i.recipe_id === r.recipe_id; }).sort(function (a, b) { return a.line_no - b.line_no; });
      var h = head(esc(r.name));
      h += '<div class="sheet-hero">' + recipePic(r) + '<div class="muted">' + esc(r.minutes) + ' Minuten<br>Grundrezept für ' + esc(r.servings_base) + (r.source_url ? '<br><a href="' + esc(r.source_url) + '" target="_blank" rel="noopener">Quelle öffnen</a>' : '') + '</div></div>';
      h += '<div class="row" style="padding:0 2px 12px;border:0"><div class="grow muted">Personen</div><div class="stepper"><button data-action="recipe-persons" data-d="-1">−</button><span>' + p + '</span><button data-action="recipe-persons" data-d="1">+</button></div></div>';
      h += '<div class="panel">' + ings.map(function (i) {
        var q = i.qty === '' || i.qty == null ? null : Number(i.qty) * (i.per === 'Person' ? p : p / Number(r.servings_base || 2));
        var stock = i.product_id ? EP.totalStock(store, i.product_id) : null;
        var dot = !i.product_id ? 'unclear' : stock > 0 ? 'ok' : 'bad';
        return '<div class="row"><span class="dot ' + dot + '"></span><div class="grow"><div class="title">' + esc(i.text_original) + '</div><div class="sub">' + (i.product_id ? 'Vorrat ' + esc(fmtQty(i.product_id, stock, false)) : 'keinem Produkt zugeordnet') + (i.per === 'Person' ? ' · pro Person' : '') + '</div></div><div class="qty">' + (q == null ? '<span class="tag unclear">ohne Menge</span>' : esc(fmtNum(q) + ' ' + (i.unit || ''))) + '</div></div>';
      }).join('') + '</div>';
      if (r.steps) h += '<div class="sec">Zubereitung</div><div class="card"><ol class="steps">' + r.steps.split('\n').filter(Boolean).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol></div>';
      h += '<div class="btn-row" style="margin-bottom:10px"><button class="btn" data-action="fav" data-id="' + r.recipe_id + '">' + (r.favorite ? '★ Favorit' : '☆ Favorit') + '</button><button class="btn" data-action="dislike" data-id="' + r.recipe_id + '">' + (r.disliked ? 'Wieder erlaubt' : 'Unerwünscht') + '</button></div>';
      h += '<button class="btn primary block" data-action="cook" data-id="' + r.recipe_id + '" data-persons="' + p + '">Gekocht</button>';
      return h;
    },

    newRecipe: function () {
      var d = sheet.draft;
      var h = head('Neues Rezept');
      h += '<div class="field"><label>Name</label><input type="text" data-draft="name" value="' + esc(d.name) + '"></div>';
      h += '<div class="grid3"><div class="field"><label>Minuten</label><input type="number" inputmode="numeric" data-draft="minutes" value="' + esc(d.minutes) + '"></div><div class="field"><label>Für Personen</label><input type="number" inputmode="numeric" data-draft="servings" value="' + esc(d.servings) + '"></div><div class="field"><label>Kategorie</label><input type="text" data-draft="category" value="' + esc(d.category) + '"></div></div>';
      h += '<div class="field"><label>Zutaten, eine pro Zeile: „Menge Einheit Zutat“, optional „pro Person“</label><textarea data-draft="ingredients" placeholder="125 g Spaghetti pro Person&#10;1 Zwiebel&#10;Salz">' + esc(d.ingredients) + '</textarea></div>';
      h += '<div class="field"><label>Zubereitung (ein Schritt pro Zeile)</label><textarea data-draft="steps">' + esc(d.steps) + '</textarea></div>';
      h += '<div class="field"><label>Rezeptlink (optional)</label><input type="text" inputmode="url" data-draft="url" value="' + esc(d.url) + '" placeholder="https://…"></div>';
      if (d.url && Net.live()) h += '<div class="note">Für Links gibt es den Import mit Prüfung: Kochbuch → „Rezept aus Link übernehmen“.</div>';
      var parsed = parseIngredients(d.ingredients);
      if (parsed.length) h += '<div class="sec">Prüfung</div><div class="panel">' + parsed.map(function (x) {
        return '<div class="row"><span class="dot ' + (x.product_id && x.qty != null ? 'ok' : 'unclear') + '"></span><div class="grow"><div class="title">' + esc(x.text) + '</div><div class="sub">' + (x.product_id ? '→ ' + esc(product(x.product_id).name) : x.suggest ? 'Meinst du ' + esc(x.suggest) + '? Ohne Bestätigung keine Zuordnung' : 'kein Produkt, wird nicht abgebucht') + (x.qty == null ? ' · ohne Menge' : '') + '</div></div><div class="qty">' + (x.qty != null ? esc(fmtNum(x.qty) + ' ' + x.unit) : '') + (x.per === 'Person' ? '<div class="small muted">pro Person</div>' : '') + '</div></div>';
      }).join('') + '</div>';
      h += '<button class="btn primary block" data-action="save-recipe"' + (d.name.trim() ? '' : ' disabled') + '>Rezept speichern</button>';
      return h;
    },

    product: function () {
      var p = product(sheet.id);
      var lots = EP.fefoSort(EP.lotsOf(store, p.product_id));
      var total = EP.totalStock(store, p.product_id);
      var k = pkgOf(p);
      var h = head(esc(p.name));
      h += '<div class="meta" style="margin-bottom:12px"><span class="qty" style="color:var(--ink)">' + esc(fmtQty(p.product_id, total)) + '</span><span>' + (k ? 'Packung: ' + esc(k.label) : 'keine Packungsregel') + '</span></div>';
      if (lots.length) h += '<div class="panel">' + lots.map(function (l) {
        return '<div class="row"><div class="grow"><div class="title">' + esc(fmtQty(p.product_id, Number(l.qty_base))) + '</div><div class="sub">' + esc(locName(l.location_id)) + (l.opened_at ? ' · angebrochen ' + dNum(l.opened_at) : ' · ungeöffnet') + (l.condition ? ' · ' + esc(l.condition) : '') + '</div></div>' + mhdPill(l.best_before) +
          (l.opened_at ? '' : '<button class="mini" data-action="open-lot" data-id="' + l.lot_id + '">Öffnen</button>') + '</div>';
      }).join('') + '</div>';
      var f = sheet.form;
      h += '<div class="sec">Buchen</div><div class="seg" style="margin-bottom:10px">' + [['add', 'Dazu'], ['set', 'Insgesamt'], ['remove', 'Entnehmen']].map(function (x) { return '<button class="' + (f.intent === x[0] ? 'on' : '') + '" data-action="pform-intent" data-v="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>';
      h += '<div class="grid3"><div class="field"><label>Menge</label><input type="number" inputmode="decimal" step="any" min="0" data-pform="qty" value="' + esc(f.qty) + '"></div><div class="field"><label>Einheit</label><select data-pform="unit">' + unitOptions(p, f.unit) + '</select></div><div class="field"><label>Ort</label><select data-pform="loc">' + locOptions(f.loc, true) + '</select></div></div>';
      if (f.intent === 'add') h += '<div class="field"><label>MHD (optional)</label><input type="date" data-pform="bb" value="' + esc(f.bb) + '"></div>';
      h += '<div class="btn-row"><button class="btn danger" data-action="used-up">Aufgebraucht</button><button class="btn primary" data-action="pform-book">Buchen</button></div>';
      var ev = T().StockEvent.filter(function (e) { return e.product_id === p.product_id; }).slice(-15).reverse();
      h += '<div class="sec">Verlauf</div>' + (ev.length ? '<div class="panel">' + ev.map(function (e) {
        var dlt = Number(e.delta_base);
        return '<div class="row"><div class="grow"><div class="title">' + esc(EVENT_LABEL[e.type] || e.type) + '</div><div class="sub">' + esc(dShort(String(e.ts).slice(0, 10))) + ' ' + esc(String(e.ts).slice(11, 16)) + ' · ' + esc(locName(e.location_id)) + (e.note ? ' · ' + esc(e.note) : '') + '</div></div><div class="qty" style="color:' + (dlt < 0 ? 'var(--bad)' : dlt > 0 ? 'var(--ok)' : 'var(--muted)') + '">' + (dlt > 0 ? '+' : dlt < 0 ? '−' : '±') + esc(fmtQty(p.product_id, Math.abs(dlt), false)) + '</div></div>';
      }).join('') + '</div>' : '<div class="card small muted">Noch keine Buchungen.</div>');
      return h;
    },

    inventory: function (el) {
      var loc = sheet.loc;
      var h = head('Inventur');
      h += '<div class="field"><label>Lagerort</label><select data-change="inv-loc">' + locOptions(loc, true) + '</select></div>';
      if (!loc) return h + '<p class="muted">Wähle den Ort, den du gerade zählst. Andere Orte bleiben unverändert.</p>';
      h += '<div class="note info">Trage ein, was jetzt tatsächlich im ' + esc(locName(loc)) + ' ist. Nicht aufgeführte Produkte werden hier auf 0 gesetzt. Andere Lagerorte bleiben unverändert.</div>';
      h += '<div class="panel">' + sheet.rows.map(function (r, idx) {
        var p = product(r.product_id);
        return '<div class="row"><div class="grow"><div class="title">' + esc(p.name) + '</div><div class="sub">bisher ' + esc(fmtQty(p.product_id, r.before, false)) + '</div></div><input type="number" inputmode="decimal" step="any" min="0" style="width:90px" value="' + esc(r.qty) + '" data-change="inv-qty" data-idx="' + idx + '"><span class="small muted" style="width:26px">' + esc(p.base_unit) + '</span></div>';
      }).join('') + '</div>';
      var others = T().Product.filter(function (p) { return !sheet.rows.some(function (r) { return r.product_id === p.product_id; }); });
      h += '<div class="field"><select data-change="inv-add"><option value="">+ Produkt hinzufügen…</option>' + others.map(function (p) { return '<option value="' + p.product_id + '">' + esc(p.name) + '</option>'; }).join('') + '</select></div>';
      h += '<button class="btn primary block" data-action="inv-save">Inventur speichern</button>';
      return h;
    },

    voice: function () {
      var h = head(sheet.listMode ? 'Auf die Einkaufsliste' : 'Sag, was sich geändert hat');
      h += '<button class="mic-big' + (recognition || media ? ' live' : '') + '" data-action="mic" aria-label="' + (media ? 'Aufnahme beenden' : 'Aufnahme starten') + '"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>';
      if (useAI()) h += '<p class="small muted" style="text-align:center;margin-top:-6px">' + (media ? 'Ich höre zu … Tippe nochmal, wenn du fertig bist.' : sheet.thinking ? 'Ich werte aus …' : 'Tippen, sprechen, nochmal tippen. Mit KI ausgewertet.') + '</p>';
      else if (!speechSupported()) h += '<p class="small muted" style="text-align:center;margin-top:-6px">Tippe ins Textfeld und nutze das Mikrofon der Tastatur.</p>';
      h += '<div class="field"><textarea id="voiceText" data-voice="text" placeholder="' + (sheet.listMode ? 'z. B. Milch, zwei Gurken und Spülmittel' : 'z. B. Wir haben noch drei Äpfel, eine Gurke und Maasdamer, haltbar bis 15. Dezember') + '">' + esc(sheet.text) + '</textarea></div>';
      if (!sheet.listMode) h += '<div class="seg" style="margin-bottom:12px"><button class="' + (!sheet.inventur ? 'on' : '') + '" data-action="voice-mode" data-v="0">Normal</button><button class="' + (sheet.inventur ? 'on' : '') + '" data-action="voice-mode" data-v="1">Inventur („noch“ = gesamt)</button></div>';
      h += '<button class="btn block" data-action="voice-parse"' + (sheet.thinking ? ' disabled' : '') + '>' + (sheet.thinking ? 'Werte aus …' : 'Verstehen') + '</button>';
      if (sheet.actions) {
        if (!sheet.actions.length) return h + '<div class="card muted" style="margin-top:12px">Ich habe kein Produkt erkannt. Formuliere es bitte etwas anders.</div>';
        h += '<div class="sec">Erkannt: ' + sheet.actions.length + ' Aktion(en)</div>';
        h += sheet.actions.map(function (a, i) { return sheet.listMode ? listActionCard(a, i) : actionCard(a, i); }).join('');
        var ok = sheet.actions.every(function (a) { return actionValid(a); });
        h += '<button class="btn primary block" data-action="voice-book"' + (ok ? '' : ' disabled') + '>' + (sheet.listMode ? 'Hinzufügen' : 'Alles buchen') + '</button>';
        if (!ok) h += '<p class="small muted" style="text-align:center">Gelb markierte Angaben bitte noch wählen.</p>';
      }
      return h;
    },

    editProduct: function () {
      var p = product(sheet.id), k = pkgOf(p), f = sheet.form;
      var h = head(esc(p.name));
      h += '<div class="note info">Die Packungsregel gilt überall: bei Bons, im Vorrat, in der Einkaufsliste und in jedem Rezept.</div>';
      h += '<div class="field"><label>Bezeichnung der Packung</label><input type="text" data-eform="label" value="' + esc(f.label) + '" placeholder="z. B. Doppelpackung"></div>';
      h += '<div class="grid2"><div class="field"><label>Inhalt</label><input type="number" inputmode="decimal" step="any" data-eform="qty" value="' + esc(f.qty) + '"></div><div class="field"><label>Einheit</label><select data-eform="unit">' + [p.base_unit].concat(p.base_unit === 'g' ? ['kg'] : p.base_unit === 'ml' ? ['l'] : []).map(function (u) { return '<option' + (u === f.unit ? ' selected' : '') + '>' + u + '</option>'; }).join('') + '</select></div></div>';
      h += '<p class="small muted">Basiseinheit: ' + esc(p.base_unit) + (k ? ' · aktuell: ' + esc(k.label) + ' = ' + esc(k.content_qty) + ' ' + esc(k.content_unit) : '') + '</p>';
      h += '<button class="btn primary block" data-action="save-package">Packungsregel bestätigen</button>';
      return h;
    },

    newProduct: function () {
      var f = sheet.form;
      var h = head('Neues Produkt');
      h += '<div class="field"><label>Name</label><input type="text" data-nform="name" value="' + esc(f.name) + '"></div>';
      h += '<div class="grid2"><div class="field"><label>Abteilung</label><select data-nform="category">' + DEPT_ORDER.filter(function (d) { return d !== 'Unklar'; }).map(function (d) { return '<option' + (d === f.category ? ' selected' : '') + '>' + d + '</option>'; }).join('') + '</select></div>';
      h += '<div class="field"><label>Gezählt in</label><select data-nform="unit">' + [['Stk', 'Stück'], ['g', 'Gramm'], ['ml', 'Milliliter']].map(function (u) { return '<option value="' + u[0] + '"' + (u[0] === f.unit ? ' selected' : '') + '>' + u[1] + '</option>'; }).join('') + '</select></div></div>';
      h += '<button class="btn primary block" data-action="save-product"' + (f.name.trim() ? '' : ' disabled') + '>Anlegen</button>';
      return h;
    },

    alias: function () {
      var f = sheet.form;
      var h = head('Neue Zuordnungsregel');
      h += '<div class="field"><label>Schreibweise (Bon, Sprache, Rezept)</label><input type="text" data-aform="text" value="' + esc(f.text) + '" placeholder="z. B. BIO MAASD. SCHEIBEN"></div>';
      h += '<div class="field"><label>Gemeintes Produkt</label><select data-aform="pid"><option value="">wählen…</option>' + T().Product.map(function (p) { return '<option value="' + p.product_id + '"' + (p.product_id === f.pid ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</select></div>';
      h += '<button class="btn primary block" data-action="save-alias"' + (f.text && f.pid ? '' : ' disabled') + '>Regel bestätigen</button>';
      return h;
    },

    shopEdit: function () {
      var i = T().ShoppingItem.filter(function (x) { return x.item_id === sheet.id; })[0];
      if (!i) return head('Artikel') + '<p>Nicht gefunden.</p>';
      var p = i.product_id ? product(i.product_id) : null;
      var h = head(esc(i.text));
      if (i.unclear_reason) h += '<div class="note">' + esc(i.unclear_reason) + '. Die Menge wird nicht geschätzt.</div>';
      if (p && !i.unclear_reason) {
        h += '<div class="field"><label>Einkaufsmenge in ' + esc(p.base_unit) + ' (überschreibt die Berechnung)</label><input type="number" inputmode="decimal" step="any" id="ovr" value="' + esc(i.manual_override !== '' && i.manual_override != null ? i.manual_override : i.qty_to_buy) + '"></div>';
        h += '<p class="small muted">Berechnet: ' + esc(fmtQty(p.product_id, i.qty_needed || 0, false)) + ' benötigt, ' + esc(fmtQty(p.product_id, i.qty_available || 0, false)) + ' vorhanden.</p>';
        h += '<div class="btn-row"><button class="btn" data-action="shop-ovr-clear">Berechnung nutzen</button><button class="btn primary" data-action="shop-ovr-save">Übernehmen</button></div>';
      }
      if (i.origin === 'manuell') h += '<button class="btn danger block" style="margin-top:10px" data-action="shop-remove">Entfernen</button>';
      return h;
    },

    bookChecked: function () {
      var h = head('In den Vorrat buchen');
      if (sheet.result) {
        return head(doneTitle()) + '<p>' + sheet.result.booked.length + ' Position(en) im Vorrat gebucht.</p>' + (sheet.result.skipped.length ? '<div class="note">' + sheet.result.skipped.length + ' nicht gebucht: ' + esc(sheet.result.skipped.map(function (s) { return s.reason; }).join('; ')) + '</div>' : '') + '<button class="btn primary block" data-action="close-sheet">Fertig</button>';
      }
      h += '<div class="note info">Lagerorte sind nach Abteilung vorbelegt. Bitte kurz prüfen.</div>';
      h += sheet.lines.map(function (l, idx) {
        var p = l.product_id ? product(l.product_id) : null;
        if (!p) return '<div class="action-card"><b>' + esc(l.text) + '</b><div class="small muted">Kein Produkt zugeordnet: wird nur abgehakt, kein Bestand gebucht.</div></div>';
        return '<div class="action-card"><b>' + esc(p.name) + '</b><div class="grid3" style="margin-top:8px"><input type="number" inputmode="decimal" step="any" value="' + esc(l.qty) + '" data-bline="qty" data-idx="' + idx + '"><select data-bline="unit" data-idx="' + idx + '">' + unitOptions(p, l.unit) + '</select><select data-bline="loc" data-idx="' + idx + '">' + locOptions(l.loc, true) + '</select></div>' +
          '<div class="field" style="margin:8px 0 0"><input type="date" data-bline="bb" data-idx="' + idx + '" value="' + esc(l.bb) + '" aria-label="MHD"></div></div>';
      }).join('');
      h += '<button class="btn primary block" data-action="book-confirm">Buchen</button>';
      return h;
    },

    journal: function () {
      var ev = T().StockEvent.slice(-60).reverse();
      return head('Buchungsjournal') + '<p class="small muted">Jede Bestandsänderung ist eine unveränderliche Buchung. Korrekturen werden als Gegenbuchung erfasst.</p><div class="panel">' + ev.map(function (e) {
        var p = product(e.product_id);
        return '<div class="row"><div class="grow"><div class="title">' + esc(p ? p.name : e.product_id) + ' · ' + esc(EVENT_LABEL[e.type] || e.type) + '</div><div class="sub">' + esc(String(e.ts).replace('T', ' ').slice(0, 16)) + ' · ' + esc(locName(e.location_id)) + ' · ' + esc(e.tx_id) + (e.note ? ' · ' + esc(e.note) : '') + '</div></div><div class="qty">' + (Number(e.delta_base) > 0 ? '+' : '') + esc(fmtNum(Number(e.delta_base))) + '</div></div>';
      }).join('') + '</div>';
    },

    newLocation: function () {
      return head('Neuer Lagerort') + '<div class="field"><label>Name</label><input type="text" id="locName" placeholder="z. B. Garage"></div><button class="btn primary block" data-action="save-location">Anlegen</button>';
    }
  };

  // ---- Sprache
  function speechSupported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
  /** KI-Diktat: Aufnahme im Browser (MediaRecorder), Verschriftung serverseitig. Zweiter Tipp beendet. */
  function startRecording() {
    if (media) { media.rec.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast('Aufnahme wird hier nicht unterstützt – nutze das Mikrofon der Tastatur', true); var ta0 = $('voiceText'); if (ta0) ta0.focus(); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].filter(function (t) { return MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t); })[0] || '';
      var rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined), chunks = [];
      var sh = sheet;
      media = { rec: rec, stream: stream, timer: setTimeout(function () { if (rec.state === 'recording') rec.stop(); }, 60000) };
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = function () {
        clearTimeout(media.timer); stream.getTracks().forEach(function (t) { t.stop(); }); media = null;
        var blob = new Blob(chunks, { type: rec.mimeType || type || 'audio/mp4' });
        if (!blob.size || sheet !== sh) { renderSheet(); return; }
        sh.thinking = true; renderSheet();
        var fr = new FileReader();
        fr.onload = function () {
          var b64 = String(fr.result).split(',')[1];
          Net.call('transcribe', { audio: b64, mime: blob.type }, { timeout: 90000 }).then(function (r) {
            if (sheet !== sh) return;
            sh.thinking = false;
            if (!r.ok) { toast((r.message || 'Verschriftung fehlgeschlagen') + ' – tippe den Satz oder nutze das Tastatur-Diktat.', true); renderSheet(); return; }
            sh.text = (sh.text ? sh.text + ' ' : '') + r.text;
            if (sh.text.trim()) interpretAI(); else { toast('Nichts verstanden – bitte nochmal', true); renderSheet(); }
          });
        };
        fr.readAsDataURL(blob);
      };
      rec.start(); renderSheet();
    }).catch(function () { toast('Mikrofon nicht erlaubt. Erlaube es in den Einstellungen oder nutze das Tastatur-Diktat.', true); });
  }
  function startMic() {
    if (useAI()) return startRecording();
    if (recognition) { try { recognition.stop(); } catch (e) {} return; }
    if (!speechSupported()) { var ta = $('voiceText'); if (ta) ta.focus(); return; }
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    var rec = new SR(); rec.lang = 'de-DE'; rec.interimResults = true; rec.continuous = false;
    var base = sheet.text ? sheet.text + ' ' : '';
    rec.onresult = function (ev) {
      var t = ''; for (var i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript;
      sheet.text = base + t; var ta = $('voiceText'); if (ta) ta.value = sheet.text;
    };
    rec.onerror = function (ev) { toast(ev.error === 'not-allowed' ? 'Mikrofon nicht erlaubt. Nutze das Tastatur-Diktat.' : 'Spracherkennung: ' + ev.error, true); };
    rec.onend = function () { recognition = null; if (sheet && sheet.type === 'voice') { renderSheet(); if (sheet.text) parseVoiceSheet(); } };
    recognition = rec; rec.start(); renderSheet();
  }
  function hintLocation(h) {
    if (!h) return '';
    var map = { 'kühlschrank': 'Kühlschrank', 'tiefkühler': 'Tiefkühler', keller: 'Vorratskeller', vorratskeller: 'Vorratskeller' };
    var l = T().Location.filter(function (x) { return x.name === map[h]; })[0];
    return l ? l.location_id : '';
  }
  function useAI() { return Net.live() && auth.phase === 'ready' && ai.configured; }
  function parseVoiceSheet() {
    if (useAI()) return interpretAI();
    applyActions(EP.parseVoice(sheet.text, today(), sheet.inventur ? 'inventur' : null));
  }
  function interpretAI() {
    var sh = sheet; sh.thinking = true; renderSheet();
    Net.call('interpret', { text: sh.text, mode: sh.listMode ? 'liste' : sh.inventur ? 'inventur' : '', today: today() }).then(function (r) {
      sh.thinking = false;
      if (sheet !== sh) return;
      if (!r.ok) { toast((r.message || 'KI nicht erreichbar') + ' – ich werte regelbasiert aus.', true); applyActions(EP.parseVoice(sh.text, today(), sh.inventur ? 'inventur' : null)); return; }
      applyActions(r.actions);
    });
  }
  function applyActions(acts) {
    sheet.actions = acts.map(function (a) {
      var r = EP.resolveProduct(store, a.product_text);
      var pid = r.status === 'resolved' ? r.product_id : '';
      var p = pid ? product(pid) : null;
      var unit = a.unit && p ? (a.unit === 'Stk' && p.base_unit !== 'Stk' && pkgOf(p) ? 'Pkg' : a.unit) : (p ? (p.base_unit === 'Stk' ? 'Stk' : (pkgOf(p) && a.qty != null && a.qty <= 20) ? 'Pkg' : p.base_unit) : (a.unit || 'Stk'));
      return {
        raw: a.raw, text: a.product_text, product_id: pid, suggestions: r.status === 'suggestion' ? r.candidates : [], newName: pid ? '' : cap(a.product_text),
        intent: a.intent === 'ambiguous' ? '' : a.intent, qty: a.qty == null ? '' : a.qty, unit: unit,
        loc: hintLocation(a.location_hint) || (pid ? lastLocation(pid) : ''), bb: a.best_before || '', condition: a.condition, opened: !!a.opened,
        question: a.intent === 'ambiguous' ? a.needs_question : ''
      };
    });
    sheet.key = uuid();
    renderSheet();
  }
  function cap(s) { s = String(s || '').trim(); return s.charAt(0).toUpperCase() + s.slice(1); }
  function actionValid(a) {
    if (sheet.listMode) return !!(a.product_id || a.newName);
    if (!a.product_id && !(a.newName && a.newUnit)) return false;
    if (!a.intent) return false;
    if (!a.loc) return false;
    if (a.intent !== 'used_up' && (a.qty === '' || isNaN(Number(a.qty)))) return false;
    return true;
  }
  function productSelect(a, i) {
    var opts = '<option value="">Produkt wählen…</option>';
    a.suggestions.forEach(function (c) { opts += '<option value="' + c.product_id + '"' + (a.product_id === c.product_id ? ' selected' : '') + '>Meinst du: ' + esc(c.name) + '?</option>'; });
    T().Product.slice().sort(function (x, y) { return x.name.localeCompare(y.name); }).forEach(function (p) { opts += '<option value="' + p.product_id + '"' + (a.product_id === p.product_id && !a.suggestions.some(function (c) { return c.product_id === p.product_id; }) ? ' selected' : '') + '>' + esc(p.name) + '</option>'; });
    opts += '<option value="__new"' + (!a.product_id && a.newUnit ? ' selected' : '') + '>+ Neu anlegen: ' + esc(a.newName) + '</option>';
    return '<select data-act="product" data-idx="' + i + '" class="' + (a.product_id || a.newUnit ? '' : 'need') + '" style="' + (a.product_id || a.newUnit ? '' : 'outline:2px solid var(--warn)') + '">' + opts + '</select>';
  }
  function actionCard(a, i) {
    var p = a.product_id ? product(a.product_id) : null;
    var h = '<div class="action-card"><div class="raw">„' + esc(a.raw) + '“</div>';
    h += '<div class="field">' + productSelect(a, i) + '</div>';
    if (!p && a.newUnit !== undefined && !a.product_id) {
      h += '<div class="grid2 field"><select data-act="newUnit" data-idx="' + i + '">' + [['', 'Gezählt in…'], ['Stk', 'Stück'], ['g', 'Gramm'], ['ml', 'Milliliter']].map(function (u) { return '<option value="' + u[0] + '"' + (u[0] === a.newUnit ? ' selected' : '') + '>' + u[1] + '</option>'; }).join('') + '</select><select data-act="newCat" data-idx="' + i + '">' + DEPT_ORDER.filter(function (d) { return d !== 'Unklar'; }).map(function (d) { return '<option' + (d === a.newCat ? ' selected' : '') + '>' + d + '</option>'; }).join('') + '</select></div>';
    }
    if (a.question) h += '<div class="small" style="color:var(--warn);margin-bottom:6px">' + esc(a.question) + '</div>';
    h += '<div class="seg field' + (a.intent ? '' : ' need') + '">' + [['add', 'Dazu'], ['set', 'Insgesamt'], ['remove', 'Weg'], ['used_up', 'Alle']].map(function (x) { return '<button class="' + (a.intent === x[0] ? 'on' : '') + '" data-action="act-intent" data-idx="' + i + '" data-v="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>';
    var unitSel = p ? unitOptions(p, a.unit) : ['Stk', 'g', 'ml'].map(function (u) { return '<option' + (u === a.unit ? ' selected' : '') + '>' + u + '</option>'; }).join('');
    h += '<div class="grid3">' + (a.intent === 'used_up' ? '<div></div><div></div>' : '<input type="number" inputmode="decimal" step="any" min="0" placeholder="Menge" value="' + esc(a.qty) + '" data-act="qty" data-idx="' + i + '" style="' + (a.qty === '' ? 'outline:2px solid var(--warn)' : '') + '"><select data-act="unit" data-idx="' + i + '">' + unitSel + '</select>') +
      '<select data-act="loc" data-idx="' + i + '" style="' + (a.loc ? '' : 'outline:2px solid var(--warn)') + '">' + locOptions(a.loc, true) + '</select></div>';
    if (a.intent === 'add' || a.intent === 'set') h += '<div class="grid2" style="margin-top:8px"><input type="date" value="' + esc(a.bb) + '" data-act="bb" data-idx="' + i + '" aria-label="MHD"><div class="small muted" style="align-self:center">' + (a.condition ? 'Zustand: ' + esc(a.condition) : 'MHD optional') + '</div></div>';
    return h + '</div>';
  }
  function listActionCard(a, i) {
    return '<div class="action-card"><div class="raw">„' + esc(a.raw) + '“</div>' + productSelect(a, i).replace('+ Neu anlegen: ', 'Ohne Produkt: ') + '<div class="small muted" style="margin-top:6px">' + (a.qty !== '' ? 'Menge: ' + esc(a.qty) + ' ' + esc(a.unit) : 'Menge wird aus dem Bedarf berechnet bzw. bleibt offen') + '</div></div>';
  }

  // ---- Zutatenzeilen für neue Rezepte
  function parseIngredients(text) {
    return String(text || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean).map(function (line) {
      var per = /\bpro person\b|\bje person\b/i.test(line) ? 'Person' : 'Rezept';
      var x = EP.parseIngredientLine(line.replace(/\b(pro|je) person\b/i, '').trim());
      var rr = EP.resolveProduct(store, x.name);
      var pid0 = rr.status === 'resolved' ? rr.product_id : '';
      return { text: x.name, qty: x.qty, unit: x.unit || (pid0 && x.qty != null ? product(pid0).base_unit : ''), per: per, product_id: pid0, suggest: rr.status === 'suggestion' ? rr.candidates[0].name : '', note: x.note };
    });
  }


  // ------------------------------------------------------------- Aktionen
  var ACTIONS = {
    tab: function (el) { state.tab = el.getAttribute('data-tab'); if (sheet) closeSheet(); render(); window.scrollTo(0, 0); },
    'close-sheet': closeSheet,
    voice: function () {
      openSheet({ type: 'voice', text: '', inventur: false, actions: null, listMode: state.tab === 'shopping', key: uuid() });
    },
    mic: startMic,
    'voice-mode': function (el) { sheet.inventur = el.getAttribute('data-v') === '1'; if (sheet.actions) parseVoiceSheet(); else renderSheet(); },
    'voice-parse': function () { var ta = $('voiceText'); sheet.text = ta ? ta.value : sheet.text; if (!sheet.text.trim()) return toast('Bitte erst etwas sagen oder tippen', true); parseVoiceSheet(); },
    'act-intent': function (el) { var a = sheet.actions[+el.getAttribute('data-idx')]; a.intent = el.getAttribute('data-v'); a.question = ''; renderSheet(); },
    'voice-book': function (el) {
      if (sheet.listMode) {
        var n0 = sheet.actions.length;
        addManualItems(sheet.actions.map(function (a) { return { pid: a.product_id, text: a.product_id ? product(a.product_id).name : a.newName, qty: a.qty === '' ? null : Number(a.qty) }; }), sheet.key)
          .then(function (r) { if (r) { toast(n0 + ' auf der Liste'); closeSheet(); } });
        return;
      }
      el.disabled = true;
      var cmds = [];
      sheet.actions.forEach(function (a) {
        var pid = a.product_id;
        if (!pid) { pid = 'P-' + uuid().slice(0, 8).toUpperCase(); cmds.push({ type: 'create_product', product_id: pid, name: a.newName, category: a.newCat || 'Sonstiges', base_unit: a.newUnit }); }
        var note = [a.condition ? 'Zustand: ' + a.condition : '', 'Sprache: „' + a.raw + '“'].filter(Boolean).join(' · ');
        if (a.intent === 'used_up') cmds.push({ type: 'used_up', product_id: pid, location_id: a.loc, note: note });
        else if (a.intent === 'set') cmds.push({ type: 'set_total', product_id: pid, location_id: a.loc, qty: Number(a.qty), unit: a.unit, best_before: a.bb, note: note });
        else cmds.push({ type: 'adjust', product_id: pid, location_id: a.loc, qty: a.intent === 'remove' ? -Number(a.qty) : Number(a.qty), unit: a.unit, best_before: a.bb, note: note });
      });
      var n1 = sheet.actions.length;
      run({ type: 'batch', commands: cmds }, sheet.key).then(function (r) {
        if (r) { toast(r.replayed ? 'War bereits gebucht' : n1 + ' Änderung(en) gebucht ✓'); closeSheet(); } else el.disabled = false;
      });
    },

    cook: function (el) {
      var rid = el.getAttribute('data-id');
      var entry = el.getAttribute('data-entry');
      var e = entry ? T().MealPlanEntry.filter(function (x) { return x.entry_id === entry; })[0] : null;
      var persons = Number(el.getAttribute('data-persons')) || (e ? Number(e.persons) : Number(recipe(rid).servings_base));
      if (!e) { var te = entryFor(today()); if (te && te.recipe_id === rid) e = te; }
      openSheet({ type: 'cook', recipe_id: rid, entry_id: e ? e.entry_id : '', entry: e ? clean(e) : null, persons: persons, overrides: {}, key: uuid() });
    },
    'cook-persons': function (el) { sheet.persons = Math.max(1, sheet.persons + Number(el.getAttribute('data-d'))); sheet.overrides = {}; renderSheet(); },
    'cook-skip': function (el) { var n = el.getAttribute('data-line'); if (sheet.overrides[n] && sheet.overrides[n].skip) delete sheet.overrides[n]; else sheet.overrides[n] = { skip: true }; renderSheet(); },
    'cook-confirm': function (el) {
      el.disabled = true;
      var sh = sheet;
      run({ type: 'cook', recipe_id: sh.recipe_id, persons: sh.persons, overrides: sh.overrides, meal_plan_entry_id: sh.entry_id || undefined, meal_plan_entry: sh.entry || undefined, date: today() }, sh.key).then(function (r) {
        if (r) { sh.result = r; if (sheet === sh) renderSheet(); toast(r.replayed ? 'War bereits gebucht, nichts doppelt abgezogen' : 'Abgebucht ✓'); } else el.disabled = false;
      });
    },

    recipe: function (el) { var r = recipe(el.getAttribute('data-id')); openSheet({ type: 'recipe', id: r.recipe_id, persons: Number(el.getAttribute('data-persons')) || Number(r.servings_base) || 2 }); },
    'recipe-persons': function (el) { sheet.persons = Math.max(1, sheet.persons + Number(el.getAttribute('data-d'))); renderSheet(); },
    fav: function (el) { var r = recipe(el.getAttribute('data-id')); upsert('Recipe', [{ recipe_id: r.recipe_id, favorite: !r.favorite }]).then(function () { renderSheet(); }); },
    dislike: function (el) { var r = recipe(el.getAttribute('data-id')); upsert('Recipe', [{ recipe_id: r.recipe_id, disliked: !r.disliked }]).then(function () { renderSheet(); }); },
    'import-recipe': function () {
      if (!Net.live()) return toast('Der Import braucht die Online-Verbindung', true);
      openSheet({ type: 'importRecipe', mode: 'link', url: '', text: '', data: null, key: uuid() });
      setTimeout(function () { var i = $('impUrl'); if (i) i.focus(); }, 250);
    },
    'imp-mode': function (el) { sheet.mode = el.getAttribute('data-v'); renderSheet(); },
    'imp-load': function () {
      var st = sheet, body = st.mode === 'link' ? { url: (st.url || '').trim() } : { text: (st.text || '').trim() };
      if (!body.url && !body.text) return toast(st.mode === 'link' ? 'Bitte einen Link einfügen' : 'Bitte Text einfügen', true);
      st.loading = true; renderSheet();
      Net.call('import_recipe', body, { timeout: 90000 }).then(function (r) {
        st.loading = false;
        if (sheet !== st) return;
        if (!r.ok) { renderSheet(); return netError(r); }
        r.ingredients.forEach(function (x) {
          x.pid = x.product_id || '';
          x.newName = cap(x.name || x.text_original);
          x.newUnit = guessBase(x.unit); x.newCat = guessDept(x.name);
          x.auto = !!x.product_id;
        });
        st.data = r; renderSheet();
      });
    },
    'imp-save': function (el) {
      var st = sheet, d = st.data, r = d.recipe, rid = st.rid || (st.rid = 'R-' + uuid().slice(0, 8).toUpperCase());
      var cmds = [], rows = [];
      d.ingredients.forEach(function (x, i) {
        var pid = x.pid;
        if (pid === '__new') {
          var ex = EP.resolveProduct(store, x.newName);
          if (ex.status === 'resolved') pid = ex.product_id;
          else { pid = x.newId || (x.newId = 'P-' + uuid().slice(0, 8).toUpperCase()); cmds.push({ type: 'create_product', product_id: pid, name: x.newName, category: x.newCat, base_unit: x.newUnit }); }
        }
        // bewusst gewählte Zuordnung als globale Regel speichern (gilt dann für alle Rezepte, Bons, Sprache)
        if (pid && !x.auto && x.pid !== '__new') {
          var rr = EP.resolveProduct(store, x.name);
          if (!(rr.status === 'resolved' && rr.product_id === pid)) cmds.push({ type: 'confirm_alias', alias: x.name, product_id: pid, source: 'rezept' });
        }
        rows.push({ recipe_id: rid, line_no: i + 1, product_id: pid || '', text_original: x.text_original, qty: x.qty === '' || x.qty == null ? '' : Number(x.qty), unit: x.unit || '', per: 'Rezept', optional: !!x.optional, note: x.note || '' });
      });
      cmds.push({ type: 'upsert_rows', table: 'Recipe', rows: [{ recipe_id: rid, name: r.name.trim(), category: r.category || 'Importiert', servings_base: Number(r.servings), minutes: Number(r.minutes) || '', steps: r.steps, source_url: r.source_url || '', image_url: r.image_url || '', favorite: false, disliked: false, repeat_every_days: 7, notes: '', version: 1 }] });
      cmds.push({ type: 'upsert_rows', table: 'RecipeIngredient', rows: rows });
      el.disabled = true;
      run({ type: 'batch', commands: cmds }, st.key).then(function (res) {
        if (!res) { el.disabled = false; return; }
        toast('„' + r.name.trim() + '“ im Kochbuch');
        closeSheet(); state.tab = 'cookbook'; render();
      });
    },
    'new-recipe': function () { openSheet({ type: 'newRecipe', draft: { name: '', minutes: 20, servings: 2, category: 'Schnell', ingredients: '', steps: '', url: '' } }); },
    'save-recipe': function () {
      var d = sheet.draft, id = sheet.draftId || (sheet.draftId = 'R-' + uuid().slice(0, 8).toUpperCase());
      if (!d.name.trim()) return toast('Bitte einen Namen eingeben', true);
      var ings = parseIngredients(d.ingredients).map(function (x, i) { return { recipe_id: id, line_no: i + 1, product_id: x.product_id, text_original: x.text, qty: x.qty == null ? '' : x.qty, unit: x.unit, per: x.per, optional: false, note: x.note || '' }; });
      var cmds = [{ type: 'upsert_rows', table: 'Recipe', rows: [{ recipe_id: id, name: d.name.trim(), category: d.category, servings_base: Number(d.servings) || 2, minutes: Number(d.minutes) || '', steps: d.steps, source_url: d.url, favorite: false, disliked: false, repeat_every_days: 7, notes: '', version: 1 }] }];
      if (ings.length) cmds.push({ type: 'upsert_rows', table: 'RecipeIngredient', rows: ings });
      sheet.saveKey = sheet.saveKey || uuid();
      run({ type: 'batch', commands: cmds }, sheet.saveKey).then(function (r) { if (r) { toast('Rezept gespeichert'); closeSheet(); } });
    },

    'week-nav': function (el) { state.weekOffset += Number(el.getAttribute('data-d')); render(); },
    persons: function (el) {
      var e = T().MealPlanEntry.filter(function (x) { return x.entry_id === el.getAttribute('data-entry'); })[0];
      upsert('MealPlanEntry', [Object.assign({}, e, { persons: Math.max(0, Number(e.persons) + Number(el.getAttribute('data-d'))) })]);
    },
    suggest: function () { suggestWeek(); render(); },
    'confirm-plan': function () {
      var ws = weekStart(state.weekOffset);
      var rows = T().MealPlanEntry.filter(function (e) { return e.date >= ws && e.date <= addDays(ws, 6) && e.status === 'Vorschlag'; }).map(function (e) { return Object.assign({}, e, { status: 'bestätigt' }); });
      if (!rows.length) return;
      upsert('MealPlanEntry', rows).then(function (r) { if (r) toast(rows.length + ' Tag(e) bestätigt, Einkaufsliste aktualisiert'); });
    },

    'shop-check': function (el) {
      var i = itemRow(el.getAttribute('data-item'));
      if (!i || i.purchase_id) return;
      upsert('ShoppingItem', [Object.assign({}, i, { checked: !i.checked })]);
    },
    'add-item': function () {
      var inp = $('addItem'); var txt = inp.value.trim(); if (!txt) return;
      var a = EP.parseVoice(txt)[0] || { product_text: txt, qty: null };
      var r = EP.resolveProduct(store, a.product_text);
      inp.value = '';
      addManualItems([{ pid: r.status === 'resolved' ? r.product_id : '', text: r.status === 'resolved' ? product(r.product_id).name : cap(a.product_text || txt), qty: a.qty }])
        .then(function (res) { if (res) toast('Hinzugefügt'); else inp.value = txt; });
    },
    'shop-edit': function (el) { openSheet({ type: 'shopEdit', id: el.getAttribute('data-item') }); },
    'shop-ovr-save': function () { var i = itemRow(sheet.id), v = $('ovr').value; if (v === '' || isNaN(Number(v))) return toast('Bitte eine Zahl eingeben', true); upsert('ShoppingItem', [Object.assign({}, i, { manual_override: Number(v) })]).then(function (r) { if (r) closeSheet(); }); },
    'shop-ovr-clear': function () { var i = itemRow(sheet.id); upsert('ShoppingItem', [Object.assign({}, i, { manual_override: '' })]).then(function (r) { if (r) closeSheet(); }); },
    'shop-remove': function () {
      var i = itemRow(sheet.id);
      var p = i.origin === 'manuell' ? run({ type: 'delete_rows', table: 'ShoppingItem', match: [{ item_id: i.item_id }] })
        : upsert('ShoppingItem', [Object.assign({}, i, { manual_override: 0, checked: true })]); // aus dem Plan berechnet: auf 0 setzen statt löschen, sonst käme sie wieder
      p.then(function (r) { if (r) closeSheet(); });
    },
    'book-checked': function () {
      var items = shoppingItems().filter(function (i) { return i.checked && !i.purchase_id && !(Number(i.manual_override) === 0 && i.manual_override !== '' && i.manual_override != null); });
      var deptLoc = { 'Tiefkühl': 'TK', 'Kühlregal': 'KS', 'Obst & Gemüse': 'KS' };
      openSheet({ type: 'bookChecked', key: uuid(), lines: items.map(function (i) {
        var p = i.product_id ? product(i.product_id) : null;
        var useP = i.packages && !(i.manual_override !== '' && i.manual_override != null);
        var q = i.manual_override !== '' && i.manual_override != null ? Number(i.manual_override) : useP ? i.packages : i.qty_to_buy;
        var loc = p ? (lastLocation(p.product_id) || deptLoc[p.category] || (T().Location.some(function (l) { return l.location_id === 'VK'; }) ? 'VK' : '')) : '';
        return { item_id: i.item_id, product_id: i.product_id, text: i.text, qty: q == null ? '' : q, unit: p ? (useP ? 'Pkg' : p.base_unit) : '', loc: loc, bb: '' };
      }) });
    },
    'book-confirm': function (el) {
      var lines = sheet.lines.filter(function (l) { return l.product_id; });
      var missing = lines.filter(function (l) { return !l.loc || l.qty === '' || isNaN(Number(l.qty)); });
      if (missing.length) return toast('Bitte Menge und Ort für alle Positionen angeben', true);
      el.disabled = true;
      var sh = sheet, cmds = [];
      if (lines.length) cmds.push({ type: 'purchase', source: 'liste', date: today(), lines: lines.map(function (l) { return { product_id: l.product_id, qty: Number(l.qty), unit: l.unit, location_id: l.loc, best_before: l.bb, shopping_item_id: l.item_id }; }) });
      var loose = sh.lines.filter(function (l) { return !l.product_id; });
      if (loose.length) cmds.push({ type: 'delete_rows', table: 'ShoppingItem', match: loose.map(function (l) { return { item_id: l.item_id }; }) });
      if (!cmds.length) { closeSheet(); return; }
      run({ type: 'batch', commands: cmds }, sh.key).then(function (r) {
        if (r) { sh.result = lines.length ? r.results[0] : { booked: [], skipped: [] }; if (sheet === sh) renderSheet(); toast('Eingebucht ✓'); } else el.disabled = false;
      });
    },

    loc: function (el) { state.loc = el.getAttribute('data-id'); render(); },
    pview: function (el) { state.pantryView = el.getAttribute('data-v'); render(); },
    product: function (el) { var pid = el.getAttribute('data-id'); openSheet({ type: 'product', id: pid, key: uuid(), form: { intent: 'add', qty: '', unit: defaultUnit(pid), loc: state.loc !== 'all' ? state.loc : lastLocation(pid), bb: '' } }); },
    'pform-intent': function (el) { sheet.form.intent = el.getAttribute('data-v'); renderSheet(); },
    'pform-book': function (el) {
      var f = sheet.form, pid = sheet.id;
      if (f.qty === '' || isNaN(Number(f.qty))) return toast('Bitte eine Menge eingeben', true);
      if (!f.loc) return toast('Bitte den Lagerort wählen', true);
      el.disabled = true;
      var cmd = f.intent === 'set' ? { type: 'set_total', product_id: pid, location_id: f.loc, qty: Number(f.qty), unit: f.unit } :
        { type: 'adjust', product_id: pid, location_id: f.loc, qty: f.intent === 'remove' ? -Number(f.qty) : Number(f.qty), unit: f.unit, best_before: f.intent === 'add' ? f.bb : '' };
      var sh = sheet;
      run(cmd, sh.key).then(function (r) {
        el.disabled = false;
        if (r) { toast('Gebucht ✓'); sh.key = uuid(); sh.form.qty = ''; sh.form.bb = ''; }
        if (sheet === sh) renderSheet();
      });
    },
    'used-up': function () {
      var f = sheet.form; if (!f.loc) return toast('Bitte den Lagerort wählen', true);
      if (!confirm(product(sheet.id).name + ' im ' + locName(f.loc) + ' als aufgebraucht markieren?')) return;
      var sh = sheet;
      run({ type: 'used_up', product_id: sh.id, location_id: f.loc }, sh.key).then(function (r) { if (r) { toast('Als aufgebraucht gebucht'); sh.key = uuid(); } if (sheet === sh) renderSheet(); });
    },
    'open-lot': function (el) { run({ type: 'open', lot_id: el.getAttribute('data-id') }).then(function (r) { if (r) toast('Als geöffnet markiert'); renderSheet(); }); },
    inventory: function (el) {
      var loc = el && el.getAttribute('data-loc') ? el.getAttribute('data-loc') : state.loc !== 'all' ? state.loc : '';
      openSheet({ type: 'inventory', loc: loc, rows: loc ? inventoryRows(loc) : [], key: uuid() });
    },
    'inv-save': function (el) {
      if (sheet.rows.some(function (r) { return r.qty === '' || isNaN(Number(r.qty)); })) return toast('Bitte für jedes Produkt eine Zahl eintragen (0 = leer)', true);
      el.disabled = true;
      var loc = sheet.loc;
      run({ type: 'inventory', location_id: loc, mode: 'full', counts: sheet.rows.map(function (x) { return { product_id: x.product_id, qty: Number(x.qty), unit: product(x.product_id).base_unit }; }) }, sheet.key).then(function (r) {
        if (r) { toast('Inventur ' + locName(loc) + ' gespeichert ✓'); closeSheet(); } else el.disabled = false;
      });
    },
    'new-product': function () { openSheet({ type: 'newProduct', form: { name: '', category: 'Sonstiges', unit: 'Stk' } }); },
    'save-product': function () { var f = sheet.form; sheet.saveKey = sheet.saveKey || uuid(); run({ type: 'create_product', product_id: sheet.newId || (sheet.newId = 'P-' + uuid().slice(0, 8).toUpperCase()), name: f.name, category: f.category, base_unit: f.unit }, sheet.saveKey).then(function (r) { if (r) { toast('Angelegt'); openSheet({ type: 'product', id: r.product_id, key: uuid(), form: { intent: 'add', qty: '', unit: f.unit, loc: state.loc !== 'all' ? state.loc : '', bb: '' } }); } }); },
    'edit-product': function (el) { var p = product(el.getAttribute('data-id')), k = pkgOf(p); openSheet({ type: 'editProduct', id: p.product_id, form: { label: k ? k.label : '', qty: k ? k.content_qty : '', unit: k ? k.content_unit : p.base_unit } }); },
    'save-package': function () {
      var f = sheet.form; if (!f.qty || isNaN(Number(f.qty))) return toast('Bitte den Inhalt angeben', true);
      var p = product(sheet.id);
      run({ type: 'confirm_package', product_id: p.product_id, package_id: p.default_package_id || undefined, label: f.label || 'Packung', content_qty: Number(f.qty), content_unit: f.unit, make_default: true })
        .then(function (r) { if (r) { toast('Packungsregel gilt jetzt überall'); closeSheet(); } });
    },
    'new-alias': function () { openSheet({ type: 'alias', form: { text: '', pid: '' } }); },
    'save-alias': function () { run({ type: 'confirm_alias', alias: sheet.form.text, product_id: sheet.form.pid, source: 'manuell' }).then(function (r) { if (r) { toast('Regel gespeichert' + (r.recipe_ingredients_updated ? ', ' + r.recipe_ingredients_updated + ' Rezeptzutat(en) zugeordnet' : '')); closeSheet(); } }); },
    'new-location': function () { openSheet({ type: 'newLocation' }); },
    'save-location': function () { run({ type: 'create_location', location_id: 'LO-' + uuid().slice(0, 6).toUpperCase(), name: $('locName').value }).then(function (r) { if (r) { toast('Lagerort angelegt'); closeSheet(); } }); },
    journal: function () { openSheet({ type: 'journal' }); },
    export: function () {
      var blob = new Blob([JSON.stringify(store, null, 1)], { type: 'application/json' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'tischlein-' + (Net.live() ? Net.conf().env.toLowerCase() : 'demo') + '-' + today() + '.json'; a.click();
    },
    reset: function () { if (Net.live()) return; if (!confirm('Alle Demo-Daten auf diesem Gerät zurücksetzen?')) return; localStorage.removeItem(STORE_KEY); store = null; load(); toast('Beispieldaten neu geladen'); render(); },

    // ---- Online: Anmeldung, Familie, Verbindung
    'login-redirect': function () { Net.redirectLogin(); },
    'access-request': function (el) {
      el.disabled = true;
      Net.call('request_access').then(function (r) {
        el.disabled = false;
        if (!r.ok) return netError(r);
        auth.status = r.status;
        if (r.allowed) { afterHello(r); return; }
        toast(r.mailed ? 'Anfrage gesendet ✓' : 'Anfrage liegt bereits vor'); render();
      });
    },
    'auth-check': function () { auth.phase = 'checking'; render(); Net.call('hello').then(afterHello); },
    logout: function () { Net.logout(); Net.clearCache(); store = EP.newStore(); rev = 0; auth = { phase: 'login' }; users = null; render(); },
    'users-load': function () { Net.call('users').then(function (r) { if (r.ok) { users = r.users; render(); } else netError(r); }); },
    'user-decide': function (el) {
      var email = el.getAttribute('data-email'), yes = el.getAttribute('data-v') === '1';
      if (!yes && !confirm(email + ' den Zugang entziehen?')) return;
      el.disabled = true;
      Net.call('decide_access', { email: email, approve: yes }).then(function (r) {
        if (r.ok) { users = r.users; toast(yes ? 'Freigegeben ✓' : 'Zugang entzogen'); render(); } else { el.disabled = false; netError(r); }
      });
    },
    'conn-save': function () {
      var url = ($('connUrl').value || '').trim(), cid = ($('connCid').value || '').trim();
      if (url && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) return toast('Die Backend-Adresse muss mit https://script.google.com/macros/s/ beginnen und auf /exec enden', true);
      if (cid && !/\.apps\.googleusercontent\.com$/.test(cid)) return toast('Die Client-ID endet auf .apps.googleusercontent.com', true);
      Net.setConf({ backendUrl: url, clientId: cid }); location.reload();
    },
    'conn-env': function (el) {
      var env = el.getAttribute('data-v');
      if (env === Net.conf().env) return;
      if (env === 'PROD' && !confirm('Auf die echte Datenbasis (PROD) umschalten? Ab dann zählen alle Buchungen wirklich.')) return;
      Net.setConf({ env: env }); location.reload();
    },
    'conn-demo': function () { if (!confirm('Verbindung trennen und zum Demo-Modus wechseln? Die Daten in der Google-Tabelle bleiben unverändert.')) return; Net.logout(); Net.clearCache(); Net.setConf({ backendUrl: '', clientId: '' }); location.reload(); },
    resync: function () { refresh().then(function () { toast('Auf aktuellem Stand ✓'); }); }
  };

  function defaultUnit(pid) { var p = product(pid); return p.base_unit === 'Stk' ? 'Stk' : pkgOf(p) ? 'Pkg' : p.base_unit; }
  function inventoryRows(loc) {
    var pids = {};
    T().StockLot.forEach(function (l) { if (l.location_id === loc && Number(l.qty_base) > 1e-9) pids[l.product_id] = true; });
    return Object.keys(pids).sort(function (a, b) { return product(a).name.localeCompare(product(b).name); }).map(function (pid) { var t = EP.totalStock(store, pid, loc); return { product_id: pid, before: t, qty: Math.round(t * 1000) / 1000 }; });
  }
  function addManualItems(list, key) {
    var ws = weekStart(0);
    return upsertKeyed('ShoppingItem', list.map(function (x) {
      return { item_id: 'SI-M-' + uuid().slice(0, 8), week_start: ws, product_id: x.pid || '', text: x.text, qty_needed: null, qty_available: null, qty_to_buy: x.qty == null ? null : x.qty, unit: x.pid ? product(x.pid).base_unit : '', department: x.pid ? product(x.pid).category : 'Sonstiges', origin: 'manuell', manual_override: '', checked: false, unclear_reason: '' };
    }), key);
  }
  function upsertKeyed(table, rows, key) { return run({ type: 'upsert_rows', table: table, rows: rows.map(clean) }, key); }

  // ------------------------------------------------------------- Ereignisse
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-action]'); if (!el || el.disabled) return;
    var fn = ACTIONS[el.getAttribute('data-action')]; if (fn) { ev.preventDefault(); fn(el); }
  });
  document.addEventListener('input', function (ev) {
    var el = ev.target;
    if (el.getAttribute('data-input') === 'cb-search') { state.search = el.value; var pos = el.selectionStart; render(); var n = document.querySelector('[data-input="cb-search"]'); n.focus(); n.setSelectionRange(pos, pos); }
    if (el.hasAttribute('data-draft')) { sheet.draft[el.getAttribute('data-draft')] = el.value; }
    if (el.hasAttribute('data-impin')) sheet[el.getAttribute('data-impin')] = el.value;
    if (el.hasAttribute('data-impr')) { sheet.data.recipe[el.getAttribute('data-impr')] = el.value; if (el.getAttribute('data-impr') !== 'steps') { var sb = document.querySelector('[data-action="imp-save"]'); if (sb) sb.disabled = !(sheet.data.recipe.name.trim() && Number(sheet.data.recipe.servings) > 0); } }
    if (el.hasAttribute('data-ing') && el.tagName === 'INPUT') sheet.data.ingredients[+el.getAttribute('data-idx')][el.getAttribute('data-ing')] = el.value;
    if (el.getAttribute('data-voice') === 'text') sheet.text = el.value;
    if (el.hasAttribute('data-act') && el.tagName === 'INPUT') { sheet.actions[+el.getAttribute('data-idx')][el.getAttribute('data-act')] = el.value; }
    if (el.hasAttribute('data-pform') && el.tagName === 'INPUT') sheet.form[el.getAttribute('data-pform')] = el.value;
    if (el.hasAttribute('data-eform') && el.tagName === 'INPUT') sheet.form[el.getAttribute('data-eform')] = el.value;
    if (el.hasAttribute('data-nform') && el.tagName === 'INPUT') { sheet.form[el.getAttribute('data-nform')] = el.value; var b = document.querySelector('[data-action="save-product"]'); if (b) b.disabled = !el.value.trim(); }
    if (el.hasAttribute('data-aform') && el.tagName === 'INPUT') { sheet.form[el.getAttribute('data-aform')] = el.value; var b2 = document.querySelector('[data-action="save-alias"]'); if (b2) b2.disabled = !(sheet.form.text && sheet.form.pid); }
    if (el.hasAttribute('data-bline') && el.tagName === 'INPUT') sheet.lines[+el.getAttribute('data-idx')][el.getAttribute('data-bline')] = el.value;
  });
  document.addEventListener('change', function (ev) {
    var el = ev.target, ch = el.getAttribute('data-change');
    if (ch === 'plan-recipe') {
      var e = T().MealPlanEntry.filter(function (x) { return x.entry_id === el.getAttribute('data-entry'); })[0];
      upsert('MealPlanEntry', [Object.assign({}, e, { recipe_id: el.value, status: el.value ? 'Vorschlag' : '', note: '' })]); return;
    }
    if (ch === 'cook-qty') { sheet.overrides[el.getAttribute('data-line')] = { qty: Number(el.value), unit: product(EP.previewCook(store, sheet.recipe_id, sheet.persons).lines.filter(function (l) { return String(l.line_no) === el.getAttribute('data-line'); })[0].product_id).base_unit }; renderSheet(); return; }
    if (el.hasAttribute('data-ing')) {
      var ing = sheet.data.ingredients[+el.getAttribute('data-idx')], fld = el.getAttribute('data-ing');
      ing[fld] = el.value;
      if (fld === 'pid') ing.auto = false;
      if (fld === 'unit' && ing.pid === '__new' && /^(g|kg|ml|l|cl|Stk)$/.test(el.value)) ing.newUnit = guessBase(el.value);
      renderSheet(); return;
    }
    if (el.hasAttribute('data-impr') && el.tagName === 'INPUT') { renderSheet(); return; }
    if (ch === 'inv-loc') { sheet.loc = el.value; sheet.rows = el.value ? inventoryRows(el.value) : []; renderSheet(); return; }
    if (ch === 'inv-qty') { sheet.rows[+el.getAttribute('data-idx')].qty = el.value; return; }
    if (ch === 'inv-add' && el.value) { sheet.rows.push({ product_id: el.value, before: 0, qty: '' }); renderSheet(); return; }
    if (el.hasAttribute('data-draft')) { sheet.draft[el.getAttribute('data-draft')] = el.value; renderSheet(); return; }
    if (el.hasAttribute('data-act')) {
      var a = sheet.actions[+el.getAttribute('data-idx')], f = el.getAttribute('data-act');
      if (f === 'product') {
        if (el.value === '__new') { a.product_id = ''; a.newUnit = a.newUnit || ''; a.newCat = a.newCat || 'Sonstiges'; }
        else { a.product_id = el.value; delete a.newUnit; if (el.value) { var p = product(el.value); a.unit = p.base_unit === 'Stk' ? 'Stk' : pkgOf(p) ? 'Pkg' : p.base_unit; if (!a.loc) a.loc = lastLocation(el.value); } }
      } else if (f === 'newUnit') { a.newUnit = el.value; a.unit = el.value || a.unit; }
      else if (f === 'newCat') a.newCat = el.value;
      else a[f] = el.value;
      renderSheet(); return;
    }
    if (el.hasAttribute('data-pform')) { sheet.form[el.getAttribute('data-pform')] = el.value; return; }
    if (el.hasAttribute('data-eform')) { sheet.form[el.getAttribute('data-eform')] = el.value; return; }
    if (el.hasAttribute('data-nform')) { sheet.form[el.getAttribute('data-nform')] = el.value; return; }
    if (el.hasAttribute('data-aform')) { sheet.form[el.getAttribute('data-aform')] = el.value; renderSheet(); return; }
    if (el.hasAttribute('data-bline')) { sheet.lines[+el.getAttribute('data-idx')][el.getAttribute('data-bline')] = el.value; return; }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && ev.target.id === 'addItem') { ev.preventDefault(); ACTIONS['add-item'](); }
    if (ev.key === 'Escape' && sheet) closeSheet();
  });

  load();
  renderChrome();
  render();
  boot();
  window.__EP_APP = { store: function () { return store; }, run: run, actions: ACTIONS };
})();
