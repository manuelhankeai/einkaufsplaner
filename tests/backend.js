/* Tests für backend/Code.gs gegen nachgebaute Google-Dienste (tests/gas-mock.js).
 * Prüft: Anmeldung, Zugangsanfrage per Mail, Freigabe/Sperre, Schutz der Tabellen,
 * vollständigen Wochenlauf mit zwei Personen über die Tabellen (Hin- und Rückweg jeder Zelle),
 * Doppelklicks, Sperre, KI-Aufrufe. Start: node tests/backend.js  (vorher: node tools/build-backend.js)
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const GAS = require('./gas-mock.js');
const EP = require('../core/domain.js');

let pass = 0, failCount = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { failCount++; console.log('  ✗ ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e)); }
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, (msg || '') + ` – erwartet ${b}, ist ${a}`);

console.log('Backend (Apps Script) – Tests mit nachgebauten Google-Diensten\n');

const g = GAS.create();
/** Einmal mit Google anmelden → Gerätesitzung */
const login = (gg, tok) => { const r = gg.post({ action: 'login', env: 'TEST', idToken: tok }); assert.strictEqual(r.ok, true, JSON.stringify(r)); return r.session; };
let M, F, k = 0;
const ex = (tok, command, key) => g.post({ action: 'exec', session: tok, env: 'TEST', command, key: key || 'key-' + (++k) });
const ok = (r) => { assert.strictEqual(r.ok, true, JSON.stringify(r)); return r; };
/** Liest die Tabelle frisch aus den (nachgebauten) Google-Tabellen, wie es der Server tut */
const fresh = (env) => g.ctx.tischLoad(env || 'TEST').store.tables;

test('Code.gs enthält keine Tabellen-IDs der ChatGPT-Version und keine E-Mail-Adressen', () => {
  const code = fs.readFileSync(path.join(__dirname, '../backend/Code.gs'), 'utf8');
  ['1oBSRyAQ', '1Rp75S30', '1NBS-gz', '1X7jn9z5', 'einkaufsplaner-514913'].forEach((x) => assert.ok(!code.includes(x), x));
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(code.replace(/noreply@anthropic\.com/g, '')), 'keine E-Mail-Adresse im Code');
});

test('Ohne Anmeldung / mit fremder App / abgelaufen: kein Zugriff', () => {
  assert.strictEqual(g.post({ action: 'bootstrap', env: 'TEST' }).code, 'AUTH');
  assert.strictEqual(g.post({ action: 'login', env: 'TEST', idToken: 'gefälscht' }).code, 'AUTH');
  assert.strictEqual(g.post({ action: 'bootstrap', env: 'TEST', session: 'ausgedacht' }).code, 'AUTH');
  const g2 = GAS.create({ tokens: { 'tok-andere-app': { email: 'x@example.org', aud: 'andere-app' }, 'tok-alt': { email: 'y@example.org', exp: '1000' } } });
  assert.strictEqual(g2.post({ action: 'login', env: 'TEST', idToken: 'tok-andere-app' }).code, 'AUTH');
  assert.strictEqual(g2.post({ action: 'login', env: 'TEST', idToken: 'tok-alt' }).code, 'AUTH');
});

test('Besitzer meldet sich an → wird automatisch als Besitzer eingetragen', () => {
  M = login(g, 'tok-besitzer');
  const r = ok(g.post({ action: 'hello', env: 'TEST', session: M }));
  assert.strictEqual(r.allowed, true); assert.strictEqual(r.owner, true);
  const u = fresh().User; assert.strictEqual(u.length, 1); assert.strictEqual(u[0].role, 'owner');
});

test('Partnerin meldet sich an → sieht nichts, kann nichts buchen', () => {
  F = login(g, 'tok-frau');
  const r = ok(g.post({ action: 'hello', env: 'TEST', session: F }));
  assert.strictEqual(r.allowed, false); assert.strictEqual(r.status, 'unbekannt');
  assert.strictEqual(g.post({ action: 'bootstrap', env: 'TEST', session: F }).code, 'NO_ACCESS');
  assert.strictEqual(ex(F, { type: 'create_location', name: 'Hack' }).code, 'NO_ACCESS');
  assert.strictEqual(fresh().Location.length, 0, 'nichts geschrieben');
});

