/* Tischlein – Apps-Script-Backend. AUTOMATISCH ERZEUGT aus core/domain.js + backend/server.js
 * (node tools/build-backend.js). Nicht von Hand ändern – Änderungen im Repository machen. */

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
    Recipe: ['recipe_id', 'name', 'category', 'servings_base', 'minutes', 'steps', 'source_url', 'favorite', 'disliked', 'repeat_every_days', 'notes', 'version', 'updated_at', 'image_url'],
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
  /** Tabellen, die über upsert_rows/delete_rows geändert werden dürfen, mit Schlüsselspalten. Journal & Bestand nie. */
  var EDITABLE = {
    Recipe: ['recipe_id'], RecipeIngredient: ['recipe_id', 'line_no'], MealPlan: ['week_start'], MealPlanEntry: ['entry_id'],
    ShoppingItem: ['item_id'], Settings: ['key'], MinStock: ['product_id', 'location_id']
  };

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

  /**
   * IDs aus dem Idempotenzschlüssel abgeleitet: Vorschau im Browser und Buchung auf dem Server
   * erzeugen für denselben Vorgang dieselben IDs (nachvollziehbar, keine „Phantom“-IDs in der Anzeige).
   */
  function makeKeyedIdGen(key) {
    var alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ', n = 0;
    function mix(str, seed) {
      var h = seed >>> 0;
      for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
      return h >>> 0;
    }
    return function (prefix) {
      var t = String(key) + '#' + (++n), a = mix(t, 0x811c9dc5), b = mix(t, 0x9747b28c), s = '';
      for (var i = 0; i < 8; i++) { var v = i < 4 ? (a >>> (i * 8)) : (b >>> ((i - 4) * 8)); s += alphabet[v & 31]; }
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

  function pluralStem(n) { return n.replace(/(en|n|e|s)$/, '').replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u'); }

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
    // Einzahl/Mehrzahl ("Gurken" ↔ "Gurke", "Tomaten" ↔ "Tomate"): nur bei eindeutigem Treffer
    var stem = pluralStem(norm);
    var stemHits = products.filter(function (p) { return pluralStem(normalizeName(p.name)) === stem; });
    if (stem.length >= 3 && stemHits.length === 1) return { status: 'resolved', product_id: stemHits[0].product_id, package_id: null, via: 'plural' };
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
    this.keyedIds = !!(opts && opts.keyedIds);
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
    if (this.keyedIds) this.idGen = makeKeyedIdGen(ctx.idempotencyKey);
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
  function copyWith(o, patch) { var r = {}; Object.keys(o).forEach(function (k) { r[k] = o[k]; }); Object.keys(patch).forEach(function (k) { r[k] = patch[k]; }); return r; }
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
    // Ohne Packungsangabe, aber mit bestätigter Standardpackung: in ganze Packungen + angebrochenen Rest aufteilen.
    // Beispiel: 8 Patties (4er-Packung) = 2 Packungen; 6 Patties = 1 Packung + 2 Stück angebrochen.
    if (!p.package_id && !p.opened_at) {
      var prod = getProduct(work, p.product_id);
      var dpkg = prod && getPackage(work, prod.default_package_id);
      var cont = dpkg ? packageContentBase(work, prod, dpkg) : null;
      if (cont && cont > EPS) {
        var full = Math.floor((p.qty_base + EPS) / cont), rest = round(p.qty_base - full * cont), ev;
        if (full > 0) ev = receive(self, work, tx, copyWith(p, { package_id: dpkg.package_id, qty_base: round(full * cont) }), type, sourceRef, note);
        if (rest > EPS) ev = receive(self, work, tx, copyWith(p, { package_id: dpkg.package_id, qty_base: rest, opened_at: isoDate(tx.ts) }), type, sourceRef,
          (note ? note + ' · ' : '') + 'Teilpackung, als angebrochen erfasst');
        return ev;
      }
    }
    var bb = isoDate(p.best_before);
    var lot = null;
    if (p.opened_at && p.package_id) {
      // Rest zu einer bereits angebrochenen Packung desselben Orts legen, solange sie dadurch nicht voller als eine Packung wird
      var pr = getProduct(work, p.product_id), pc = packageContentBase(work, pr, getPackage(work, p.package_id));
      lot = work.tables.StockLot.filter(function (l) {
        return l.product_id === p.product_id && l.location_id === p.location_id && l.opened_at && l.package_id === p.package_id &&
          num(l.qty_base) > EPS && (!pc || num(l.qty_base) + p.qty_base <= pc + EPS);
      })[0] || null;
    }
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
        if (!lot.opened_at && num(lot.qty_base) > EPS && !content && product.base_unit !== 'Stk') {
          // Teilentnahme aus Charge ohne bekannte Packungsgröße (g/ml, z. B. Käse am Stück): als angebrochen markieren.
          // Lose Stückware (Äpfel, Zwiebeln) wird nie „angebrochen“.
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
    /** Mehrere Befehle als EINE atomare Transaktion (z. B. ein Sprachsatz mit mehreren Aktionen) */
    batch: function (work, c, tx) {
      var self = this;
      var results = (c.commands || []).map(function (cmd) {
        if (cmd.type === 'batch') fail('NESTED', 'Verschachtelte Stapel nicht erlaubt');
        var h = HANDLERS[cmd.type];
        if (!h) fail('UNKNOWN_COMMAND', 'Unbekannter Befehl: ' + cmd.type);
        return h.call(self, work, cmd, tx);
      });
      return { ok: true, results: results };
    },

    /** Neues Produkt im globalen Katalog */
    create_product: function (work, c, tx) {
      var name = String(c.name || '').trim();
      if (!name) fail('NAME', 'Produktname fehlt');
      var r = resolveProduct(work, name);
      if (r.status === 'resolved') fail('EXISTS', '„' + name + '“ gibt es schon', { product_id: r.product_id });
      if (['g', 'ml', 'Stk'].indexOf(c.base_unit) < 0) fail('UNIT', 'Basiseinheit muss g, ml oder Stk sein');
      var id = c.product_id || this.idGen('P');
      work.tables.Product.push({ product_id: id, name: name, category: c.category || 'Sonstiges', base_unit: c.base_unit, default_package_id: '', notes: '', active: true, created_at: tx.ts, updated_at: tx.ts });
      return { ok: true, product_id: id };
    },

    /** Neuer Lagerort */
    create_location: function (work, c, tx) {
      var name = String(c.name || '').trim();
      if (!name) fail('NAME', 'Name fehlt');
      if (work.tables.Location.some(function (l) { return normalizeName(l.name) === normalizeName(name); })) fail('EXISTS', 'Lagerort gibt es schon');
      var id = c.location_id || this.idGen('LO');
      work.tables.Location.push({ location_id: id, name: name, sort: work.tables.Location.length + 1, active: true });
      return { ok: true, location_id: id };
    },

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
        receive(self, work, tx, { product_id: ln.product_id, location_id: loc, qty_base: r.qty_base, package_id: r.package_id || ln.package_id, best_before: ln.best_before }, 'purchase', purchaseId, c.receipt_id ? 'Bon ' + c.receipt_id : c.source === 'liste' ? 'Einkaufsliste' : (c.source || 'Einkauf'));
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
      if (c.meal_plan_entry_id) {
        var found = false;
        work.tables.MealPlanEntry.forEach(function (e) { if (e.entry_id === c.meal_plan_entry_id) { e.status = 'gekocht'; e.updated_at = tx.ts; found = true; } });
        if (!found && c.meal_plan_entry) {
          var me = {}; SCHEMA.MealPlanEntry.forEach(function (col) { me[col] = c.meal_plan_entry[col] == null ? '' : c.meal_plan_entry[col]; });
          me.entry_id = c.meal_plan_entry_id; me.status = 'gekocht'; me.updated_at = tx.ts;
          work.tables.MealPlanEntry.push(me);
        }
      }
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

    /**
     * Planungs-, Rezept- und Listendaten (keine Bestandsbuchung!). Nur freigegebene Tabellen,
     * nur bekannte Spalten. Zeilen werden über ihren Schlüssel ersetzt oder neu angelegt.
     * Schutz: purchase_id einer Einkaufslisten-Position kann hier weder gesetzt noch gelöscht werden.
     */
    upsert_rows: function (work, c, tx) {
      var keys = EDITABLE[c.table];
      if (!keys) fail('TABLE', 'Tabelle ' + c.table + ' ist hierüber nicht änderbar');
      var cols = SCHEMA[c.table], n = 0;
      (c.rows || []).forEach(function (row) {
        keys.forEach(function (k) { if (row[k] === undefined || row[k] === null || row[k] === '') fail('KEY', 'Schlüssel ' + k + ' fehlt (' + c.table + ')'); });
        var clean = {};
        cols.forEach(function (col) { if (row[col] !== undefined) clean[col] = row[col] === null ? '' : row[col]; });
        if (cols.indexOf('updated_at') >= 0) clean.updated_at = tx.ts;
        var ex = work.tables[c.table].filter(function (r) { return keys.every(function (k) { return String(r[k]) === String(row[k]); }); })[0];
        if (c.table === 'ShoppingItem') { delete clean.purchase_id; }
        if (ex) { Object.keys(clean).forEach(function (col) { ex[col] = clean[col]; }); }
        else {
          var fresh = {}; cols.forEach(function (col) { fresh[col] = clean[col] !== undefined ? clean[col] : ''; });
          work.tables[c.table].push(fresh);
        }
        n++;
      });
      return { ok: true, table: c.table, upserted: n };
    },
    /** Löscht Zeilen (gleiche Freigabeliste). match: Liste von Feld=Wert-Objekten, z. B. [{ recipe_id: 'R-1' }]. */
    delete_rows: function (work, c, tx) {
      if (!EDITABLE[c.table]) fail('TABLE', 'Tabelle ' + c.table + ' ist hierüber nicht änderbar');
      var matches = c.match || [];
      if (!matches.length || matches.some(function (m) { return !m || !Object.keys(m).length; })) fail('MATCH', 'Löschbedingung fehlt');
      var before = work.tables[c.table].length;
      work.tables[c.table] = work.tables[c.table].filter(function (r) {
        return !matches.some(function (m) { return Object.keys(m).every(function (k) { return String(r[k]) === String(m[k]); }); });
      });
      return { ok: true, table: c.table, deleted: before - work.tables[c.table].length };
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
  function computeShoppingList(store, weekStart, existingItems, fromDate) {
    var need = {}, unclear = [], origins = {};
    var entries = store.tables.MealPlanEntry.filter(function (e) { return e.week_start === weekStart && e.status === 'bestätigt' && e.recipe_id && (!fromDate || e.date >= fromDate); });
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
      else if (missing > EPS && product.base_unit === 'Stk' && Math.abs(missing - Math.round(missing)) > EPS) { it.qty_to_buy = Math.ceil(missing - EPS); it.leftover_after_cooking = round(it.qty_to_buy - missing); }
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

  // ------------------------------------------------------- Rezeptzutaten (Import)
  var RECIPE_UNITS = {
    el: 'EL', 'eßl': 'EL', 'essl': 'EL', 'esslöffel': 'EL', 'eßlöffel': 'EL', tl: 'TL', 'teel': 'TL', 'teelöffel': 'TL',
    prise: 'Prise', prisen: 'Prise', msp: 'Msp', messerspitze: 'Msp', bund: 'Bund', zehe: 'Zehe', zehen: 'Zehe',
    scheibe: 'Scheibe', scheiben: 'Scheibe', tasse: 'Tasse', tassen: 'Tasse', handvoll: 'Handvoll', schuss: 'Schuss', spritzer: 'Schuss',
    'päckchen': 'Pkg', 'pkt': 'Pkg', beutel: 'Pkg', knolle: 'Knolle', stange: 'Stange', stangen: 'Stange', zweig: 'Zweig', zweige: 'Zweig',
    blatt: 'Blatt', 'blätter': 'Blatt', tropfen: 'Tropfen', 'würfel': 'Würfel', kopf: 'Kopf'
  };
  var FRACTIONS = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 };
  /**
   * Zerlegt eine Zutatenzeile („2 Zehen Knoblauch, fein gehackt“) in Menge, Einheit, Zutat, Hinweis.
   * Erfindet nichts: ohne erkennbare Menge ist qty null („Salz und Pfeffer“).
   */
  function parseIngredientLine(line) {
    var orig = String(line || '').replace(/\s+/g, ' ').trim();
    var s = orig.replace(/^[-•*·]\s*/, '');
    var out = { text: orig, qty: null, unit: '', name: '', note: '', optional: false, range: '' };
    if (/\b(optional|nach belieben|nach geschmack|n\.\s*b\.|evtl\.?|eventuell)\b/i.test(s)) out.optional = true;
    s = s.replace(/^(ca\.?|etwa|circa|gut|knapp)\s+/i, '');
    Object.keys(FRACTIONS).forEach(function (f) { s = s.replace(new RegExp('(\\d)\\s*' + f), function (m, d) { return String(Number(d) + FRACTIONS[f]); }).replace(f, String(FRACTIONS[f])); });
    var m = /^(\d+(?:[.,]\d+)?)(?:\s+(\d+)\/(\d+))?(?:\s*\/\s*(\d+))?(?:\s*[-–]\s*(\d+(?:[.,]\d+)?))?\s*/.exec(s);
    if (m) {
      var q = Number(m[1].replace(',', '.'));
      if (m[2]) q += Number(m[2]) / Number(m[3]);
      if (m[4]) q = q / Number(m[4]);
      if (m[5]) out.range = m[1] + '–' + m[5];
      out.qty = Math.round(q * 1000) / 1000;
      s = s.slice(m[0].length);
      var w = /^([A-Za-zÄÖÜäöüß]+\.?)(?=\s|$)/.exec(s);
      if (w) {
        var k = w[1].toLowerCase().replace(/\.$/, '');
        var u = RECIPE_UNITS[k] || (UNIT_ALIASES[k] && ['x', 'st'].indexOf(k) < 0 ? UNIT_ALIASES[k] : '');
        if (u) { out.unit = u; s = s.slice(w[0].length).trim(); }
      }
    }
    // Hinweise: Klammern und alles nach dem ersten Komma
    var notes = [];
    s = s.replace(/\(([^)]*)\)/g, function (all, inner) { if (/^(n|en|e|s|er)$/i.test(inner.trim())) return ''; notes.push(inner.trim()); return ''; });
    var c = s.indexOf(',');
    if (c >= 0) { notes.push(s.slice(c + 1).trim()); s = s.slice(0, c); }
    out.name = s.replace(/\s+/g, ' ').replace(/^(von|vom)\s+/i, '').trim();
    out.note = notes.filter(Boolean).join(', ');
    if (out.range) out.note = (out.note ? out.note + ', ' : '') + 'Angabe ' + out.range;
    if (!out.name) out.name = orig;
    return out;
  }
  /** ISO-8601-Dauer (PT1H20M) → Minuten, sonst null */
  function isoMinutes(d) {
    var m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i.exec(String(d || ''));
    if (!m || !(m[1] || m[2] || m[3])) return null;
    return (Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3] || 0);
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
    SCHEMA: SCHEMA, EDITABLE: EDITABLE, DomainError: DomainError, newStore: newStore, makeIdGen: makeIdGen, makeKeyedIdGen: makeKeyedIdGen,
    normalizeName: normalizeName, resolveProduct: resolveProduct, normUnit: normUnit, toBase: toBase,
    totalStock: totalStock, lotsOf: lotsOf, fefoSort: fefoSort,
    Engine: Engine, previewCook: previewCook, computeShoppingList: computeShoppingList,
    receiptFingerprint: receiptFingerprint, parseVoice: parseVoice, stableHash: stableHash, parseIngredientLine: parseIngredientLine, isoMinutes: isoMinutes
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = EP;


/* Tischlein – Backend für Google Apps Script.
 * Wird mit core/domain.js zu backend/Code.gs zusammengefügt (node tools/build-backend.js).
 * Läuft als Web-App „Ausführen als: ich“ im Konto des Besitzers. Enthält keine Geheimnisse:
 * OpenAI-Schlüssel und Google-Client-ID stehen in den Skripteigenschaften.
 *
 * Sicherheit
 *  - Schreibt ausschließlich in die zwei eigenen Tabellen unten und nur, wenn deren Blatt _Info!B1 = TEST/PROD ist.
 *  - Jede Anfrage braucht ein gültiges Google-ID-Token (Anmeldung mit Google), ausgestellt für unsere Client-ID.
 *  - Zugriff nur für den Besitzer und vom Besitzer freigegebene Personen.
 *  - Alle Änderungen laufen über die Fachlogik (EP.Engine) unter einer Sperre, mit Idempotenzschlüssel.
 */
var TISCH_VERSION = '1.1.0';
var TISCH_SHEETS = {
  TEST: '1CyqvAVa_wVgL0FzhebN372SBPn6N3RcbiglVgu8pym0',
  PROD: '1QF1rurB4iaa4ckmY7zY5QFc5un06YkoQNHLhgztrBcI'
};
var TISCH_APP_URL = 'https://manuelhankeai.github.io/einkaufsplaner/';
var TISCH_DEFAULTS = { OPENAI_TRANSCRIBE_MODEL: 'gpt-transcribe', OPENAI_TEXT_MODEL: 'gpt-6-luna' };
/** Tabellen, die nur wachsen (neue Zeilen werden angehängt statt Blatt neu zu schreiben). */
var TISCH_APPEND_ONLY = { StockEvent: 1, Transaction: 1, CookEvent: 1, Purchase: 1, PriceHistory: 1 };
var TISCH_NUM = {
  content_qty: 1, pieces: 1, factor: 1, sort: 1, qty_base: 1, delta_base: 1, qty_after: 1, min_qty_base: 1, servings_base: 1,
  minutes: 1, repeat_every_days: 1, version: 1, line_no: 1, qty: 1, persons: 1, qty_needed: 1, qty_available: 1, qty_to_buy: 1,
  manual_override: 1, total: 1, unit_price: 1, line_price: 1, discount: 1, deposit: 1, base_price: 1
};
var TISCH_BOOL = { active: 1, favorite: 1, disliked: 1, optional: 1, checked: 1 };

// ===================================================================== Einstieg
function doGet() {
  return tischJson({ ok: true, service: 'Tischlein', version: TISCH_VERSION });
}

function doPost(e) {
  var req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (x) { return tischJson({ ok: false, code: 'BAD_REQUEST', message: 'Anfrage nicht lesbar' }); }
  var t0 = Date.now(), out;
  try { out = tischHandle(req); }
  catch (err) { out = tischErrorOut(err); }
  out.ms = Date.now() - t0;
  return tischJson(out);
}

function tischJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function tischErrorOut(err) {
  if (err && err.name === 'DomainError') return { ok: false, code: err.code, message: err.message, details: err.details || null };
  if (err && err.tisch) return { ok: false, code: err.code, message: err.message };
  return { ok: false, code: 'SERVER', message: 'Interner Fehler: ' + (err && err.message ? err.message : String(err)) };
}
function tischFail(code, message) { var e = new Error(message); e.code = code; e.tisch = true; throw e; }

function tischProps() { return PropertiesService.getScriptProperties(); }
function tischProp(k) { var v = tischProps().getProperty(k); return v == null || v === '' ? (TISCH_DEFAULTS[k] || '') : v; }
function tischOwnerEmail() { return String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); }

// ===================================================================== Router
function tischHandle(req) {
  var env = req.env === 'PROD' ? 'PROD' : 'TEST';
  if (req.action === 'ping') return { ok: true, version: TISCH_VERSION };
  if (req.action === 'logout') { tischEndSession(req.session); return { ok: true }; }
  var session = null, who;
  if (req.action === 'login') {
    who = tischVerifyIdToken(req.idToken);
    session = tischStartSession(who);
    req.action = 'hello';
  } else who = tischSessionUser(req.session);
  var owner = tischOwnerEmail();
  var isOwner = who.email === owner;

  if (req.action === 'hello' || req.action === 'request_access') {
    return tischWithLock(function () {
      var db = tischLoad(env, ['User']);
      tischEnsureOwner(db, owner);
      var access = tischAccess(db, who.email, owner);
      var notify = false;
      if (req.action === 'request_access' && !access.allowed) {
        var r = EP.requestAccess(db.store, who.email, who.name, tischNow());
        notify = r.notify;
        access = tischAccess(db, who.email, owner);
      }
      tischSave(db);
      if (notify) tischMailOwner(owner, who, env);
      return { ok: true, env: env, email: who.email, name: who.name, status: access.status, allowed: access.allowed, owner: isOwner, mailed: notify, rev: tischRev(env), session: session };
    });
  }

  // Ab hier nur mit Freigabe. Zugang wird im selben Lesevorgang geprüft wie die eigentliche Aktion (eine Tabellenrunde).
  function gate(db) {
    tischEnsureOwner(db, owner);
    var a = tischAccess(db, who.email, owner);
    if (!a.allowed) tischFail('NO_ACCESS', a.status === 'abgelehnt' ? 'Zugang wurde abgelehnt' : a.status === 'angefragt' ? 'Zugang ist angefragt, aber noch nicht freigegeben' : 'Kein Zugang – bitte Zugang anfragen');
  }

  switch (req.action) {
    case 'bootstrap': {
      var db0 = tischLoad(env);
      gate(db0);
      var t = {};
      Object.keys(db0.store.tables).forEach(function (k) { if (k !== 'Transaction') t[k] = db0.store.tables[k]; });
      return { ok: true, env: env, tables: t, rev: tischRev(env), owner: isOwner, email: who.email, fast: !!tischFast() };
    }
    case 'exec': {
      if (!req.command || !req.key) tischFail('BAD_REQUEST', 'Befehl oder Schlüssel fehlt');
      return tischWithLock(function () {
        var db = tischLoad(env);
        gate(db);
        var eng = new EP.Engine(db.store, { now: tischNow, keyedIds: true });
        var result = eng.execute(req.command, { idempotencyKey: String(req.key), user: who.email });
        var changed = tischSave(db);
        var out = {};
        changed.forEach(function (k) { if (k !== 'Transaction' && k !== 'User') out[k] = db.store.tables[k]; });
        return { ok: true, result: result, tables: out, rev: tischRev(env), fast: !!tischFast() };
      });
    }
    case 'users': {
      if (!isOwner) tischFail('FORBIDDEN', 'Nur der Besitzer');
      var dbu = tischLoad(env, ['User']); tischEnsureOwner(dbu, owner);
      return { ok: true, users: dbu.store.tables.User };
    }
    case 'decide_access': {
      if (!isOwner) tischFail('FORBIDDEN', 'Nur der Besitzer darf freigeben');
      return tischWithLock(function () {
        var db = tischLoad(env, ['User']);
        tischEnsureOwner(db, owner);
        if (String(req.email).toLowerCase() === owner) tischFail('FORBIDDEN', 'Der Besitzer kann sich nicht selbst sperren');
        var r = EP.decideAccess(db.store, owner, req.email, !!req.approve, tischNow());
        tischSave(db);
        return { ok: true, status: r.status, users: db.store.tables.User };
      });
    }
    case 'ai_status': {
      gate(tischLoad(env, ['User']));
      return { ok: true, configured: !!tischProps().getProperty('OPENAI_API_KEY'), transcribe_model: tischProp('OPENAI_TRANSCRIBE_MODEL'), text_model: tischProp('OPENAI_TEXT_MODEL'), fast: !!tischFast() };
    }
    case 'transcribe':
    case 'interpret':
    case 'import_recipe': {
      var dba = tischLoad(env, ['User', 'Product', 'ProductAlias', 'PackageProfile', 'UnitConversion']);
      gate(dba);
      if (req.action === 'transcribe') return tischTranscribe(env, req, dba);
      if (req.action === 'interpret') return tischInterpret(env, req, dba);
      return tischImportRecipe(env, req, dba);
    }
    default:
      tischFail('UNKNOWN_ACTION', 'Unbekannte Aktion: ' + req.action);
  }
}

function tischWithLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) tischFail('BUSY', 'Gerade wird von einem anderen Gerät gespeichert. Bitte gleich nochmal versuchen – es wurde nichts gebucht.');
  try { return fn(); } finally { lock.releaseLock(); }
}
function tischNow() { return new Date().toISOString(); }
function tischRev(env) { return Number(tischProps().getProperty('REV_' + env) || 0); }

// ===================================================================== Anmeldung & Zugang
function tischVerifyIdToken(token) {
  if (!token) tischFail('AUTH', 'Bitte mit Google anmelden');
  var clientId = tischProps().getProperty('GOOGLE_CLIENT_ID');
  if (!clientId) tischFail('CONFIG', 'Skripteigenschaft GOOGLE_CLIENT_ID fehlt');
  var cache = CacheService.getScriptCache();
  var ck = 'tok_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)).slice(0, 40);
  var hit = cache.get(ck);
  if (hit) return JSON.parse(hit);
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) tischFail('AUTH', 'Anmeldung abgelaufen – bitte erneut anmelden');
  var p = JSON.parse(res.getContentText());
  var nowSec = Math.floor(Date.now() / 1000);
  if (p.aud !== clientId) tischFail('AUTH', 'Anmeldung gehört nicht zu dieser App');
  if (p.iss !== 'accounts.google.com' && p.iss !== 'https://accounts.google.com') tischFail('AUTH', 'Unbekannter Aussteller');
  if (String(p.email_verified) !== 'true') tischFail('AUTH', 'E-Mail-Adresse nicht bestätigt');
  if (Number(p.exp) < nowSec) tischFail('AUTH', 'Anmeldung abgelaufen – bitte erneut anmelden');
  var who = { email: String(p.email).toLowerCase(), name: p.name || p.given_name || '' };
  var ttl = Math.min(600, Number(p.exp) - nowSec);
  if (ttl > 30) cache.put(ck, JSON.stringify(who), ttl);
  return who;
}

