/* Tischlein – Illustrationen & Icons als Vektor (SVG).
 * Farben kommen über CSS-Klassen (f-*, s-*), damit Hell/Dunkel-Modus automatisch passt. */
var Illus = (function () {
  'use strict';

  function svg(vb, body, cls) { return '<svg class="' + (cls || 'ill') + '" viewBox="' + vb + '" aria-hidden="true" focusable="false">' + body + '</svg>'; }

  // ---------------------------------------------------------------- Gerichte
  var plate = '<ellipse cx="32" cy="36" rx="28" ry="24" class="f-plate"/><ellipse cx="32" cy="36" rx="21" ry="17.5" class="f-plate2"/>';
  var DISH = {
    pasta: plate +
      '<path d="M18 36c3-7 10-9 15-6s10 1 13-3M17 40c5-3 9-1 13 1s11 2 16-3M20 44c4-2 8 0 12 1s9 0 12-3M22 32c4-3 8-3 12-1s8 1 10-1" class="s-pasta" fill="none" stroke-width="2.6" stroke-linecap="round"/>' +
      '<path d="M28 31c3-3 9-3 11 0s-1 7-6 7-8-4-5-7z" class="f-pap"/><circle cx="31" cy="33" r="1.6" class="f-pap2"/><circle cx="35.5" cy="34.5" r="1.3" class="f-pap2"/>' +
      '<path d="M38 27c2-3 6-3 7-1-2 1-4 3-7 1z" class="f-sal"/>',
    burger: plate +
      '<path d="M15 31c0-9 8-14 17-14s17 5 17 14z" class="f-bun"/><circle cx="25" cy="23" r=".9" class="f-seed"/><circle cx="31" cy="20.5" r=".9" class="f-seed"/><circle cx="37" cy="23" r=".9" class="f-seed"/><circle cx="29" cy="26" r=".9" class="f-seed"/><circle cx="35" cy="27" r=".9" class="f-seed"/>' +
      '<path d="M13 32c3 2 5-1 8 1s5-1 8 1 5-1 8 1 5-1 8 1 4-1 6 0v2H13z" class="f-sal"/>' +
      '<rect x="14" y="34.5" width="36" height="5.5" rx="2.6" class="f-patty"/><path d="M15 40.5h34" class="s-kur" stroke-width="2.4" stroke-linecap="round"/>' +
      '<path d="M15 42h34c0 4-4 6-8 6H23c-4 0-8-2-8-6z" class="f-bun"/>',
    soup: '<path d="M8 32h48c0 13-11 20-24 20S8 45 8 32z" class="f-bowl"/><ellipse cx="32" cy="32" rx="24" ry="5" class="f-broth"/>' +
      '<path d="M18 31c0-2.5 3-4 6-4s6 1.5 6 4-3 3-6 3-6-.5-6-3z" class="f-dump"/><path d="M33 32c0-2.5 3-4 6-4s6 1.5 6 4-3 3-6 3-6-.5-6-3z" class="f-dump"/>' +
      '<circle cx="29" cy="30" r="1" class="f-sal"/><circle cx="41" cy="33" r="1" class="f-sal"/><circle cx="23" cy="34" r=".9" class="f-sal"/>' +
      '<path d="M24 22c-2-3 2-4 0-8M32 21c-2-3 2-4 0-8M40 22c-2-3 2-4 0-8" class="s-steam" fill="none" stroke-width="2" stroke-linecap="round"/>',
    salad: '<path d="M8 32h48c0 13-11 20-24 20S8 45 8 32z" class="f-bowl"/>' +
      '<path d="M10 33c1-8 7-12 12-10 2-6 10-8 14-3 5-3 12 0 13 5 4 1 6 5 5 8z" class="f-sal"/>' +
      '<path d="M16 31c4-4 9-5 12-2M30 26c4-2 9-1 11 3" class="s-sal2" fill="none" stroke-width="1.6" stroke-linecap="round"/>' +
      '<circle cx="24" cy="29" r="3.4" class="f-pap"/><circle cx="38" cy="30" r="3" class="f-pap"/><circle cx="31" cy="25" r="2.6" class="f-pap"/>' +
      '<ellipse cx="44" cy="25.5" rx="3.6" ry="2.6" class="f-egg"/><circle cx="44" cy="25.5" r="1.4" class="f-kur"/>',
    pizza: plate + '<circle cx="32" cy="36" r="19" class="f-crust"/><circle cx="32" cy="36" r="16" class="f-pap"/>' +
      '<path d="M22 31c4 2 6-2 10 0s7-1 10 1M21 41c4-2 7 1 11-1s7 1 11-1" class="s-cheese" fill="none" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M32 20v32M16 36h32M21 25l22 22M43 25 21 47" class="s-cut" stroke-width="1" opacity=".5"/>' +
      '<circle cx="27" cy="30" r="2" class="f-sal"/><circle cx="38" cy="40" r="2" class="f-sal"/><circle cx="36" cy="29" r="1.8" class="f-sal"/>',
    egg: '<circle cx="30" cy="36" r="20" class="f-pan"/><path d="M50 36h11" class="s-panh" stroke-width="5" stroke-linecap="round"/>' +
      '<path d="M18 36c0-8 6-12 12-11s9 3 11 7-1 10-7 12-16 0-16-8z" class="f-egg"/><circle cx="30" cy="35" r="5" class="f-kur"/><circle cx="28.5" cy="33.5" r="1.3" class="f-shine"/>',
    plate: plate + '<path d="M18 38a14 12 0 0 1 28 0z" class="f-cloche"/><circle cx="32" cy="24" r="2" class="f-cloche"/><path d="M15 39h34" class="s-ink" stroke-width="2" stroke-linecap="round"/>'
  };
  function dishKind(r) {
    var n = ((r && r.name) || '') + ' ' + ((r && r.category) || '');
    n = n.toLowerCase();
    if (/nudel|spaghetti|pasta|penne|lasagne|tortellini|spätzle/.test(n)) return 'pasta';
    if (/burger|sandwich|wrap|hotdog/.test(n)) return 'burger';
    if (/maultasche|suppe|brühe|eintopf|curry|chili/.test(n)) return 'soup';
    if (/salat|bowl/.test(n)) return 'salad';
    if (/pizza|flammkuchen/.test(n)) return 'pizza';
    if (/omelett|ei\b|eier|rührei|pfannkuchen/.test(n)) return 'egg';
    return 'plate';
  }
  // Echtes Bild (img/bilder.js), sonst Vektor. Lädt das Bild nicht, springt der Vektor ein.
  function pic(key, cls, fallbackSvg) {
    var b = (typeof BILDER !== 'undefined') && BILDER[key];
    if (!b) return fallbackSvg;
    return '<span class="pic ' + cls + '"><img src="' + b.src + '" width="' + b.w + '" height="' + b.h + '" alt="" decoding="async" loading="lazy" ' +
      'onerror="this.parentNode.classList.add(\'fail\')">' + fallbackSvg + '</span>';
  }
  function dishSvg(r, cls) { return svg('0 0 64 64', DISH[dishKind(r)], cls || 'dish'); }
  function dish(r, cls) { return pic('dish-' + dishKind(r), cls || 'dish', dishSvg(r, 'fb')); }

  // --------------------------------------------------------------- Szenen (Kopf)
  var SCENE = {
    today: '<rect x="0" y="78" width="180" height="22" rx="4" class="f-wood"/><rect x="0" y="78" width="180" height="4" class="f-wood2"/>' +
      '<ellipse cx="92" cy="74" rx="44" ry="10" class="f-shadow"/><ellipse cx="92" cy="70" rx="42" ry="11" class="f-plate"/><ellipse cx="92" cy="69" rx="32" ry="7.5" class="f-plate2"/>' +
      '<path d="M66 68c6-12 16-15 26-13s18-1 22 8c-14 8-34 9-48 5z" class="f-pap"/><path d="M74 63c5-3 9-2 13 0M92 60c4-2 9-1 12 2" class="s-pasta" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M96 56c3-4 8-3 9 0-3 1-6 3-9 0z" class="f-sal"/>' +
      '<path d="M84 44c-3-5 3-7 0-13M95 42c-3-5 3-7 0-13" class="s-steam" fill="none" stroke-width="2.4" stroke-linecap="round"/>' +
      '<path d="M40 52v22M36 52v6c0 3 8 3 8 0v-6" class="s-ink" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M146 50c4 0 5 8 1 12v12" class="s-ink" stroke-width="2.4" fill="none" stroke-linecap="round"/>' +
      '<rect x="160" y="40" width="7" height="30" rx="2" class="f-zit"/><path d="M163.5 40c-3-4 0-9 0-11 0 2 3 7 0 11z" class="f-kur"/>',
    week: '<rect x="30" y="18" width="128" height="74" rx="10" class="f-card"/><rect x="30" y="18" width="128" height="18" rx="10" class="f-aub"/><rect x="30" y="28" width="128" height="8" class="f-aub"/>' +
      '<circle cx="54" cy="18" r="3.5" class="f-ink"/><circle cx="134" cy="18" r="3.5" class="f-ink"/>' +
      [0, 1, 2, 3, 4, 5, 6].map(function (i) { var x = 38 + (i % 4) * 30, y = 44 + Math.floor(i / 4) * 22; return '<rect x="' + x + '" y="' + y + '" width="22" height="16" rx="4" class="' + (i === 2 ? 'f-kur' : i === 5 ? 'f-sal' : 'f-plate2') + '"/>'; }).join('') +
      '<path d="M128 72c4-8 12-10 16-6-2 6-10 10-16 6z" class="f-sal"/><path d="M128 72l12-6" class="s-sal2" stroke-width="1.2"/>',
    cookbook: '<path d="M30 30c18-6 34-4 52 6v52c-18-10-34-12-52-6z" class="f-card"/><path d="M134 30c-18-6-34-4-52 6v52c18-10 34-12 52-6z" class="f-card2"/>' +
      '<path d="M40 42c10-3 22-2 32 3M40 52c10-3 22-2 32 3M40 62c10-3 18-2 26 2M92 45c10-5 22-6 32-3M92 55c10-5 22-6 32-3" class="s-line" stroke-width="2" fill="none" stroke-linecap="round"/>' +
      '<path d="M82 36v52" class="s-ink" stroke-width="1.5" opacity=".4"/>' +
      '<path d="M140 92c6-22 10-40 6-60" class="s-salk" stroke-width="2" fill="none" stroke-linecap="round"/>' +
      '<path d="M146 40c6-2 10 2 9 6-5 1-9-1-9-6zM144 54c6-2 10 2 9 6-5 1-9-1-9-6zM140 68c6-2 10 2 9 6-5 1-9-1-9-6zM146 48c-6-2-10 2-9 6 5 1 9-1 9-6zM143 62c-6-2-10 2-9 6 5 1 9-1 9-6z" class="f-sal"/>' +
      '<path d="M108 74l30 12" class="s-ink" stroke-width="3" stroke-linecap="round"/><ellipse cx="106" cy="73" rx="7" ry="4.5" transform="rotate(22 106 73)" class="f-aub"/>',
    shopping: '<path d="M70 26c0-10 7-15 16-15s16 5 16 15" class="s-aub" stroke-width="4" fill="none"/>' +
      '<path d="M86 22l10 2 6-20 5 2-6 20" class="f-sal"/><path d="M58 30c2-12 6-20 8-22l4 2c-3 6-5 14-6 22" class="f-kur"/><path d="M106 34l22-26 5 3-20 26" class="f-crust"/><path d="M112 27l5 3M118 20l5 3M124 13l5 3" class="s-ink" stroke-width="1.4" opacity=".4"/>' +
      '<path d="M50 34h76l-6 56c-1 4-4 6-8 6H64c-4 0-7-2-8-6z" class="f-aub"/><path d="M58 46h60" class="s-plate" stroke-width="2" opacity=".35"/>' +
      '<circle cx="74" cy="66" r="9" class="f-pap"/><path d="M74 57c1-3 4-4 6-3" class="s-sal2" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="98" cy="70" r="11" class="f-zit"/>',
    offers: '<path d="M60 30h50l26 30-26 30H60z" class="f-kur" transform="rotate(-8 98 60)"/><circle cx="74" cy="56" r="6" class="f-bg" transform="rotate(-8 98 60)"/>' +
      '<path d="M98 50l-16 26" class="s-white" stroke-width="4" stroke-linecap="round"/><circle cx="85" cy="54" r="4.5" class="s-white" stroke-width="3.5" fill="none"/><circle cx="102" cy="72" r="4.5" class="s-white" stroke-width="3.5" fill="none"/>' +
      '<path d="M74 56C60 50 52 40 54 22" class="s-ink" stroke-width="2" fill="none" stroke-linecap="round"/>' +
      '<circle cx="142" cy="78" r="13" class="f-pap"/><path d="M142 65c0-5 3-8 7-9" class="s-ink" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M144 63c5-5 11-3 12 0-5 3-9 3-12 0z" class="f-sal"/>',
    pantry: '<rect x="36" y="44" width="124" height="5" rx="2" class="f-wood"/><rect x="36" y="90" width="124" height="5" rx="2" class="f-wood"/><rect x="38" y="10" width="5" height="85" class="f-wood2"/><rect x="153" y="10" width="5" height="85" class="f-wood2"/>' +
      jar(52, 16, 20, 28, 'f-kur', .7) + jar(78, 22, 16, 22, 'f-sal', .55) + jar(100, 14, 22, 30, 'f-pap', .8) + jar(128, 20, 18, 24, 'f-zit', .45) +
      jar(54, 60, 24, 30, 'f-crust', .6) + jar(84, 64, 18, 26, 'f-aub2', .7) + '<ellipse cx="124" cy="82" rx="16" ry="8" class="f-crust"/><path d="M110 78c4-8 24-8 28 0" class="f-wood"/>'
  };
  function jar(x, y, w, h, fillCls, level) {
    var fh = (h - 6) * level;
    return '<rect x="' + (x + 2) + '" y="' + y + '" width="' + (w - 4) + '" height="4" rx="1.5" class="f-lid"/>' +
      '<rect x="' + x + '" y="' + (y + 4) + '" width="' + w + '" height="' + (h - 4) + '" rx="4" class="f-glass"/>' +
      '<rect x="' + (x + 2) + '" y="' + (y + h - 2 - fh) + '" width="' + (w - 4) + '" height="' + fh + '" rx="2.5" class="' + fillCls + '"/>' +
      '<rect x="' + (x + 3) + '" y="' + (y + 7) + '" width="2" height="' + (h - 14) + '" rx="1" class="f-shine" opacity=".7"/>';
  }
  function sceneSvg(name, cls) { return SCENE[name] ? svg('0 0 180 100', SCENE[name], cls || 'scene') : ''; }
  function scene(name) { return SCENE[name] ? pic('scene-' + name, 'scene', sceneSvg(name, 'fb')) : ''; }

  // ---------------------------------------------------------------- Abteilungen
  var DEPT = {
    'Obst & Gemüse': '<path d="M9 22c-3-2-4-6-1-11 3-4 8-5 11-4L12 22z" class="f-kur"/><path d="M17 9c1-3 4-4 6-3-1 2-3 3-6 3zM18 8c0-3 1-5 3-6" class="s-salk" stroke-width="1.6" fill="none"/><path d="M11 14l3 1M10 18l2 1" class="s-ink" stroke-width="1" opacity=".3"/>',
    'Brot & Backwaren': '<path d="M4 15c0-5 5-8 10-8s10 3 10 8v5c0 1-1 2-2 2H6c-1 0-2-1-2-2z" class="f-crust"/><path d="M10 10l-1 4M14 9v5M18 10l1 4" class="s-ink" stroke-width="1.3" opacity=".35" stroke-linecap="round"/>',
    'Kühlregal': '<path d="M8 8l3-5h6l3 5v15H8z" class="f-plate2"/><path d="M8 8h12" class="s-ink" stroke-width="1.2" opacity=".3"/><rect x="10" y="12" width="8" height="6" rx="1" class="f-sal"/>',
    'Tiefkühl': '<path d="M14 3v22M4.5 8.5l19 11M4.5 19.5l19-11M11 4l3 3 3-3M11 24l3-3 3 3" class="s-frost" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    'Vorrat': jarSmall('f-kur'),
    'Haushalt': '<rect x="5" y="11" width="18" height="11" rx="3" class="f-zit"/><rect x="5" y="11" width="18" height="4" rx="2" class="f-sal"/><circle cx="20" cy="6" r="2" class="f-plate2"/><circle cx="16" cy="4" r="1.3" class="f-plate2"/>',
    'Sonstiges': '<circle cx="14" cy="14" r="9" class="f-plate2"/><circle cx="10" cy="14" r="1.5" class="f-ink"/><circle cx="14" cy="14" r="1.5" class="f-ink"/><circle cx="18" cy="14" r="1.5" class="f-ink"/>',
    'Unklar': '<circle cx="14" cy="14" r="10" class="f-kur" opacity=".35"/><path d="M11 11c0-2 1.5-3 3-3s3 1 3 3c0 2-3 2-3 5M14 20v.5" class="s-ink" stroke-width="2" fill="none" stroke-linecap="round"/>'
  };
  function jarSmall(c) { return '<rect x="9" y="3" width="10" height="3" rx="1" class="f-lid"/><rect x="7" y="6" width="14" height="18" rx="3" class="f-glass"/><rect x="9" y="12" width="10" height="10" rx="2" class="' + c + '"/>'; }
  function dept(name) { return svg('0 0 28 28', DEPT[name] || DEPT['Sonstiges'], 'dept'); }

  // ---------------------------------------------------------------- Tab-Icons
  var TAB = {
    today: '<ellipse cx="12" cy="13" rx="7.5" ry="7.5"/><ellipse cx="12" cy="13" rx="4" ry="4"/><path d="M2.5 4v5.5M1 4v3a1.5 1.5 0 0 0 3 0V4M2.5 9.5V22M21.5 4c-1.8 0-2.5 3-2.5 6 0 1.5 1 2 2.5 2V22"/>',
    week: '<rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/><circle cx="8" cy="14" r="1.2" class="dotfill"/><circle cx="12" cy="14" r="1.2" class="dotfill"/><circle cx="16" cy="14" r="1.2" class="dotfill"/>',
    cookbook: '<path d="M12 6.5C9.5 4.8 6.5 4.3 3 4.8v14c3.5-.5 6.5 0 9 1.7 2.5-1.7 5.5-2.2 9-1.7v-14c-3.5-.5-6.5 0-9 1.7z"/><path d="M12 6.5v14"/>',
    shopping: '<path d="M5 8.5h14l-1.2 11.3a2 2 0 0 1-2 1.7H8.2a2 2 0 0 1-2-1.7z"/><path d="M8.5 8.5V7a3.5 3.5 0 0 1 7 0v1.5"/><path d="M14 4.5 17 1.5"/>',
    offers: '<path d="M3 12.2V4.5A1.5 1.5 0 0 1 4.5 3h7.7l8.8 8.8a1.5 1.5 0 0 1 0 2.1l-7.1 7.1a1.5 1.5 0 0 1-2.1 0z"/><circle cx="8" cy="8" r="1.6"/>',
    pantry: '<path d="M8 3h8v3H8z"/><path d="M7 6h10a2 2 0 0 1 2 2v11a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 19V8a2 2 0 0 1 2-2z"/><path d="M5 12.5c2.5 1.2 4.5-1.2 7 0s4.5 1.2 7 0"/>',
    settings: '<path d="M10.3 3.2a1.8 1.8 0 0 1 3.4 0l.3.9a1.8 1.8 0 0 0 2.4 1l.9-.4a1.8 1.8 0 0 1 2.4 2.4l-.4.9a1.8 1.8 0 0 0 1 2.4l.9.3a1.8 1.8 0 0 1 0 3.4l-.9.3a1.8 1.8 0 0 0-1 2.4l.4.9a1.8 1.8 0 0 1-2.4 2.4l-.9-.4a1.8 1.8 0 0 0-2.4 1l-.3.9a1.8 1.8 0 0 1-3.4 0l-.3-.9a1.8 1.8 0 0 0-2.4-1l-.9.4a1.8 1.8 0 0 1-2.4-2.4l.4-.9a1.8 1.8 0 0 0-1-2.4l-.9-.3a1.8 1.8 0 0 1 0-3.4l.9-.3a1.8 1.8 0 0 0 1-2.4l-.4-.9a1.8 1.8 0 0 1 2.4-2.4l.9.4a1.8 1.8 0 0 0 2.4-1z"/><circle cx="12" cy="12" r="3.2"/>',
    mic: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5"/>'
  };
  function tab(name) { return '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">' + TAB[name] + '</svg>'; }

  return { dish: dish, dishSvg: dishSvg, dishKind: dishKind, scene: scene, sceneSvg: sceneSvg, dept: dept, tab: tab };
})();