test('Zugang anfragen → genau EINE Mail an den Besitzer, weiterhin kein Zugriff', () => {
  const r = ok(g.post({ action: 'request_access', env: 'TEST', session: F }));
  assert.strictEqual(r.status, 'angefragt'); assert.strictEqual(r.allowed, false); assert.strictEqual(r.mailed, true);
  assert.strictEqual(g.mails.length, 1); assert.strictEqual(g.mails[0].to, g.OWNER);
  assert.ok(/partnerin@example\.org/.test(g.mails[0].body) && /#settings/.test(g.mails[0].body));
  ok(g.post({ action: 'request_access', env: 'TEST', session: F }));
  assert.strictEqual(g.mails.length, 1, 'keine zweite Mail bei erneutem Tippen');
  assert.strictEqual(g.post({ action: 'bootstrap', env: 'TEST', session: F }).code, 'NO_ACCESS');
});

test('Partnerin kann sich nicht selbst freigeben; Besitzer gibt frei → voller Zugriff', () => {
  const self = g.post({ action: 'decide_access', env: 'TEST', session: F, email: 'partnerin@example.org', approve: true });
  assert.strictEqual(self.ok, false); assert.ok(['NO_ACCESS', 'FORBIDDEN'].includes(self.code));
  assert.strictEqual(fresh().User.find((u) => u.email === 'partnerin@example.org').status, 'angefragt', 'Status unverändert');
  const list = ok(g.post({ action: 'users', env: 'TEST', session: M })).users;
  assert.ok(list.some((u) => u.email === 'partnerin@example.org' && u.status === 'angefragt'));
  ok(g.post({ action: 'decide_access', env: 'TEST', session: M, email: 'partnerin@example.org', approve: true }));
  const r = ok(g.post({ action: 'hello', env: 'TEST', session: F }));
  assert.strictEqual(r.allowed, true); assert.strictEqual(r.owner, false);
  ok(g.post({ action: 'bootstrap', env: 'TEST', session: F }));
  assert.strictEqual(g.post({ action: 'users', env: 'TEST', session: F }).code, 'FORBIDDEN', 'Mitnutzer sieht keine Personenverwaltung');
});

// ----------------------------------------------------------------- Wochenlauf über die Tabellen
// Dieselben Befehle laufen parallel gegen eine reine Speicher-Engine (Referenz).
const ref = EP.newStore();
const refEng = new EP.Engine(ref, {});
let rk = 0;
const refReceipt = {};
function both(tok, cmd, key) {
  const kk = key || 'w-' + (++rk);
  const r = ok(ex(tok, cmd, kk));
  const c2 = JSON.parse(JSON.stringify(cmd));
  if (c2.receipt_id) c2.receipt_id = refReceipt[c2.receipt_id];
  const rr = refEng.execute(c2, { idempotencyKey: kk, user: 'ref' });
  if (cmd.type === 'register_receipt') refReceipt[r.result.receipt_id] = rr.receipt_id;
  return r;
}
function same(label) {
  const s = { tables: fresh() };
  const v = EP.verifyLedger(s); assert.ok(v.ok, label + ': Journal ≠ Bestand ' + JSON.stringify(v.problems));
  const sum = (st) => { const m = {}; st.tables.StockLot.forEach((l) => { if (Number(l.qty_base) > 1e-9) { const key = l.product_id + '@' + l.location_id + (l.opened_at ? ' offen' : ''); m[key] = Math.round(((m[key] || 0) + Number(l.qty_base)) * 1000) / 1000; } }); return m; };
  assert.deepStrictEqual(sum(s), sum(ref), label + ': Bestand nach Tabellen-Rundweg weicht von Referenz ab');
}

test('Stammdaten über die App angelegt (Orte, Produkte, Packungen, Rezepte) – Zellen kommen unverändert zurück', () => {
  both(M, { type: 'batch', commands: [
    { type: 'create_location', location_id: 'KS', name: 'Kühlschrank' }, { type: 'create_location', location_id: 'TK', name: 'Tiefkühler' }, { type: 'create_location', location_id: 'VK', name: 'Vorratskeller' }] });
  [['P-PATTY', 'Chicken Patties', 'Tiefkühl', 'Stk', 4], ['P-BUN', 'Brioche Buns', 'Brot & Backwaren', 'Stk', 4], ['P-WURST', 'Wiener Würstchen', 'Vorrat', 'Stk', 6],
    ['P-MAUL', 'Maultaschen', 'Kühlregal', 'Stk', 6], ['P-MILCH', 'Milch', 'Kühlregal', 'ml', 1000], ['P-ZWIEBEL', 'Zwiebel', 'Obst & Gemüse', 'Stk', 0]].forEach(([id, name, cat, unit, pk]) => {
    both(M, { type: 'create_product', product_id: id, name, category: cat, base_unit: unit });
    if (pk) both(M, { type: 'confirm_package', product_id: id, label: 'Packung', content_qty: pk, content_unit: unit, make_default: true });
  });
  both(F, { type: 'batch', commands: [
    { type: 'upsert_rows', table: 'Recipe', rows: [{ recipe_id: 'R-BURGER', name: 'Chicken Burger', servings_base: 2, minutes: 15, favorite: true, disliked: false }, { recipe_id: 'R-MAUL', name: 'Maultaschen in Brühe', servings_base: 2, minutes: 15, favorite: false, disliked: false }] },
    { type: 'upsert_rows', table: 'RecipeIngredient', rows: [
      { recipe_id: 'R-BURGER', line_no: 1, product_id: 'P-PATTY', text_original: 'Chicken Patties', qty: 1, unit: 'Stk', per: 'Person', optional: false },
      { recipe_id: 'R-BURGER', line_no: 2, product_id: 'P-BUN', text_original: 'Brioche Buns', qty: 1, unit: 'Stk', per: 'Person', optional: false },
      { recipe_id: 'R-MAUL', line_no: 1, product_id: 'P-MAUL', text_original: 'Maultaschen', qty: 4, unit: 'Stk', per: 'Person', optional: false },
      { recipe_id: 'R-MAUL', line_no: 2, product_id: 'P-ZWIEBEL', text_original: 'Zwiebel', qty: 1, unit: 'Stk', per: 'Rezept', optional: false }] }] });
  const s = fresh();
  assert.strictEqual(s.Recipe.find((r) => r.recipe_id === 'R-BURGER').favorite, true, 'Wahrheitswert');
  assert.strictEqual(s.RecipeIngredient.find((r) => r.line_no === 1).qty, 1, 'Zahl');
  assert.strictEqual(typeof s.PackageProfile[0].confirmed_at, 'string', 'Zeitstempel bleibt Text');
  same('Stammdaten');
});

let receiptId;
test('Plan bestätigt, Bon gescannt (Partnerin), gleicher Bon vom Besitzer nochmal → Dublette', () => {
  both(M, { type: 'upsert_rows', table: 'MealPlanEntry', rows: [
    { entry_id: 'MP-2026-11-16', week_start: '2026-11-16', date: '2026-11-16', persons: 2, recipe_id: 'R-BURGER', status: 'bestätigt' },
    { entry_id: 'MP-2026-11-17', week_start: '2026-11-16', date: '2026-11-17', persons: 4, recipe_id: 'R-MAUL', status: 'bestätigt' }] });
  const s = fresh();
  assert.strictEqual(s.MealPlanEntry[0].date, '2026-11-16', 'Datum bleibt Text, kein Datumsobjekt');
  const list = EP.computeShoppingList({ tables: s }, '2026-11-16', [], '2026-11-16');
  assert.strictEqual(list.find((i) => i.product_id === 'P-MAUL').packages, 3);
  const bon = { type: 'register_receipt', market: 'PENNY', datetime: '2026-11-16T17:42', receipt_no: '4711', total: 15.73, file_sha256: 'abc',
    lines: [{ text_original: 'CHICKEN PATTIES', product_id: 'P-PATTY', qty: 1, unit: 'Pkg', line_price: 3.49 }, { text_original: 'MAULTASCHEN', product_id: 'P-MAUL', qty: 3, unit: 'Pkg', line_price: 5.97 }] };
  receiptId = both(F, bon).result.receipt_id;
  const dup = ok(ex(M, Object.assign({}, bon, { file_sha256: 'xyz' }))).result;
  assert.strictEqual(dup.duplicate_of, receiptId);
});

test('Bon buchen; Doppelklick und zweites Gerät mit gleichem Schlüssel buchen nicht doppelt', () => {
  const cmd = { type: 'purchase', source: 'bon', receipt_id: receiptId, date: '2026-11-16', market: 'PENNY', lines: [
    { product_id: 'P-PATTY', qty: 1, unit: 'Pkg', location_id: 'TK' }, { product_id: 'P-BUN', qty: 1, unit: 'Pkg', location_id: 'VK' },
    { product_id: 'P-MAUL', qty: 3, unit: 'Pkg', location_id: 'KS', best_before: '2026-11-24' }, { product_id: 'P-WURST', qty: 1, unit: 'Pkg', location_id: 'VK' },
    { product_id: 'P-ZWIEBEL', qty: 8, unit: 'Stk', location_id: 'VK' }, { product_id: 'P-MILCH', qty: 4, unit: 'Pkg', location_id: 'VK' }] };
  both(F, cmd, 'bon-buchen');
  const events = fresh().StockEvent.length;
  const again = ok(ex(F, cmd, 'bon-buchen'));
  assert.strictEqual(again.result.replayed, true);
  const other = ok(ex(M, cmd, 'bon-buchen'));
  assert.strictEqual(other.result.replayed, true);
  assert.strictEqual(fresh().StockEvent.length, events, 'keine neuen Buchungen');
  assert.strictEqual(ex(M, cmd, 'neuer-schluessel').code, 'ALREADY_BOOKED', 'neuer Klick auf denselben Bon wird abgewiesen');
  same('nach Einkauf');
});

test('Partnerin kocht Burger für 2 statt 4 → 1 Packung Patties geöffnet, 2 Stück „angebrochen“ in der Tabelle', () => {
  both(F, { type: 'cook', recipe_id: 'R-BURGER', persons: 2, meal_plan_entry_id: 'MP-2026-11-16', date: '2026-11-16' }, 'cook-mo');
  const lots = fresh().StockLot.filter((l) => l.product_id === 'P-PATTY' && l.qty_base > 0);
  assert.strictEqual(lots.length, 1); near(lots[0].qty_base, 2);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(lots[0].opened_at), 'Öffnungsdatum als Text');
  assert.strictEqual(fresh().MealPlanEntry.find((e) => e.entry_id === 'MP-2026-11-16').status, 'gekocht');
  same('nach Burger');
});