// Gerätesitzung: nach EINER Google-Anmeldung 60 Tage gültig (verlängert sich bei Nutzung).
// Zugriff wird trotzdem bei jeder Anfrage gegen die Personentabelle geprüft (Sperre wirkt sofort).
var TISCH_SESSION_DAYS = 60;
function tischSessionKey(token) {
  return 'S_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token))).slice(0, 43);
}
function tischStartSession(who) {
  var p = tischProps(), nowMs = Date.now();
  var all = p.getProperties ? p.getProperties() : {};
  Object.keys(all).forEach(function (k) { if (k.indexOf('S_') === 0) { try { if (JSON.parse(all[k]).exp < nowMs) p.deleteProperty(k); } catch (e) { p.deleteProperty(k); } } });
  var token = Utilities.getUuid() + Utilities.getUuid();
  p.setProperty(tischSessionKey(token), JSON.stringify({ email: who.email, name: who.name, exp: nowMs + TISCH_SESSION_DAYS * 864e5 }));
  return token;
}
function tischSessionUser(token) {
  if (!token) tischFail('AUTH', 'Bitte mit Google anmelden');
  var p = tischProps(), key = tischSessionKey(token), raw = p.getProperty(key);
  if (!raw) tischFail('AUTH', 'Bitte erneut mit Google anmelden');
  var s = JSON.parse(raw), nowMs = Date.now();
  if (s.exp < nowMs) { p.deleteProperty(key); tischFail('AUTH', 'Anmeldung abgelaufen – bitte erneut mit Google anmelden'); }
  if (s.exp - nowMs < (TISCH_SESSION_DAYS - 7) * 864e5) { s.exp = nowMs + TISCH_SESSION_DAYS * 864e5; p.setProperty(key, JSON.stringify(s)); }
  return { email: String(s.email).toLowerCase(), name: s.name || '' };
}
function tischEndSession(token) { if (token) tischProps().deleteProperty(tischSessionKey(token)); }

