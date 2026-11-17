/* Nachbau der benötigten Google-Apps-Script-Dienste für lokale Tests von backend/Code.gs.
 * Bildet auch typische Tabellen-Eigenheiten nach: Ohne Textformat wandelt Google Sheets
 * „3“ in eine Zahl, „2026-11-18“ in ein Datum und „TRUE“ in einen Wahrheitswert um. */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function coerce(v) {
  if (typeof v !== 'string') return v;
  if (v === '') return '';
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^(TRUE|FALSE)$/i.test(v)) return v.toUpperCase() === 'TRUE';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(v + 'T00:00:00');
  return v;
}

class Sheet {
  constructor(name, header) { this.name = name; this.cells = header ? [header.slice()] : []; this.text = new Set(); this.stats = { clears: 0, writes: 0 }; }
  getLastRow() { return this.cells.length; }
  getLastColumn() { return this.cells.reduce((m, r) => Math.max(m, r.length), 0); }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  getRange(a, b, c, d) {
    if (typeof a === 'string') { const m = a.match(/^([A-Z])(\d+)$/); return new Range(this, Number(m[2]), m[1].charCodeAt(0) - 64, 1, 1); }
    return new Range(this, a, b, c || 1, d || 1);
  }
}
class Range {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) { const v = (this.sh.cells[this.r - 1 + i] || [])[this.c - 1 + j]; row.push(v === undefined ? '' : v); } out.push(row); }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setNumberFormat(f) { if (f === '@') for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sh.text.add((this.r + i) + ':' + (this.c + j)); return this; }
  setValues(vals) {
    if (vals.length !== this.nr || vals.some((r) => r.length !== this.nc)) throw new Error('Bereichsgröße passt nicht');
    this.sh.stats.writes++;
    vals.forEach((row, i) => row.forEach((v, j) => {
      const R = this.r - 1 + i, C = this.c - 1 + j;
      while (this.sh.cells.length <= R) this.sh.cells.push([]);
      this.sh.cells[R][C] = this.sh.text.has((R + 1) + ':' + (C + 1)) ? (v === null ? '' : String(v)) : coerce(v);
    }));
    return this;
  }
  clearContent() {
    this.sh.stats.clears++;
    for (let i = 0; i < this.nr; i++) { const row = this.sh.cells[this.r - 1 + i]; if (row) for (let j = 0; j < this.nc; j++) row[this.c - 1 + j] = ''; }
    // leere Endzeilen abschneiden (wie getLastRow)
    while (this.sh.cells.length && this.sh.cells[this.sh.cells.length - 1].every((v) => v === '' || v === undefined)) this.sh.cells.pop();
    return this;
  }
}
class Spreadsheet {
  constructor(id, env, schema) {
    this.id = id; this.sheets = {};
    this.sheets._Info = new Sheet('_Info', ['Umgebung', env]);
    Object.keys(schema).forEach((k) => { this.sheets[k] = new Sheet(k, schema[k]); });
  }
  getSheetByName(n) { return this.sheets[n] || null; }
}

/**
 * Erzeugt eine Testumgebung. Rückgabe: { ctx (globale Apps-Script-Funktionen), post(), spreadsheets, mails, fetches, props, setLockBusy }
 */