test('Besitzer kocht Maultaschen für 4 → 2 Stück Rest; Würstchen-Glas 2 entnommen → 4; „insgesamt 6 Patties“', () => {
  both(M, { type: 'cook', recipe_id: 'R-MAUL', persons: 4, meal_plan_entry_id: 'MP-2026-11-17', date: '2026-11-17' });
  both(F, { type: 'adjust', product_id: 'P-WURST', location_id: 'VK', qty: -2, unit: 'Stk' });
  both(M, { type: 'set_total', product_id: 'P-PATTY', location_id: 'TK', qty: 6, unit: 'Stk' });
  both(F, { type: 'adjust', product_id: 'P-MILCH', location_id: 'VK', qty: -250, unit: 'ml' });
  const s = fresh();
  near(EP.totalStock({ tables: s }, 'P-MAUL'), 2); near(EP.totalStock({ tables: s }, 'P-WURST'), 4);
  near(EP.totalStock({ tables: s }, 'P-PATTY'), 6); near(EP.totalStock({ tables: s }, 'P-ZWIEBEL'), 6);
  near(EP.totalStock({ tables: s }, 'P-MILCH'), 3750);
  same('nach Woche');
});

test('Inventur Kühlschrank (Partnerin): Maultaschen weg → 0, Tiefkühler/Keller unverändert', () => {
  both(F, { type: 'inventory', location_id: 'KS', mode: 'full', counts: [] });
  const s = { tables: fresh() };
  near(EP.totalStock(s, 'P-MAUL'), 0); near(EP.totalStock(s, 'P-PATTY'), 6); near(EP.totalStock(s, 'P-WURST'), 4);
  same('nach Inventur');
});