function tischEnsureOwner(db, owner) {
  if (!owner) tischFail('CONFIG', 'Besitzer nicht ermittelbar');
  var U = db.store.tables.User;
  var ex = U.filter(function (u) { return String(u.email).toLowerCase() === owner; })[0];
  if (!ex) U.push({ email: owner, name: 'Besitzer', role: 'owner', status: 'freigegeben', requested_at: '', decided_at: tischNow(), decided_by: owner });
  else if (ex.role !== 'owner') { ex.role = 'owner'; ex.status = 'freigegeben'; }
}
function tischAccess(db, email, owner) {
  if (email === owner) return { allowed: true, status: 'besitzer' };
  var u = db.store.tables.User.filter(function (x) { return String(x.email).toLowerCase() === email; })[0];
  return { allowed: EP.isAllowed(db.store, email), status: u ? u.status : 'unbekannt' };
}
function tischMailOwner(owner, who, env) {
  try {
    MailApp.sendEmail({
      to: owner,
      subject: 'Tischlein: ' + (who.name || who.email) + ' möchte mitmachen',
      body: (who.name ? who.name + ' (' + who.email + ')' : who.email) + ' hat Zugang zu Tischlein beantragt (Datenbasis ' + env + ').\n\n' +
        'Freigeben oder ablehnen: ' + TISCH_APP_URL + '#settings\n\nOhne deine Freigabe sieht diese Person keine Daten.'
    });
  } catch (e) { /* Mailfehler darf die Anfrage nicht verhindern; Anfrage ist gespeichert. */ }
}

