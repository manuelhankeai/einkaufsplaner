/* Automatisierte Tests der Fachlogik – deckt die 15 Fehlerfälle aus der Übergabe ab.
 * Start: node tests/run.js
 * Nutzt ausschließlich Beispieldaten im Speicher, kein Google-Zugriff. */
'use strict';
const EP = require('../core/domain.js');
const assert = require('assert');

let pass = 0, failCount = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { failCount++; console.log('  ✗ ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e)); }
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, (msg || '') + ` erwartet ${b}, ist ${a}`);

let clock = 0;
function fixture() {
  const s = EP.newStore();
  const T = s.tables;
  T.Location.push({ location_id: 'KS', name: 'Kühlschrank', sort: 1 }, { location_id: 'TK', name: 'Tiefkühler', sort: 2 }, { location_id: 'VK', name: 'Vorratskeller', sort: 3 });
  const P = (id, name, cat, unit) => T.Product.push({ product_id: id, name, category: cat, base_unit: unit, default_package_id: '', active: true });
  P('P-MILCH', 'Milch', 'Kühlregal', 'ml');
  P('P-PATTY', 'Chicken Patties', 'Tiefkühl', 'Stk');
  P('P-BUN', 'Brioche Buns', 'Brot & Backwaren', 'Stk');
  P('P-MAUL', 'Maultaschen', 'Kühlregal', 'Stk');
  P('P-PIZZA', 'Pizza', 'Tiefkühl', 'Stk');
  P('P-KUCHEN', 'Kuchen', 'Brot & Backwaren', 'Stk');
  P('P-MAAS', 'Maasdamer', 'Kühlregal', 'g');
  P('P-KAESE', 'Käsestück', 'Kühlregal', 'g');
  P('P-GURKE', 'Gurke', 'Obst & Gemüse', 'Stk');
  P('P-SALAT', 'Salat', 'Obst & Gemüse', 'Stk');
  const now = () => new Date(Date.UTC(2026, 10, 17, 18, 0, clock++)).toISOString();
  let n = 0;
  const idGen = (p) => p + '-' + String(++n).padStart(5, '0');
  const eng = new EP.Engine(s, { now, idGen });
  let k = 0;
  const run = (cmd, key, user) => eng.execute(cmd, { idempotencyKey: key || 'k' + (++k), user: user || 'manuel' });
  // bestätigte Packungsprofile
  run({ type: 'confirm_package', product_id: 'P-MILCH', label: '1-l-Packung', content_qty: 1, content_unit: 'l' });
  run({ type: 'confirm_package', product_id: 'P-PATTY', label: 'Packung', content_qty: 4, content_unit: 'Stk' });
  run({ type: 'confirm_package', product_id: 'P-BUN', label: 'Beutel', content_qty: 4, content_unit: 'Stk' });
  run({ type: 'confirm_package', product_id: 'P-MAUL', label: 'Packung', content_qty: 6, content_unit: 'Stk' });
  run({ type: 'confirm_package', product_id: 'P-PIZZA', label: 'Doppelpackung', content_qty: 2, content_unit: 'Stk' });
  run({ type: 'confirm_package', product_id: 'P-KUCHEN', label: 'Kuchen (8 Stücke)', content_qty: 8, content_unit: 'Stk', pieces: 8 });
  run({ type: 'confirm_package', product_id: 'P-MAAS', label: 'Stück 400 g', content_qty: 400, content_unit: 'g' });
  // Rezepte
  T.Recipe.push({ recipe_id: 'R-BURGER', name: 'Chicken Burger', servings_base: 2, minutes: 15 });
  T.RecipeIngredient.push(
    { recipe_id: 'R-BURGER', line_no: 1, product_id: 'P-PATTY', text_original: 'Chicken Patties', qty: 1, unit: 'Stk', per: 'Person' },
    { recipe_id: 'R-BURGER', line_no: 2, product_id: 'P-BUN', text_original: 'Brioche Buns', qty: 1, unit: 'Stk', per: 'Person' },
    { recipe_id: 'R-BURGER', line_no: 3, product_id: '', text_original: 'Salz', qty: '', unit: '', per: 'Rezept' });
  T.Recipe.push({ recipe_id: 'R-MAUL', name: 'Maultaschen in Brühe', servings_base: 2, minutes: 15 });
  T.RecipeIngredient.push({ recipe_id: 'R-MAUL', line_no: 1, product_id: 'P-MAUL', text_original: 'Maultaschen', qty: 4, unit: 'Stk', per: 'Person' });
  T.Recipe.push({ recipe_id: 'R-KAESE', name: 'Käsebrot', servings_base: 2, minutes: 5 });
  T.RecipeIngredient.push({ recipe_id: 'R-KAESE', line_no: 1, product_id: '', text_original: 'Bio-Maasdamer', qty: 100, unit: 'g', per: 'Rezept' });
  return { s, T, eng, run };
}
const buy = (run, lines, key, extra) => run(Object.assign({ type: 'purchase', source: 'liste', date: '2026-11-17', lines }, extra || {}), key);

console.log('Einkaufsplaner – Tests der Fachlogik\n');

test('1 Globale Rezeptabbuchung: Patties UND Buns werden abgezogen', () => {
  const { s, run } = fixture();
  buy(run, [{ product_id: 'P-PATTY', qty: 2, unit: 'Pkg', location_id: 'TK' }, { product_id: 'P-BUN', qty: 1, unit: 'Pkg', location_id: 'VK' }]);
  const r = run({ type: 'cook', recipe_id: 'R-BURGER', persons: 3 });
  near(EP.totalStock(s, 'P-PATTY'), 5); near(EP.totalStock(s, 'P-BUN'), 1);
  assert.strictEqual(r.lines.find(l => l.text === 'Salz').status, 'unklar');
  assert.ok(EP.verifyLedger(s).ok);
});

test('2 Gekocht wiederholbar, Doppelklick bucht nur einmal', () => {
  const { s, run } = fixture();
  buy(run, [{ product_id: 'P-PATTY', qty: 3, unit: 'Pkg', location_id: 'TK' }, { product_id: 'P-BUN', qty: 3, unit: 'Pkg', location_id: 'VK' }]);
  run({ type: 'cook', recipe_id: 'R-BURGER', persons: 2, date: '2026-11-17' }, 'cook-A');
  const again = run({ type: 'cook', recipe_id: 'R-BURGER', persons: 2, date: '2026-11-17' }, 'cook-A'); // Doppelklick
  assert.strictEqual(again.replayed, true);
  near(EP.totalStock(s, 'P-PATTY'), 10);
  run({ type: 'cook', recipe_id: 'R-BURGER', persons: 2, date: '2026-11-24' }, 'cook-B'); // nächste Woche
  near(EP.totalStock(s, 'P-PATTY'), 8); near(EP.totalStock(s, 'P-BUN'), 8);
  assert.strictEqual(s.tables.CookEvent.length, 2);
});

test('3 Bestandsänderung zur Laufzeit: 3 Milch, 1 entnommen, 4 gekauft → 6', () => {
  const { s, run } = fixture();
  run({ type: 'set_total', product_id: 'P-MILCH', location_id: 'KS', qty: 3, unit: 'Pkg' });
  const uiStand = EP.totalStock(s, 'P-MILCH'); // Gerät A zeigt 3000 ml
  run({ type: 'adjust', product_id: 'P-MILCH', location_id: 'KS', qty: -1, unit: 'Pkg' }); // Gerät B entnimmt
  buy(run, [{ product_id: 'P-MILCH', qty: 4, unit: 'Pkg', location_id: 'KS' }]); // Gerät A bucht Einkauf (Delta, kein Absolutwert)
  near(uiStand, 3000); near(EP.totalStock(s, 'P-MILCH'), 6000);
  // ohne Entnahme: 3 + 4 = 7
  const f2 = fixture();
  f2.run({ type: 'set_total', product_id: 'P-MILCH', location_id: 'KS', qty: 3, unit: 'Pkg' });
  buy(f2.run, [{ product_id: 'P-MILCH', qty: 4, unit: 'Pkg', location_id: 'KS' }]);
  near(EP.totalStock(f2.s, 'P-MILCH'), 7000);
});

test('4 „Insgesamt vier“ setzt absolut, „vier gekauft“ addiert', () => {
  const { s, run } = fixture();
  run({ type: 'adjust', product_id: 'P-GURKE', location_id: 'KS', qty: 3, unit: 'Stk' });
  run({ type: 'set_total', product_id: 'P-GURKE', location_id: 'KS', qty: 4, unit: 'Stk' });
  near(EP.totalStock(s, 'P-GURKE'), 4);
  run({ type: 'adjust', product_id: 'P-GURKE', location_id: 'KS', qty: 4, unit: 'Stk' });
  near(EP.totalStock(s, 'P-GURKE'), 8);
  const v = EP.parseVoice('insgesamt vier Gurken');
  assert.strictEqual(v[0].intent, 'set'); assert.strictEqual(v[0].qty, 4);
  assert.strictEqual(EP.parseVoice('vier Gurken gekauft')[0].intent, 'add');
  assert.strictEqual(EP.parseVoice('noch vier Gurken')[0].intent, 'ambiguous');
});

test('5 Teilpackung: Pizza-Doppelpack und Kuchen', () => {
  const { s, run } = fixture();
  buy(run, [{ product_id: 'P-PIZZA', qty: 1, unit: 'Pkg', location_id: 'TK' }]);
  run({ type: 'adjust', product_id: 'P-PIZZA', location_id: 'TK', qty: -1, unit: 'Stk' });
  near(EP.totalStock(s, 'P-PIZZA'), 1);
  buy(run, [{ product_id: 'P-PIZZA', qty: 1, unit: 'Pkg', location_id: 'TK' }]);
  near(EP.totalStock(s, 'P-PIZZA'), 3);
  const lots = EP.lotsOf(s, 'P-PIZZA');
  assert.strictEqual(lots.filter(l => l.opened_at).length, 1, 'eine angebrochene Doppelpackung');
  assert.strictEqual(lots.filter(l => !l.opened_at).length, 1, 'eine volle Doppelpackung');
  buy(run, [{ product_id: 'P-KUCHEN', qty: 1, unit: 'Pkg', location_id: 'KS' }]);
  run({ type: 'adjust', product_id: 'P-KUCHEN', location_id: 'KS', qty: -4, unit: 'Stk' });
  near(EP.totalStock(s, 'P-KUCHEN'), 4);
  assert.ok(EP.verifyLedger(s).ok);
});

test('5b Maultaschen: 4 Personen × 4 Stk = 16, 3 Packungen à 6 → 2 Rest', () => {
  const { s, T, run } = fixture();
  T.MealPlanEntry.push({ entry_id: 'M1', week_start: '2026-11-16', date: '2026-11-18', persons: 4, recipe_id: 'R-MAUL', status: 'bestätigt' });
  const list = EP.computeShoppingList(s, '2026-11-16', []);
  const it = list.find(i => i.product_id === 'P-MAUL');
  assert.strictEqual(it.packages, 3); near(it.qty_to_buy, 18); near(it.leftover_after_cooking, 2);
  buy(run, [{ product_id: 'P-MAUL', qty: 3, unit: 'Pkg', location_id: 'KS' }]);
  run({ type: 'cook', recipe_id: 'R-MAUL', persons: 4, meal_plan_entry_id: 'M1' });
  near(EP.totalStock(s, 'P-MAUL'), 2);
  const rest = EP.lotsOf(s, 'P-MAUL');
  assert.strictEqual(rest.length, 1); assert.ok(rest[0].opened_at, 'Rest ist als angebrochen markiert');
});

test('6 Öffnungsdatum je Packung, neue Packung bleibt getrennt', () => {
  const { s, run } = fixture();
  buy(run, [{ product_id: 'P-MAAS', qty: 2, unit: 'Pkg', location_id: 'KS', best_before: '2026-12-01' }]);
  const lot = EP.lotsOf(s, 'P-MAAS')[0];
  run({ type: 'open', lot_id: lot.lot_id, date: '2026-11-17' });
  const lots = EP.lotsOf(s, 'P-MAAS');
  assert.strictEqual(lots.length, 2);
  assert.strictEqual(lots.find(l => l.opened_at).opened_at, '2026-11-17');
  near(lots.find(l => !l.opened_at).qty_base, 400);
  buy(run, [{ product_id: 'P-MAAS', qty: 1, unit: 'Pkg', location_id: 'KS', best_before: '2026-12-01' }]);
  assert.strictEqual(EP.lotsOf(s, 'P-MAAS').filter(l => l.opened_at).length, 1);
  near(EP.totalStock(s, 'P-MAAS'), 1200);
});

test('7 Bestätigte Zuordnung gilt global (Sprache, Rezept, Bon)', () => {
  const { s, run } = fixture();
  assert.notStrictEqual(EP.resolveProduct(s, 'Biomasdammer').status, 'resolved', 'vor Bestätigung keine Automatik');
  const r = run({ type: 'confirm_alias', alias: 'Bio-Maasdamer', product_id: 'P-MAAS' });
  assert.strictEqual(r.recipe_ingredients_updated, 1, 'Rezept Käsebrot automatisch zugeordnet');
  assert.strictEqual(EP.resolveProduct(s, 'Biomasdammer').product_id, 'P-MAAS', 'Tippvariante');
  assert.strictEqual(EP.resolveProduct(s, 'BIO MAASDAMER').product_id, 'P-MAAS', 'Bon-Schreibweise');
  assert.strictEqual(EP.resolveProduct(s, 'Käsestück').product_id, 'P-KAESE', 'anderer Käse bleibt getrennt');
  assert.notStrictEqual(EP.resolveProduct(s, 'Milch 3,5%').status, 'resolved', 'Milch-Variante nicht automatisch');
  buy(run, [{ product_id: 'P-MAAS', qty: 1, unit: 'Pkg', location_id: 'KS' }]);
  run({ type: 'cook', recipe_id: 'R-KAESE', persons: 2 });
  near(EP.totalStock(s, 'P-MAAS'), 300);
});

test('8 Unterschiedliche MHD getrennt, ältere Ware zuerst', () => {
  const { s, run } = fixture();
  buy(run, [{ product_id: 'P-MILCH', qty: 1, unit: 'Pkg', location_id: 'KS', best_before: '2026-11-30' }]);
  buy(run, [{ product_id: 'P-MILCH', qty: 1, unit: 'Pkg', location_id: 'KS', best_before: '2026-11-20' }]);
  assert.strictEqual(EP.lotsOf(s, 'P-MILCH').length, 2);
  run({ type: 'adjust', product_id: 'P-MILCH', location_id: 'KS', qty: -1, unit: 'Pkg' });
  const left = EP.lotsOf(s, 'P-MILCH');
  assert.strictEqual(left.length, 1); assert.strictEqual(left[0].best_before, '2026-11-30');
});

test('9 Bon-Dubletten: gleiche Datei und gleicher Inhalt → nur eine Buchung', () => {
  const { s, run } = fixture();
  const head = { market: 'PENNY', datetime: '2026-08-18T17:42', receipt_no: '4711', total: 23.45 };
  const a = run(Object.assign({ type: 'register_receipt', file_sha256: 'abc', file_name: 'bon1.pdf' }, head));
  const b = run(Object.assign({ type: 'register_receipt', file_sha256: 'abc', file_name: 'bon1 (1).pdf' }, head));
  const c = run(Object.assign({ type: 'register_receipt', file_sha256: 'zzz', file_name: 'foto.jpg' }, head));
  assert.strictEqual(b.duplicate_of, a.receipt_id); assert.strictEqual(c.duplicate_of, a.receipt_id);
  buy(run, [{ product_id: 'P-MILCH', qty: 2, unit: 'Pkg', location_id: 'KS' }], 'bon:' + a.receipt_id, { source: 'bon', receipt_id: a.receipt_id });
  assert.throws(() => buy(run, [{ product_id: 'P-MILCH', qty: 2, unit: 'Pkg', location_id: 'KS' }], 'bon:' + b.receipt_id, { source: 'bon', receipt_id: b.receipt_id }), /Dublette/);
  assert.throws(() => buy(run, [{ product_id: 'P-MILCH', qty: 2, unit: 'Pkg', location_id: 'KS' }], 'anderer-key', { source: 'bon', receipt_id: a.receipt_id }), /bereits gebucht/);
  near(EP.totalStock(s, 'P-MILCH'), 2000);
});

test('10 Zwei Geräte: gleicher Einkauf einmal, zwei verschiedene Einkäufe beide', () => {
  const { s, run } = fixture();
  const lines = [{ product_id: 'P-GURKE', qty: 2, unit: 'Stk', location_id: 'KS' }];
  buy(run, lines, 'einkauf-123', null);
  const r2 = buy(run, lines, 'einkauf-123', null); // zweites Gerät, gleicher Vorgang
  assert.strictEqual(r2.replayed, true);
  near(EP.totalStock(s, 'P-GURKE'), 2);
  buy(run, lines, 'einkauf-456', null);
  near(EP.totalStock(s, 'P-GURKE'), 4);
  assert.throws(() => buy(run, [{ product_id: 'P-GURKE', qty: 9, unit: 'Stk', location_id: 'KS' }], 'einkauf-456'), /anderen Vorgang/);
});

test('Stückware wird auf ganze Stück aufgerundet', () => {
  const { s, T } = fixture();
  T.Recipe.push({ recipe_id: 'R-G', name: 'Gurkensalat', servings_base: 2 });
  T.RecipeIngredient.push({ recipe_id: 'R-G', line_no: 1, product_id: 'P-GURKE', text_original: 'Gurke', qty: 0.5, unit: 'Stk', per: 'Person' });
  T.MealPlanEntry.push({ entry_id: 'X', week_start: '2026-11-16', date: '2026-11-18', persons: 3, recipe_id: 'R-G', status: 'bestätigt' });
  const it = EP.computeShoppingList(s, '2026-11-16', []).find(i => i.product_id === 'P-GURKE');
  near(it.qty_needed, 1.5); near(it.qty_to_buy, 2); near(it.leftover_after_cooking, 0.5);
});

test('11 Wochenplanung verändert den Bestand nicht', () => {
  const { s, T, run } = fixture();
  buy(run, [{ product_id: 'P-PATTY', qty: 1, unit: 'Pkg', location_id: 'TK' }]);
  const evBefore = T.StockEvent.length;
  T.MealPlanEntry.push({ entry_id: 'M1', week_start: '2026-11-16', date: '2026-11-19', persons: 2, recipe_id: 'R-BURGER', status: 'bestätigt' });
  T.MealPlanEntry.push({ entry_id: 'M2', week_start: '2026-11-16', date: '2026-11-21', persons: 4, recipe_id: 'R-BURGER', status: 'bestätigt' });
  const list = EP.computeShoppingList(s, '2026-11-16', []);
  assert.strictEqual(T.StockEvent.length, evBefore);
  near(EP.totalStock(s, 'P-PATTY'), 4);
  const p = list.find(i => i.product_id === 'P-PATTY');
  near(p.qty_needed, 6); near(p.qty_available, 4); assert.strictEqual(p.packages, 1, 'Bestand nur einmal gegengerechnet');
});

test('12 Fehler mitten in der Buchung → nichts gespeichert', () => {
  const { s, T, run } = fixture();
  const snap = JSON.stringify(T);
  assert.throws(() => buy(run, [{ product_id: 'P-MILCH', qty: 1, unit: 'Pkg', location_id: 'KS' }, { product_id: 'P-GURKE', qty: 1, unit: 'Stk', location_id: 'GIBTSNICHT' }]), /Lagerort/);
  assert.strictEqual(JSON.stringify(T), snap);
  assert.throws(() => run({ type: 'adjust', product_id: 'P-GURKE', location_id: 'KS', qty: -1, unit: 'Stk' }), /Nicht genug/);
  assert.strictEqual(JSON.stringify(T), snap);
});

test('13 Unklare Zutat: keine erfundene Menge, kein Abzug', () => {
  const { s, T, run } = fixture();
  T.MealPlanEntry.push({ entry_id: 'M1', week_start: '2026-11-16', date: '2026-11-19', persons: 2, recipe_id: 'R-BURGER', status: 'bestätigt' });
  const list = EP.computeShoppingList(s, '2026-11-16', []);
  const salz = list.find(i => i.text === 'Salz');
  assert.ok(salz.unclear_reason); assert.strictEqual(salz.qty_to_buy, null);
  // Packung ohne bestätigtes Profil → unklar statt Raten
  const r = EP.toBase(s, 'P-GURKE', 1, 'Pkg');
  assert.strictEqual(r.ok, false);
  const pv = EP.previewCook(s, 'R-BURGER', 2);
  assert.strictEqual(pv.lines.find(l => l.text === 'Salz').status, 'unklar');
});

test('14 Inventur Kühlschrank berührt Tiefkühler/Keller nicht', () => {
  const { s, run } = fixture();
  buy(run, [{ product_id: 'P-MILCH', qty: 2, unit: 'Pkg', location_id: 'KS' }, { product_id: 'P-PATTY', qty: 1, unit: 'Pkg', location_id: 'TK' }, { product_id: 'P-MILCH', qty: 3, unit: 'Pkg', location_id: 'VK' }]);
  run({ type: 'inventory', location_id: 'KS', mode: 'full', counts: [] });
  near(EP.totalStock(s, 'P-MILCH', 'KS'), 0); near(EP.totalStock(s, 'P-MILCH', 'VK'), 3000); near(EP.totalStock(s, 'P-PATTY', 'TK'), 4);
});

test('15 Zugangsanfrage gibt keinen Zugriff bis zur Freigabe', () => {
  const { s, T } = fixture();
  T.User.push({ email: 'besitzer@example.com', role: 'owner', status: 'freigegeben' });
  const r = EP.requestAccess(s, 'partnerin@example.com', 'Partnerin', '2026-11-17');
  assert.strictEqual(r.notify, true);
  assert.strictEqual(EP.isAllowed(s, 'partnerin@example.com'), false);
  assert.throws(() => EP.decideAccess(s, 'partnerin@example.com', 'partnerin@example.com', true, 'x'), /Besitzer/);
  EP.decideAccess(s, 'besitzer@example.com', 'partnerin@example.com', true, '2026-11-17');
  assert.strictEqual(EP.isAllowed(s, 'partnerin@example.com'), true);
  assert.strictEqual(EP.isAllowed(s, 'fremd@example.com'), false);
});

test('Sprache: Mehrfachaussage mit Zustand und MHD', () => {
  const v = EP.parseVoice('Wir haben noch drei Äpfel, eine Gurke, die noch gut aussieht, und Maasdammer, haltbar bis zum 15. Oktober', '2026-10-01');
  const names = v.map(a => a.product_text);
  assert.ok(names.includes('äpfel'), JSON.stringify(v));
  const g = v.find(a => a.product_text === 'gurke'); assert.strictEqual(g.qty, 1);
  const m = v.find(a => a.product_text === 'maasdammer'); assert.strictEqual(m.best_before, '2026-10-15'); assert.ok(m.needs_question, 'Menge fehlt → Rückfrage');
  assert.strictEqual(g.condition, 'gut'); assert.strictEqual(g.intent, 'ambiguous', '„noch“ gilt für den ganzen Satz');
  const inv = EP.parseVoice('noch vier Gurken, zwei Milch', '2026-11-17', 'inventur');
  assert.ok(inv.every(a => a.intent === 'set'), 'Inventur: „noch“ = absoluter Bestand');
});

test('Journal-Prüfung: Bestand = Summe aller Buchungen', () => {
  const { s, run } = fixture();
  buy(run, [{ product_id: 'P-MAUL', qty: 5, unit: 'Pkg', location_id: 'KS' }]);
  run({ type: 'cook', recipe_id: 'R-MAUL', persons: 3 });
  run({ type: 'set_total', product_id: 'P-MAUL', location_id: 'KS', qty: 10, unit: 'Stk' });
  assert.ok(EP.verifyLedger(s).ok); near(EP.totalStock(s, 'P-MAUL'), 10);
});

test('Sprachsatz als Stapel: alles oder nichts', () => {
  const { s, T, run } = fixture();
  run({ type: 'batch', commands: [
    { type: 'set_total', product_id: 'P-GURKE', location_id: 'KS', qty: 3, unit: 'Stk' },
    { type: 'adjust', product_id: 'P-MILCH', location_id: 'KS', qty: 2, unit: 'Pkg' }] });
  near(EP.totalStock(s, 'P-GURKE'), 3); near(EP.totalStock(s, 'P-MILCH'), 2000);
  const snap = JSON.stringify(T);
  assert.throws(() => run({ type: 'batch', commands: [
    { type: 'adjust', product_id: 'P-GURKE', location_id: 'KS', qty: 1, unit: 'Stk' },
    { type: 'adjust', product_id: 'P-PIZZA', location_id: 'KS', qty: -5, unit: 'Stk' }] }), /Nicht genug/);
  assert.strictEqual(JSON.stringify(T), snap, 'erste Aktion wurde nicht gebucht');
});

test('Einzahl/Mehrzahl wird erkannt, aber nur eindeutig', () => {
  const { s } = fixture();
  assert.strictEqual(EP.resolveProduct(s, 'Gurken').product_id, 'P-GURKE');
  s.tables.Product.push({ product_id: 'P-APFEL', name: 'Apfel', category: 'Obst & Gemüse', base_unit: 'Stk' });
  assert.strictEqual(EP.resolveProduct(s, 'Äpfel').product_id, 'P-APFEL');
  assert.strictEqual(EP.resolveProduct(s, 'Pizzen').status === 'resolved', false, 'unregelmäßige Mehrzahl → Rückfrage statt Raten');
});

console.log(`\n${pass} bestanden, ${failCount} fehlgeschlagen`);
process.exit(failCount ? 1 : 0);