test('Einkaufsliste: Häkchen der Partnerin sieht der Besitzer; Einkaufs-ID lässt sich nicht überschreiben', () => {
  ok(ex(F, { type: 'upsert_rows', table: 'ShoppingItem', rows: [{ item_id: 'SI-M-1', week_start: '2026-11-16', product_id: '', text: 'Spülmittel', origin: 'manuell', checked: true, qty_to_buy: null }] }));
  const b = ok(g.post({ action: 'bootstrap', env: 'TEST', session: M }));
  const it = b.tables.ShoppingItem.find((i) => i.item_id === 'SI-M-1');
  assert.strictEqual(it.checked, true); assert.strictEqual(it.qty_to_buy, null, 'leere Menge bleibt leer (nicht 0)');
  assert.ok(!('Transaction' in b.tables), 'Protokoll-Interna gehen nicht an den Browser');
});

test('Journal wird nur angehängt (nie neu geschrieben), Bestandstabelle wird abgeglichen', () => {
  assert.strictEqual(g.sheet('TEST', 'StockEvent').stats.clears, 0);
  assert.strictEqual(g.sheet('TEST', 'Transaction').stats.clears, 0);
  const evRows = g.sheet('TEST', 'StockEvent').getLastRow() - 1;
  assert.strictEqual(evRows, fresh().StockEvent.length);
});