// ===================================================================== Tabellen lesen/schreiben
// Schneller Weg: Erweiterter Dienst „Google Sheets API“ (im Editor unter Dienste hinzufügen) –
// liest alle Blätter mit EINEM Aufruf und schreibt alle Änderungen mit EINEM Aufruf.
// Ohne den Dienst läuft der langsamere Weg über SpreadsheetApp (Blatt für Blatt).
function tischFast() { return typeof Sheets !== 'undefined' && Sheets.Spreadsheets && Sheets.Spreadsheets.Values; }

function tischOpen(env) {
  var id = TISCH_SHEETS[env];
  if (!id) tischFail('CONFIG', 'Unbekannte Umgebung');
  var ss = SpreadsheetApp.openById(id);
  var info = ss.getSheetByName('_Info');
  var mark = info ? String(info.getRange('B1').getValue()).trim() : '';
  if (mark !== env) tischFail('SAFETY', 'Sicherheitsstopp: Tabelle ist nicht als ' + env + ' gekennzeichnet');
  return ss;
}

/** Lädt Tabellen in einen Store. Merkt sich die gelesenen Zellen, um nur Geändertes zu schreiben. */
function tischLoad(env, only) {
  var names = only || Object.keys(EP.SCHEMA);
  var id = TISCH_SHEETS[env];
  if (!id) tischFail('CONFIG', 'Unbekannte Umgebung');
  var grids = {}, ss = null, lastRow = {};
  if (tischFast()) {
    var res;
    try {
      res = Sheets.Spreadsheets.Values.batchGet(id, { ranges: ['_Info!B1'].concat(names), valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' });
    } catch (e) { tischFail('SCHEMA', 'Tabelle nicht lesbar (fehlt ein Blatt?): ' + e.message); }
    var vr = res.valueRanges || [];
    var mark = vr[0] && vr[0].values && vr[0].values[0] ? String(vr[0].values[0][0]).trim() : '';
    if (mark !== env) tischFail('SAFETY', 'Sicherheitsstopp: Tabelle ist nicht als ' + env + ' gekennzeichnet');
    names.forEach(function (n, i) { grids[n] = (vr[i + 1] && vr[i + 1].values) || []; });
  } else {
    ss = tischOpen(env);
    names.forEach(function (n) {
      var sh = ss.getSheetByName(n);
      if (!sh) tischFail('SCHEMA', 'Blatt ' + n + ' fehlt');
      grids[n] = sh.getDataRange().getValues();
    });
  }
  var store = EP.newStore(), raw = {};
  names.forEach(function (name) {
    var cols = EP.SCHEMA[name], values = grids[name];
    var head = (values[0] || []).map(function (h) { return String(h).trim(); });
    for (var i = 0; i < cols.length; i++) if (head[i] !== cols[i]) tischFail('SCHEMA', 'Blatt ' + name + ': Spalte ' + (i + 1) + ' muss „' + cols[i] + '“ heißen');
    var rows = [];
    for (var r = 1; r < values.length; r++) {
      var line = (values[r] || []).slice(0, cols.length);
      if (line.every(function (v) { return v === '' || v === null || v === undefined; })) continue;
      var obj = {};
      cols.forEach(function (c, j) { obj[c] = tischFromCell(c, line[j] === undefined ? '' : line[j]); });
      rows.push(obj);
    }
    store.tables[name] = rows;
    raw[name] = rows.map(function (o) { return tischToCells(cols, o); });
    lastRow[name] = Math.max(values.length, 1); // letzte belegte Zeile (1 = nur Kopfzeile)
  });
  return { env: env, id: id, ss: ss, store: store, raw: raw, lastRow: lastRow };
}

function tischFromCell(col, v) {
  if (Object.prototype.toString.call(v) === '[object Date]') v = Utilities.formatDate(v, Session.getScriptTimeZone(), (v.getHours() || v.getMinutes()) ? "yyyy-MM-dd'T'HH:mm:ss" : 'yyyy-MM-dd');
  if (typeof v === 'string') { var d = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v.trim()); if (d) v = d[3] + '-' + ('0' + d[2]).slice(-2) + '-' + ('0' + d[1]).slice(-2); }
  if (TISCH_NUM[col]) { if (v === '' || v === null) return null; var n = Number(String(v).replace(',', '.')); return isNaN(n) ? null : n; }
  if (TISCH_BOOL[col]) { if (v === true || String(v).toUpperCase() === 'TRUE') return true; if (v === false || String(v).toUpperCase() === 'FALSE') return false; return ''; }
  return v === null ? '' : String(v);
}
function tischToCell(col, v) {
  if (v === null || v === undefined) return '';
  if (TISCH_BOOL[col]) return v === true || v === 'TRUE' || v === 'true' ? 'TRUE' : v === '' ? '' : 'FALSE';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function tischToCells(cols, o) { return cols.map(function (c) { return tischToCell(c, o[c]); }); }
function tischColLetter(n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

/** Schreibt geänderte Tabellen (Journal nur anhängen). Rückgabe: Namen der geänderten Tabellen. Erhöht die Revision. */
function tischSave(db) {
  var changed = [], data = [];
  Object.keys(db.raw).forEach(function (name) {
    var cols = EP.SCHEMA[name];
    var now = db.store.tables[name].map(function (o) { return tischToCells(cols, o); });
    var before = db.raw[name];
    if (JSON.stringify(now) === JSON.stringify(before)) return;
    var appendOnly = TISCH_APPEND_ONLY[name] && now.length >= before.length && JSON.stringify(now.slice(0, before.length)) === JSON.stringify(before);
    var start, rows;
    if (appendOnly) {
      rows = now.slice(before.length);
      start = db.lastRow[name] + 1; // hinter der letzten belegten Zeile, nie überschreiben
    } else {
      // ganze Tabelle neu: alte Zeilen bis zur bisher letzten belegten Zeile mit Leerzellen überschreiben
      rows = now.slice();
      var clearTo = db.lastRow[name] - 1;
      while (rows.length < clearTo) rows.push(cols.map(function () { return ''; }));
      start = 2;
    }
    if (rows.length) data.push({ name: name, start: start, rows: rows, cols: cols.length });
    db.raw[name] = now;
    db.lastRow[name] = appendOnly ? db.lastRow[name] + rows.length : Math.max(now.length + 1, 1);
    changed.push(name);
  });
  if (!changed.length) return changed;
  if (tischFast()) {
    Sheets.Spreadsheets.Values.batchUpdate({
      valueInputOption: 'RAW',
      data: data.map(function (d) { return { range: d.name + '!A' + d.start + ':' + tischColLetter(d.cols) + (d.start + d.rows.length - 1), values: d.rows }; })
    }, db.id);
  } else {
    var ss = db.ss || tischOpen(db.env);
    data.forEach(function (d) {
      var rng = ss.getSheetByName(d.name).getRange(d.start, 1, d.rows.length, d.cols);
      rng.setNumberFormat('@'); rng.setValues(d.rows);
    });
    SpreadsheetApp.flush();
  }
  var p = tischProps(); p.setProperty('REV_' + db.env, String(Number(p.getProperty('REV_' + db.env) || 0) + 1));
  return changed;
}

// ===================================================================== OpenAI
function tischOpenAI(path, options) {
  var key = tischProps().getProperty('OPENAI_API_KEY');
  if (!key) tischFail('AI_OFF', 'KI ist nicht eingerichtet (OPENAI_API_KEY fehlt)');
  options.headers = options.headers || {};
  options.headers.Authorization = 'Bearer ' + key;
  options.muteHttpExceptions = true;
  var res;
  try { res = UrlFetchApp.fetch('https://api.openai.com' + path, options); }
  catch (e) { tischFail('AI_NET', 'KI-Dienst nicht erreichbar: ' + e.message); }
  var code = res.getResponseCode(), text = res.getContentText();
  var body; try { body = JSON.parse(text); } catch (e) { body = null; }
  if (code !== 200) tischFail('AI_ERROR', 'KI-Dienst meldet ' + code + ': ' + (body && body.error && body.error.message ? body.error.message : text.slice(0, 200)));
  return body;
}

function tischTranscribe(env, req, db) {
  if (!req.audio) tischFail('BAD_REQUEST', 'Keine Aufnahme');
  var bytes = Utilities.base64Decode(req.audio);
  if (bytes.length > 10 * 1024 * 1024) tischFail('TOO_BIG', 'Aufnahme zu lang');
  var mime = String(req.mime || 'audio/mp4').split(';')[0];
  var ext = /webm/.test(mime) ? 'webm' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : /mpeg|mp3/.test(mime) ? 'mp3' : 'm4a';
  var blob = Utilities.newBlob(bytes, mime, 'diktat.' + ext);
  // Produktnamen als Hinweis verbessern die Erkennung (z. B. „Maasdamer“)
  var names = (db || tischLoad(env, ['Product'])).store.tables.Product.map(function (p) { return p.name; }).slice(0, 120).join(', ');
  var body = tischOpenAI('/v1/audio/transcriptions', {
    method: 'post',
    payload: { file: blob, model: tischProp('OPENAI_TRANSCRIBE_MODEL'), language: 'de', response_format: 'json', prompt: 'Einkauf und Vorrat einer Familie. Produkte: ' + names }
  });
  return { ok: true, text: String((body && body.text) || '').trim(), model: tischProp('OPENAI_TRANSCRIBE_MODEL') };
}

var TISCH_ACTION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['actions'],
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['raw', 'intent', 'product_text', 'qty', 'unit', 'location', 'best_before', 'condition', 'opened', 'question'],
        properties: {
          raw: { type: 'string', description: 'Der Satzteil des Nutzers, auf den sich diese Aktion bezieht, wörtlich' },
          intent: { type: 'string', enum: ['add', 'remove', 'set', 'used_up', 'ambiguous'] },
          product_text: { type: 'string', description: 'Produkt wie genannt, ohne Menge/Einheit' },
          qty: { type: ['number', 'null'] },
          unit: { type: ['string', 'null'], enum: ['Stk', 'g', 'kg', 'ml', 'l', 'Pkg', null] },
          location: { type: ['string', 'null'], enum: ['kühlschrank', 'tiefkühler', 'vorratskeller', null] },
          best_before: { type: ['string', 'null'], description: 'MHD als JJJJ-MM-TT, nur wenn genannt' },
          condition: { type: ['string', 'null'] },
          opened: { type: 'boolean' },
          question: { type: ['string', 'null'], description: 'Kurze Rückfrage, wenn Absicht oder Menge unklar ist' }
        }
      }
    }
  }
};