function create(opts) {
  opts = opts || {};
  const root = path.join(__dirname, '..');
  const code = fs.readFileSync(path.join(root, 'backend/Code.gs'), 'utf8');
  const OWNER = opts.owner || 'besitzer@example.org';
  const CLIENT = 'client-123.apps.googleusercontent.com';
  const tokens = Object.assign({
    'tok-besitzer': { email: OWNER, name: 'Manuel' },
    'tok-frau': { email: 'partnerin@example.org', name: 'Partnerin' },
    'tok-fremd': { email: 'fremd@example.org', name: 'Fremd' }
  }, opts.tokens || {});
  const spreadsheets = {}, opened = [], mails = [], fetches = [], logs = [];
  const props = new Map([['GOOGLE_CLIENT_ID', CLIENT]]);
  const cache = new Map();
  let lockBusy = false, lockHeld = false, openaiHandler = opts.openai || null, clock = opts.clock || null;

  const ctx = {
    console,
    SpreadsheetApp: {
      openById(id) { opened.push(id); if (!spreadsheets[id]) throw new Error('Keine Berechtigung für ' + id); return spreadsheets[id]; },
      flush() {}
    },
    LockService: { getScriptLock() { return { tryLock() { if (lockBusy || lockHeld) return false; lockHeld = true; return true; }, releaseLock() { lockHeld = false; } }; } },
    PropertiesService: { getScriptProperties() { return { getProperty: (k) => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => props.set(k, String(v)), deleteProperty: (k) => props.delete(k), getProperties: () => Object.fromEntries(props) }; } },
    CacheService: { getScriptCache() { return { get: (k) => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, v) }; } },
    Session: { getEffectiveUser() { return { getEmail: () => OWNER }; }, getScriptTimeZone() { return 'Europe/Berlin'; } },
    MailApp: { sendEmail(m) { mails.push(m); } },
    Logger: { log(s) { logs.push(s); } },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(s) { return { content: s, setMimeType() { return this; } }; }
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest(alg, s) { return Array.from(crypto.createHash('sha256').update(String(s)).digest()); },
      base64EncodeWebSafe(bytes) { return Buffer.from(bytes).toString('base64url'); },
      base64Decode(s) { return Array.from(Buffer.from(s, 'base64')); },
      getUuid() { return crypto.randomUUID(); },
      newBlob(bytes, mime, name) { return { bytes, mime, name, isBlob: true }; },
      formatDate(d, tz, f) {
        const p = (n) => String(n).padStart(2, '0');
        const s = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
        return f === 'yyyy-MM-dd' ? s : s + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
      }
    },
    UrlFetchApp: {
      fetch(url, o) {
        fetches.push({ url, o });
        if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
          const t = decodeURIComponent(url.split('id_token=')[1]);
          const nowSec = Math.floor(Date.now() / 1000);
          const base = tokens[t];
          if (!base) return resp(400, { error: 'invalid_token' });
          const p = Object.assign({ aud: CLIENT, iss: 'https://accounts.google.com', email_verified: 'true', exp: String(nowSec + 3000) }, base);
          return resp(200, p);
        }
        if (url.startsWith('https://api.openai.com')) {
          if (!openaiHandler) throw new Error('Netz nicht erreichbar');
          const r = openaiHandler(url, o);
          return resp(r.code || 200, r.body);
        }
        throw new Error('Unerwartete Adresse ' + url);
      }
    }
  };
  function resp(code, body) { const t = typeof body === 'string' ? body : JSON.stringify(body); return { getResponseCode: () => code, getContentText: () => t }; }
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'Code.gs' });
  if (clock) vm.runInContext('Date.now = ' + clock.toString(), ctx);

  const SCHEMA = vm.runInContext('EP.SCHEMA', ctx);
  const ids = vm.runInContext('TISCH_SHEETS', ctx);
  spreadsheets[ids.TEST] = new Spreadsheet(ids.TEST, 'TEST', SCHEMA);
  spreadsheets[ids.PROD] = new Spreadsheet(ids.PROD, 'PROD', SCHEMA);

  function post(body) {
    const out = ctx.doPost({ postData: { contents: JSON.stringify(body) } });
    return JSON.parse(out.content);
  }
  return {
    ctx, post, spreadsheets, ids, opened, mails, fetches, logs, props, cache, SCHEMA, CLIENT, OWNER,
    setLockBusy(v) { lockBusy = v; },
    setOpenAI(fn) { openaiHandler = fn; },
    sheet(env, name) { return spreadsheets[ids[env]].sheets[name]; }
  };
}

module.exports = { create, coerce };