test('Leerzeile im Journal (von Hand eingefügt) → neue Buchung überschreibt nichts', () => {
  const sh = g.sheet('TEST', 'StockEvent');
  const n = sh.getLastRow();
  sh.cells.splice(3, 0, new Array(12).fill(''));          // Leerzeile mitten im Journal
  const snapshot = JSON.stringify(sh.cells.filter((r) => r.some((v) => v !== '')));
  ok(ex(M, { type: 'adjust', product_id: 'P-WURST', location_id: 'VK', qty: 1, unit: 'Stk' }));
  const after = sh.cells.filter((r) => r.some((v) => v !== ''));
  assert.strictEqual(JSON.stringify(after.slice(0, n)), snapshot, 'alte Zeilen unverändert');
  assert.strictEqual(after.length, n + 1);
  assert.ok(EP.verifyLedger({ tables: fresh() }).ok);
});

test('Gleichzeitiges Speichern: belegte Sperre → klare Meldung, nichts gebucht', () => {
  const before = fresh().StockEvent.length;
  g.setLockBusy(true);
  const r = ex(F, { type: 'adjust', product_id: 'P-WURST', location_id: 'VK', qty: -1, unit: 'Stk' }, 'busy-1');
  g.setLockBusy(false);
  assert.strictEqual(r.code, 'BUSY'); assert.strictEqual(fresh().StockEvent.length, before);
  ok(ex(F, { type: 'adjust', product_id: 'P-WURST', location_id: 'VK', qty: -1, unit: 'Stk' }, 'busy-1'));
  assert.strictEqual(fresh().StockEvent.length, before + 1, 'Wiederholung mit gleichem Schlüssel bucht genau einmal');
  refEng.execute({ type: 'adjust', product_id: 'P-WURST', location_id: 'VK', qty: -1, unit: 'Stk' }, { idempotencyKey: 'busy-1', user: 'ref' });
  refEng.execute({ type: 'adjust', product_id: 'P-WURST', location_id: 'VK', qty: 1, unit: 'Stk' }, { idempotencyKey: 'leer-1', user: 'ref' });
  same('nach Sperre');
});