function tischInterpret(env, req, db0) {
  var text = String(req.text || '').trim();
  if (!text) tischFail('BAD_REQUEST', 'Kein Text');
  var db = db0 || tischLoad(env, ['Product']);
  var names = db.store.tables.Product.map(function (p) { return p.name; }).slice(0, 200).join(', ');
  var today = String(req.today || tischNow()).slice(0, 10);
  var sys = 'Du zerlegst gesprochene Sätze einer Familie über ihren Lebensmittelvorrat in einzelne Aktionen. Heute ist ' + today + '. ' +
    'intent: add = zusätzlich (gekauft, dazu), remove = entnommen/verbraucht, set = Gesamtbestand („insgesamt“, „wir haben noch genau“), ' +
    'used_up = aufgebraucht/leer, ambiguous = nicht eindeutig (z. B. „wir haben noch drei“ ohne „insgesamt“ oder „dazu“) – dann question setzen. ' +
    (req.mode === 'inventur' ? 'Es läuft eine Inventur: Mengenangaben ohne Zusatz bedeuten den Gesamtbestand (set). ' : '') +
    (req.mode === 'liste' ? 'Es geht um die Einkaufsliste: intent ist dann add. ' : '') +
    'Erfinde nichts: fehlt eine Menge, ist qty null. Keine Lagerorte, Daten oder Mengen raten. Jahr beim MHD ergänzen, wenn nur Tag/Monat genannt. ' +
    'Bekannte Produkte des Haushalts (für die Schreibweise): ' + names;
  var body = tischOpenAI('/v1/responses', {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({
      model: tischProp('OPENAI_TEXT_MODEL'),
      input: [{ role: 'system', content: sys }, { role: 'user', content: text }],
      text: { format: { type: 'json_schema', name: 'vorratsaktionen', strict: true, schema: TISCH_ACTION_SCHEMA } }
    })
  });
  var out = tischOutputText(body);
  var parsed; try { parsed = JSON.parse(out); } catch (e) { tischFail('AI_ERROR', 'KI-Antwort nicht lesbar'); }
  var acts = (parsed.actions || []).filter(function (a) { return a && a.product_text; }).map(function (a) {
    var amb = a.intent === 'ambiguous';
    return {
      raw: a.raw || a.product_text, intent: a.intent, qty: typeof a.qty === 'number' ? a.qty : null, unit: a.unit || '',
      product_text: a.product_text, best_before: /^\d{4}-\d{2}-\d{2}$/.test(a.best_before || '') ? a.best_before : '',
      condition: a.condition || '', opened: !!a.opened, location_hint: a.location || '',
      needs_question: amb ? (a.question || 'Ist das der gesamte Bestand (setzen) oder zusätzlich (dazu)?') : (a.qty === null && a.intent !== 'used_up' ? (a.question || 'Menge für „' + a.product_text + '“ fehlt') : null)
    };
  });
  return { ok: true, actions: acts, model: tischProp('OPENAI_TEXT_MODEL'), usage: body.usage || null };
}
function tischOutputText(body) {
  if (body && typeof body.output_text === 'string') return body.output_text;
  var parts = [];
  ((body && body.output) || []).forEach(function (item) {
    (item.content || []).forEach(function (c) { if (c.type === 'output_text' && c.text) parts.push(c.text); if (c.type === 'refusal') tischFail('AI_ERROR', 'KI hat abgelehnt'); });
  });
  if (!parts.length) tischFail('AI_ERROR', 'KI-Antwort leer');
  return parts.join('');
}

