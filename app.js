/* Einkaufsplaner – Web-App (Demo-Modus).
 * Alle Bestandsänderungen laufen über EP.Engine (core/domain.js): dieselbe Logik wie im späteren Backend.
 * Demo-Daten liegen nur im Speicher dieses Browsers. */
(function () {
  'use strict';

  var STORE_KEY = 'ep-demo-v1';
  var DEPT_ORDER = ['Obst & Gemüse', 'Brot & Backwaren', 'Kühlregal', 'Tiefkühl', 'Vorrat', 'Haushalt', 'Sonstiges', 'Unklar'];
  var TITLES = { today: 'Heute', week: 'Woche', cookbook: 'Kochbuch', shopping: 'Einkauf', offers: 'Angebote', pantry: 'Vorrat', settings: 'Einstellungen' };
  var EVENT_LABEL = { purchase: 'Einkauf', cook: 'Gekocht', manual_delta: 'Korrektur', set_total: 'Gesetzt', inventory: 'Inventur', open: 'Geöffnet', correction: 'Korrektur', discard: 'Entsorgt' };

  var store, engine;
  var state = { tab: 'today', loc: 'all', search: '', weekOffset: 0 };
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
    var cls = d < 0 ? 'bad' : d <= 3 ? 'warn' : 'neutral';
    var txt = d < 0 ? 'abgelaufen ' + dNum(bb) : d === 0 ? 'MHD heute' : d === 1 ? 'MHD morgen' : 'MHD ' + dNum(bb);
    return '<span class="pill ' + cls + '">' + txt + '</span>';
  }

  // ------------------------------------------------------- Speicher & Buchung
  function load() {
    try { var raw = localStorage.getItem(STORE_KEY); if (raw) store = JSON.parse(raw); } catch (e) { store = null; }
    if (!store || !store.tables || !store.tables.Product) store = Seed.build();
    Object.keys(EP.SCHEMA).forEach(function (k) { if (!store.tables[k]) store.tables[k] = []; });
    engine = new EP.Engine(store, {});
    save(true);
  }
  function save(silent) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); return true; }
    catch (e) { if (!silent) toast('Im Browser konnte nicht gespeichert werden', true); return false; }
  }
  /** Führt einen Befehl über die Fachlogik aus. Erfolg wird nur gemeldet, wenn auch gespeichert. */
  function run(cmd, key) {
    try {
      var r = engine.execute(cmd, { idempotencyKey: key || uuid(), user: 'Demo' });
      if (!save()) throw new Error('Nicht gespeichert');
      return r;
    } catch (e) {
      toast(e.message || String(e), true);
      return null;
    }
  }

  var toastTimer;
  function toast(msg, err) {
    var t = $('toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = 'toast'; }, err ? 4200 : 2400);
  }

  // ------------------------------------------------------------- Rendering
  function render() {
    $('title').textContent = TITLES[state.tab];
    var now = new Date();
    $('eyebrow').textContent = WD_LONG[now.getDay()] + ', ' + now.getDate() + '. ' + now.toLocaleString('de-DE', { month: 'long' });
    document.querySelectorAll('.tabbar button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === state.tab); });
    var fn = VIEWS[state.tab];
    $('view').innerHTML = fn();
  }

  function weekStart(offset) { return addDays(Seed.monday(new Date()), 7 * (offset || 0)); }
  function ensureWeek(ws) {
    for (var i = 0; i < 7; i++) {
      var d = addDays(ws, i);
      if (!T().MealPlanEntry.some(function (e) { return e.date === d; })) {
        T().MealPlanEntry.push({ entry_id: 'MP-' + uuid().slice(0, 8), week_start: ws, date: d, persons: defaultPersons(), recipe_id: '', status: '', note: '', updated_at: new Date().toISOString() });
      }
    }
  }
  function defaultPersons() { var s = T().Settings.filter(function (x) { return x.key === 'default_persons'; })[0]; return s ? Number(s.value) : 2; }
  function entryFor(dateIso) { return T().MealPlanEntry.filter(function (e) { return e.date === dateIso; })[0]; }

  function ingredientPills(pv) {
    return pv.lines.map(function (l) {
      if (l.status === 'unklar') return '<span class="pill unclear" title="' + esc(l.reason) + '">? ' + esc(l.text) + '</span>';
      if (l.status !== 'ok') return '';
      if (l.missing > 1e-9) return '<span class="pill warn">' + esc(l.text) + ' · fehlt ' + esc(fmtQty(l.product_id, l.missing, false)) + '</span>';
      return '<span class="pill ok">✓ ' + esc(l.text) + '</span>';
    }).join('');
  }

  // ---- Heute
  function viewToday() {
    var t = today(), e = entryFor(t), h = '';
    if (e && e.recipe_id && recipe(e.recipe_id)) {
      var r = recipe(e.recipe_id), pv = EP.previewCook(store, r.recipe_id, e.persons);
      var cooked = e.status === 'gekocht';
      var planned = e.status === 'bestätigt';
      h += '<div class="card hero"><div class="kicker">Heute Abend' + (cooked ? ' · gekocht ✓' : planned ? '' : ' · Vorschlag') + '</div>' +
        '<h3>' + esc(r.name) + '</h3><div class="meta"><span>' + e.persons + ' Personen</span><span>' + esc(r.minutes) + ' Min.</span></div>' +
        '<div class="ing">' + ingredientPills(pv) + '</div>' +
        '<div class="btn-row"><button class="btn" data-action="recipe" data-id="' + r.recipe_id + '" data-persons="' + e.persons + '">Rezept</button>' +
        '<button class="btn primary" data-action="cook" data-id="' + r.recipe_id + '" data-entry="' + e.entry_id + '">' + (cooked ? 'Nochmal gekocht…' : 'Gekocht') + '</button></div></div>';
    } else {
      h += '<div class="card"><div class="empty"><div class="big">🍽️</div>Für heute Abend ist nichts geplant.<br><br><button class="btn primary" data-action="tab" data-tab="week">Woche planen</button></div></div>';
    }
    var tm = entryFor(addDays(t, 1));
    if (tm && tm.recipe_id && recipe(tm.recipe_id)) {
      h += '<div class="list"><div class="row tap" data-action="tab" data-tab="week"><div class="grow"><div class="sub">Morgen</div><div class="title">' + esc(recipe(tm.recipe_id).name) + '</div></div><span class="muted">' + tm.persons + ' Pers.</span></div></div>';
    }
    var soon = T().StockLot.filter(function (l) { return Number(l.qty_base) > 1e-9 && l.best_before && daysUntil(l.best_before) <= 4; })
      .sort(function (a, b) { return a.best_before < b.best_before ? -1 : 1; }).slice(0, 5);
    h += '<h2>Bald aufbrauchen</h2>';
    h += soon.length ? '<div class="list">' + soon.map(function (l) {
      var p = product(l.product_id);
      return '<div class="row tap" data-action="product" data-id="' + l.product_id + '"><div class="grow"><div class="title">' + esc(p.name) + '</div><div class="sub">' + esc(fmtQty(l.product_id, Number(l.qty_base))) + ' · ' + esc(locName(l.location_id)) + (l.opened_at ? ' · angebrochen' : '') + '</div></div>' + mhdPill(l.best_before) + '</div>';
    }).join('') + '</div>' : '<div class="card muted small">Nichts läuft in den nächsten 4 Tagen ab.</div>';
    var items = shoppingItems();
    var open = items.filter(function (i) { return !i.checked && !i.unclear_reason; }).length;
    var unclear = items.filter(function (i) { return i.unclear_reason; }).length;
    h += '<h2>Einkauf</h2><div class="list"><div class="row tap" data-action="tab" data-tab="shopping"><div class="grow"><div class="title">' + open + ' Artikel offen</div><div class="sub">' + (unclear ? unclear + ' unklar · ' : '') + 'für diese Woche</div></div><span class="muted">›</span></div></div>';
    return h;
  }

  // ---- Woche
  function viewWeek() {
    var ws = weekStart(state.weekOffset);
    ensureWeek(ws); save(true);
    var entries = T().MealPlanEntry.filter(function (e) { return e.date >= ws && e.date <= addDays(ws, 6); }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var recipes = T().Recipe.filter(function (r) { return !r.disliked; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    var t = today();
    var proposals = entries.filter(function (e) { return e.status === 'Vorschlag'; }).length;
    var h = '<div class="btn-row" style="margin-bottom:12px"><button class="mini" data-action="week-nav" data-d="-1">‹</button>' +
      '<div style="flex:1;text-align:center;align-self:center;font-weight:650">' + dNum(ws) + ' – ' + dNum(addDays(ws, 6)) + (state.weekOffset === 0 ? ' · diese Woche' : '') + '</div>' +
      '<button class="mini" data-action="week-nav" data-d="1">›</button></div>';
    if (proposals) h += '<div class="note">' + proposals + ' Tag(e) mit Vorschlag. Erst nach „Plan bestätigen“ zählen sie für die Einkaufsliste. Der Bestand ändert sich erst beim Kochen.</div>';
    h += '<div class="list">' + entries.map(function (e) {
      var d = new Date(e.date + 'T12:00:00');
      var past = e.date < t;
      var badge = e.status === 'gekocht' ? '<span class="pill ok">gekocht</span>' : e.status === 'Vorschlag' ? '<span class="pill warn">Vorschlag</span>' : '';
      return '<div class="row day' + (e.date === t ? ' today' : '') + '"><div class="d"><small>' + WD[d.getDay()] + '</small><b>' + d.getDate() + '</b></div>' +
        '<div class="grow"><select data-change="plan-recipe" data-entry="' + e.entry_id + '"' + (past || e.status === 'gekocht' ? ' disabled' : '') + '><option value="">— nichts —</option>' +
        recipes.map(function (r) { return '<option value="' + r.recipe_id + '"' + (r.recipe_id === e.recipe_id ? ' selected' : '') + '>' + esc(r.name) + ' · ' + esc(r.minutes) + ' Min.</option>'; }).join('') +
        '</select><div class="sub" style="margin-top:4px">' + badge + '</div></div>' +
        '<div class="stepper"><button data-action="persons" data-entry="' + e.entry_id + '" data-d="-1" aria-label="weniger">−</button><span>' + e.persons + '</span><button data-action="persons" data-entry="' + e.entry_id + '" data-d="1" aria-label="mehr">+</button></div></div>';
    }).join('') + '</div>';
    h += '<div class="btn-row"><button class="btn" data-action="suggest">Lücken füllen</button><button class="btn primary" data-action="confirm-plan"' + (proposals ? '' : ' disabled') + '>Plan bestätigen</button></div>';
    h += '<p class="small muted" style="margin:12px 4px">Vorschläge bevorzugen Rezepte mit bald ablaufenden Zutaten aus dem Vorrat, Favoriten und kurze Kochzeiten und vermeiden Wiederholungen in der Woche.</p>';
    return h;
  }

  function suggestWeek() {
    var ws = weekStart(state.weekOffset), t = today();
    var entries = T().MealPlanEntry.filter(function (e) { return e.date >= ws && e.date <= addDays(ws, 6); });
    var used = {}; entries.forEach(function (e) { if (e.recipe_id) used[e.recipe_id] = (used[e.recipe_id] || 0) + 1; });
    var filled = 0;
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
      if (best) { e.recipe_id = best.r.recipe_id; e.status = 'Vorschlag'; e.note = best.why.length ? 'nutzt ' + best.why.join(', ') : ''; used[best.r.recipe_id] = (used[best.r.recipe_id] || 0) + 1; filled++; }
    });
    save(); toast(filled ? filled + ' Vorschlag/Vorschläge eingetragen' : 'Keine freien Tage');
  }

  // ---- Kochbuch
  function viewCookbook() {
    var q = state.search.toLowerCase();
    var rs = T().Recipe.filter(function (r) { return !q || r.name.toLowerCase().indexOf(q) >= 0; })
      .sort(function (a, b) { return (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || a.name.localeCompare(b.name); });
    var h = '<div class="inline-add"><input type="search" placeholder="Rezept suchen" value="' + esc(state.search) + '" data-input="cb-search"><button class="btn primary" data-action="new-recipe">+ Neu</button></div>';
    h += '<div class="list">' + rs.map(function (r) {
      var unclear = T().RecipeIngredient.filter(function (i) { return i.recipe_id === r.recipe_id && !i.product_id; }).length;
      return '<div class="row tap" data-action="recipe" data-id="' + r.recipe_id + '"><div class="grow"><div class="title">' + (r.favorite ? '★ ' : '') + esc(r.name) + (r.disliked ? ' <span class="pill bad">unerwünscht</span>' : '') + '</div>' +
        '<div class="sub">' + esc(r.minutes) + ' Min. · für ' + esc(r.servings_base) + ' · ' + esc(r.category || '') + (unclear ? ' · ' + unclear + ' Zutat(en) ohne Produkt' : '') + '</div></div><span class="muted">›</span></div>';
    }).join('') + '</div>';
    if (!rs.length) h += '<div class="empty">Kein Rezept gefunden.</div>';
    return h;
  }

  // ---- Einkauf
  function shoppingItems() {
    var ws = weekStart(0);
    var existing = T().ShoppingItem.filter(function (i) { return i.week_start === ws; });
    var items = EP.computeShoppingList(store, ws, existing, today());
    items.forEach(function (i) {
      if (!i.item_id) i.item_id = 'SI-' + (i.product_id || EP.normalizeName(i.text)) + '-' + (i.origin || '').slice(0, 4);
      i.week_start = ws;
    });
    store.tables.ShoppingItem = T().ShoppingItem.filter(function (i) { return i.week_start !== ws; }).concat(items);
    save(true);
    return items;
  }
  function itemQty(i) {
    if (i.unclear_reason) return '<span class="pill unclear">Menge unklar</span>';
    if (i.manual_override !== undefined && i.manual_override !== '' && i.manual_override != null) return esc(fmtQty(i.product_id, Number(i.manual_override)));
    if (i.packages) return esc(i.packages + ' × ' + (i.package_label || 'Pkg'));
    if (i.qty_to_buy == null) return '';
    return i.product_id ? esc(fmtQty(i.product_id, i.qty_to_buy)) : esc(fmtNum(i.qty_to_buy));
  }
  function viewShopping() {
    var items = shoppingItems();
    var h = '<div class="inline-add"><input type="text" id="addItem" placeholder="Artikel hinzufügen, z. B. 2 Gurken" enterkeyhint="done"><button class="btn primary" data-action="add-item">+</button></div>';
    if (!items.length) return h + '<div class="card"><div class="empty"><div class="big">🛒</div>Alles da. Die Liste füllt sich aus dem bestätigten Wochenplan und den Mindestbeständen.</div></div>';
    var groups = {};
    items.forEach(function (i) { (groups[i.department || 'Sonstiges'] = groups[i.department || 'Sonstiges'] || []).push(i); });
    var depts = Object.keys(groups).sort(function (a, b) { var x = DEPT_ORDER.indexOf(a), y = DEPT_ORDER.indexOf(b); return (x < 0 ? 50 : x) - (y < 0 ? 50 : y); });
    depts.forEach(function (d) {
      h += '<h2>' + esc(d) + '</h2><div class="list">' + groups[d].map(function (i) {
        var booked = !!i.purchase_id;
        var sub = i.unclear_reason ? esc(i.unclear_reason) + (i.origin_detail ? ' · ' + esc(niceOrigin(i.origin_detail)) : '') :
          i.origin === 'Mindestbestand' ? 'Mindestbestand · vorhanden ' + esc(fmtQty(i.product_id, i.qty_available || 0)) :
          i.origin === 'manuell' ? 'manuell ergänzt' + (i.product_id ? '' : ' · kein Produkt zugeordnet') :
          esc(niceOrigin(i.origin_detail)) + (i.qty_available > 0 ? ' · vorhanden ' + esc(fmtQty(i.product_id, i.qty_available, false)) : '');
        if (i.leftover_after_cooking > 1e-9) sub += ' · Rest danach ' + esc(fmtQty(i.product_id, i.leftover_after_cooking, false));
        return '<div class="row' + (i.checked ? ' done' : '') + '"><button class="check' + (i.checked ? ' on' : '') + '" data-action="shop-check" data-item="' + esc(i.item_id) + '" aria-label="abhaken"' + (booked ? ' disabled' : '') + '><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>' +
          '<div class="grow tap" data-action="shop-edit" data-item="' + esc(i.item_id) + '"><div class="title">' + esc(i.text) + '</div><div class="sub">' + sub + '</div></div>' +
          '<div class="qty">' + (booked ? '<span class="pill ok">gebucht</span>' : itemQty(i)) + '</div></div>';
      }).join('') + '</div>';
    });
    var n = items.filter(function (i) { return i.checked && !i.purchase_id; }).length;
    h += '<button class="btn primary block" data-action="book-checked"' + (n ? '' : ' disabled') + ' style="margin-top:6px">Abgehakte in den Vorrat buchen' + (n ? ' (' + n + ')' : '') + '</button>';
    h += '<p class="small muted" style="margin:10px 4px">Abhaken allein ändert den Vorrat nicht. Gebucht wird erst über diesen Knopf oder später über den Kassenbon, nie doppelt.</p>';
    return h;
  }

  // ---- Angebote
  function viewOffers() {
    var ph = T().PriceHistory.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).slice(0, 20);
    var h = '<div class="card"><h3>Keine geprüften Angebote</h3><p class="muted small" style="margin:6px 0 0">Angebote erscheinen hier nur mit echter Quelle und Datum. Es gibt keine Schätzungen und keine erfundenen Rabatte. Eine verlässliche Angebotsquelle ist noch nicht angebunden.</p></div>';
    h += '<h2>Eigene Preise (historisch)</h2>';
    h += ph.length ? '<div class="list">' + ph.map(function (p) {
      var pr = product(p.product_id);
      return '<div class="row"><div class="grow"><div class="title">' + esc(pr ? pr.name : p.product_id) + '</div><div class="sub">' + esc(p.market) + ' · ' + esc(dShort(p.date)) + ' · historischer Preis</div></div><div class="qty">' + fmtNum(p.unit_price) + ' €</div></div>';
    }).join('') + '</div>' : '<div class="card muted small">Noch keine Kassenbons erfasst. Sobald Bons gebucht sind, siehst du hier deine bezahlten Preise. Sie sind als historisch gekennzeichnet und gelten nicht als aktuelle Angebote.</div>';
    return h;
  }

  // ---- Vorrat
  function viewPantry() {
    var locs = T().Location.slice().sort(function (a, b) { return a.sort - b.sort; });
    var h = '<div class="chips"><button class="chip' + (state.loc === 'all' ? ' on' : '') + '" data-action="loc" data-id="all">Alle</button>' +
      locs.map(function (l) { return '<button class="chip' + (state.loc === l.location_id ? ' on' : '') + '" data-action="loc" data-id="' + l.location_id + '">' + esc(l.name) + '</button>'; }).join('') + '</div>';
    var locFilter = state.loc === 'all' ? null : state.loc;
    var byProduct = {};
    T().StockLot.forEach(function (l) {
      if (Number(l.qty_base) <= 1e-9 || (locFilter && l.location_id !== locFilter)) return;
      (byProduct[l.product_id] = byProduct[l.product_id] || []).push(l);
    });
    var pids = Object.keys(byProduct).sort(function (a, b) { return product(a).name.localeCompare(product(b).name); });
    h += '<div class="btn-row" style="margin-bottom:12px"><button class="btn" data-action="inventory">Inventur' + (locFilter ? ' ' + esc(locName(locFilter)) : '…') + '</button><button class="btn" data-action="new-product">+ Produkt</button></div>';
    if (!pids.length) h += '<div class="card"><div class="empty">Hier ist nichts eingelagert.</div></div>';
    else h += '<div class="list">' + pids.map(function (pid) {
      var lots = EP.fefoSort(byProduct[pid]);
      var total = lots.reduce(function (s, l) { return s + Number(l.qty_base); }, 0);
      var first = lots.filter(function (l) { return l.best_before; })[0];
      var opened = lots.filter(function (l) { return l.opened_at; })[0];
      var d = first ? daysUntil(first.best_before) : 99;
      var dot = d < 0 ? 'bad' : d <= 3 ? 'warn' : 'ok';
      var sub = [];
      if (!locFilter) sub.push(Array.from(new Set(lots.map(function (l) { return locName(l.location_id); }))).join(', '));
      if (lots.length > 1) sub.push(lots.length + ' Chargen');
      if (opened) sub.push('angebrochen seit ' + dNum(opened.opened_at));
      return '<div class="row tap" data-action="product" data-id="' + pid + '"><span class="dot ' + dot + '"></span><div class="grow"><div class="title">' + esc(product(pid).name) + '</div><div class="sub">' + esc(sub.join(' · ')) + '</div></div>' +
        '<div style="text-align:right"><div class="qty">' + esc(fmtQty(pid, total)) + '</div>' + (first ? '<div style="margin-top:3px">' + mhdPill(first.best_before) + '</div>' : '') + '</div></div>';
    }).join('') + '</div>';
    var low = T().MinStock.filter(function (m) { return EP.totalStock(store, m.product_id, m.location_id || null) < Number(m.min_qty_base) - 1e-9; });
    if (low.length) h += '<h2>Unter Mindestbestand</h2><div class="list">' + low.map(function (m) {
      return '<div class="row tap" data-action="product" data-id="' + m.product_id + '"><span class="dot bad"></span><div class="grow"><div class="title">' + esc(product(m.product_id).name) + '</div><div class="sub">Mindestens ' + esc(fmtQty(m.product_id, Number(m.min_qty_base))) + '</div></div><div class="qty">' + esc(fmtQty(m.product_id, EP.totalStock(store, m.product_id, m.location_id || null))) + '</div></div>';
    }).join('') + '</div>';
    return h;
  }

  // ---- Einstellungen
  function viewSettings() {
    var check = EP.verifyLedger(store);
    var h = '<div class="note">Demo-Modus: Beispieldaten nur auf diesem Gerät. Deine echten Bestände und die ChatGPT-Version werden nicht berührt.</div>';
    h += '<h2>Produkte & Packungsregeln</h2><div class="list">' + T().Product.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (p) {
      var k = pkgOf(p);
      return '<div class="row tap" data-action="edit-product" data-id="' + p.product_id + '"><div class="grow"><div class="title">' + esc(p.name) + '</div><div class="sub">' + esc(p.category) + ' · Basiseinheit ' + esc(p.base_unit) + '</div></div><div class="small ' + (k ? '' : 'muted') + '">' + (k ? esc(k.label) : 'keine Packung') + '</div></div>';
    }).join('') + '</div>';
    var aliases = T().ProductAlias;
    h += '<h2>Produktzuordnungen <button class="link" data-action="new-alias">+ Regel</button></h2>';
    h += aliases.length ? '<div class="list">' + aliases.map(function (a) {
      return '<div class="row"><div class="grow"><div class="title">„' + esc(a.alias_original) + '“ → ' + esc((product(a.product_id) || {}).name) + '</div><div class="sub">' + esc(a.status) + ' · Quelle ' + esc(a.source) + '</div></div></div>';
    }).join('') + '</div>' : '<div class="card small muted">Noch keine Regeln.</div>';
    h += '<h2>Lagerorte <button class="link" data-action="new-location">+ Ort</button></h2><div class="list">' + T().Location.map(function (l) {
      return '<div class="row"><div class="grow"><div class="title">' + esc(l.name) + '</div></div><span class="muted small">' + esc(l.location_id) + '</span></div>';
    }).join('') + '</div>';
    h += '<h2>Daten & Nachvollziehbarkeit</h2><div class="list">' +
      '<div class="row"><div class="grow"><div class="title">Bestand = Summe aller Buchungen</div><div class="sub">' + T().StockEvent.length + ' Buchungen im Journal</div></div>' + (check.ok ? '<span class="pill ok">geprüft ✓</span>' : '<span class="pill bad">' + check.problems.length + ' Abweichung(en)</span>') + '</div>' +
      '<div class="row tap" data-action="journal"><div class="grow"><div class="title">Buchungsjournal ansehen</div></div><span class="muted">›</span></div>' +
      '<div class="row tap" data-action="export"><div class="grow"><div class="title">Daten exportieren (JSON)</div></div><span class="muted">›</span></div>' +
      '<div class="row tap" data-action="reset"><div class="grow"><div class="title" style="color:var(--bad)">Beispieldaten zurücksetzen</div></div></div></div>';
    h += '<h2>Familienzugang</h2><div class="card small">Kommt mit der Online-Datenbasis: Anmeldung mit Google, Zugangsanfrage per E-Mail an den Besitzer, Zugriff erst nach deiner Freigabe.</div>';
    h += '<h2>Sprache</h2><div class="card small">' + (speechSupported() ? 'Spracheingabe über die Spracherkennung des Browsers ist verfügbar.' : 'Dieser Browser bietet keine direkte Spracherkennung. Nutze das Mikrofon der Tastatur (Diktat), das funktioniert genauso.') + ' Verstandener Text wird regelbasiert ausgewertet. Es fallen keine KI-Kosten an.</div>';
    h += '<p class="small muted" style="margin:16px 4px">Einkaufsplaner · Claude-Variante · Demo-Version 0.1</p>';
    return h;
  }

  var VIEWS = { today: viewToday, week: viewWeek, cookbook: viewCookbook, shopping: viewShopping, offers: viewOffers, pantry: viewPantry, settings: viewSettings };

  // ------------------------------------------------------------- Sheets
  function openSheet(s) { sheet = s; renderSheet(); $('sheet').classList.add('open'); $('backdrop').classList.add('open'); }
  function closeSheet() {
    if (recognition) { try { recognition.stop(); } catch (e) {} recognition = null; }
    sheet = null; $('sheet').classList.remove('open'); $('backdrop').classList.remove('open'); render();
  }
  function head(title) { return '<div class="grab"></div><div class="sheet-head"><h3 id="sheetTitle">' + title + '</h3><button class="icon-btn" data-action="close-sheet" aria-label="Schließen"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>'; }
  function renderSheet() { if (!sheet) return; $('sheet').innerHTML = SHEETS[sheet.type](); }
  function locOptions(sel, allowEmpty) {
    return (allowEmpty ? '<option value="">Ort wählen…</option>' : '') + T().Location.map(function (l) { return '<option value="' + l.location_id + '"' + (l.location_id === sel ? ' selected' : '') + '>' + esc(l.name) + '</option>'; }).join('');
  }
  function unitOptions(p, sel) {
    var u = [p.base_unit]; if (p.base_unit === 'g') u.push('kg'); if (p.base_unit === 'ml') u.push('l'); if (pkgOf(p)) u.push('Pkg');
    return u.map(function (x) { return '<option' + (x === sel ? ' selected' : '') + '>' + x + '</option>'; }).join('');
  }
  function lastLocation(pid) { var l = T().StockLot.filter(function (x) { return x.product_id === pid; }); return l.length ? l[l.length - 1].location_id : ''; }

  var SHEETS = {
    cook: function () {
      var r = recipe(sheet.recipe_id);
      if (sheet.result) {
        return head('Gebucht ✓') + '<div class="list">' + sheet.result.lines.map(function (l) {
          var p = l.product_id ? product(l.product_id) : null;
          var right = l.status === 'ok' ? '<span class="qty">−' + esc(fmtQty(l.product_id, l.booked, false)) + '</span>' :
            l.status === 'teilweise' ? '<span class="pill warn">−' + esc(fmtQty(l.product_id, l.booked, false)) + ', fehlte ' + esc(fmtQty(l.product_id, l.missing, false)) + '</span>' :
            '<span class="pill unclear">nicht gebucht</span>';
          return '<div class="row"><div class="grow"><div class="title">' + esc(p ? p.name : l.text) + '</div>' + (l.reason ? '<div class="sub">' + esc(l.reason) + '</div>' : '') + '</div>' + right + '</div>';
        }).join('') + '</div><p class="small muted">Vorgang ' + esc(sheet.result.cook_id) + ' · ' + sheet.result.events.length + ' Buchungen im Journal</p><button class="btn primary block" data-action="close-sheet">Fertig</button>';
      }
      var pv = EP.previewCook(store, sheet.recipe_id, sheet.persons, sheet.overrides);
      var h = head(esc(r.name) + ' gekocht?');
      h += '<div class="row" style="padding:0 2px 12px;border:0"><div class="grow muted">Personen</div><div class="stepper"><button data-action="cook-persons" data-d="-1">−</button><span>' + sheet.persons + '</span><button data-action="cook-persons" data-d="1">+</button></div></div>';
      h += '<div class="list">' + pv.lines.map(function (l) {
        if (l.status === 'unklar') return '<div class="row"><span class="dot unclear"></span><div class="grow"><div class="title">' + esc(l.text) + '</div><div class="sub">' + esc(l.reason) + ' · wird nicht abgebucht</div></div></div>';
        if (l.status === 'übersprungen') return '<div class="row"><span class="dot"></span><div class="grow"><div class="title muted">' + esc(l.text) + '</div><div class="sub">nicht verwendet</div></div><button class="mini" data-action="cook-skip" data-line="' + l.line_no + '">Doch</button></div>';
        var p = product(l.product_id);
        return '<div class="row"><span class="dot ' + (l.missing > 1e-9 ? 'warn' : 'ok') + '"></span><div class="grow"><div class="title">' + esc(p.name) + '</div><div class="sub">Vorrat ' + esc(fmtQty(l.product_id, l.in_stock, false)) + (l.missing > 1e-9 ? ' · fehlt ' + esc(fmtQty(l.product_id, l.missing, false)) : '') + '</div></div>' +
          '<input type="number" inputmode="decimal" step="any" min="0" style="width:84px" value="' + fmtNum(l.qty_base).replace(',', '.') + '" data-change="cook-qty" data-line="' + l.line_no + '"><span class="small muted" style="width:26px">' + esc(p.base_unit) + '</span>' +
          '<button class="mini" data-action="cook-skip" data-line="' + l.line_no + '" aria-label="nicht verwendet">✕</button></div>';
      }).join('') + '</div>';
      h += '<p class="small muted">Mengen sind änderbar, falls du tatsächlich mehr oder weniger verwendet hast. Abgezogen wird zuerst die Ware mit dem frühesten MHD, angebrochene Packungen zuerst.</p>';
      h += '<button class="btn primary block" data-action="cook-confirm">Abbuchen</button>';
      return h;
    },

    recipe: function () {
      var r = recipe(sheet.id), p = sheet.persons;
      var ings = T().RecipeIngredient.filter(function (i) { return i.recipe_id === r.recipe_id; }).sort(function (a, b) { return a.line_no - b.line_no; });
      var h = head(esc(r.name));
      h += '<div class="meta" style="margin-bottom:12px"><span>' + esc(r.minutes) + ' Min.</span><span>Grundrezept für ' + esc(r.servings_base) + '</span>' + (r.source_url ? '<a href="' + esc(r.source_url) + '" target="_blank" rel="noopener">Quelle</a>' : '') + '</div>';
      h += '<div class="row" style="padding:0 2px 12px;border:0"><div class="grow muted">Personen</div><div class="stepper"><button data-action="recipe-persons" data-d="-1">−</button><span>' + p + '</span><button data-action="recipe-persons" data-d="1">+</button></div></div>';
      h += '<div class="list">' + ings.map(function (i) {
        var q = i.qty === '' || i.qty == null ? null : Number(i.qty) * (i.per === 'Person' ? p : p / Number(r.servings_base || 2));
        var stock = i.product_id ? EP.totalStock(store, i.product_id) : null;
        var dot = !i.product_id ? 'unclear' : stock > 0 ? 'ok' : 'bad';
        return '<div class="row"><span class="dot ' + dot + '"></span><div class="grow"><div class="title">' + esc(i.text_original) + '</div><div class="sub">' + (i.product_id ? 'Vorrat ' + esc(fmtQty(i.product_id, stock, false)) : 'keinem Produkt zugeordnet') + (i.per === 'Person' ? ' · pro Person' : '') + '</div></div><div class="qty">' + (q == null ? '<span class="pill unclear">ohne Menge</span>' : esc(fmtNum(q) + ' ' + (i.unit || ''))) + '</div></div>';
      }).join('') + '</div>';
      if (r.steps) h += '<h2>Zubereitung</h2><div class="card"><ol class="steps">' + r.steps.split('\n').filter(Boolean).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol></div>';
      h += '<div class="btn-row" style="margin-bottom:10px"><button class="btn" data-action="fav" data-id="' + r.recipe_id + '">' + (r.favorite ? '★ Favorit' : '☆ Favorit') + '</button><button class="btn" data-action="dislike" data-id="' + r.recipe_id + '">' + (r.disliked ? 'Wieder erlaubt' : 'Unerwünscht') + '</button></div>';
      h += '<button class="btn primary block" data-action="cook" data-id="' + r.recipe_id + '" data-persons="' + p + '">Gekocht…</button>';
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
      if (d.url) h += '<div class="note">Automatischer Import von Links kommt mit dem Server-Teil. Der Link wird als Quelle gespeichert.</div>';
      var parsed = parseIngredients(d.ingredients);
      if (parsed.length) h += '<h2>Prüfung</h2><div class="list">' + parsed.map(function (x) {
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
      if (lots.length) h += '<div class="list">' + lots.map(function (l) {
        return '<div class="row"><div class="grow"><div class="title">' + esc(fmtQty(p.product_id, Number(l.qty_base))) + '</div><div class="sub">' + esc(locName(l.location_id)) + (l.opened_at ? ' · angebrochen ' + dNum(l.opened_at) : ' · ungeöffnet') + (l.condition ? ' · ' + esc(l.condition) : '') + '</div></div>' + mhdPill(l.best_before) +
          (l.opened_at ? '' : '<button class="mini" data-action="open-lot" data-id="' + l.lot_id + '">Öffnen</button>') + '</div>';
      }).join('') + '</div>';
      var f = sheet.form;
      h += '<h2>Buchen</h2><div class="seg" style="margin-bottom:10px">' + [['add', 'Dazu'], ['set', 'Insgesamt'], ['remove', 'Entnehmen']].map(function (x) { return '<button class="' + (f.intent === x[0] ? 'on' : '') + '" data-action="pform-intent" data-v="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>';
      h += '<div class="grid3"><div class="field"><label>Menge</label><input type="number" inputmode="decimal" step="any" min="0" data-pform="qty" value="' + esc(f.qty) + '"></div><div class="field"><label>Einheit</label><select data-pform="unit">' + unitOptions(p, f.unit) + '</select></div><div class="field"><label>Ort</label><select data-pform="loc">' + locOptions(f.loc, true) + '</select></div></div>';
      if (f.intent === 'add') h += '<div class="field"><label>MHD (optional)</label><input type="date" data-pform="bb" value="' + esc(f.bb) + '"></div>';
      h += '<div class="btn-row"><button class="btn danger" data-action="used-up">Aufgebraucht</button><button class="btn primary" data-action="pform-book">Buchen</button></div>';
      var ev = T().StockEvent.filter(function (e) { return e.product_id === p.product_id; }).slice(-15).reverse();
      h += '<h2>Verlauf</h2>' + (ev.length ? '<div class="list">' + ev.map(function (e) {
        var dlt = Number(e.delta_base);
        return '<div class="row"><div class="grow"><div class="title">' + esc(EVENT_LABEL[e.type] || e.type) + '</div><div class="sub">' + esc(dShort(String(e.ts).slice(0, 10))) + ' ' + esc(String(e.ts).slice(11, 16)) + ' · ' + esc(locName(e.location_id)) + (e.note ? ' · ' + esc(e.note) : '') + '</div></div><div class="qty" style="color:' + (dlt < 0 ? 'var(--bad)' : dlt > 0 ? 'var(--ok)' : 'var(--muted)') + '">' + (dlt > 0 ? '+' : dlt < 0 ? '−' : '±') + esc(fmtQty(p.product_id, Math.abs(dlt), false)) + '</div></div>';
      }).join('') + '</div>' : '<div class="card small muted">Noch keine Buchungen.</div>');
      return h;
    },

    inventory: function () {
      var loc = sheet.loc;
      var h = head('Inventur');
      h += '<div class="field"><label>Lagerort</label><select data-change="inv-loc">' + locOptions(loc, true) + '</select></div>';
      if (!loc) return h + '<p class="muted">Wähle den Ort, den du gerade zählst. Andere Orte bleiben unverändert.</p>';
      h += '<div class="note info">Trage ein, was jetzt tatsächlich im ' + esc(locName(loc)) + ' ist. Nicht aufgeführte Produkte werden hier auf 0 gesetzt. Andere Lagerorte bleiben unverändert.</div>';
      h += '<div class="list">' + sheet.rows.map(function (r, idx) {
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
      h += '<button class="mic-big' + (recognition ? ' live' : '') + '" data-action="mic" aria-label="Aufnahme"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>';
      if (!speechSupported()) h += '<p class="small muted" style="text-align:center;margin-top:-6px">Tippe ins Textfeld und nutze das Mikrofon der Tastatur.</p>';
      h += '<div class="field"><textarea id="voiceText" data-voice="text" placeholder="' + (sheet.listMode ? 'z. B. Milch, zwei Gurken und Spülmittel' : 'z. B. Wir haben noch drei Äpfel, eine Gurke und Maasdamer, haltbar bis 15. Dezember') + '">' + esc(sheet.text) + '</textarea></div>';
      if (!sheet.listMode) h += '<div class="seg" style="margin-bottom:12px"><button class="' + (!sheet.inventur ? 'on' : '') + '" data-action="voice-mode" data-v="0">Normal</button><button class="' + (sheet.inventur ? 'on' : '') + '" data-action="voice-mode" data-v="1">Inventur („noch“ = gesamt)</button></div>';
      h += '<button class="btn block" data-action="voice-parse">Verstehen</button>';
      if (sheet.actions) {
        if (!sheet.actions.length) return h + '<div class="card muted" style="margin-top:12px">Ich habe kein Produkt erkannt. Formuliere es bitte etwas anders.</div>';
        h += '<h2>Erkannt: ' + sheet.actions.length + ' Aktion(en)</h2>';
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
        return head('Gebucht ✓') + '<p>' + sheet.result.booked.length + ' Position(en) im Vorrat gebucht.</p>' + (sheet.result.skipped.length ? '<div class="note">' + sheet.result.skipped.length + ' nicht gebucht: ' + esc(sheet.result.skipped.map(function (s) { return s.reason; }).join('; ')) + '</div>' : '') + '<button class="btn primary block" data-action="close-sheet">Fertig</button>';
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
      return head('Buchungsjournal') + '<p class="small muted">Jede Bestandsänderung ist eine unveränderliche Buchung. Korrekturen werden als Gegenbuchung erfasst.</p><div class="list">' + ev.map(function (e) {
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
  function startMic() {
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
  function parseVoiceSheet() {
    var acts = EP.parseVoice(sheet.text, today(), sheet.inventur ? 'inventur' : null);
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
      var s = line.replace(/\b(pro|je) person\b/i, '').trim();
      var m = s.match(/^([\d.,\/½¼¾]+)\s*(.*)$/);
      var qty = null, rest = s, unit = '';
      if (m) {
        var qs = m[1].replace('½', '.5').replace('¼', '.25').replace('¾', '.75').replace(',', '.');
        qty = qs.indexOf('/') > 0 ? Number(qs.split('/')[0]) / Number(qs.split('/')[1]) : Number(qs);
        rest = m[2];
        var w = rest.split(/\s+/)[0];
        var nu = EP.normUnit(w);
        if (['g', 'kg', 'ml', 'l', 'cl', 'Stk', 'Pkg'].indexOf(nu) >= 0) { unit = nu; rest = rest.slice(w.length).trim(); }
      }
      var r = EP.resolveProduct(store, rest);
      var pid = r.status === 'resolved' ? r.product_id : '';
      if (pid && !unit) unit = product(pid).base_unit;
      return { text: rest, qty: isNaN(qty) ? null : qty, unit: unit, per: per, product_id: pid, suggest: r.status === 'suggestion' ? r.candidates[0].name : '' };
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
        sheet.actions.forEach(function (a) { addManualItem(a.product_id, a.product_id ? product(a.product_id).name : a.newName, a.qty === '' ? null : Number(a.qty)); });
        toast(sheet.actions.length + ' auf der Liste'); closeSheet(); return;
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
      var r = run({ type: 'batch', commands: cmds }, sheet.key);
      if (r) { toast(r.replayed ? 'War bereits gebucht' : sheet.actions.length + ' Änderung(en) gebucht ✓'); closeSheet(); } else el.disabled = false;
    },

    cook: function (el) {
      var rid = el.getAttribute('data-id');
      var entry = el.getAttribute('data-entry');
      var e = entry ? T().MealPlanEntry.filter(function (x) { return x.entry_id === entry; })[0] : null;
      var persons = Number(el.getAttribute('data-persons')) || (e ? Number(e.persons) : Number(recipe(rid).servings_base));
      if (!e) { var te = entryFor(today()); if (te && te.recipe_id === rid) e = te; }
      openSheet({ type: 'cook', recipe_id: rid, entry_id: e ? e.entry_id : '', persons: persons, overrides: {}, key: uuid() });
    },
    'cook-persons': function (el) { sheet.persons = Math.max(1, sheet.persons + Number(el.getAttribute('data-d'))); sheet.overrides = {}; renderSheet(); },
    'cook-skip': function (el) { var n = el.getAttribute('data-line'); if (sheet.overrides[n] && sheet.overrides[n].skip) delete sheet.overrides[n]; else sheet.overrides[n] = { skip: true }; renderSheet(); },
    'cook-confirm': function (el) {
      el.disabled = true;
      var r = run({ type: 'cook', recipe_id: sheet.recipe_id, persons: sheet.persons, overrides: sheet.overrides, meal_plan_entry_id: sheet.entry_id || undefined, date: today() }, sheet.key);
      if (r) { sheet.result = r; renderSheet(); toast(r.replayed ? 'War bereits gebucht, nichts doppelt abgezogen' : 'Abgebucht ✓'); } else el.disabled = false;
    },

    recipe: function (el) { var r = recipe(el.getAttribute('data-id')); openSheet({ type: 'recipe', id: r.recipe_id, persons: Number(el.getAttribute('data-persons')) || Number(r.servings_base) || 2 }); },
    'recipe-persons': function (el) { sheet.persons = Math.max(1, sheet.persons + Number(el.getAttribute('data-d'))); renderSheet(); },
    fav: function (el) { var r = recipe(el.getAttribute('data-id')); r.favorite = !r.favorite; save(); renderSheet(); },
    dislike: function (el) { var r = recipe(el.getAttribute('data-id')); r.disliked = !r.disliked; save(); renderSheet(); },
    'new-recipe': function () { openSheet({ type: 'newRecipe', draft: { name: '', minutes: 20, servings: 2, category: 'Schnell', ingredients: '', steps: '', url: '' } }); },
    'save-recipe': function () {
      var d = sheet.draft, id = 'R-' + uuid().slice(0, 8).toUpperCase();
      T().Recipe.push({ recipe_id: id, name: d.name.trim(), category: d.category, servings_base: Number(d.servings) || 2, minutes: Number(d.minutes) || '', steps: d.steps, source_url: d.url, favorite: false, disliked: false, repeat_every_days: 7, notes: '', version: 1, updated_at: new Date().toISOString() });
      parseIngredients(d.ingredients).forEach(function (x, i) { T().RecipeIngredient.push({ recipe_id: id, line_no: i + 1, product_id: x.product_id, text_original: x.text, qty: x.qty == null ? '' : x.qty, unit: x.unit, per: x.per, optional: false, note: '' }); });
      if (save()) { toast('Rezept gespeichert'); closeSheet(); }
    },

    'week-nav': function (el) { state.weekOffset += Number(el.getAttribute('data-d')); render(); },
    persons: function (el) {
      var e = T().MealPlanEntry.filter(function (x) { return x.entry_id === el.getAttribute('data-entry'); })[0];
      e.persons = Math.max(0, Number(e.persons) + Number(el.getAttribute('data-d'))); e.updated_at = new Date().toISOString(); save(); render();
    },
    suggest: function () { suggestWeek(); render(); },
    'confirm-plan': function () {
      var ws = weekStart(state.weekOffset), n = 0;
      T().MealPlanEntry.forEach(function (e) { if (e.date >= ws && e.date <= addDays(ws, 6) && e.status === 'Vorschlag') { e.status = 'bestätigt'; n++; } });
      if (save()) toast(n + ' Tag(e) bestätigt, Einkaufsliste aktualisiert'); render();
    },

    'shop-check': function (el) {
      var i = T().ShoppingItem.filter(function (x) { return x.item_id === el.getAttribute('data-item'); })[0];
      if (!i || i.purchase_id) return; i.checked = !i.checked; save(); render();
    },
    'add-item': function () {
      var inp = $('addItem'); var txt = inp.value.trim(); if (!txt) return;
      var a = EP.parseVoice(txt)[0] || { product_text: txt, qty: null };
      var r = EP.resolveProduct(store, a.product_text);
      addManualItem(r.status === 'resolved' ? r.product_id : '', r.status === 'resolved' ? product(r.product_id).name : cap(a.product_text || txt), a.qty);
      render(); toast('Hinzugefügt');
    },
    'shop-edit': function (el) { openSheet({ type: 'shopEdit', id: el.getAttribute('data-item') }); },
    'shop-ovr-save': function () { var i = T().ShoppingItem.filter(function (x) { return x.item_id === sheet.id; })[0]; i.manual_override = Number($('ovr').value); save(); closeSheet(); },
    'shop-ovr-clear': function () { var i = T().ShoppingItem.filter(function (x) { return x.item_id === sheet.id; })[0]; i.manual_override = ''; save(); closeSheet(); },
    'shop-remove': function () { store.tables.ShoppingItem = T().ShoppingItem.filter(function (x) { return x.item_id !== sheet.id; }); save(); closeSheet(); },
    'book-checked': function () {
      var items = T().ShoppingItem.filter(function (i) { return i.week_start === weekStart(0) && i.checked && !i.purchase_id; });
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
      var r = lines.length ? run({ type: 'purchase', source: 'liste', date: today(), lines: lines.map(function (l) { return { product_id: l.product_id, qty: Number(l.qty), unit: l.unit, location_id: l.loc, best_before: l.bb, shopping_item_id: l.item_id }; }) }, sheet.key) : { booked: [], skipped: [] };
      if (r) {
        sheet.lines.filter(function (l) { return !l.product_id; }).forEach(function (l) { store.tables.ShoppingItem = T().ShoppingItem.filter(function (x) { return x.item_id !== l.item_id; }); });
        save(); sheet.result = r; renderSheet(); toast('Eingebucht ✓');
      } else el.disabled = false;
    },

    loc: function (el) { state.loc = el.getAttribute('data-id'); render(); },
    product: function (el) { var pid = el.getAttribute('data-id'); openSheet({ type: 'product', id: pid, key: uuid(), form: { intent: 'add', qty: '', unit: defaultUnit(pid), loc: state.loc !== 'all' ? state.loc : lastLocation(pid), bb: '' } }); },
    'pform-intent': function (el) { sheet.form.intent = el.getAttribute('data-v'); renderSheet(); },
    'pform-book': function (el) {
      var f = sheet.form, pid = sheet.id;
      if (f.qty === '' || isNaN(Number(f.qty))) return toast('Bitte eine Menge eingeben', true);
      if (!f.loc) return toast('Bitte den Lagerort wählen', true);
      el.disabled = true;
      var cmd = f.intent === 'set' ? { type: 'set_total', product_id: pid, location_id: f.loc, qty: Number(f.qty), unit: f.unit } :
        { type: 'adjust', product_id: pid, location_id: f.loc, qty: f.intent === 'remove' ? -Number(f.qty) : Number(f.qty), unit: f.unit, best_before: f.intent === 'add' ? f.bb : '' };
      var r = run(cmd, sheet.key);
      if (r) { toast('Gebucht ✓'); sheet.key = uuid(); sheet.form.qty = ''; sheet.form.bb = ''; }
      renderSheet();
    },
    'used-up': function () {
      var f = sheet.form; if (!f.loc) return toast('Bitte den Lagerort wählen', true);
      if (!confirm(product(sheet.id).name + ' im ' + locName(f.loc) + ' als aufgebraucht markieren?')) return;
      var r = run({ type: 'used_up', product_id: sheet.id, location_id: f.loc }, sheet.key);
      if (r) { toast('Als aufgebraucht gebucht'); sheet.key = uuid(); } renderSheet();
    },
    'open-lot': function (el) { var r = run({ type: 'open', lot_id: el.getAttribute('data-id') }, uuid()); if (r) toast('Als geöffnet markiert'); renderSheet(); },
    inventory: function () {
      var loc = state.loc !== 'all' ? state.loc : '';
      openSheet({ type: 'inventory', loc: loc, rows: loc ? inventoryRows(loc) : [], key: uuid() });
    },
    'inv-save': function (el) {
      if (sheet.rows.some(function (r) { return r.qty === '' || isNaN(Number(r.qty)); })) return toast('Bitte für jedes Produkt eine Zahl eintragen (0 = leer)', true);
      el.disabled = true;
      var r = run({ type: 'inventory', location_id: sheet.loc, mode: 'full', counts: sheet.rows.map(function (x) { return { product_id: x.product_id, qty: Number(x.qty), unit: product(x.product_id).base_unit }; }) }, sheet.key);
      if (r) { toast('Inventur ' + locName(sheet.loc) + ' gespeichert ✓'); closeSheet(); } else el.disabled = false;
    },
    'new-product': function () { openSheet({ type: 'newProduct', form: { name: '', category: 'Sonstiges', unit: 'Stk' } }); },
    'save-product': function () { var f = sheet.form; var r = run({ type: 'create_product', name: f.name, category: f.category, base_unit: f.unit }); if (r) { toast('Angelegt'); openSheet({ type: 'product', id: r.product_id, key: uuid(), form: { intent: 'add', qty: '', unit: f.unit, loc: state.loc !== 'all' ? state.loc : '', bb: '' } }); } },
    'edit-product': function (el) { var p = product(el.getAttribute('data-id')), k = pkgOf(p); openSheet({ type: 'editProduct', id: p.product_id, form: { label: k ? k.label : '', qty: k ? k.content_qty : '', unit: k ? k.content_unit : p.base_unit } }); },
    'save-package': function () {
      var f = sheet.form; if (!f.qty || isNaN(Number(f.qty))) return toast('Bitte den Inhalt angeben', true);
      var p = product(sheet.id);
      var r = run({ type: 'confirm_package', product_id: p.product_id, package_id: p.default_package_id || undefined, label: f.label || 'Packung', content_qty: Number(f.qty), content_unit: f.unit, make_default: true });
      if (r) { toast('Packungsregel gilt jetzt überall'); closeSheet(); }
    },
    'new-alias': function () { openSheet({ type: 'alias', form: { text: '', pid: '' } }); },
    'save-alias': function () { var r = run({ type: 'confirm_alias', alias: sheet.form.text, product_id: sheet.form.pid, source: 'manuell' }); if (r) { toast('Regel gespeichert' + (r.recipe_ingredients_updated ? ', ' + r.recipe_ingredients_updated + ' Rezeptzutat(en) zugeordnet' : '')); closeSheet(); } },
    'new-location': function () { openSheet({ type: 'newLocation' }); },
    'save-location': function () { var r = run({ type: 'create_location', name: $('locName').value }); if (r) { toast('Lagerort angelegt'); closeSheet(); } },
    journal: function () { openSheet({ type: 'journal' }); },
    export: function () {
      var blob = new Blob([JSON.stringify(store, null, 1)], { type: 'application/json' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'einkaufsplaner-demo-' + today() + '.json'; a.click();
    },
    reset: function () { if (!confirm('Alle Demo-Daten auf diesem Gerät zurücksetzen?')) return; localStorage.removeItem(STORE_KEY); store = null; load(); toast('Beispieldaten neu geladen'); render(); }
  };

  function defaultUnit(pid) { var p = product(pid); return p.base_unit === 'Stk' ? 'Stk' : pkgOf(p) ? 'Pkg' : p.base_unit; }
  function inventoryRows(loc) {
    var pids = {};
    T().StockLot.forEach(function (l) { if (l.location_id === loc && Number(l.qty_base) > 1e-9) pids[l.product_id] = true; });
    return Object.keys(pids).sort(function (a, b) { return product(a).name.localeCompare(product(b).name); }).map(function (pid) { var t = EP.totalStock(store, pid, loc); return { product_id: pid, before: t, qty: Math.round(t * 1000) / 1000 }; });
  }
  function addManualItem(pid, text, qty) {
    var ws = weekStart(0);
    T().ShoppingItem.push({ item_id: 'SI-M-' + uuid().slice(0, 8), week_start: ws, product_id: pid || '', text: text, qty_needed: null, qty_available: null, qty_to_buy: qty, unit: pid ? product(pid).base_unit : '', department: pid ? product(pid).category : 'Sonstiges', origin: 'manuell', manual_override: '', checked: false, purchase_id: '', unclear_reason: '', updated_at: new Date().toISOString() });
    save();
  }

  // ------------------------------------------------------------- Ereignisse
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-action]'); if (!el || el.disabled) return;
    var fn = ACTIONS[el.getAttribute('data-action')]; if (fn) { ev.preventDefault(); fn(el); }
  });
  document.addEventListener('input', function (ev) {
    var el = ev.target;
    if (el.getAttribute('data-input') === 'cb-search') { state.search = el.value; var pos = el.selectionStart; render(); var n = document.querySelector('[data-input="cb-search"]'); n.focus(); n.setSelectionRange(pos, pos); }
    if (el.hasAttribute('data-draft')) { sheet.draft[el.getAttribute('data-draft')] = el.value; }
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
      e.recipe_id = el.value; e.status = el.value ? 'Vorschlag' : ''; e.updated_at = new Date().toISOString(); save(); render(); return;
    }
    if (ch === 'cook-qty') { sheet.overrides[el.getAttribute('data-line')] = { qty: Number(el.value), unit: product(EP.previewCook(store, sheet.recipe_id, sheet.persons).lines.filter(function (l) { return String(l.line_no) === el.getAttribute('data-line'); })[0].product_id).base_unit }; renderSheet(); return; }
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
  render();
  window.__EP_APP = { store: function () { return store; }, run: run, actions: ACTIONS };
})();
