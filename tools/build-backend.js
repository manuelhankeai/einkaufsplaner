#!/usr/bin/env node
/* Fügt Fachlogik und Backend zu EINER Datei zusammen: backend/Code.gs (zum Einfügen in Apps Script). */
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const domain = fs.readFileSync(path.join(root, 'core/domain.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'backend/server.js'), 'utf8');
const out = '/* Tischlein – Apps-Script-Backend. AUTOMATISCH ERZEUGT aus core/domain.js + backend/server.js\n' +
  ' * (node tools/build-backend.js). Nicht von Hand ändern – Änderungen im Repository machen. */\n\n' +
  domain + '\n\n' + server;
fs.writeFileSync(path.join(root, 'backend/Code.gs'), out);
console.log('backend/Code.gs geschrieben (' + Math.round(out.length / 1024) + ' KB)');