test('Fehlerhafte Buchung (zu viel entnommen) → Fehlermeldung, Tabellen unverändert', () => {
  const snap = JSON.stringify(g.spreadsheets[g.ids.TEST].sheets.StockLot.cells);
  const r = ex(M, { type: 'adjust', product_id: 'P-WURST', location_id: 'VK', qty: -50, unit: 'Stk' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(JSON.stringify(g.spreadsheets[g.ids.TEST].sheets.StockLot.cells), snap);
});

test('Von Hand in die Tabelle getipptes Datum/Zahl wird korrekt gelesen', () => {
  const sh = g.sheet('TEST', 'StockLot');
  const row = sh.cells.findIndex((r, i) => i > 0 && r[1] === 'P-WURST' && Number(r[3]) > 0);
  sh.cells[row][5] = new Date('2027-03-01T00:00:00'); // best_before als echtes Datum
  sh.cells[row][3] = Number(sh.cells[row][3]);         // Menge als echte Zahl
  const lot = fresh().StockLot.find((l) => l.lot_id === sh.cells[row][0]);
  assert.strictEqual(lot.best_before, '2027-03-01'); assert.strictEqual(typeof lot.qty_base, 'number');
});

test('Besitzer sperrt Partnerin → sofort kein Zugriff mehr; Besitzer kann sich nicht selbst sperren', () => {
  ok(g.post({ action: 'decide_access', env: 'TEST', session: M, email: 'partnerin@example.org', approve: false }));
  assert.strictEqual(g.post({ action: 'bootstrap', env: 'TEST', session: F }).code, 'NO_ACCESS');
  assert.strictEqual(g.post({ action: 'decide_access', env: 'TEST', session: M, email: g.OWNER, approve: false }).code, 'FORBIDDEN');
  ok(g.post({ action: 'decide_access', env: 'TEST', session: M, email: 'partnerin@example.org', approve: true }));
  ok(g.post({ action: 'bootstrap', env: 'TEST', session: F }));
});

test('TEST und PROD sind getrennt: Freigabe in TEST gilt nicht für PROD', () => {
  assert.strictEqual(g.post({ action: 'bootstrap', env: 'PROD', session: F }).code, 'NO_ACCESS');
  ok(g.post({ action: 'bootstrap', env: 'PROD', session: M }));
  assert.strictEqual(fresh('PROD').StockEvent.length, 0, 'PROD bleibt leer');
});

test('Sicherheitsstopp: falsch gekennzeichnete Tabelle wird nicht beschrieben; nur die zwei eigenen IDs werden geöffnet', () => {
  const info = g.sheet('PROD', '_Info');
  info.cells[0][1] = 'ANDERS';
  const r = g.post({ action: 'exec', env: 'PROD', session: M, command: { type: 'create_location', name: 'X' }, key: 'safe-1' });
  assert.strictEqual(r.code, 'SAFETY');
  info.cells[0][1] = 'PROD';
  assert.ok(g.opened.every((id) => id === g.ids.TEST || id === g.ids.PROD));
});

test('Falsche Spalten in einem Blatt → klarer Fehler statt Fehlbuchung', () => {
  const g3 = GAS.create();
  g3.sheet('TEST', 'StockLot').cells[0][3] = 'menge';
  const r3 = g3.post({ action: 'login', env: 'TEST', idToken: 'tok-besitzer' });
  assert.strictEqual(g3.post({ action: 'bootstrap', env: 'TEST', session: r3.session }).code, 'SCHEMA');
});

// ----------------------------------------------------------------- KI
test('KI ohne Schlüssel → klare Meldung „nicht eingerichtet“', () => {
  const r = ok(g.post({ action: 'ai_status', env: 'TEST', session: F }));
  assert.strictEqual(r.configured, false);
  assert.strictEqual(g.post({ action: 'interpret', env: 'TEST', session: F, text: 'drei Äpfel' }).code, 'AI_OFF');
});

test('Diktat: Aufnahme geht als Datei an OpenAI (Modell, Sprache de, Produktnamen als Hinweis)', () => {
  g.props.set('OPENAI_API_KEY', 'sk-test');
  let seen;
  g.setOpenAI((url, o) => { seen = { url, o }; return { body: { text: ' Drei Patties gekauft. ' } }; });
  const r = ok(g.post({ action: 'transcribe', env: 'TEST', session: F, audio: Buffer.from('fake-audio').toString('base64'), mime: 'audio/mp4' }));
  assert.strictEqual(r.text, 'Drei Patties gekauft.');
  assert.strictEqual(seen.url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.strictEqual(seen.o.headers.Authorization, 'Bearer sk-test');
  assert.strictEqual(seen.o.payload.model, 'gpt-transcribe'); assert.strictEqual(seen.o.payload.language, 'de');
  assert.ok(seen.o.payload.file.isBlob && seen.o.payload.file.name === 'diktat.m4a');
  assert.ok(/Chicken Patties/.test(seen.o.payload.prompt));
});

test('Freier Satz → strukturierte Aktionen (strenges JSON-Schema), nichts wird gebucht', () => {
  let body;
  g.setOpenAI((url, o) => {
    body = JSON.parse(o.payload);
    return { body: { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ actions: [
      { raw: 'drei Äpfel gekauft', intent: 'add', product_text: 'Äpfel', qty: 3, unit: 'Stk', location: null, best_before: null, condition: null, opened: false, question: null },
      { raw: 'Maasdamer bis 15. Oktober', intent: 'ambiguous', product_text: 'Maasdamer', qty: null, unit: null, location: 'kühlschrank', best_before: '2027-10-15', condition: null, opened: false, question: 'Wie viel Maasdamer?' }] }) }] }], usage: { input_tokens: 900, output_tokens: 120 } } };
  });
  const before = fresh().StockEvent.length;
  const r = ok(g.post({ action: 'interpret', env: 'TEST', session: F, text: 'drei Äpfel gekauft und Maasdamer bis 15. Oktober', today: '2026-11-18' }));
  assert.strictEqual(body.model, 'gpt-6-luna');
  assert.strictEqual(body.text.format.type, 'json_schema'); assert.strictEqual(body.text.format.strict, true);
  assert.ok(body.input[0].content.includes('Wiener Würstchen'), 'Produktliste als Kontext');
  assert.strictEqual(r.actions.length, 2);
  assert.deepStrictEqual([r.actions[0].intent, r.actions[0].qty, r.actions[0].product_text], ['add', 3, 'Äpfel']);
  assert.strictEqual(r.actions[1].needs_question, 'Wie viel Maasdamer?');
  assert.strictEqual(r.actions[1].location_hint, 'kühlschrank');
  assert.strictEqual(fresh().StockEvent.length, before, 'KI bucht nie selbst');
});

