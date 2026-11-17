/* Beispieldaten für den Demo-Modus. Erfunden zu Testzwecken – keine echten Bestände.
 * Alle Buchungen laufen über dieselbe Fachlogik (EP.Engine) wie später im Backend. */
var Seed = (function () {
  'use strict';
  function iso(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); }
  function plus(days) { var d = new Date(); d.setDate(d.getDate() + days); return iso(d); }
  function monday(d) { var x = new Date(d); var wd = (x.getDay() + 6) % 7; x.setDate(x.getDate() - wd); return iso(x); }

  function build() {
    var s = EP.newStore();
    var T = s.tables;
    var eng = new EP.Engine(s, {});
    var k = 0;
    function run(cmd) { return eng.execute(cmd, { idempotencyKey: 'seed-' + (++k), user: 'Demo' }); }

    T.User.push({ email: 'demo@lokal', name: 'Demo', role: 'owner', status: 'freigegeben' });
    T.Location.push(
      { location_id: 'KS', name: 'Kühlschrank', sort: 1, active: true },
      { location_id: 'TK', name: 'Tiefkühler', sort: 2, active: true },
      { location_id: 'VK', name: 'Vorratskeller', sort: 3, active: true });

    var P = [
      ['P-MILCH', 'Milch', 'Kühlregal', 'ml'], ['P-PATTY', 'Chicken Patties', 'Tiefkühl', 'Stk'],
      ['P-BUN', 'Brioche Buns', 'Brot & Backwaren', 'Stk'], ['P-MAUL', 'Maultaschen', 'Kühlregal', 'Stk'],
      ['P-PIZZA', 'Pizza Margherita', 'Tiefkühl', 'Stk'], ['P-KUCHEN', 'Apfelkuchen', 'Brot & Backwaren', 'Stk'],
      ['P-MAAS', 'Maasdamer', 'Kühlregal', 'g'], ['P-GURKE', 'Gurke', 'Obst & Gemüse', 'Stk'],
      ['P-TOMATE', 'Cherrytomaten', 'Obst & Gemüse', 'g'], ['P-NUDEL', 'Spaghetti', 'Vorrat', 'g'],
      ['P-PASSATA', 'Passierte Tomaten', 'Vorrat', 'g'], ['P-SALAT', 'Eisbergsalat', 'Obst & Gemüse', 'Stk'],
      ['P-ZWIEBEL', 'Zwiebel', 'Obst & Gemüse', 'Stk'], ['P-BRUEHE', 'Gemüsebrühe', 'Vorrat', 'ml'],
      ['P-PARM', 'Parmesan', 'Kühlregal', 'g'], ['P-APFEL', 'Apfel', 'Obst & Gemüse', 'Stk'],
      ['P-EI', 'Eier', 'Kühlregal', 'Stk'], ['P-SPUELI', 'Spülmittel', 'Haushalt', 'ml']
    ];
    P.forEach(function (p) { run({ type: 'create_product', product_id: p[0], name: p[1], category: p[2], base_unit: p[3] }); });

    [['P-MILCH', '1-l-Packung', 1, 'l'], ['P-PATTY', 'Packung (4 Stk)', 4, 'Stk'], ['P-BUN', 'Beutel (4 Stk)', 4, 'Stk'],
     ['P-MAUL', 'Packung (6 Stk)', 6, 'Stk'], ['P-PIZZA', 'Doppelpackung', 2, 'Stk'], ['P-KUCHEN', 'Kuchen (8 Stücke)', 8, 'Stk'],
     ['P-MAAS', 'Stück 400 g', 400, 'g'], ['P-TOMATE', 'Schale 250 g', 250, 'g'], ['P-NUDEL', 'Packung 500 g', 500, 'g'],
     ['P-PASSATA', 'Packung 500 g', 500, 'g'], ['P-BRUEHE', 'Glas (5 l Brühe)', 5000, 'ml'], ['P-PARM', 'Stück 100 g', 100, 'g'],
     ['P-EI', '10er-Packung', 10, 'Stk'], ['P-SPUELI', 'Flasche 450 ml', 450, 'ml']
    ].forEach(function (x) { run({ type: 'confirm_package', product_id: x[0], label: x[1], content_qty: x[2], content_unit: x[3] }); });

    run({ type: 'confirm_alias', alias: 'Bio-Maasdamer', product_id: 'P-MAAS', source: 'bon' });
    run({ type: 'confirm_alias', alias: 'Chicken Burger Patties', product_id: 'P-PATTY', source: 'bon' });

    function R(id, name, cat, servings, minutes, steps, fav, ings) {
      T.Recipe.push({ recipe_id: id, name: name, category: cat, servings_base: servings, minutes: minutes, steps: steps.join('\n'), source_url: '', favorite: !!fav, disliked: false, repeat_every_days: 7, notes: '', version: 1, updated_at: plus(0) });
      ings.forEach(function (g, i) { T.RecipeIngredient.push({ recipe_id: id, line_no: i + 1, product_id: g[0], text_original: g[1], qty: g[2], unit: g[3], per: g[4] || 'Rezept', optional: false, note: '' }); });
    }
    R('R-BURGER', 'Chicken Burger', 'Schnell', 2, 15, ['Patties nach Packungsangabe braten.', 'Buns kurz anrösten.', 'Mit Salat und Gurke belegen.'], true, [
      ['P-PATTY', 'Chicken Patties', 1, 'Stk', 'Person'], ['P-BUN', 'Brioche Buns', 1, 'Stk', 'Person'],
      ['P-GURKE', 'Gurke', 0.5, 'Stk'], ['P-SALAT', 'Eisbergsalat', 0.25, 'Stk'], ['', 'Burgersoße', '', '']]);
    R('R-MAUL', 'Maultaschen in Brühe', 'Schnell', 2, 15, ['Brühe aufkochen.', 'Maultaschen 10 Minuten ziehen lassen.', 'Mit Zwiebel bestreuen.'], true, [
      ['P-MAUL', 'Maultaschen', 4, 'Stk', 'Person'], ['P-BRUEHE', 'Gemüsebrühe', 250, 'ml', 'Person'], ['P-ZWIEBEL', 'Zwiebel', 1, 'Stk']]);
    R('R-SPAG', 'Spaghetti mit Tomatensoße', 'Nudeln', 2, 20, ['Spaghetti kochen.', 'Zwiebel andünsten, passierte Tomaten zugeben, 10 Min. köcheln.', 'Mit Parmesan servieren.'], true, [
      ['P-NUDEL', 'Spaghetti', 125, 'g', 'Person'], ['P-PASSATA', 'Passierte Tomaten', 500, 'g'], ['P-ZWIEBEL', 'Zwiebel', 1, 'Stk'],
      ['P-PARM', 'Parmesan', 40, 'g'], ['', 'Salz, Pfeffer', '', '']]);
    R('R-SALAT', 'Bunter Salat mit Ei', 'Salat', 2, 15, ['Eier hart kochen.', 'Salat, Gurke und Tomaten schneiden.', 'Dressing anrühren und mischen.'], false, [
      ['P-SALAT', 'Eisbergsalat', 1, 'Stk'], ['P-GURKE', 'Gurke', 1, 'Stk'], ['P-TOMATE', 'Cherrytomaten', 250, 'g'],
      ['P-EI', 'Eier', 1, 'Stk', 'Person'], ['', 'Dressing', '', '']]);
    R('R-PIZZA', 'Pizza-Abend', 'Schnell', 2, 15, ['Ofen vorheizen.', 'Pizza nach Packungsangabe backen.'], false, [
      ['P-PIZZA', 'Pizza Margherita', 1, 'Stk', 'Person']]);
    R('R-OMELETT', 'Käse-Omelett', 'Schnell', 2, 10, ['Eier verquirlen.', 'In der Pfanne stocken lassen, Käse darüber.'], false, [
      ['P-EI', 'Eier', 3, 'Stk', 'Person'], ['', 'Bio-Maasdamer', 50, 'g', 'Person']]);

    // Bestand (Beispiel): gebucht wie echte Einkäufe → vollständig im Journal nachvollziehbar
    run({ type: 'purchase', source: 'Beispiel-Einkauf', date: plus(-3), market: 'Beispiel', lines: [
      { product_id: 'P-MILCH', qty: 2, unit: 'Pkg', location_id: 'KS', best_before: plus(6) },
      { product_id: 'P-PATTY', qty: 1, unit: 'Pkg', location_id: 'TK', best_before: plus(90) },
      { product_id: 'P-BUN', qty: 1, unit: 'Pkg', location_id: 'VK', best_before: plus(3) },
      { product_id: 'P-MAUL', qty: 1, unit: 'Pkg', location_id: 'KS', best_before: plus(2) },
      { product_id: 'P-PIZZA', qty: 1, unit: 'Pkg', location_id: 'TK', best_before: plus(120) },
      { product_id: 'P-MAAS', qty: 1, unit: 'Pkg', location_id: 'KS', best_before: plus(12) },
      { product_id: 'P-GURKE', qty: 1, unit: 'Stk', location_id: 'KS', best_before: '' },
      { product_id: 'P-NUDEL', qty: 2, unit: 'Pkg', location_id: 'VK', best_before: plus(300) },
      { product_id: 'P-PASSATA', qty: 1, unit: 'Pkg', location_id: 'VK', best_before: plus(200) },
      { product_id: 'P-ZWIEBEL', qty: 4, unit: 'Stk', location_id: 'VK' },
      { product_id: 'P-BRUEHE', qty: 1, unit: 'Pkg', location_id: 'VK', best_before: plus(400) },
      { product_id: 'P-APFEL', qty: 3, unit: 'Stk', location_id: 'KS' },
      { product_id: 'P-EI', qty: 1, unit: 'Pkg', location_id: 'KS', best_before: plus(9) }
    ] });
    var maas = EP.lotsOf(s, 'P-MAAS')[0];
    run({ type: 'open', lot_id: maas.lot_id, date: plus(-1) });
    run({ type: 'adjust', product_id: 'P-MAAS', location_id: 'KS', qty: -150, unit: 'g', note: 'Brotzeit' });
    run({ type: 'adjust', product_id: 'P-EI', location_id: 'KS', qty: -4, unit: 'Stk', note: 'Frühstück' });
    T.MinStock.push({ product_id: 'P-MILCH', location_id: '', min_qty_base: 2000, updated_at: plus(0) },
      { product_id: 'P-SPUELI', location_id: '', min_qty_base: 450, updated_at: plus(0) });

    // Wochenplan (aktuelle Woche, Mo–So)
    var ws = monday(new Date());
    var plan = ['R-SPAG', 'R-BURGER', 'R-MAUL', 'R-SALAT', 'R-PIZZA', 'R-BURGER', ''];
    var persons = [2, 2, 4, 2, 3, 4, 2];
    T.MealPlan.push({ week_start: ws, status: 'bestätigt', confirmed_at: plus(0), confirmed_by: 'Demo' });
    for (var i = 0; i < 7; i++) {
      var d = new Date(ws + 'T12:00:00'); d.setDate(d.getDate() + i);
      T.MealPlanEntry.push({ entry_id: 'MP-' + i, week_start: ws, date: iso(d), persons: persons[i], recipe_id: plan[i], status: plan[i] ? 'bestätigt' : '', note: '', updated_at: plus(0) });
    }
    return s;
  }
  return { build: build, iso: iso, monday: monday };
})();