// ===================================================================== Rezept-Import
/**
 * Rezept aus Link (oder eingefügtem Text) holen und zur PRÜFUNG zurückgeben – speichert nichts.
 * 1) strukturierte Rezeptdaten der Seite (schema.org/Recipe als JSON-LD, z. B. Chefkoch)
 * 2) sonst KI (falls eingerichtet) aus dem Seitentext
 * Zutaten: KI zerlegt Mengen/Einheiten (falls eingerichtet), sonst Regeln; Zuordnung zu Produkten über den Namensabgleich.
 */
function tischImportRecipe(env, req, db) {
  var url = String(req.url || '').trim(), text = String(req.text || '').trim(), raw = null, source = '';
  if (url) {
    if (!/^https?:\/\/[^\s]+$/i.test(url)) tischFail('BAD_REQUEST', 'Bitte einen vollständigen Link (https://…) angeben');
    var res;
    try { res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': 'Mozilla/5.0 (Tischlein Rezeptimport)', 'Accept-Language': 'de-DE,de;q=0.9' } }); }
    catch (e) { tischFail('FETCH', 'Seite nicht erreichbar: ' + e.message); }
    if (res.getResponseCode() >= 400) tischFail('FETCH', 'Seite meldet Fehler ' + res.getResponseCode());
    var html = res.getContentText().slice(0, 3000000);
    raw = tischRecipeFromJsonLd(html);
    if (raw) source = 'Rezeptdaten der Seite';
    else if (tischProps().getProperty('OPENAI_API_KEY')) { raw = tischRecipeFromAI(tischHtmlToText(html), db); source = 'KI aus dem Seitentext'; }
    else tischFail('NO_RECIPE', 'Auf der Seite stehen keine lesbaren Rezeptdaten. Mit eingerichteter KI kann ich den Text auswerten.');
  } else if (text) {
    if (tischProps().getProperty('OPENAI_API_KEY')) { raw = tischRecipeFromAI(text.slice(0, 20000), db); source = 'KI aus dem Text'; }
    else {
      var lines = text.split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean);
      raw = { name: lines[0] || 'Neues Rezept', ingredients: lines.slice(1), steps: [], servings: null, minutes: null, image: '', category: '' };
      source = 'Text (erste Zeile = Name, Rest = Zutaten)';
    }
  } else tischFail('BAD_REQUEST', 'Link oder Text fehlt');
  if (!raw || !raw.name || !(raw.ingredients || []).length) tischFail('NO_RECIPE', 'Kein Rezept mit Zutaten erkannt');

  var parsed = null;
  if (tischProps().getProperty('OPENAI_API_KEY')) { try { parsed = tischIngredientsAI(raw.ingredients, db); } catch (e) { parsed = null; } }
  if (!parsed) parsed = raw.ingredients.map(function (l) { return EP.parseIngredientLine(l); });

  var ings = parsed.map(function (x, i) {
    var r = EP.resolveProduct(db.store, x.name);
    var pid = r.status === 'resolved' ? r.product_id : '';
    var unit = x.unit || '';
    if (pid && !unit && x.qty != null) unit = tischBaseUnit(db, pid);
    var conv = pid && x.qty != null ? EP.toBase(db.store, pid, x.qty, unit || tischBaseUnit(db, pid)) : null;
    return {
      line_no: i + 1, text_original: x.text || raw.ingredients[i], name: x.name, qty: x.qty, unit: unit, note: x.note || '', optional: !!x.optional,
      product_id: pid, candidates: r.status === 'suggestion' ? r.candidates.slice(0, 4) : [],
      check: !pid ? 'Produkt zuordnen' : x.qty == null ? 'ohne Menge – wird beim Kochen nicht abgebucht' : conv && !conv.ok ? conv.reason : ''
    };
  });
  return { ok: true, source: source, recipe: {
    name: String(raw.name).trim().slice(0, 120), servings: raw.servings || null, minutes: raw.minutes || null,
    steps: (raw.steps || []).join('\n'), source_url: url, image_url: raw.image || '', category: raw.category || ''
  }, ingredients: ings };
}
function tischBaseUnit(db, pid) { var p = db.store.tables.Product.filter(function (x) { return x.product_id === pid; })[0]; return p ? p.base_unit : ''; }

