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
