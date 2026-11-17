/**
 * Einkaufsplaner (Claude-Variante) – gemeinsame Fachlogik.
 *
 * Läuft unverändert in:
 *  - Google Apps Script (V8) als Backend,
 *  - Node (automatisierte Tests),
 *  - im Browser (Demo-Modus mit lokalem Speicher).
 *
 * Keine Abhängigkeit zu Google-Diensten. Speicher wird als "Store" übergeben:
 *   store.tables[Name] = Array von Zeilenobjekten (Spalten = Kopfzeilen der Tabelle).
 * Der Aufrufer (Apps Script) sorgt für Sperre (LockService) und schreibt
 * die vom Engine gemeldeten Änderungen (changes) gesammelt zurück.
 */
var EP = (function () {
  'use strict';

  // ---------------------------------------------------------------- Hilfen
  var SCHEMA = {
    Product: ['product_id', 'name', 'category', 'base_unit', 'default_package_id', 'notes', 'active', 'created_at', 'updated_at'],
    PackageProfile: ['package_id', 'product_id', 'label', 'content_qty', 'content_unit', 'pieces', 'confirmed_by', 'confirmed_at'],
    ProductAlias: ['alias_norm', 'alias_original', 'product_id', 'package_id', 'source', 'status', 'created_by', 'created_at'],
    UnitConversion: ['product_id', 'from_unit', 'to_unit', 'factor', 'confirmed_by', 'confirmed_at'],
    Location: ['location_id', 'name', 'sort', 'active'],
    StockLot: ['lot_id', 'product_id', 'location_id', 'qty_base', 'package_id', 'best_before', 'opened_at', 'condition', 'created_at', 'updated_at', 'last_event_id'],
    StockEvent: ['event_id', 'tx_id', 'ts', 'type', 'product_id', 'lot_id', 'location_id', 'delta_base', 'qty_after', 'source_ref', 'user', 'note'],
    Transaction: ['tx_id', 'idempotency_key', 'type', 'status', 'request_hash', 'user', 'ts', 'result_json'],
    MinStock: ['product_id', 'location_id', 'min_qty_base', 'updated_at'],
    Recipe: ['recipe_id', 'name', 'category', 'servings_base', 'minutes', 'steps', 'source_url', 'favorite', 'disliked', 'repeat_every_days', 'notes', 'version', 'updated_at'],
    RecipeIngredient: ['recipe_id', 'line_no', 'product_id', 'text_original', 'qty', 'unit', 'per', 'optional', 'note'],
    CookEvent: ['cook_id', 'recipe_id', 'date', 'persons', 'tx_id', 'user', 'ts'],
    MealPlan: ['week_start', 'status', 'confirmed_at', 'confirmed_by'],
    MealPlanEntry: ['entry_id', 'week_start', 'date', 'persons', 'recipe_id', 'status', 'note', 'updated_at'],
    ShoppingItem: ['item_id', 'week_start', 'product_id', 'text', 'qty_needed', 'qty_available', 'qty_to_buy', 'unit', 'department', 'origin', 'manual_override', 'checked', 'purchase_id', 'unclear_reason', 'updated_at'],
    Receipt: ['receipt_id', 'file_id', 'file_name', 'file_sha256', 'fingerprint', 'market', 'datetime', 'receipt_no', 'total', 'status', 'purchase_id', 'uploaded_by', 'uploaded_at', 'error'],
    ReceiptLine: ['receipt_id', 'line_no', 'text_original', 'product_id', 'qty', 'unit', 'unit_price', 'line_price', 'discount', 'deposit', 'mapping_status'],
    Purchase: ['purchase_id', 'date', 'market', 'source', 'receipt_id', 'tx_id', 'user'],
    PriceHistory: ['product_id', 'date', 'market', 'unit_price', 'base_price', 'base_unit', 'discount', 'receipt_id'],
    User: ['email', 'name', 'role', 'status', 'requested_at', 'decided_at', 'decided_by'],
    Settings: ['key', 'value', 'updated_at']
  };

  var EPS = 1e-9;

  function DomainError(code, message, details) {
    this.name = 'DomainError';
    this.code = code;
    this.message = message;
    this.details = details || null;
  }
  DomainError.prototype = Object.create(Error.prototype);

  function fail(code, msg, details) { throw new DomainError(code, msg, details); }
  function num(v) { if (v === '' || v === null || v === undefined) return null; var n = Number(v); return isNaN(n) ? null : n; }
  function round(n) { return Math.round(n * 1000) / 1000; }
  function isoDate(d) { return d ? String(d).slice(0, 10) : ''; }

  function newStore() {
    var t = {};
    Object.keys(SCHEMA).forEach(function (k) { t[k] = []; });
    return { tables: t };
  }

  /** Erzeugt kurze, gut lesbare IDs, z. B. "P-7K2M9Q". */
  function makeIdGen(seedFn) {
    var rnd = seedFn || Math.random;
    var alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    return function (prefix) {
      var s = '';
      for (var i = 0; i < 8; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      return prefix + '-' + s;
    };
  }

  // ---------------------------------------------------------- Namensabgleich
  /**
   * Normalisierung für Alias-Vergleich: Kleinschreibung, Umlaute, nur Buchstaben/Ziffern,
   * Doppelbuchstaben zusammengezogen ("Bio-Maasdamer" == "Biomasdammer").
   */
  function normalizeName(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]/g, '')
      .replace(/(.)\1+/g, '$1');
  }

  function levenshtein(a, b) {
    var m = a.length, n = b.length, d = [], i, j;
    for (i = 0; i <= m; i++) d[i] = [i];
    for (j = 0; j <= n; j++) d[0][j] = j;
    for (i = 1; i <= m; i++) for (j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return d[m][n];
  }

  /**
   * Löst einen Namen auf eine product_id auf.
   * Nur BESTÄTIGTE Aliase und exakte Produktnamen werden automatisch zugeordnet.
   * Ähnliche Namen werden nur als Vorschlag geliefert (status 'suggestion').
   */
  function resolveProduct(store, text) {
    var norm = normalizeName(text);
    if (!norm) return { status: 'unknown', input: text };
    var aliases = store.tables.ProductAlias;
    for (var i = 0; i < aliases.length; i++) {
      var a = aliases[i];
      if (a.alias_norm === norm && a.status === 'bestätigt') {
        return { status: 'resolved', product_id: a.product_id, package_id: a.package_id || null, via: 'alias' };
      }
      if (a.alias_norm === norm && a.status === 'abgelehnt') {
        // explizit abgelehnte Zuordnung: nicht automatisch, aber auch nicht vorschlagen
      }
    }
    var products = store.tables.Product;
    for (var k = 0; k < products.length; k++) {
      if (normalizeName(products[k].name) === norm) return { status: 'resolved', product_id: products[k].product_id, package_id: null, via: 'name' };
    }
    // Vorschläge (nie automatisch)
    var rejected = {};
    aliases.forEach(function (a) { if (a.alias_norm === norm && a.status === 'abgelehnt') rejected[a.product_id] = true; });
    var cands = [];
    products.forEach(function (p) {
      if (rejected[p.product_id]) return;
      var pn = normalizeName(p.name);
      var dist = levenshtein(norm, pn);
      var lim = Math.max(1, Math.floor(Math.min(norm.length, pn.length) / 6));
      if (dist <= lim) cands.push({ product_id: p.product_id, name: p.name, distance: dist });
    });
    cands.sort(function (x, y) { return x.distance - y.distance; });
    return cands.length ? { status: 'suggestion', input: text, candidates: cands } : { status: 'unknown', input: text };
  }

  // ----------------------------------------------------------------- Einheiten
  var UNIT_ALIASES = {
    g: 'g', gramm: 'g', gr: 'g', kg: 'kg', kilo: 'kg', kilogramm: 'kg',
    ml: 'ml', milliliter: 'ml', l: 'l', liter: 'l', cl: 'cl',
    stk: 'Stk', 'stück': 'Stk', stueck: 'Stk', st: 'Stk', x: 'Stk',
    pkg: 'Pkg', packung: 'Pkg', packungen: 'Pkg', pack: 'Pkg', pck: 'Pkg', pk: 'Pkg',
    becher: 'Pkg', dose: 'Pkg', dosen: 'Pkg', flasche: 'Pkg', flaschen: 'Pkg', glas: 'Pkg', 'gläser': 'Pkg'
  };
  var GLOBAL_FACTORS = { kg: { g: 1000 }, l: { ml: 1000 }, cl: { ml: 10 } };

  function normUnit(u) {
    if (!u) return '';
    var k = String(u).trim().toLowerCase().replace(/\.$/, '');
    return UNIT_ALIASES[k] || String(u).trim();
  }

  function getProduct(store, id) {
    for (var i = 0; i < store.tables.Product.length; i++) if (store.tables.Product[i].product_id === id) return store.tables.Product[i];
    return null;
  }
  function getPackage(store, id) {
    if (!id) return null;
    for (var i = 0; i < store.tables.PackageProfile.length; i++) if (store.tables.PackageProfile[i].package_id === id) return store.tables.PackageProfile[i];
    return null;
  }
  function packageContentBase(store, product, pkg) {
    if (!pkg || !pkg.confirmed_at) return null; // nur bestätigte Packungsprofile
    var r = toBaseSimple(store, product, num(pkg.content_qty), normUnit(pkg.content_unit));
    return r;
  }
  function toBaseSimple(store, product, qty, unit) {
    if (qty === null) return null;
    var base = product.base_unit;
    if (unit === base || unit === '') return qty;
    if (GLOBAL_FACTORS[unit] && GLOBAL_FACTORS[unit][base]) return qty * GLOBAL_FACTORS[unit][base];
    if (GLOBAL_FACTORS[base] && GLOBAL_FACTORS[base][unit]) return qty / GLOBAL_FACTORS[base][unit];
    var convs = store.tables.UnitConversion;
    for (var i = 0; i < convs.length; i++) {
      var c = convs[i];
      if (c.product_id !== product.product_id || !c.confirmed_at) continue;
      if (normUnit(c.from_unit) === unit && normUnit(c.to_unit) === base) return qty * num(c.factor);
      if (normUnit(c.to_unit) === unit && normUnit(c.from_unit) === base) return qty / num(c.factor);
    }
    return null;
  }

  /**
   * Rechnet eine Menge in die Basiseinheit des Produkts um.
   * Stück↔Packung nur über bestätigtes Packungsprofil. Sonst {ok:false, reason}.
   */
  function toBase(store, productId, qty, unit, packageId) {
    var product = getProduct(store, productId);
    if (!product) return { ok: false, reason: 'Produkt unbekannt' };
    var q = num(qty);
    if (q === null) return { ok: false, reason: 'Menge fehlt' };
    var u = normUnit(unit) || product.base_unit;
    if (u === 'Pkg') {
      var pkg = getPackage(store, packageId || product.default_package_id);
      var content = packageContentBase(store, product, pkg);
      if (content === null) return { ok: false, reason: 'Packungsgröße für ' + product.name + ' nicht bestätigt' };
      return { ok: true, qty_base: round(q * content), unit: product.base_unit, package_id: pkg.package_id };
    }
    var b = toBaseSimple(store, product, q, u);
    if (b === null) return { ok: false, reason: 'Keine bestätigte Umrechnung ' + u + ' → ' + product.base_unit + ' für ' + product.name };
    return { ok: true, qty_base: round(b), unit: product.base_unit, package_id: packageId || null };
  }

  // ----------------------------------------------------------------- Bestand
  function lotsOf(store, productId, locationId) {
    return store.tables.StockLot.filter(function (l) {
      return l.product_id === productId && num(l.qty_base) > EPS && (!locationId || l.location_id === locationId);
    });
  }
  function totalStock(store, productId, locationId) {
    return round(lotsOf(store, productId, locationId).reduce(function (s, l) { return s + num(l.qty_base); }, 0));
  }
  /** FEFO: frühestes MHD zuerst; ohne MHD zuletzt; bei Gleichstand angebrochene zuerst, dann älteste Charge. */
  function fefoSort(lots) {
    return lots.slice().sort(function (a, b) {
      var ab = a.best_before || '9999-12-31', bb = b.best_before || '9999-12-31';
      if (ab !== bb) return ab < bb ? -1 : 1;
      var ao = a.opened_at ? 0 : 1, bo = b.opened_at ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return String(a.created_at) < String(b.created_at) ? -1 : 1;
    });
  }

  // ------------------------------------------------------------ Engine / Tx
  /**
   * Engine kapselt eine Transaktion. Aufruf immer unter Sperre (Apps Script: LockService).
   * opts: { now: () => ISO-String, idGen: (prefix) => id, user }
   */
  function Engine(store, opts) {
    this.store = store;
    this.now = (opts && opts.now) || function () { return new Date().toISOString(); };
    this.idGen = (opts && opts.idGen) || makeIdGen();
  }

  /**
   * Führt einen Befehl idempotent aus.
   * - gleicher idempotency_key + gleicher Inhalt → gespeichertes Ergebnis, keine zweite Buchung
   * - gleicher Schlüssel + anderer Inhalt → Fehler (Schutz vor Verwechslung)
   * - Fehler → keine Teiländerungen (Arbeit auf Kopie, erst am Ende übernommen)
   */
  Engine.prototype.execute = function (command, ctx) {
    if (!ctx || !ctx.idempotencyKey) fail('NO_KEY', 'Idempotenzschlüssel fehlt');
    var user = ctx.user || 'unbekannt';
    var reqHash = stableHash(command);
    var txs = this.store.tables.Transaction;
    for (var i = 0; i < txs.length; i++) {
      if (txs[i].idempotency_key === ctx.idempotencyKey && txs[i].status === 'ok') {
        if (txs[i].request_hash !== reqHash) fail('KEY_REUSED', 'Schlüssel wurde bereits für einen anderen Vorgang verwendet');
        var prev = JSON.parse(txs[i].result_json);
        prev.replayed = true;
        return prev;
      }
    }
    // Auf Kopie arbeiten → atomar
    var work = deepCopy(this.store);
    var before = snapshotCounts(this.store);
    var tx = { tx_id: this.idGen('TX'), user: user, ts: this.now(), events: [] };
    var handler = HANDLERS[command.type];
    if (!handler) fail('UNKNOWN_COMMAND', 'Unbekannter Befehl: ' + command.type);
    var result = handler.call(this, work, command, tx);
    result.tx_id = tx.tx_id;
    result.events = tx.events.map(function (e) { return e.event_id; });
    work.tables.Transaction.push({
      tx_id: tx.tx_id, idempotency_key: ctx.idempotencyKey, type: command.type, status: 'ok',
      request_hash: reqHash, user: user, ts: tx.ts, result_json: JSON.stringify(result)
    });
    // übernehmen
    var self = this;
    Object.keys(work.tables).forEach(function (k) { self.store.tables[k] = work.tables[k]; });
    result.changes = diffTables(before, this.store);
    return result;
  };

  function snapshotCounts(store) {
    var s = {};
    Object.keys(store.tables).forEach(function (k) { s[k] = JSON.stringify(store.tables[k]); });
    return s;
  }
  function diffTables(beforeSnap, store) {
    var changed = [];
    Object.keys(store.tables).forEach(function (k) { if (beforeSnap[k] !== JSON.stringify(store.tables[k])) changed.push(k); });
    return changed;
  }
  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }
  function stableHash(obj) {
    var s = stableStringify(obj), h1 = 0x811c9dc5, h2 = 0;
    for (var i = 0; i < s.length; i++) { h1 ^= s.charCodeAt(i); h1 = (h1 * 16777619) >>> 0; h2 = (h2 * 31 + s.charCodeAt(i)) >>> 0; }
    return h1.toString(16) + h2.toString(16);
  }
  function stableStringify(o) {
    if (o === null || typeof o !== 'object') return JSON.stringify(o);
    if (Array.isArray(o)) return '[' + o.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(o).sort().map(function (k) { return JSON.stringify(k) + ':' + stableStringify(o[k]); }).join(',') + '}';
  }

  // ---- Buchungsprimitive (arbeiten auf "work"-Store innerhalb einer Tx)
  function addEvent(self, work, tx, type, lot, delta, sourceRef, note) {
    var ev = {
      event_id: self.idGen('EV'), tx_id: tx.tx_id, ts: tx.ts, type: type,
      product_id: lot.product_id, lot_id: lot.lot_id, location_id: lot.location_id,
      delta_base: round(delta), qty_after: round(num(lot.qty_base)),
      source_ref: sourceRef || '', user: tx.user, note: note || ''
    };
    work.tables.StockEvent.push(ev);
    lot.last_event_id = ev.event_id;
    lot.updated_at = tx.ts;
    tx.events.push(ev);
    return ev;
  }

  function newLot(self, work, tx, p) {
    var lot = {
      lot_id: self.idGen('L'), product_id: p.product_id, location_id: p.location_id, qty_base: 0,
      package_id: p.package_id || '', best_before: isoDate(p.best_before), opened_at: p.opened_at || '',
      condition: p.condition || '', created_at: tx.ts, updated_at: tx.ts, last_event_id: ''
    };
    work.tables.StockLot.push(lot);
    return lot;
  }

  /** Zugang: legt neue Charge an oder ergänzt identische ungeöffnete Charge (gleiches MHD, Ort, Packung). */
  function receive(self, work, tx, p, type, sourceRef, note) {
    var bb = isoDate(p.best_before);
    var lot = null;
    if (!p.opened_at) {
      lot = work.tables.StockLot.filter(function (l) {
        return l.product_id === p.product_id && l.location_id === p.location_id && !l.opened_at &&
          (l.package_id || '') === (p.package_id || '') && (l.best_before || '') === bb && num(l.qty_base) > EPS;
      })[0] || null;
    }
    if (!lot) lot = newLot(self, work, tx, p);
    lot.qty_base = round(num(lot.qty_base) + p.qty_base);
    return addEvent(self, work, tx, type, lot, p.qty_base, sourceRef, note);
  }

  /**
   * Abgang nach FEFO. Ganze ungeöffnete Packungen werden ganz entnommen; muss eine Packung
   * angebrochen werden, entsteht eine eigene angebrochene Charge mit Öffnungsdatum.
   * Liefert {taken, missing}.
   */
  function consume(self, work, tx, productId, qtyBase, locationId, type, sourceRef, note) {
    var product = getProduct(work, productId);
    var remaining = qtyBase;
    var lots = fefoSort(lotsOf(work, productId, locationId));
    for (var i = 0; i < lots.length && remaining > EPS; i++) {
      var lot = lots[i];
      var have = num(lot.qty_base);
      var take = Math.min(have, remaining);
      var pkg = getPackage(work, lot.package_id);
      var content = pkg ? packageContentBase(work, product, pkg) : null;
      if (!lot.opened_at && content && content > EPS) {
        var full = Math.floor((take + EPS) / content);
        var rest = round(take - full * content);
        if (full > 0) {
          lot.qty_base = round(have - full * content);
          addEvent(self, work, tx, type, lot, -full * content, sourceRef, note);
        }
        if (rest > EPS) {
          // eine Packung öffnen → eigene angebrochene Charge
          lot.qty_base = round(num(lot.qty_base) - content);
          addEvent(self, work, tx, 'open', lot, -content, sourceRef, 'Packung geöffnet');
          var opened = newLot(self, work, tx, {
            product_id: lot.product_id, location_id: lot.location_id, package_id: lot.package_id,
            best_before: lot.best_before, opened_at: isoDate(tx.ts), condition: lot.condition
          });
          opened.qty_base = content;
          addEvent(self, work, tx, 'open', opened, content, sourceRef, 'Packung geöffnet');
          opened.qty_base = round(content - rest);
          addEvent(self, work, tx, type, opened, -rest, sourceRef, note);
        }
      } else {
        lot.qty_base = round(have - take);
        if (!lot.opened_at && num(lot.qty_base) > EPS && !content) {
          // Teilentnahme aus Charge ohne bekannte Packungsgröße: als angebrochen markieren
          lot.opened_at = isoDate(tx.ts);
        }
        addEvent(self, work, tx, type, lot, -take, sourceRef, note);
      }
      remaining = round(remaining - take);
    }
    return { taken: round(qtyBase - Math.max(0, remaining)), missing: round(Math.max(0, remaining)) };
  }

  function requireLocation(work, id) {
    var ok = work.tables.Location.some(function (l) { return l.location_id === id; });
    if (!ok) fail('LOCATION', 'Lagerort unbekannt: ' + id);
  }

  function baseOrFail(work, productId, qty, unit, packageId) {
    var r = toBase(work, productId, qty, unit, packageId);
    if (!r.ok) fail('UNIT', r.reason, { product_id: productId, qty: qty, unit: unit });
    return r;
  }

  // ------------------------------------------------------------- Befehle
  var HANDLERS = {
    /** +/- Menge (z. B. "vier gekauft" → +4, "eine entnommen" → -1) */
    adjust: function (work, c, tx) {
      requireLocation(work, c.location_id);
      var b = baseOrFail(work, c.product_id, Math.abs(c.qty), c.unit, c.package_id);
      if (c.qty >= 0) {
        receive(this, work, tx, { product_id: c.product_id, location_id: c.location_id, qty_base: b.qty_base, package_id: b.package_id || c.package_id, best_before: c.best_before }, 'manual_delta', c.source_ref, c.note);
        return { ok: true, total: totalStock(work, c.product_id, c.location_id) };
      }
      var r = consume(this, work, tx, c.product_id, b.qty_base, c.location_id, 'manual_delta', c.source_ref, c.note);
      if (r.missing > EPS && !c.allow_partial) fail('INSUFFICIENT', 'Nicht genug Bestand', r);
      return { ok: true, taken: r.taken, missing: r.missing, total: totalStock(work, c.product_id, c.location_id) };
    },

    /** "insgesamt vier" → absoluter Wert, Differenz wird serverseitig auf AKTUELLEM Stand berechnet */
    set_total: function (work, c, tx) {
      requireLocation(work, c.location_id);
      var b = baseOrFail(work, c.product_id, c.qty, c.unit, c.package_id);
      var current = totalStock(work, c.product_id, c.location_id);
      var delta = round(b.qty_base - current);
      if (delta > EPS) receive(this, work, tx, { product_id: c.product_id, location_id: c.location_id, qty_base: delta, package_id: b.package_id || c.package_id, best_before: c.best_before }, 'set_total', c.source_ref, 'gesetzt auf ' + b.qty_base);
      else if (delta < -EPS) consume(this, work, tx, c.product_id, -delta, c.location_id, 'set_total', c.source_ref, 'gesetzt auf ' + b.qty_base);
      return { ok: true, before: current, total: totalStock(work, c.product_id, c.location_id), delta: delta };
    },

    /** Aufgebraucht: alle Chargen des Produkts am Ort auf 0 */
    used_up: function (work, c, tx) {
      var cur = totalStock(work, c.product_id, c.location_id);
      if (cur > EPS) consume(this, work, tx, c.product_id, cur, c.location_id, 'manual_delta', c.source_ref, 'aufgebraucht');
      return { ok: true, total: 0 };
    },

    /** Packung öffnen ohne Entnahme (Öffnungsdatum je Packung) */
    open: function (work, c, tx) {
      var lot = work.tables.StockLot.filter(function (l) { return l.lot_id === c.lot_id; })[0];
      if (!lot) fail('LOT', 'Charge unbekannt');
      if (lot.opened_at) return { ok: true, lot_id: lot.lot_id, already: true };
      var product = getProduct(work, lot.product_id);
      var content = packageContentBase(work, product, getPackage(work, lot.package_id));
      if (content && num(lot.qty_base) > content + EPS) {
        lot.qty_base = round(num(lot.qty_base) - content);
        addEvent(this, work, tx, 'open', lot, -content, c.source_ref, 'Packung geöffnet');
        var o = newLot(this, work, tx, { product_id: lot.product_id, location_id: lot.location_id, package_id: lot.package_id, best_before: lot.best_before, opened_at: isoDate(c.date || tx.ts), condition: lot.condition });
        o.qty_base = content;
        addEvent(this, work, tx, 'open', o, content, c.source_ref, 'Packung geöffnet');
        return { ok: true, lot_id: o.lot_id };
      }
      lot.opened_at = isoDate(c.date || tx.ts);
      addEvent(this, work, tx, 'open', lot, 0, c.source_ref, 'Packung geöffnet');
      return { ok: true, lot_id: lot.lot_id };
    },

    /**
     * Inventur für EINEN Lagerort. Nur Produkte dieses Ortes werden angefasst.
     * counts: [{product_id, qty, unit, package_id, best_before}]
     * mode 'full': nicht genannte Produkte dieses Ortes → 0. mode 'partial': nur genannte.
     */
    inventory: function (work, c, tx) {
      requireLocation(work, c.location_id);
      var self = this, seen = {}, changes = [];
      (c.counts || []).forEach(function (cnt) {
        var b = baseOrFail(work, cnt.product_id, cnt.qty, cnt.unit, cnt.package_id);
        seen[cnt.product_id] = true;
        var cur = totalStock(work, cnt.product_id, c.location_id);
        var d = round(b.qty_base - cur);
        if (d > EPS) receive(self, work, tx, { product_id: cnt.product_id, location_id: c.location_id, qty_base: d, package_id: b.package_id || cnt.package_id, best_before: cnt.best_before }, 'inventory', c.source_ref, 'Inventur');
        else if (d < -EPS) consume(self, work, tx, cnt.product_id, -d, c.location_id, 'inventory', c.source_ref, 'Inventur');
        changes.push({ product_id: cnt.product_id, before: cur, after: b.qty_base });
      });
      if (c.mode === 'full') {
        var others = {};
        work.tables.StockLot.forEach(function (l) { if (l.location_id === c.location_id && num(l.qty_base) > EPS && !seen[l.product_id]) others[l.product_id] = true; });
        Object.keys(others).forEach(function (pid) {
          var cur = totalStock(work, pid, c.location_id);
          consume(self, work, tx, pid, cur, c.location_id, 'inventory', c.source_ref, 'Inventur: nicht mehr vorhanden');
          changes.push({ product_id: pid, before: cur, after: 0 });
        });
      }
      return { ok: true, location_id: c.location_id, changes: changes };
    },

    /**
     * Einkauf buchen (aus Bon oder abgehakter Liste). Zeilen ohne sichere Produkt-/Mengenzuordnung
     * werden NICHT gebucht, sondern zurückgemeldet.
     * c: {source:'bon'|'liste', receipt_id?, date, market, lines:[{product_id, qty, unit, package_id, location_id, best_before, shopping_item_id?}]}
     */
    purchase: function (work, c, tx) {
      var self = this;
      if (c.receipt_id) {
        var rc = work.tables.Receipt.filter(function (r) { return r.receipt_id === c.receipt_id; })[0];
        if (!rc) fail('RECEIPT', 'Bon unbekannt');
        if (rc.status === 'gebucht') fail('ALREADY_BOOKED', 'Dieser Bon ist bereits gebucht', { purchase_id: rc.purchase_id });
        if (rc.status === 'dublette') fail('DUPLICATE', 'Dieser Bon ist eine Dublette und wird nicht gebucht');
      }
      var purchaseId = self.idGen('PU');
      var booked = [], skipped = [];
      (c.lines || []).forEach(function (ln, idx) {
        if (!ln.product_id) { skipped.push({ line: idx, reason: 'Produkt nicht zugeordnet' }); return; }
        if (ln.shopping_item_id) {
          var si = work.tables.ShoppingItem.filter(function (s) { return s.item_id === ln.shopping_item_id; })[0];
          if (si && si.purchase_id) { skipped.push({ line: idx, reason: 'Bereits über Einkauf ' + si.purchase_id + ' gebucht' }); return; }
        }
        var r = toBase(work, ln.product_id, ln.qty, ln.unit, ln.package_id);
        if (!r.ok) { skipped.push({ line: idx, reason: r.reason }); return; }
        var loc = ln.location_id || defaultLocation(work, ln.product_id);
        if (!loc) { skipped.push({ line: idx, reason: 'Lagerort fehlt' }); return; }
        requireLocation(work, loc);
        receive(self, work, tx, { product_id: ln.product_id, location_id: loc, qty_base: r.qty_base, package_id: r.package_id || ln.package_id, best_before: ln.best_before }, 'purchase', purchaseId, c.receipt_id ? 'Bon ' + c.receipt_id : 'Einkaufsliste');
        if (ln.shopping_item_id) {
          work.tables.ShoppingItem.forEach(function (s) { if (s.item_id === ln.shopping_item_id) { s.purchase_id = purchaseId; s.checked = true; } });
        }
        booked.push({ line: idx, product_id: ln.product_id, qty_base: r.qty_base, location_id: loc });
      });
      if (!booked.length) fail('NOTHING_TO_BOOK', 'Keine buchbare Position', { skipped: skipped });
      work.tables.Purchase.push({ purchase_id: purchaseId, date: isoDate(c.date || tx.ts), market: c.market || '', source: c.source || '', receipt_id: c.receipt_id || '', tx_id: tx.tx_id, user: tx.user });
      if (c.receipt_id) work.tables.Receipt.forEach(function (r) { if (r.receipt_id === c.receipt_id) { r.status = 'gebucht'; r.purchase_id = purchaseId; } });
      return { ok: true, purchase_id: purchaseId, booked: booked, skipped: skipped };
    },

    /** Gekocht: zieht alle zugeordneten Zutaten ab. Vorher previewCook() anzeigen. */
    cook: function (work, c, tx) {
      var pv = previewCook(work, c.recipe_id, c.persons, c.overrides);
      var self = this;
      var cookId = self.idGen('CK');
      var lines = [];
      pv.lines.forEach(function (l) {
        if (l.status !== 'ok' || l.qty_base <= EPS) { lines.push({ text: l.text, status: l.status, reason: l.reason, booked: 0 }); return; }
        var r = consume(self, work, tx, l.product_id, l.qty_base, null, 'cook', cookId, pv.recipe_name);
        lines.push({ text: l.text, product_id: l.product_id, status: r.missing > EPS ? 'teilweise' : 'ok', booked: r.taken, missing: r.missing, unit: l.unit });
      });
      work.tables.CookEvent.push({ cook_id: cookId, recipe_id: c.recipe_id, date: isoDate(c.date || tx.ts), persons: pv.persons, tx_id: tx.tx_id, user: tx.user, ts: tx.ts });
      if (c.meal_plan_entry_id) work.tables.MealPlanEntry.forEach(function (e) { if (e.entry_id === c.meal_plan_entry_id) { e.status = 'gekocht'; e.updated_at = tx.ts; } });
      return { ok: true, cook_id: cookId, lines: lines };
    },

    /** Bestätigte Produktzuordnung als globale Regel speichern */
    confirm_alias: function (work, c, tx) {
      var norm = normalizeName(c.alias);
      if (!getProduct(work, c.product_id)) fail('PRODUCT', 'Produkt unbekannt');
      work.tables.ProductAlias = work.tables.ProductAlias.filter(function (a) { return !(a.alias_norm === norm && a.product_id === c.product_id); });
      work.tables.ProductAlias.push({ alias_norm: norm, alias_original: c.alias, product_id: c.product_id, package_id: c.package_id || '', source: c.source || 'manuell', status: c.reject ? 'abgelehnt' : 'bestätigt', created_by: tx.user, created_at: tx.ts });
      // Rezeptzutaten mit gleichem Text ohne Produkt nachträglich zuordnen (globale Wirkung)
      var updated = 0;
      if (!c.reject) work.tables.RecipeIngredient.forEach(function (ri) { if (!ri.product_id && normalizeName(ri.text_original) === norm) { ri.product_id = c.product_id; updated++; } });
      return { ok: true, alias_norm: norm, recipe_ingredients_updated: updated };
    },

    /** Packungsprofil bestätigen (z. B. Maultaschen 1 Pkg = 6 Stk) */
    confirm_package: function (work, c, tx) {
      var product = getProduct(work, c.product_id);
      if (!product) fail('PRODUCT', 'Produkt unbekannt');
      var pkg = c.package_id ? getPackage(work, c.package_id) : null;
      if (!pkg) { pkg = { package_id: this.idGen('PK'), product_id: c.product_id }; work.tables.PackageProfile.push(pkg); }
      pkg.label = c.label || pkg.label || 'Packung';
      pkg.content_qty = c.content_qty; pkg.content_unit = c.content_unit || product.base_unit; pkg.pieces = c.pieces || '';
      pkg.confirmed_by = tx.user; pkg.confirmed_at = tx.ts;
      if (toBaseSimple(work, product, num(c.content_qty), normUnit(pkg.content_unit)) === null) fail('UNIT', 'Packungsinhalt nicht in ' + product.base_unit + ' umrechenbar');
      if (c.make_default || !product.default_package_id) product.default_package_id = pkg.package_id;
      return { ok: true, package_id: pkg.package_id };
    },

    /** Bon registrieren mit Dublettenprüfung (Datei-Hash + Inhalts-Fingerabdruck) */
    register_receipt: function (work, c, tx) {
      var fp = receiptFingerprint(c);
      var dup = work.tables.Receipt.filter(function (r) {
        return r.status !== 'dublette' && r.status !== 'fehler' && ((c.file_sha256 && r.file_sha256 === c.file_sha256) || (fp && r.fingerprint === fp));
      })[0];
      var id = this.idGen('BON');
      work.tables.Receipt.push({
        receipt_id: id, file_id: c.file_id || '', file_name: c.file_name || '', file_sha256: c.file_sha256 || '', fingerprint: fp || '',
        market: c.market || '', datetime: c.datetime || '', receipt_no: c.receipt_no || '', total: c.total == null ? '' : c.total,
        status: dup ? 'dublette' : (c.lines && c.lines.length ? 'prüfen' : 'hochgeladen'), purchase_id: '', uploaded_by: tx.user, uploaded_at: tx.ts,
        error: dup ? 'Dublette von ' + dup.receipt_id : ''
      });
      if (!dup) (c.lines || []).forEach(function (ln, i) {
        work.tables.ReceiptLine.push({ receipt_id: id, line_no: i + 1, text_original: ln.text_original, product_id: ln.product_id || '', qty: ln.qty, unit: ln.unit || '', unit_price: ln.unit_price, line_price: ln.line_price, discount: ln.discount || 0, deposit: ln.deposit || 0, mapping_status: ln.product_id ? 'zugeordnet' : 'offen' });
      });
      return { ok: true, receipt_id: id, duplicate_of: dup ? dup.receipt_id : null };
    }
  };

  function defaultLocation(work, productId) {
    // letzter genutzter Lagerort des Produkts, sonst keiner (keine Annahme)
    var lots = work.tables.StockLot.filter(function (l) { return l.product_id === productId; });
    return lots.length ? lots[lots.length - 1].location_id : null;
  }

  function receiptFingerprint(c) {
    if (!c.market || !c.datetime || c.total == null || c.total === '') return null;
    return [normalizeName(c.market), String(c.datetime).replace(/[^0-9]/g, '').slice(0, 12), String(c.receipt_no || ''), Number(c.total).toFixed(2)].join('|');
  }

  // ------------------------------------------------------------- Kochen
  /**
   * Vorschau für "Gekocht": zeigt je Zutat Menge, Bestand und Unklarheiten. Bucht nichts.
   * overrides: {line_no: {qty, unit} | {skip:true}}
   */
  function previewCook(store, recipeId, persons, overrides) {
    var recipe = store.tables.Recipe.filter(function (r) { return r.recipe_id === recipeId; })[0];
    if (!recipe) fail('RECIPE', 'Rezept unbekannt');
    var servings = num(recipe.servings_base) || 2;
    var p = num(persons) || servings;
    overrides = overrides || {};
    var lines = store.tables.RecipeIngredient.filter(function (i) { return i.recipe_id === recipeId; })
      .sort(function (a, b) { return num(a.line_no) - num(b.line_no); })
      .map(function (ing) {
        var ov = overrides[ing.line_no] || overrides[String(ing.line_no)];
        var text = ing.text_original;
        if (ov && ov.skip) return { line_no: ing.line_no, text: text, status: 'übersprungen', qty_base: 0 };
        if (!ing.product_id) return { line_no: ing.line_no, text: text, status: 'unklar', reason: 'Zutat keinem Produkt zugeordnet', qty_base: 0 };
        var qty = ov && ov.qty != null ? num(ov.qty) : num(ing.qty);
        var unit = ov && ov.unit ? ov.unit : ing.unit;
        if (qty === null) return { line_no: ing.line_no, text: text, product_id: ing.product_id, status: 'unklar', reason: 'Menge im Rezept nicht angegeben', qty_base: 0 };
        if (!(ov && ov.qty != null)) qty = ing.per === 'Person' ? qty * p : qty * p / servings;
        var b = toBase(store, ing.product_id, qty, unit);
        if (!b.ok) return { line_no: ing.line_no, text: text, product_id: ing.product_id, status: 'unklar', reason: b.reason, qty_base: 0 };
        var have = totalStock(store, ing.product_id);
        return { line_no: ing.line_no, text: text, product_id: ing.product_id, status: 'ok', qty_base: b.qty_base, unit: b.unit, in_stock: have, missing: round(Math.max(0, b.qty_base - have)), optional: ing.optional === true || ing.optional === 'TRUE' };
      });
    return { recipe_id: recipeId, recipe_name: recipe.name, persons: p, lines: lines };
  }

  // -------------------------------------------------------- Einkaufsliste
  /**
   * Berechnet die Einkaufsliste aus bestätigten Planeinträgen (nicht gekocht).
   * Bestand wird je Produkt EINMAL gegengerechnet. Packungen werden aufgerundet, wenn bestätigt.
   * Manuelle Positionen/Overrides aus existingItems bleiben erhalten.
   */
  function computeShoppingList(store, weekStart, existingItems) {
    var need = {}, unclear = [], origins = {};
    var entries = store.tables.MealPlanEntry.filter(function (e) { return e.week_start === weekStart && e.status === 'bestätigt' && e.recipe_id; });
    entries.forEach(function (e) {
      var pv = previewCook(store, e.recipe_id, e.persons);
      pv.lines.forEach(function (l) {
        if (l.status === 'ok') {
          need[l.product_id] = round((need[l.product_id] || 0) + l.qty_base);
          (origins[l.product_id] = origins[l.product_id] || []).push(e.date + ' ' + pv.recipe_name);
        } else if (l.status === 'unklar') {
          unclear.push({ text: l.text, reason: l.reason, origin: e.date + ' ' + pv.recipe_name, product_id: l.product_id || '' });
        }
      });
    });
    var items = [];
    Object.keys(need).forEach(function (pid) {
      var product = getProduct(store, pid);
      var have = totalStock(store, pid);
      var missing = round(Math.max(0, need[pid] - have));
      var it = { product_id: pid, text: product.name, department: product.category || 'Sonstiges', qty_needed: need[pid], qty_available: have, unit: product.base_unit, origin: 'Plan', origin_detail: origins[pid].join(', '), qty_to_buy: missing, packages: null, unclear_reason: '' };
      var pkg = getPackage(store, product.default_package_id);
      var content = packageContentBase(store, product, pkg);
      if (missing > EPS && content) { it.packages = Math.ceil(missing / content - EPS); it.qty_to_buy = round(it.packages * content); it.package_label = pkg.label; it.leftover_after_cooking = round(it.qty_to_buy - missing); }
      if (missing > EPS) items.push(it);
    });
    // Mindestbestände
    store.tables.MinStock.forEach(function (m) {
      if (need[m.product_id] !== undefined) return;
      var have = totalStock(store, m.product_id, m.location_id || null);
      var min = num(m.min_qty_base);
      if (min !== null && have < min - EPS) {
        var product = getProduct(store, m.product_id);
        items.push({ product_id: m.product_id, text: product.name, department: product.category || 'Sonstiges', qty_needed: min, qty_available: have, unit: product.base_unit, origin: 'Mindestbestand', qty_to_buy: round(min - have), unclear_reason: '' });
      }
    });
    unclear.forEach(function (u) { items.push({ product_id: u.product_id, text: u.text, department: 'Unklar', qty_needed: null, qty_available: null, qty_to_buy: null, unit: '', origin: 'Plan', origin_detail: u.origin, unclear_reason: u.reason }); });
    // manuelle Positionen & Overrides erhalten
    (existingItems || []).forEach(function (ex) {
      if (ex.origin === 'manuell') { items.push(ex); return; }
      var match = items.filter(function (i) { return i.product_id && i.product_id === ex.product_id && i.origin === ex.origin; })[0];
      if (match) {
        match.item_id = ex.item_id; match.checked = ex.checked; match.purchase_id = ex.purchase_id;
        if (ex.manual_override !== '' && ex.manual_override != null) { match.manual_override = ex.manual_override; match.qty_to_buy = num(ex.manual_override); }
      }
    });
    return items;
  }

  // ------------------------------------------------------------ Sprache
  var NUMWORDS = { ein: 1, eins: 1, eine: 1, einen: 1, einem: 1, einer: 1, zwei: 2, drei: 3, vier: 4, 'fünf': 5, fuenf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, 'zwölf': 12, zwoelf: 12, halbe: 0.5, halb: 0.5 };
  var MONTHS = { januar: 1, februar: 2, 'märz': 3, maerz: 3, april: 4, mai: 5, juni: 6, juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12 };

  /**
   * Zerlegt einen Satz in einzelne Bestandsaktionen. Bucht NICHTS.
   * Ergebnis je Aktion: {intent: add|set|remove|used_up|ambiguous, qty, unit, product_text, best_before, condition, needs_question}
   */
  function parseVoice(text, refDate, context) {
    var ref = refDate ? new Date(refDate) : new Date();
    var parts = String(text).replace(/\s+/g, ' ').split(/,|;|\bsowie\b|\bund\b(?=\s+(?:noch\s+)?(?:\d|ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|insgesamt|wir|es))/i);
    // Nebensätze ("…, haltbar bis …", "…, die noch gut aussieht") an die vorige Aussage anhängen
    var merged = [];
    parts.forEach(function (p) {
      var t = (p || '').trim();
      if (merged.length && /^(haltbar|mhd|bis\b|die\b|der\b|das\b|welche|offen|angebrochen|geöffnet)/i.test(t)) merged[merged.length - 1] += ', ' + t;
      else merged.push(t);
    });
    parts = merged;
    var out = [];
    parts.forEach(function (raw) {
      var s = raw.trim();
      if (!s) return;
      var lower = s.toLowerCase();
      var a = { raw: s, intent: null, qty: null, unit: '', product_text: '', best_before: '', condition: '', needs_question: null };
      // MHD
      var m = lower.match(/(?:haltbar bis|mhd|bis zum|bis)\s+(?:zum\s+)?(\d{1,2})\.\s*(\d{1,2}|[a-zäö]+)\.?\s*(\d{2,4})?/);
      if (m) {
        var day = Number(m[1]), mon = /\d/.test(m[2]) ? Number(m[2]) : MONTHS[m[2]];
        var yr = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : ref.getFullYear();
        if (mon) {
          if (!m[3]) { var cand = new Date(Date.UTC(yr, mon - 1, day)); if (cand < new Date(ref.getTime() - 60 * 864e5)) yr++; }
          a.best_before = yr + '-' + String(mon).padStart(2, '0') + '-' + String(day).padStart(2, '0');
        }
        lower = lower.replace(m[0], ' ');
      }
      if (/noch gut|sieht (noch )?gut aus/.test(lower)) { a.condition = 'gut'; lower = lower.replace(/,?\s*(die|der|das)?\s*(noch gut aussieht|sieht noch gut aus|noch gut)/, ' '); }
      if (/angebrochen|geöffnet|\boffen\b/.test(lower)) { a.opened = true; lower = lower.replace(/angebrochen|geöffnet|\boffen\b/g, ' '); }
      if (/aufgebraucht|leer|alle\b/.test(lower)) a.intent = 'used_up';
      else if (/insgesamt|genau|gesamt/.test(lower)) a.intent = 'set';
      else if (/gekauft|dazu|mehr|zusätzlich|neu/.test(lower)) a.intent = 'add';
      else if (/entnommen|verbraucht|weg|gegessen|weniger/.test(lower)) a.intent = 'remove';
      else if (/\bnoch\b|wir haben|haben/.test(lower)) { a.intent = 'ambiguous'; a.needs_question = 'Ist das der gesamte Bestand (setzen) oder zusätzlich (dazu)?'; }
      else a.intent = 'ambiguous';
      var ownKeyword = a.intent !== 'ambiguous' || /\bnoch\b|wir haben|haben/.test(lower);
      if (!ownKeyword && out.length) { a.intent = out[out.length - 1].intent; a.inherited_intent = true; }
      if (a.intent === 'ambiguous' && context === 'inventur') { a.intent = 'set'; a.needs_question = null; }
      if (a.intent !== 'ambiguous' && a.needs_question && /gesamte Bestand/.test(a.needs_question)) a.needs_question = null;
      if (a.intent === 'ambiguous' && !a.needs_question) a.needs_question = 'Ist das der gesamte Bestand (setzen) oder zusätzlich (dazu)?';
      var words = lower.replace(/[.,!?;:]/g, ' ').split(' ').filter(Boolean);
      var stop = { wir: 1, haben: 1, noch: 1, insgesamt: 1, genau: 1, gekauft: 1, entnommen: 1, verbraucht: 1, die: 1, der: 1, das: 1, und: 1, von: 1, sind: 1, ist: 1, es: 1, gibt: 1, im: 1, in: 1, aus: 1, dem: 1, den: 1, auch: 1, mehr: 1, dazu: 1, 'zusätzlich': 1, aufgebraucht: 1, leer: 1, alle: 1, weg: 1, gegessen: 1, 'kühlschrank': 1, 'tiefkühler': 1, keller: 1, vorratskeller: 1, gesamt: 1, neu: 1, weniger: 1, sieht: 1, gut: 1, aus_: 1 };
      var prod = [];
      words.forEach(function (w) {
        if (a.qty === null && /^\d+([.,]\d+)?$/.test(w)) { a.qty = Number(w.replace(',', '.')); return; }
        if (a.qty === null && NUMWORDS[w] !== undefined) { a.qty = NUMWORDS[w]; return; }
        if (!a.unit && UNIT_ALIASES[w]) { a.unit = UNIT_ALIASES[w]; return; }
        if (!stop[w]) prod.push(w);
      });
      a.product_text = prod.join(' ').trim();
      var loc = lower.match(/kühlschrank|tiefkühler|vorratskeller|keller/);
      if (loc) a.location_hint = loc[0];
      if (a.intent !== 'used_up' && a.qty === null && a.product_text) { a.needs_question = a.needs_question || 'Menge für „' + a.product_text + '“ fehlt'; }
      if (a.product_text) out.push(a);
    });
    return out;
  }

  // ------------------------------------------------------------- Zugang
  /** Zugriff nur für Besitzer oder ausdrücklich freigegebene Nutzer. */
  function isAllowed(store, email) {
    var e = String(email || '').toLowerCase();
    if (!e) return false;
    return store.tables.User.some(function (u) { return String(u.email).toLowerCase() === e && (u.role === 'owner' || u.status === 'freigegeben'); });
  }
  /** Zugangsanfrage: legt Eintrag "angefragt" an. Gibt zurück, ob der Besitzer benachrichtigt werden soll. */
  function requestAccess(store, email, name, now) {
    var e = String(email || '').toLowerCase();
    var ex = store.tables.User.filter(function (u) { return String(u.email).toLowerCase() === e; })[0];
    if (ex) return { status: ex.status, notify: false };
    store.tables.User.push({ email: e, name: name || '', role: 'member', status: 'angefragt', requested_at: now, decided_at: '', decided_by: '' });
    return { status: 'angefragt', notify: true };
  }
  function decideAccess(store, ownerEmail, email, approve, now) {
    var owner = store.tables.User.filter(function (u) { return u.role === 'owner' && String(u.email).toLowerCase() === String(ownerEmail).toLowerCase(); })[0];
    if (!owner) fail('FORBIDDEN', 'Nur der Besitzer darf freigeben');
    var u = store.tables.User.filter(function (x) { return String(x.email).toLowerCase() === String(email).toLowerCase(); })[0];
    if (!u) fail('USER', 'Keine Anfrage vorhanden');
    u.status = approve ? 'freigegeben' : 'abgelehnt'; u.decided_at = now; u.decided_by = owner.email;
    return { status: u.status };
  }

  /** Prüft, ob StockLot exakt der Summe des Journals entspricht (Nachvollziehbarkeit). */
  function verifyLedger(store) {
    var sums = {}, problems = [];
    store.tables.StockEvent.forEach(function (e) { sums[e.lot_id] = round((sums[e.lot_id] || 0) + num(e.delta_base)); });
    store.tables.StockLot.forEach(function (l) {
      var s = sums[l.lot_id] || 0;
      if (Math.abs(s - num(l.qty_base)) > 1e-6) problems.push({ lot_id: l.lot_id, lot: num(l.qty_base), journal: s });
      if (num(l.qty_base) < -EPS) problems.push({ lot_id: l.lot_id, negative: num(l.qty_base) });
    });
    return { ok: problems.length === 0, problems: problems };
  }

  return {
    isAllowed: isAllowed, requestAccess: requestAccess, decideAccess: decideAccess, verifyLedger: verifyLedger,
    SCHEMA: SCHEMA, DomainError: DomainError, newStore: newStore, makeIdGen: makeIdGen,
    normalizeName: normalizeName, resolveProduct: resolveProduct, normUnit: normUnit, toBase: toBase,
    totalStock: totalStock, lotsOf: lotsOf, fefoSort: fefoSort,
    Engine: Engine, previewCook: previewCook, computeShoppingList: computeShoppingList,
    receiptFingerprint: receiptFingerprint, parseVoice: parseVoice, stableHash: stableHash
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = EP;
