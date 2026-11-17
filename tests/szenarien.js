/* Durchgehender Wochen-Testlauf: Planen → Einkaufsliste → Bon → Bestand → Kochen (auch Teilpackungen)
 * → Reste → Inventur → Doppelte Bons/Klicks. Nach JEDEM Schritt wird geprüft:
 *   - Bestand je Charge = Summe aller Journal-Buchungen (nichts „hängt“)
 *   - kein negativer Bestand
 *   - erwartete Mengen, offene/geschlossene Packungen
 * Start: node tests/szenarien.js   (nur Beispieldaten im Speicher, kein Google-Zugriff)
 */
'use strict';
const EP = require('../core/domain.js');
const assert = require('assert');

let pass = 0, failCount = 0, verbose = process.argv.includes('-v');
function step(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { failCount++; console.log('  ✗ ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e)); }
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, (msg || '') + ` – erwartet ${b}, ist ${a}`);

// ------------------------------------------------------------------ Aufbau
const s = EP.newStore(), T = s.tables;
let clock = 0, n = 0, k = 0, day = '2026-11-16';
const now = () => day + 'T18:' + String(Math.floor(clock / 60) % 60).padStart(2, '0') + ':' + String(clock++ % 60).padStart(2, '0') + '.000Z';
const eng = new EP.Engine(s, { now, idGen: (p) => p + '-' + String(++n).padStart(5, '0') });
const run = (cmd, key, user) => eng.execute(cmd, { idempotencyKey: key || 'auto-' + (++k), user: user || 'manuel' });

T.Location.push({ location_id: 'KS', name: 'Kühlschrank', sort: 1 }, { location_id: 'TK', name: 'Tiefkühler', sort: 2 }, { location_id: 'VK', name: 'Vorratskeller', sort: 3 });
const P = (id, name, cat, unit) => run({ type: 'create_product', product_id: id, name, category: cat, base_unit: unit });
P('P-PATTY', 'Chicken Patties', 'Tiefkühl', 'Stk');
P('P-BUN', 'Brioche Buns', 'Brot & Backwaren', 'Stk');
P('P-WURST', 'Wiener Würstchen', 'Vorrat', 'Stk');
P('P-MAUL', 'Maultaschen', 'Kühlregal', 'Stk');
P('P-MILCH', 'Milch', 'Kühlregal', 'ml');
P('P-PIZZA', 'Pizza', 'Tiefkühl', 'Stk');
P('P-KUCHEN', 'Kuchen', 'Brot & Backwaren', 'Stk');
P('P-ZWIEBEL', 'Zwiebel', 'Obst & Gemüse', 'Stk');
P('P-KAESE', 'Gouda gerieben', 'Kühlregal', 'g');
const PKG = (pid, label, q, u) => run({ type: 'confirm_package', product_id: pid, label, content_qty: q, content_unit: u, make_default: true });
PKG('P-PATTY', '4er-Packung', 4, 'Stk');
PKG('P-BUN', '4er-Beutel', 4, 'Stk');
PKG('P-WURST', 'Glas (6 Stück)', 6, 'Stk');
PKG('P-MAUL', 'Packung (6 Stück)', 6, 'Stk');
PKG('P-MILCH', '1-l-Packung', 1, 'l');
PKG('P-PIZZA', 'Doppelpackung', 2, 'Stk');
PKG('P-KUCHEN', 'Kuchen (8 Stücke)', 8, 'Stk');
PKG('P-KAESE', 'Beutel 200 g', 200, 'g');

const recipe = (id, name, lines) => run({ type: 'batch', commands: [
  { type: 'upsert_rows', table: 'Recipe', rows: [{ recipe_id: id, name, category: 'Schnell', servings_base: 2, minutes: 15, favorite: false, disliked: false, version: 1 }] },
  { type: 'upsert_rows', table: 'RecipeIngredient', rows: lines.map((l, i) => Object.assign({ recipe_id: id, line_no: i + 1, optional: false, note: '' }, l)) }] });
recipe('R-BURGER', 'Chicken Burger', [
  { product_id: 'P-PATTY', text_original: 'Chicken Patties', qty: 1, unit: 'Stk', per: 'Person' },
  { product_id: 'P-BUN', text_original: 'Brioche Buns', qty: 1, unit: 'Stk', per: 'Person' },
  { product_id: 'P-KAESE', text_original: 'Gouda gerieben', qty: 25, unit: 'g', per: 'Person' },
  { product_id: '', text_original: 'Salz', qty: '', unit: '', per: 'Rezept' }]);
recipe('R-MAUL', 'Maultaschen in Brühe', [
  { product_id: 'P-MAUL', text_original: 'Maultaschen', qty: 4, unit: 'Stk', per: 'Person' },
  { product_id: 'P-ZWIEBEL', text_original: 'Zwiebel', qty: 1, unit: 'Stk', per: 'Rezept' }]);
recipe('R-HOTDOG', 'Hotdogs', [
  { product_id: 'P-WURST', text_original: 'Wiener Würstchen', qty: 1, unit: 'Stk', per: 'Person' },
  { product_id: 'P-BUN', text_original: 'Brioche Buns', qty: 1, unit: 'Stk', per: 'Person' }]);

// ------------------------------------------------------------------ Prüfhilfen
const lots = (pid) => T.StockLot.filter((l) => l.product_id === pid && Number(l.qty_base) > 1e-9);
const total = (pid, loc) => EP.totalStock(s, pid, loc);
function healthy(label) {
  const v = EP.verifyLedger(s);
  assert.ok(v.ok, (label || '') + ' Journal ≠ Bestand: ' + JSON.stringify(v.problems));
  T.StockLot.forEach((l) => assert.ok(Number(l.qty_base) > -1e-9, 'negativer Bestand in ' + l.lot_id));
}
/** offene und geschlossene Packungen eines Produkts */
function packs(pid) {
  const r = { zu: 0, offen: [], lose: 0 };
  lots(pid).forEach((l) => {
    const prod = T.Product.find((p) => p.product_id === pid);
    const pkg = T.PackageProfile.find((x) => x.package_id === l.package_id);
    const c = pkg ? EP.toBase(s, pid, 1, 'Pkg', pkg.package_id).qty_base : null;
    if (l.opened_at) r.offen.push(Number(l.qty_base));
    else if (c) r.zu += Number(l.qty_base) / c;
    else r.lose += Number(l.qty_base);
    void prod;
  });
  return r;
}
function show(title) {
  if (!verbose) return;
  console.log('      ' + title);
  T.Product.forEach((p) => {
    const t = total(p.product_id); if (t < 1e-9) return;
    const k = packs(p.product_id);
    console.log('        ' + p.name.padEnd(18) + String(t).padStart(6) + ' ' + p.base_unit + '   zu: ' + k.zu + (k.offen.length ? '   offen: ' + k.offen.join(' + ') : '') + (k.lose ? '   lose: ' + k.lose : ''));
  });
}

console.log('Durchgehender Wochen-Testlauf\n');

// ------------------------------------------------------------------ 1 Planung
const WS = '2026-11-16';
step('1 Wochenplan als Vorschlag bucht nichts vom Bestand ab', () => {
  run({ type: 'upsert_rows', table: 'MealPlanEntry', rows: [
    { entry_id: 'MP-2026-11-16', week_start: WS, date: '2026-11-16', persons: 2, recipe_id: 'R-BURGER', status: 'Vorschlag' },
    { entry_id: 'MP-2026-11-17', week_start: WS, date: '2026-11-17', persons: 4, recipe_id: 'R-MAUL', status: 'Vorschlag' },
    { entry_id: 'MP-2026-11-18', week_start: WS, date: '2026-11-18', persons: 2, recipe_id: 'R-HOTDOG', status: 'Vorschlag' }] });
  assert.strictEqual(T.StockEvent.length, 0);
  assert.strictEqual(EP.computeShoppingList(s, WS, [], WS).length, 0, 'Vorschläge erzeugen noch keine Liste');
});

let list;
step('2 Plan bestätigt → Einkaufsliste in ganzen Packungen, Salz ohne Menge als unklar', () => {
  run({ type: 'upsert_rows', table: 'MealPlanEntry', rows: ['16', '17', '18'].map((d) => ({ entry_id: 'MP-2026-11-' + d, status: 'bestätigt' })) });
  list = EP.computeShoppingList(s, WS, [], WS);
  const by = (pid) => list.find((i) => i.product_id === pid);
  assert.strictEqual(by('P-PATTY').packages, 1, 'Patties: 2 nötig → 1 Packung');
  assert.strictEqual(by('P-BUN').packages, 1, 'Buns: 2 Burger + 2 Hotdogs = 4 → 1 Beutel');
  assert.strictEqual(by('P-MAUL').packages, 3, 'Maultaschen: 16 → 3 Packungen');
  near(by('P-MAUL').leftover_after_cooking, 2, 'Maultaschen-Rest nach dem Kochen');
  assert.strictEqual(by('P-WURST').packages, 1, 'Würstchen: 2 → 1 Glas');
  assert.strictEqual(by('P-ZWIEBEL').qty_to_buy, 2, 'Rezept für 2 mit 1 Zwiebel → für 4 Personen 2 Zwiebeln');
  assert.strictEqual(by('P-KAESE').packages, 1, 'Käse 50 g → 1 Beutel');
  assert.ok(list.some((i) => i.unclear_reason && /Salz/.test(i.text)), 'Salz als unklar');
  assert.ok(!list.some((i) => i.text === 'Salz' && i.qty_to_buy), 'keine erfundene Salzmenge');
});

step('3 Liste: Häkchen setzen bucht noch keinen Bestand', () => {
  const rows = list.filter((i) => i.product_id).map((i) => Object.assign({}, i, { item_id: 'SI-' + i.product_id + '-Plan', week_start: WS, checked: true }));
  run({ type: 'upsert_rows', table: 'ShoppingItem', rows });
  assert.strictEqual(T.StockEvent.length, 0);
  assert.ok(T.ShoppingItem.every((i) => i.checked && !i.purchase_id));
});

// ------------------------------------------------------------------ 2 Bon
const bon = { market: 'PENNY', datetime: '2026-11-16T17:42', receipt_no: '4711', total: 23.47, file_sha256: 'aaa111',
  lines: [{ text_original: 'CHICKEN PATTIES 4ST', product_id: 'P-PATTY', qty: 1, unit: 'Pkg', line_price: 3.49 },
    { text_original: 'BRIOCHE BURGER BUNS', product_id: 'P-BUN', qty: 1, unit: 'Pkg', line_price: 1.99 },
    { text_original: 'MAULTASCHEN 360G', product_id: 'P-MAUL', qty: 3, unit: 'Pkg', line_price: 5.97 },
    { text_original: 'WIENER IM GLAS', product_id: 'P-WURST', qty: 1, unit: 'Pkg', line_price: 2.29 },
    { text_original: 'ZWIEBELN 1KG NETZ', product_id: '', qty: 1, unit: '', line_price: 1.29 },
    { text_original: 'GOUDA GERIEBEN', product_id: 'P-KAESE', qty: 1, unit: 'Pkg', line_price: 1.79 },
    { text_original: 'H-MILCH 3,5% 1L', product_id: 'P-MILCH', qty: 4, unit: 'Pkg', line_price: 4.36 },
    { text_original: 'PFAND', product_id: '', qty: 1, unit: '', line_price: 0.25, deposit: 0.25 }] };
let receiptId;
step('4 Bon gescannt → „prüfen“, noch keine Buchung', () => {
  const r = run(Object.assign({ type: 'register_receipt' }, bon));
  receiptId = r.receipt_id;
  assert.strictEqual(T.Receipt[0].status, 'prüfen');
  assert.strictEqual(T.StockEvent.length, 0);
  assert.strictEqual(T.ReceiptLine.filter((l) => l.mapping_status === 'offen').length, 2, 'Zwiebelnetz + Pfand offen');
});

step('5 Gleicher Bon nochmal (anderes Gerät, anderer Dateiname) → Dublette', () => {
  const r = run(Object.assign({ type: 'register_receipt', file_name: 'IMG_0042.jpg' }, bon, { file_sha256: 'bbb222' }), 'k-bon-handy');
  assert.ok(r.duplicate_of === receiptId, 'Inhalts-Fingerabdruck erkennt die Dublette');
  assert.throws(() => run({ type: 'purchase', source: 'bon', receipt_id: T.Receipt[1].receipt_id, date: '2026-11-16', lines: [{ product_id: 'P-PATTY', qty: 1, unit: 'Pkg', location_id: 'TK' }] }), /Dublette/);
  healthy();
});

const loc = { 'P-PATTY': 'TK', 'P-BUN': 'VK', 'P-MAUL': 'KS', 'P-WURST': 'VK', 'P-KAESE': 'KS', 'P-MILCH': 'VK' };
const bonLines = () => bon.lines.filter((l) => l.product_id).map((l) => ({ product_id: l.product_id, qty: l.qty, unit: l.unit, location_id: loc[l.product_id], best_before: l.product_id === 'P-MAUL' ? '2026-11-24' : '', shopping_item_id: T.ShoppingItem.some((i) => i.item_id === 'SI-' + l.product_id + '-Plan') ? 'SI-' + l.product_id + '-Plan' : undefined }));
step('6 Bon bestätigt → Bestand gutgeschrieben, Listenpositionen als gekauft markiert', () => {
  const r = run({ type: 'purchase', source: 'bon', receipt_id: receiptId, market: 'PENNY', date: '2026-11-16', lines: bonLines() }, 'k-bon-buchen');
  assert.strictEqual(r.skipped.length, 0);
  near(total('P-PATTY'), 4); near(total('P-BUN'), 4); near(total('P-MAUL'), 18); near(total('P-WURST'), 6);
  near(total('P-MILCH'), 4000); near(total('P-KAESE'), 200);
  assert.deepStrictEqual(packs('P-MAUL'), { zu: 3, offen: [], lose: 0 });
  assert.strictEqual(T.Receipt[0].status, 'gebucht');
  assert.ok(T.ShoppingItem.filter((i) => i.product_id !== 'P-ZWIEBEL').every((i) => i.purchase_id), 'Listenpositionen tragen die Einkaufs-ID');
  healthy(); show('Nach dem Einkauf:');
});

step('7 Doppelklick auf „Bon buchen“ → keine zweite Gutschrift', () => {
  const r = run({ type: 'purchase', source: 'bon', receipt_id: receiptId, market: 'PENNY', date: '2026-11-16', lines: bonLines() }, 'k-bon-buchen');
  assert.ok(r.replayed); near(total('P-PATTY'), 4); near(total('P-MAUL'), 18);
});

step('8 Zusätzlich „Abgehakte einbuchen“ über die Liste → bereits per Bon gebuchte Positionen werden übersprungen', () => {
  const lines = T.ShoppingItem.filter((i) => i.checked && i.product_id && i.product_id !== 'P-ZWIEBEL').map((i) => ({ product_id: i.product_id, qty: 1, unit: 'Pkg', location_id: loc[i.product_id], shopping_item_id: i.item_id }));
  assert.throws(() => run({ type: 'purchase', source: 'liste', date: '2026-11-16', lines }), /Keine buchbare Position/);
  near(total('P-PATTY'), 4); near(total('P-MAUL'), 18);
  healthy();
});

step('9 Unbekannte Bonzeile „ZWIEBELN 1KG NETZ“: Zuordnung bestätigen, dann gezielt nachbuchen', () => {
  run({ type: 'confirm_alias', alias: 'ZWIEBELN 1KG NETZ', product_id: 'P-ZWIEBEL', source: 'bon' });
  assert.strictEqual(EP.resolveProduct(s, 'Zwiebeln 1kg Netz').product_id, 'P-ZWIEBEL', 'Regel gilt beim nächsten Bon');
  run({ type: 'purchase', source: 'liste', date: '2026-11-16', lines: [{ product_id: 'P-ZWIEBEL', qty: 8, unit: 'Stk', location_id: 'VK', shopping_item_id: 'SI-P-ZWIEBEL-Plan' }] });
  near(total('P-ZWIEBEL'), 8);
  healthy();
});

// ------------------------------------------------------------------ 3 Kochen
step('10 Burger für 2 statt 4: 2 Patties raus → Packung geöffnet, 2 Stück bleiben als „angebrochen“', () => {
  day = '2026-11-16';
  const pv = EP.previewCook(s, 'R-BURGER', 2);
  assert.ok(pv.lines.some((l) => l.status === 'unklar' || l.status === 'ohne Menge' || l.text === 'Salz'), 'Salz wird angezeigt, aber nicht gebucht');
  const r = run({ type: 'cook', recipe_id: 'R-BURGER', persons: 2, meal_plan_entry_id: 'MP-2026-11-16', date: '2026-11-16' }, 'k-cook-mo');
  near(total('P-PATTY'), 2); near(total('P-BUN'), 2); near(total('P-KAESE'), 150);
  assert.deepStrictEqual(packs('P-PATTY'), { zu: 0, offen: [2], lose: 0 });
  assert.deepStrictEqual(packs('P-KAESE'), { zu: 0, offen: [150], lose: 0 });
  assert.strictEqual(lots('P-PATTY')[0].opened_at, '2026-11-16', 'Öffnungsdatum gesetzt');
  assert.ok(r.lines.find((l) => l.text === 'Salz').booked === 0);
  assert.strictEqual(T.MealPlanEntry.find((e) => e.entry_id === 'MP-2026-11-16').status, 'gekocht');
  healthy(); show('Nach Burgern (2 Pers.):');
});

step('11 Doppelklick auf „Gekocht“ → nichts doppelt abgezogen; neuer bewusster Kochvorgang geht trotzdem', () => {
  const r = run({ type: 'cook', recipe_id: 'R-BURGER', persons: 2, meal_plan_entry_id: 'MP-2026-11-16', date: '2026-11-16' }, 'k-cook-mo');
  assert.ok(r.replayed); near(total('P-PATTY'), 2);
});

step('12 Maultaschen für 4: 16 von 18 → 2 bleiben in einer angebrochenen Packung, 2 Packungen ganz verbraucht', () => {
  day = '2026-11-17';
  run({ type: 'cook', recipe_id: 'R-MAUL', persons: 4, meal_plan_entry_id: 'MP-2026-11-17', date: '2026-11-17' });
  near(total('P-MAUL'), 2); near(total('P-ZWIEBEL'), 6, 'Zwiebeln: 1 je 2 Personen → 2');
  assert.deepStrictEqual(packs('P-ZWIEBEL'), { zu: 0, offen: [], lose: 6 }, 'lose Zwiebeln sind nie „angebrochen“');
  assert.deepStrictEqual(packs('P-MAUL'), { zu: 0, offen: [2], lose: 0 });
  assert.strictEqual(lots('P-MAUL')[0].best_before, '2026-11-24', 'MHD bleibt an der Restcharge');
  healthy(); show('Nach Maultaschen (4 Pers.):');
});

step('13 Würstchen: Glas mit 6, 2 entnommen (von Hand) → 4 im angebrochenen Glas', () => {
  run({ type: 'adjust', product_id: 'P-WURST', location_id: 'VK', qty: -2, unit: 'Stk' });
  near(total('P-WURST'), 4);
  assert.deepStrictEqual(packs('P-WURST'), { zu: 0, offen: [4], lose: 0 });
  healthy();
});

step('14 Hotdogs für 2 nehmen zuerst aus dem offenen Glas, kein neues Glas wird geöffnet', () => {
  day = '2026-11-18';
  run({ type: 'cook', recipe_id: 'R-HOTDOG', persons: 2, meal_plan_entry_id: 'MP-2026-11-18', date: '2026-11-18' });
  near(total('P-WURST'), 2); near(total('P-BUN'), 0);
  assert.deepStrictEqual(packs('P-WURST'), { zu: 0, offen: [2], lose: 0 });
  healthy();
});

step('15 Neues Glas Würstchen dazu → offenes Glas (2) und geschlossenes Glas (6) bleiben getrennt', () => {
  run({ type: 'adjust', product_id: 'P-WURST', location_id: 'VK', qty: 1, unit: 'Pkg', best_before: '2027-03-01' });
  near(total('P-WURST'), 8);
  assert.deepStrictEqual(packs('P-WURST'), { zu: 1, offen: [2], lose: 0 });
  healthy();
});

step('16 Ungeplanter Burger für 4, aber nur 2 Patties und 0 Buns da → bucht was da ist, meldet den Rest, nie negativ', () => {
  const r = run({ type: 'cook', recipe_id: 'R-BURGER', persons: 4, date: '2026-11-18' });
  const pat = r.lines.find((l) => l.product_id === 'P-PATTY');
  near(pat.booked, 2); near(pat.missing, 2);
  near(total('P-PATTY'), 0); near(total('P-BUN'), 0);
  assert.ok(!T.StockLot.some((l) => Number(l.qty_base) < 0));
  healthy();
});

step('17 Einkauf in Stück statt Packungen (8 Patties) wird als 2 ganze Packungen erkannt', () => {
  run({ type: 'adjust', product_id: 'P-PATTY', location_id: 'TK', qty: 8, unit: 'Stk' });
  assert.deepStrictEqual(packs('P-PATTY'), { zu: 2, offen: [], lose: 0 });
  run({ type: 'cook', recipe_id: 'R-BURGER', persons: 3, date: '2026-11-19' });
  assert.deepStrictEqual(packs('P-PATTY'), { zu: 1, offen: [1], lose: 0 }, '3 Patties aus 2 Packungen: 1 zu, 1 offen mit 1');
  healthy();
});

step('18 Bestand „insgesamt 6 Patties“ → 1 Packung zu + 2 Stück angebrochen', () => {
  run({ type: 'set_total', product_id: 'P-PATTY', location_id: 'TK', qty: 6, unit: 'Stk' });
  near(total('P-PATTY'), 6);
  assert.deepStrictEqual(packs('P-PATTY'), { zu: 1, offen: [2], lose: 0 }, 'eine offene Packung mit 2, nicht zwei offene');
  healthy(); show('Nach „insgesamt 6 Patties“:');
});

step('19 Kuchen: 8 Stücke, 4 gegessen → 4 übrig; Pizza-Doppelpack: 1 gegessen → 1 übrig', () => {
  run({ type: 'adjust', product_id: 'P-KUCHEN', location_id: 'KS', qty: 1, unit: 'Pkg' });
  run({ type: 'adjust', product_id: 'P-KUCHEN', location_id: 'KS', qty: -4, unit: 'Stk' });
  assert.deepStrictEqual(packs('P-KUCHEN'), { zu: 0, offen: [4], lose: 0 });
  run({ type: 'adjust', product_id: 'P-PIZZA', location_id: 'TK', qty: 1, unit: 'Pkg' });
  run({ type: 'adjust', product_id: 'P-PIZZA', location_id: 'TK', qty: -1, unit: 'Stk' });
  assert.deepStrictEqual(packs('P-PIZZA'), { zu: 0, offen: [1], lose: 0 });
  run({ type: 'adjust', product_id: 'P-PIZZA', location_id: 'TK', qty: 1, unit: 'Pkg' });
  assert.deepStrictEqual(packs('P-PIZZA'), { zu: 1, offen: [1], lose: 0 });
  near(total('P-PIZZA'), 3);
  healthy();
});

step('20 Milch: 4 l, 250 ml entnommen → 3 Packungen zu + 750 ml offen', () => {
  run({ type: 'adjust', product_id: 'P-MILCH', location_id: 'VK', qty: -250, unit: 'ml' });
  assert.deepStrictEqual(packs('P-MILCH'), { zu: 3, offen: [750], lose: 0 });
  healthy();
});

// ------------------------------------------------------------------ 4 Inventur & Abschluss
step('21 Inventur Kühlschrank: Maultaschen sind weg → 0, Tiefkühler und Keller unverändert', () => {
  const tkBefore = total('P-PATTY', 'TK'), vkBefore = total('P-WURST', 'VK');
  const counts = [...new Set(lots('P-KAESE').concat(lots('P-KUCHEN')).filter((l) => l.location_id === 'KS').map((l) => l.product_id))]
    .map((pid) => ({ product_id: pid, qty: total(pid, 'KS'), unit: T.Product.find((p) => p.product_id === pid).base_unit }));
  run({ type: 'inventory', location_id: 'KS', mode: 'full', counts });
  near(total('P-MAUL'), 0);
  near(total('P-PATTY', 'TK'), tkBefore); near(total('P-WURST', 'VK'), vkBefore);
  healthy();
});

step('22 Einkaufsliste nächste Woche rechnet Reste korrekt gegen (offene Packungen zählen mit)', () => {
  const WS2 = '2026-11-23';
  run({ type: 'upsert_rows', table: 'MealPlanEntry', rows: [{ entry_id: 'MP-2026-11-23', week_start: WS2, date: '2026-11-23', persons: 2, recipe_id: 'R-HOTDOG', status: 'bestätigt' }] });
  const l2 = EP.computeShoppingList(s, WS2, [], WS2);
  assert.ok(!l2.some((i) => i.product_id === 'P-WURST'), 'Würstchen reichen (2 offen + 6 zu)');
  assert.strictEqual(l2.find((i) => i.product_id === 'P-BUN').packages, 1);
});

step('23 Gesamtabgleich: jede Charge = Summe ihrer Buchungen, keine Charge negativ, kein Restbestand ohne Buchung', () => {
  healthy('Abschluss');
  const sumByProduct = {};
  T.StockEvent.forEach((e) => { sumByProduct[e.product_id] = (sumByProduct[e.product_id] || 0) + Number(e.delta_base); });
  T.Product.forEach((p) => near(total(p.product_id), Math.round((sumByProduct[p.product_id] || 0) * 1000) / 1000, p.name));
  show('Endbestand:');
});

console.log(`\n${pass} bestanden, ${failCount} fehlgeschlagen`);
process.exit(failCount ? 1 : 0);
