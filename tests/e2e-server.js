/* Lokaler Testserver für den Ende-zu-Ende-Test:
 *  - liefert die App aus (wie GitHub Pages)
 *  - beantwortet POST /exec mit dem ECHTEN backend/Code.gs gegen nachgebaute Google-Dienste (tests/gas-mock.js)
 *  - /__ctl zum Steuern im Test (Beispieldaten laden, Mails lesen, KI-Antworten, Offline schalten)
 * Start: node tests/e2e-server.js [port]
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const GAS = require('./gas-mock.js');

const root = path.join(__dirname, '..');
const port = Number(process.argv[2] || 8770);
const PAGE = fs.readFileSync(path.join(root, 'tests/fixtures/rezeptseite.html'), 'utf8');
const g = GAS.create({ fast: true, web: (url) => (url === 'https://rezepte.example.org/gnocchi' ? { body: PAGE } : null) });
g.props.set('GOOGLE_CLIENT_ID', 'client-123.apps.googleusercontent.com');
let offline = false, aiReply = null;

function seedDemo() {
  const ctx = { window: {}, Date, Math, JSON };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'core/domain.js'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'seed.js'), 'utf8') + '\nthis.__seed = Seed.build();', ctx);
  const seed = ctx.__seed;
  const db = g.ctx.tischLoad('TEST');
  Object.keys(db.store.tables).forEach((k) => { if (k !== 'User' && seed.tables[k]) db.store.tables[k] = JSON.parse(JSON.stringify(seed.tables[k])); });
  g.ctx.tischSave(db);
  return Object.keys(seed.tables).map((k) => k + ':' + seed.tables[k].length).join(' ');
}

g.setOpenAI((url, o) => {
  if (url.endsWith('/v1/audio/transcriptions')) return { body: { text: aiReply && aiReply.transcript || 'Zwei Gurken gekauft' } };
  const acts = (aiReply && aiReply.actions) || [{ raw: 'zwei Gurken gekauft', intent: 'add', product_text: 'Gurken', qty: 2, unit: 'Stk', location: null, best_before: null, condition: null, opened: false, question: null }];
  return { body: { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ actions: acts }) }] }] } };
});

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.webmanifest': 'application/manifest+json' };

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = req.url.split('?')[0];
    if (req.method === 'POST' && url === '/exec') {
      if (offline) { req.socket.destroy(); return; }
      const out = g.ctx.doPost({ postData: { contents: body } });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(out.content); return;
    }
    if (req.method === 'POST' && url === '/__ctl') {
      const c = JSON.parse(body || '{}'); let r = {};
      if (c.cmd === 'seed') r = { seeded: seedDemo() };
      if (c.cmd === 'mails') r = { mails: g.mails };
      if (c.cmd === 'offline') { offline = !!c.on; r = { offline }; }
      if (c.cmd === 'ai') { if (c.key) g.props.set('OPENAI_API_KEY', c.key); else g.props.delete('OPENAI_API_KEY'); aiReply = c.reply || null; r = { ai: !!c.key }; }
      if (c.cmd === 'stock') { const s = g.ctx.tischLoad('TEST').store; r = { lots: s.tables.StockLot, events: s.tables.StockEvent.length, users: s.tables.User, items: s.tables.ShoppingItem, plan: s.tables.MealPlanEntry, recipes: s.tables.Recipe, ings: s.tables.RecipeIngredient, products: s.tables.Product, aliases: s.tables.ProductAlias, ledger: g.ctx.EP.verifyLedger(s) }; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)); return;
    }
    let f = path.join(root, url === '/' ? 'index.html' : url);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nicht gefunden'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
}).listen(port, '127.0.0.1', () => console.log('E2E-Server auf http://127.0.0.1:' + port));