function tischRecipeFromJsonLd(html) {
  var re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, m, found = null;
  function walk(o) {
    if (!o || found) return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (typeof o !== 'object') return;
    var t = o['@type']; if (Array.isArray(t) ? t.indexOf('Recipe') >= 0 : t === 'Recipe') { found = o; return; }
    if (o['@graph']) walk(o['@graph']);
  }
  while ((m = re.exec(html)) && !found) { try { walk(JSON.parse(m[1].trim())); } catch (e) { /* ungültiges JSON auf der Seite überspringen */ } }
  if (!found) return null;
  function str(v) { return v == null ? '' : tischDecode(String(v)).replace(/\s+/g, ' ').trim(); }
  var steps = [];
  (function addSteps(v) {
    if (!v) return;
    if (typeof v === 'string') { v.split(/\n+/).forEach(function (x) { if (str(x)) steps.push(str(x)); }); return; }
    if (Array.isArray(v)) { v.forEach(addSteps); return; }
    if (v.itemListElement) { addSteps(v.itemListElement); return; }
    if (v.text) steps.push(str(v.text)); else if (v.name) steps.push(str(v.name));
  })(found.recipeInstructions);
  var y = found.recipeYield; if (Array.isArray(y)) y = y[0];
  var servings = y != null ? Number((String(y).match(/\d+/) || [])[0]) || null : null;
  var minutes = EP.isoMinutes(found.totalTime) || ((EP.isoMinutes(found.prepTime) || 0) + (EP.isoMinutes(found.cookTime) || 0)) || null;
  var img = found.image; if (Array.isArray(img)) img = img[0]; if (img && typeof img === 'object') img = img.url || img.contentUrl;
  var cat = found.recipeCategory; if (Array.isArray(cat)) cat = cat[0];
  return {
    name: str(found.name), servings: servings, minutes: minutes, steps: steps,
    ingredients: [].concat(found.recipeIngredient || found.ingredients || []).map(str).filter(Boolean),
    image: /^https:\/\//.test(String(img || '')) ? String(img) : '', category: str(cat)
  };
}
function tischDecode(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, function (a, n) { return String.fromCharCode(Number(n)); });
}
function tischHtmlToText(html) {
  return tischDecode(html.replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')).replace(/\s+/g, ' ').trim().slice(0, 15000);
}

var TISCH_RECIPE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['name', 'servings', 'minutes', 'ingredients', 'steps', 'category'],
  properties: {
    name: { type: 'string' }, servings: { type: ['number', 'null'] }, minutes: { type: ['number', 'null'] },
    ingredients: { type: 'array', items: { type: 'string' }, description: 'Zutatenzeilen wörtlich wie im Rezept, inklusive Menge und Einheit' },
    steps: { type: 'array', items: { type: 'string' } }, category: { type: ['string', 'null'] }
  }
};
function tischRecipeFromAI(text, db) {
  var body = tischOpenAI('/v1/responses', { method: 'post', contentType: 'application/json', payload: JSON.stringify({
    model: tischProp('OPENAI_TEXT_MODEL'),
    input: [{ role: 'system', content: 'Lies aus dem Text genau EIN Rezept aus. Übernimm Zutaten und Schritte wörtlich, erfinde nichts. Fehlende Angaben sind null bzw. leer. Wenn kein Rezept enthalten ist, gib name leer zurück.' }, { role: 'user', content: text }],
    text: { format: { type: 'json_schema', name: 'rezept', strict: true, schema: TISCH_RECIPE_SCHEMA } }
  }) });
  var r = JSON.parse(tischOutputText(body));
  if (!r.name) return null;
  return { name: r.name, servings: r.servings, minutes: r.minutes, ingredients: r.ingredients || [], steps: r.steps || [], image: '', category: r.category || '' };
}

