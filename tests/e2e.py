"""Ende-zu-Ende-Test im echten Browser (Chromium, iPhone-Größe) mit ZWEI Personen auf zwei „Geräten“.
Backend = echtes backend/Code.gs gegen nachgebaute Google-Dienste (tests/e2e-server.js).
Die Google-Anmeldung selbst wird simuliert (fester Test-Ausweis), alles danach ist echt.

Start:  node tools/build-backend.js && python3 tests/e2e.py
"""
import json, os, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8770
BASE = f'http://127.0.0.1:{PORT}/'
SHOTS = os.environ.get('E2E_SHOTS', '/tmp/e2e-shots')
os.makedirs(SHOTS, exist_ok=True)
results = []


def ctl(cmd, **kw):
    req = urllib.request.Request(BASE + '__ctl', data=json.dumps(dict(cmd=cmd, **kw)).encode(), method='POST')
    return json.loads(urllib.request.urlopen(req).read())


PAGES = {}


def step(name, fn):
    try:
        fn(); results.append((True, name)); print('  ✓ ' + name)
    except Exception as e:  # noqa
        results.append((False, name)); print('  ✗ ' + name + '\n      ' + str(e).split('\n')[0][:300])
        for tag, pg in PAGES.items():
            try:
                pg.screenshot(path=f'{SHOTS}/FEHLER-{len(results)}-{tag}.png')
            except Exception:
                pass


INIT = """
localStorage.setItem('tisch-conn', JSON.stringify({ backendUrl: location.origin + '/exec', clientId: 'client-123.apps.googleusercontent.com', env: 'TEST' }));
window.__TOKEN = %s;
window.google = { accounts: { id: {
  initialize(c) { window.__gcb = c.callback; },
  renderButton(el) { const b = document.createElement('button'); b.id = 'g-test-btn'; b.className = 'btn'; b.textContent = 'Mit Google anmelden (Test)';
    b.onclick = () => window.__gcb({ credential: window.__TOKEN }); el.innerHTML = ''; el.appendChild(b); },
  disableAutoSelect() {}, prompt() {} } } };
"""


def device(browser, token, errors, tag):
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    ctx.add_init_script(INIT % json.dumps(token))
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(f'{tag}: {e}'))
    page.on('console', lambda m: errors.append(f'{tag}: {m.text}') if m.type == 'error' and 'Failed to load resource' not in m.text and 'ERR_' not in m.text else None)
    page.on('dialog', lambda d: d.accept())
    return ctx, page


def wait_toast(page, text, timeout=8000):
    page.wait_for_function('t => document.getElementById("toast").textContent.includes(t)', arg=text, timeout=timeout)


def idle(page):
    page.wait_for_function('() => !document.querySelector("#busy.on")', timeout=10000)


def total(page, pid):
    return page.evaluate('pid => EP.totalStock(window.__EP_APP.store(), pid)', pid)


def server_total(pid):
    s = ctl('stock')
    return round(sum(float(l['qty_base'] or 0) for l in s['lots'] if l['product_id'] == pid), 3)


