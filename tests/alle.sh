#!/bin/sh
# Alle Prüfungen: Fachlogik, Wochenlauf, Backend gegen nachgebaute Google-Dienste, Klicktest mit zwei Personen.
# Bricht beim ersten Fehler ab und zeigt dann die vollständige Ausgabe.
cd "$(dirname "$0")/.."
pruefe() { titel="$1"; shift; out=$("$@" 2>&1) || { echo "== $titel: FEHLER"; echo "$out"; exit 1; }; echo "== $titel: $(echo "$out" | tail -1)"; }
pruefe "Fachlogik"           node tests/run.js
pruefe "Wochen-Testlauf"     node tests/szenarien.js
pruefe "Backend bauen"       node tools/build-backend.js
pruefe "Backend (langsamer Weg)" node tests/backend.js
pruefe "Backend (Sheets-Dienst)" env TISCH_FAST=1 node tests/backend.js
pruefe "Klicktest (Browser)" python3 tests/e2e.py