var TISCH_ING_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'qty', 'unit', 'name', 'note', 'optional'], properties: {
    text: { type: 'string' }, qty: { type: ['number', 'null'] },
    unit: { type: ['string', 'null'], enum: ['g', 'kg', 'ml', 'l', 'Stk', 'Pkg', 'EL', 'TL', 'Prise', 'Msp', 'Bund', 'Zehe', 'Scheibe', 'Tasse', 'Handvoll', 'Schuss', 'Knolle', 'Stange', 'Zweig', 'Blatt', 'Würfel', 'Kopf', null] },
    name: { type: 'string', description: 'Lebensmittel wie man es einkauft, Einzahl, ohne Zubereitungshinweis' }, note: { type: ['string', 'null'] }, optional: { type: 'boolean' }
  } } } }
};
function tischIngredientsAI(lines, db) {
  var names = db.store.tables.Product.map(function (p) { return p.name; }).slice(0, 200).join(', ');
  var body = tischOpenAI('/v1/responses', { method: 'post', contentType: 'application/json', payload: JSON.stringify({
    model: tischProp('OPENAI_TEXT_MODEL'),
    input: [{ role: 'system', content: 'Zerlege jede Zutatenzeile in Menge, Einheit, Lebensmittel und Hinweis. Genau ein Eintrag je Zeile, gleiche Reihenfolge, text = Originalzeile. ' +
      'Keine Menge erfinden: „Salz“, „etwas Öl“ → qty null. Bei Spannen („2–3“) die kleinere Zahl und die Spanne als Hinweis. Dose/Becher/Päckchen/Glas → Pkg. ' +
      'Verwende für name möglichst die Schreibweise dieser Haushaltsprodukte, wenn es dasselbe Lebensmittel ist: ' + names }, { role: 'user', content: lines.join('\n') }],
    text: { format: { type: 'json_schema', name: 'zutaten', strict: true, schema: TISCH_ING_SCHEMA } }
  }) });
  var items = JSON.parse(tischOutputText(body)).items || [];
  if (items.length !== lines.length) return null; // Zuordnung Zeile↔Ergebnis nicht sicher → Regeln verwenden
  return items.map(function (x, i) { return { text: lines[i], qty: typeof x.qty === 'number' ? x.qty : null, unit: x.unit || '', name: x.name || lines[i], note: x.note || '', optional: !!x.optional }; });
}

// ===================================================================== Einrichtung (einmal im Editor ausführen)
/** Prüft Tabellen, Besitzer und Skripteigenschaften und schreibt einen Bericht ins Protokoll. Ändert keine Daten. */
function einrichtungPruefen() {
  var log = [];
  log.push('Besitzer (Ausführen als): ' + tischOwnerEmail());
  ['TEST', 'PROD'].forEach(function (env) {
    try { var db = tischLoad(env); log.push(env + ': OK, ' + Object.keys(db.store.tables).length + ' Tabellen, ' + db.store.tables.Product.length + ' Produkte, ' + db.store.tables.User.length + ' Personen'); }
    catch (e) { log.push(env + ': FEHLER ' + e.message); }
  });
  var p = tischProps();
  log.push('GOOGLE_CLIENT_ID: ' + (p.getProperty('GOOGLE_CLIENT_ID') ? 'gesetzt' : 'FEHLT'));
  log.push('OPENAI_API_KEY: ' + (p.getProperty('OPENAI_API_KEY') ? 'gesetzt' : 'nicht gesetzt (KI aus)'));
  log.push('Modelle: ' + tischProp('OPENAI_TRANSCRIBE_MODEL') + ' / ' + tischProp('OPENAI_TEXT_MODEL'));
  log.push('Schneller Tabellenzugriff (Dienst „Google Sheets API“): ' + (tischFast() ? 'aktiv' : 'NICHT aktiv – im Editor links bei „Dienste“ hinzufügen'));
  Logger.log(log.join('\n'));
  return log;
}

/** Testet die OpenAI-Verbindung mit einem kurzen Satz (kostet Bruchteile eines Cents). */
function kiTesten() {
  var r = tischInterpret('TEST', { text: 'Wir haben drei Äpfel gekauft und die Milch ist leer', today: tischNow() });
  Logger.log(JSON.stringify(r, null, 1));
  return r;
}