test('KI-Fehler (falscher Schlüssel / kein Netz) → eindeutige Meldung, kein falscher Erfolg', () => {
  g.setOpenAI(() => ({ code: 401, body: { error: { message: 'Incorrect API key provided' } } }));
  const r = g.post({ action: 'interpret', env: 'TEST', session: F, text: 'zwei Gurken' });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'AI_ERROR'); assert.ok(/401/.test(r.message));
  g.setOpenAI(null);
  assert.strictEqual(g.post({ action: 'transcribe', env: 'TEST', session: F, audio: 'AAAA', mime: 'audio/webm' }).code, 'AI_NET');
});

test('Einrichtungsprüfung im Editor meldet alles Nötige', () => {
  const log = g.ctx.einrichtungPruefen().join('\n');
  assert.ok(/TEST: OK/.test(log) && /PROD: OK/.test(log) && /GOOGLE_CLIENT_ID: gesetzt/.test(log));
});

test('Gerätesitzung: bleibt nach der Google-Stunde gültig, Abmelden beendet sie, Sitzung verrät keinen Schlüssel', () => {
  const S = login(g, 'tok-frau');
  assert.ok(S.length >= 64);
  assert.ok(![...g.props.keys()].some((key) => key.includes(S)), 'Sitzung nur als Prüfsumme gespeichert');
  ok(g.post({ action: 'bootstrap', env: 'TEST', session: S }));
  ok(g.post({ action: 'logout', env: 'TEST', session: S }));
  assert.strictEqual(g.post({ action: 'bootstrap', env: 'TEST', session: S }).code, 'AUTH');
});

test('Abgelaufene Sitzung (nach 60 Tagen ohne Nutzung) → erneut anmelden', () => {
  const S = login(g, 'tok-frau');
  const key = [...g.props.keys()].filter((x) => x.startsWith('S_')).pop();
  const v = JSON.parse(g.props.get(key)); v.exp = Date.now() - 1000; g.props.set(key, JSON.stringify(v));
  assert.strictEqual(g.post({ action: 'bootstrap', env: 'TEST', session: S }).code, 'AUTH');
});

console.log(`\n${pass} bestanden, ${failCount} fehlgeschlagen`);
process.exit(failCount ? 1 : 0);
