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
var TISCH_VERSION = '1.0.0';
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
  try { return tischJson(tischHandle(req)); }
  catch (err) { return tischJson(tischErrorOut(err)); }
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

  // Ab hier nur mit Freigabe
  var gate = tischWithLock(function () { var db = tischLoad(env, ['User']); tischEnsureOwner(db, owner); tischSave(db); return tischAccess(db, who.email, owner); });
  if (!gate.allowed) tischFail('NO_ACCESS', gate.status === 'abgelehnt' ? 'Zugang wurde abgelehnt' : gate.status === 'angefragt' ? 'Zugang ist angefragt, aber noch nicht freigegeben' : 'Kein Zugang – bitte Zugang anfragen');

  switch (req.action) {
    case 'bootstrap': {
      var db0 = tischLoad(env);
      var t = {};
      Object.keys(db0.store.tables).forEach(function (k) { if (k !== 'Transaction') t[k] = db0.store.tables[k]; });
      return { ok: true, env: env, tables: t, rev: tischRev(env), owner: isOwner, email: who.email };
    }
    case 'exec': {
      if (!req.command || !req.key) tischFail('BAD_REQUEST', 'Befehl oder Schlüssel fehlt');
      return tischWithLock(function () {
        var db = tischLoad(env);
        var eng = new EP.Engine(db.store, { now: tischNow });
        var result = eng.execute(req.command, { idempotencyKey: String(req.key), user: who.email });
        var changed = tischSave(db);
        var out = {};
        changed.forEach(function (k) { if (k !== 'Transaction') out[k] = db.store.tables[k]; });
        return { ok: true, result: result, tables: out, rev: tischRev(env) };
      });
    }
    case 'users': {
      if (!isOwner) tischFail('FORBIDDEN', 'Nur der Besitzer');
      return { ok: true, users: tischLoad(env, ['User']).store.tables.User };
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
    case 'ai_status':
      return { ok: true, configured: !!tischProps().getProperty('OPENAI_API_KEY'), transcribe_model: tischProp('OPENAI_TRANSCRIBE_MODEL'), text_model: tischProp('OPENAI_TEXT_MODEL') };
    case 'transcribe':
      return tischTranscribe(env, req);
    case 'interpret':
      return tischInterpret(env, req);
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
function tischOpen(env) {
  var id = TISCH_SHEETS[env];
  if (!id) tischFail('CONFIG', 'Unbekannte Umgebung');
  var ss = SpreadsheetApp.openById(id);
  var info = ss.getSheetByName('_Info');
  var mark = info ? String(info.getRange('B1').getValue()).trim() : '';
  if (mark !== env) tischFail('SAFETY', 'Sicherheitsstopp: Tabelle ist nicht als ' + env + ' gekennzeichnet');
  return ss;
}

/** Lädt alle Tabellen in einen Store. Merkt sich die gelesenen Zellen, um nur Geändertes zu schreiben. */
function tischLoad(env, only) {
  var ss = tischOpen(env);
  var store = EP.newStore(), raw = {};
  (only || Object.keys(EP.SCHEMA)).forEach(function (name) {
    var cols = EP.SCHEMA[name];
    var sh = ss.getSheetByName(name);
    if (!sh) tischFail('SCHEMA', 'Blatt ' + name + ' fehlt');
    var values = sh.getDataRange().getValues();
    var head = (values[0] || []).map(function (h) { return String(h).trim(); });
    for (var i = 0; i < cols.length; i++) if (head[i] !== cols[i]) tischFail('SCHEMA', 'Blatt ' + name + ': Spalte ' + (i + 1) + ' muss „' + cols[i] + '“ heißen');
    var rows = [];
    for (var r = 1; r < values.length; r++) {
      var line = values[r].slice(0, cols.length);
      if (line.every(function (v) { return v === '' || v === null; })) continue;
      var obj = {};
      cols.forEach(function (c, j) { obj[c] = tischFromCell(c, line[j]); });
      rows.push(obj);
    }
    store.tables[name] = rows;
    raw[name] = rows.map(function (o) { return tischToCells(cols, o); });
  });
  return { env: env, ss: ss, store: store, raw: raw };
}

function tischFromCell(col, v) {
  if (Object.prototype.toString.call(v) === '[object Date]') v = Utilities.formatDate(v, Session.getScriptTimeZone(), (v.getHours() || v.getMinutes()) ? "yyyy-MM-dd'T'HH:mm:ss" : 'yyyy-MM-dd');
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

/** Schreibt geänderte Tabellen. Rückgabe: Namen der geänderten Tabellen. Erhöht die Revision. */
function tischSave(db) {
  var changed = [];
  Object.keys(db.raw).forEach(function (name) {
    var cols = EP.SCHEMA[name];
    var now = db.store.tables[name].map(function (o) { return tischToCells(cols, o); });
    var before = db.raw[name];
    if (JSON.stringify(now) === JSON.stringify(before)) return;
    var sh = db.ss.getSheetByName(name);
    var prefixSame = TISCH_APPEND_ONLY[name] && now.length >= before.length &&
      JSON.stringify(now.slice(0, before.length)) === JSON.stringify(before);
    if (prefixSame) {
      var add = now.slice(before.length);
      var rng = sh.getRange(before.length + 2, 1, add.length, cols.length);
      rng.setNumberFormat('@'); rng.setValues(add);
    } else {
      var last = sh.getLastRow();
      if (last > 1) sh.getRange(2, 1, last - 1, Math.max(cols.length, sh.getLastColumn())).clearContent();
      if (now.length) { var r2 = sh.getRange(2, 1, now.length, cols.length); r2.setNumberFormat('@'); r2.setValues(now); }
    }
    db.raw[name] = now;
    changed.push(name);
  });
  if (changed.length) {
    SpreadsheetApp.flush();
    var p = tischProps(); p.setProperty('REV_' + db.env, String(Number(p.getProperty('REV_' + db.env) || 0) + 1));
  }
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

function tischTranscribe(env, req) {
  if (!req.audio) tischFail('BAD_REQUEST', 'Keine Aufnahme');
  var bytes = Utilities.base64Decode(req.audio);
  if (bytes.length > 10 * 1024 * 1024) tischFail('TOO_BIG', 'Aufnahme zu lang');
  var mime = String(req.mime || 'audio/mp4').split(';')[0];
  var ext = /webm/.test(mime) ? 'webm' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : /mpeg|mp3/.test(mime) ? 'mp3' : 'm4a';
  var blob = Utilities.newBlob(bytes, mime, 'diktat.' + ext);
  // Produktnamen als Hinweis verbessern die Erkennung (z. B. „Maasdamer“)
  var names = tischLoad(env, ['Product']).store.tables.Product.map(function (p) { return p.name; }).slice(0, 120).join(', ');
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

function tischInterpret(env, req) {
  var text = String(req.text || '').trim();
  if (!text) tischFail('BAD_REQUEST', 'Kein Text');
  var db = tischLoad(env, ['Product']);
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
  Logger.log(log.join('\n'));
  return log;
}

/** Testet die OpenAI-Verbindung mit einem kurzen Satz (kostet Bruchteile eines Cents). */
function kiTesten() {
  var r = tischInterpret('TEST', { text: 'Wir haben drei Äpfel gekauft und die Milch ist leer', today: tischNow() });
  Logger.log(JSON.stringify(r, null, 1));
  return r;
}