def main():
    srv = subprocess.Popen(['node', os.path.join(ROOT, 'tests/e2e-server.js'), str(PORT)], stdout=subprocess.PIPE)
    srv.stdout.readline()
    errors = []
    try:
        ctl('seed')
        with sync_playwright() as p:
            b = p.chromium.launch()
            octx, owner = device(b, 'tok-besitzer', errors, 'Besitzer')
            wctx, wife = device(b, 'tok-frau', errors, 'Partnerin')
            PAGES.update(besitzer=owner, partnerin=wife)
            print('Ende-zu-Ende: zwei Personen, echtes Backend\n')

            def owner_login():
                owner.goto(BASE)
                owner.wait_for_selector('text=Willkommen bei Tischlein')
                owner.screenshot(path=f'{SHOTS}/01-anmeldung.png')
                owner.click('#g-test-btn')
                owner.wait_for_selector('.tabbar button', state='visible')
                assert 'Heute' in owner.inner_text('h1')
                assert total(owner, 'P-MAUL') == server_total('P-MAUL') > 0, 'Beispieldaten aus der Tabelle geladen'
            step('Besitzer meldet sich mit Google an und sieht die Daten aus der Tabelle', owner_login)

            def wife_login():
                wife.goto(BASE)
                wife.click('#g-test-btn')
                wife.wait_for_selector('text=Fast geschafft')
                assert not wife.is_visible('.tabbar'), 'ohne Freigabe keine Navigation'
                assert wife.evaluate('window.__EP_APP.store().tables.StockLot.length') == 0, 'ohne Freigabe keine Daten im Browser'
                wife.click('[data-action="access-request"]')
                wait_toast(wife, 'Anfrage gesendet')
                wife.wait_for_selector('text=Anfrage ist unterwegs')
                wife.screenshot(path=f'{SHOTS}/02-anfrage.png')
                mails = ctl('mails')['mails']
                assert len(mails) == 1 and 'partnerin@example.org' in mails[0]['body'], mails
            step('Partnerin meldet sich an → sieht nichts → fragt Zugang an → Besitzer bekommt eine Mail', wife_login)

            def approve():
                owner.click('.gear')
                owner.click('[data-action="users-load"]')
                owner.wait_for_selector('text=wartet auf Freigabe')
                owner.screenshot(path=f'{SHOTS}/03-freigabe.png')
                owner.click('[data-action="user-decide"][data-v="1"]')
                wait_toast(owner, 'Freigegeben')
                wife.click('[data-action="auth-check"]')
                wife.wait_for_selector('.tabbar button', state='visible')
                wife.click('.gear')
                assert 'Mitnutzer' in wife.inner_text('#view')
                assert 'Familienzugang' not in wife.inner_text('#view'), 'Mitnutzer verwaltet keine Personen'
                wife.click('[data-tab="today"]')
            step('Besitzer gibt in den Einstellungen frei → Partnerin tippt „Erneut prüfen“ → App ist offen', approve)

            def wife_books():
                before = server_total('P-MAUL')
                wife.click('[data-tab="pantry"]')
                wife.click('[data-action="pview"][data-v="list"]') if wife.is_visible('[data-action="pview"][data-v="list"]') else None
                wife.click('[data-action="product"][data-id="P-MAUL"] >> nth=0')
                wife.click('[data-action="pform-intent"][data-v="remove"]')
                wife.fill('[data-pform="qty"]', '2')
                wife.select_option('[data-pform="unit"]', 'Stk')
                loc = wife.eval_on_selector('[data-pform="loc"]', 'e => e.value')
                if not loc:
                    wife.select_option('[data-pform="loc"]', 'KS')
                wife.click('[data-action="pform-book"]')
                wait_toast(wife, 'Gebucht')
                idle(wife)
                after = server_total('P-MAUL')
                assert round(before - after, 3) == 2, (before, after)
                assert ctl('stock')['ledger']['ok']
                wife.click('#sheet .x')
            step('Partnerin nimmt 2 Maultaschen raus → in der Tabelle gebucht, Journal stimmt', wife_books)

            def owner_sees():
                owner.click('[data-action="resync"]'); idle(owner)
                wait_toast(owner, 'aktuellem Stand')
                assert total(owner, 'P-MAUL') == server_total('P-MAUL')
            step('Besitzer sieht die Änderung der Partnerin nach „Neu laden“', owner_sees)

            def wife_cooks():
                wife.click('[data-tab="today"]')
                if not wife.is_visible('.tonight [data-action="cook"]'):
                    raise AssertionError('kein Gericht für heute im Beispielplan')
                ev0 = ctl('stock')['events']
                wife.click('.tonight [data-action="cook"]')
                wife.wait_for_selector('[data-action="cook-confirm"]')
                wife.screenshot(path=f'{SHOTS}/04-kochen.png')
                wife.click('[data-action="cook-confirm"]')
                wife.wait_for_selector('text=Gebucht ✓')
                wife.screenshot(path=f'{SHOTS}/05-gebucht.png')
                s = ctl('stock')
                assert s['events'] > ev0 and s['ledger']['ok']
                assert any(e['status'] == 'gekocht' for e in s['plan']), 'Plan zeigt gekocht'
                wife.click('text=Fertig')
            step('Partnerin tippt „Gekocht“ → Zutaten abgebucht, Plan steht auf gekocht', wife_cooks)

            def check_item():
                wife.click('[data-tab="shopping"]')
                el = wife.query_selector('[data-action="shop-check"]')
                if not el:
                    raise AssertionError('keine Position auf der Liste')
                iid = el.get_attribute('data-item')
                el.click(); idle(wife)
                items = {i['item_id']: i for i in ctl('stock')['items']}
                assert items.get(iid, {}).get('checked') is True, ('Position', iid, items.get(iid), 'gespeichert:', list(items.keys())[:8])
                owner.evaluate('document.getElementById("toast").textContent = ""')
                owner.click('[data-action="resync"]'); idle(owner); wait_toast(owner, 'aktuellem Stand')
                assert owner.evaluate('id => window.__EP_APP.store().tables.ShoppingItem.some(i => i.item_id === id && i.checked === true)', iid)
            step('Häkchen auf der Einkaufsliste wird gespeichert und ist beim Besitzer sichtbar (keine Bestandsbuchung)', check_item)

            def session_and_ai():
                ctl('ai', key='sk-test')
                wife.reload()
                wife.wait_for_selector('.tabbar button', state='visible')  # ohne erneute Anmeldung
                before = server_total('P-GURKE')
                wife.click('#fab')
                wife.fill('#voiceText', 'zwei Gurken gekauft')
                wife.click('[data-action="voice-parse"]')
                wife.wait_for_selector('.action-card')
                if not wife.eval_on_selector('[data-act="loc"]', 'e => e.value'):
                    wife.select_option('[data-act="loc"]', 'KS')
                wife.screenshot(path=f'{SHOTS}/06-sprache.png')
                wife.click('[data-action="voice-book"]')
                wait_toast(wife, 'gebucht')
                idle(wife)
                assert round(server_total('P-GURKE') - before, 3) == 2
            step('Partnerin öffnet die App erneut (bleibt angemeldet) und bucht per KI-Sprache „zwei Gurken gekauft“', session_and_ai)

            def offline():
                ev0 = ctl('stock')['events']
                ctl('offline', on=True)
                wife.click('[data-tab="pantry"]')
                wife.click('[data-action="product"][data-id="P-GURKE"] >> nth=0')
                wife.click('[data-action="pform-intent"][data-v="remove"]')
                wife.fill('[data-pform="qty"]', '1')
                if not wife.eval_on_selector('[data-pform="loc"]', 'e => e.value'):
                    wife.select_option('[data-pform="loc"]', 'KS')
                wife.click('[data-action="pform-book"]')
                wait_toast(wife, 'nichts gespeichert', timeout=15000)
                ctl('offline', on=False)
                assert ctl('stock')['events'] == ev0
                assert 'Gebucht' not in wife.inner_text('#toast')
                wife.click('#sheet .x')
            step('Kein Netz → klare Meldung „nichts gespeichert“, kein falscher Erfolg', offline)

            def revoke():
                owner.click('[data-action="users-load"]') if owner.is_visible('[data-action="users-load"]') else None
                owner.wait_for_selector('text=Entziehen')
                owner.click('text=Entziehen')
                wait_toast(owner, 'entzogen')
                wife.click('[data-tab="today"]')
                wife.click('.tonight [data-action="recipe"]') if wife.is_visible('.tonight [data-action="recipe"]') else None
                # beliebige Änderung versuchen
                wife.evaluate("window.__EP_APP.run({ type: 'create_location', name: 'Gartenhaus' })")
                wife.wait_for_selector('text=Kein Zugang', timeout=10000)
                assert not wife.is_visible('#sheet.open'), 'offenes Fenster geschlossen'
                assert wife.evaluate('window.__EP_APP.store().tables.StockLot.length') == 0, 'Daten vom Gerät entfernt'
                assert wife.evaluate('localStorage.getItem("tisch-cache-TEST")') in (None, 'null')
                assert not any(l['name'] == 'Gartenhaus' for l in ctl('stock').get('locations', [])), 'nichts gebucht'
                wife.screenshot(path=f'{SHOTS}/08-gesperrt.png')
            step('Besitzer entzieht den Zugang → Partnerin ist sofort gesperrt', revoke)

            def logout():
                owner.click('[data-action="logout"] >> nth=0')
                owner.wait_for_selector('text=Willkommen bei Tischlein')
                assert owner.evaluate('localStorage.getItem("tisch-session")') in (None, 'null')
            step('Abmelden entfernt Sitzung und zwischengespeicherte Daten', logout)

            # ---------------- Demo-Modus (ohne Backend): alle umgebauten Aktionen
            dctx = b.new_context(viewport={'width': 390, 'height': 844})
            demo = dctx.new_page()
            demo.on('pageerror', lambda e: errors.append(f'Demo: {e}'))
            demo.on('dialog', lambda d: d.accept())

            def demo_flow():
                demo.goto(BASE)
                demo.wait_for_selector('.tabbar button')
                demo.click('[data-tab="week"]')
                demo.click('[data-action="persons"][data-d="1"] >> nth=0');
                demo.click('[data-action="suggest"]')
                demo.click('[data-action="confirm-plan"]') if demo.is_enabled('[data-action="confirm-plan"]') else None
                demo.click('[data-tab="shopping"]')
                demo.fill('#addItem', '2 Gurken'); demo.click('[data-action="add-item"]'); wait_toast(demo, 'Hinzugefügt')
                demo.click('[data-action="shop-check"] >> nth=0')
                demo.click('[data-tab="cookbook"]')
                demo.click('[data-action="new-recipe"]')
                demo.fill('[data-draft="name"]', 'Testnudeln')
                demo.fill('[data-draft="ingredients"]', '200 g Spaghetti\n1 Gurke')
                demo.click('[data-action="save-recipe"]'); wait_toast(demo, 'Rezept gespeichert')
                assert demo.evaluate("window.__EP_APP.store().tables.Recipe.some(r => r.name === 'Testnudeln')")
                assert demo.evaluate('EP.verifyLedger(window.__EP_APP.store()).ok')
                demo.screenshot(path=f'{SHOTS}/07-demo.png')
            step('Demo-Modus: Personen, Vorschläge, Liste, Häkchen, neues Rezept funktionieren weiter', demo_flow)

            b.close()
    finally:
        srv.terminate()
    bad = [e for e in errors]
    if bad:
        results.append((False, 'Keine JavaScript-Fehler')); print('  ✗ JavaScript-Fehler:\n      ' + '\n      '.join(bad[:10]))
    else:
        results.append((True, 'Keine JavaScript-Fehler')); print('  ✓ Keine JavaScript-Fehler in beiden Browsern')
    ok = sum(1 for r in results if r[0])
    print(f'\n{ok} bestanden, {len(results) - ok} fehlgeschlagen   (Bildschirmfotos: {SHOTS})')
    sys.exit(0 if ok == len(results) else 1)


if __name__ == '__main__':
    main()
