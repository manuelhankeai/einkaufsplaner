# Tischlein einrichten (einmalig, ca. 20 Minuten, am Computer)

Alles im Konto **manuel.hanke.ai@gmail.com**. Nichts davon berührt die ChatGPT-Version.
Du brauchst am Ende zwei Werte für die App: **Backend-Adresse** (Schritt 2) und **Client-ID** (Schritt 1).

## 1. Google-Anmeldung erlauben (Google Cloud, neues Projekt)

1. https://console.cloud.google.com öffnen (als manuel.hanke.ai@gmail.com angemeldet).
2. Oben Projektauswahl → **Neues Projekt** → Name `Tischlein` → Erstellen. *(Nicht `einkaufsplaner-514913` verwenden – das gehört der ChatGPT-Version.)*
3. Menü → **Google Auth Platform** → **Jetzt starten**:
   - App-Name `Tischlein`, Support-E-Mail: deine Adresse
   - Zielgruppe: **Extern**
   - Kontakt-E-Mail: deine Adresse → Zustimmen → Erstellen
4. **Zielgruppe** → **Testnutzer** → **Nutzer hinzufügen**: deine Adresse und die deiner Frau.
   *(Die App fragt nur Name und E-Mail ab. Dafür ist keine Prüfung durch Google nötig. Beim ersten Anmelden zeigt Google einen Hinweis „App wird getestet“ – einfach fortfahren.)*
5. **Clients** → **Client erstellen** → Typ **Webanwendung**, Name `Tischlein Web`
   - Autorisierte JavaScript-Quellen: `https://manuelhankeai.github.io`
   - Autorisierte Weiterleitungs-URIs: `https://manuelhankeai.github.io/einkaufsplaner/`
   - Erstellen → **Client-ID kopieren** (endet auf `.apps.googleusercontent.com`). Ein Client-Secret wird nicht gebraucht.

## 2. Backend anlegen (Google Apps Script)

1. https://script.google.com → **Neues Projekt** → oben links umbenennen in `Tischlein Backend`.
2. Den Inhalt von `Code.gs` komplett ersetzen durch die Datei
   https://raw.githubusercontent.com/manuelhankeai/einkaufsplaner/main/backend/Code.gs
   (Seite öffnen, alles markieren, kopieren, im Editor einfügen) → **Speichern**.
3. Links **Projekteinstellungen** (Zahnrad):
   - Zeitzone: `(GMT+01:00) Berlin`
   - Unten **Skripteigenschaften** → Eigenschaft hinzufügen: `GOOGLE_CLIENT_ID` = die Client-ID aus Schritt 1 → Speichern.
4. Zurück in den **Editor**, oben in der Funktionsauswahl `einrichtungPruefen` wählen → **Ausführen**.
   Google fragt nach Berechtigungen → Konto wählen → „Google hat diese App nicht überprüft“ → **Erweitert** → **Zu Tischlein Backend wechseln** → **Zulassen**.
   Im Protokoll muss stehen: `TEST: OK …`, `PROD: OK …`, `GOOGLE_CLIENT_ID: gesetzt`.
5. Oben rechts **Bereitstellen → Neue Bereitstellung** → Zahnrad → **Web-App**:
   - Beschreibung `Tischlein 1.0`
   - Ausführen als: **Ich (manuel.hanke.ai@gmail.com)**
   - Zugriff: **Jeder**
   - Bereitstellen → **Web-App-URL kopieren** (endet auf `/exec`).

   *„Jeder“ heißt nur, dass die Adresse erreichbar ist. Daten gibt das Backend ausschließlich nach Google-Anmeldung und deiner Freigabe heraus. Geschrieben wird nur in `Einkaufsplaner_Claude_TEST` und `_PROD`.*

## 3. App verbinden

Schick mir die beiden Werte (Backend-URL und Client-ID). Ich trage sie fest in die App ein, dann muss niemand etwas eintippen.
*(Alternativ selbst: App öffnen → Einstellungen → „Mit Google-Tabelle verbinden“.)*

Die App startet mit der **Test**-Datenbasis. Auf „Echt“ (PROD) schaltest du in den Einstellungen um, wenn alles passt.

## 4. Auf dem iPhone (du und deine Frau)

1. In **Safari** https://manuelhankeai.github.io/einkaufsplaner/ öffnen → **Mit Google anmelden**.
2. Deine Frau tippt danach **Zugang anfragen**. Du bekommst eine E-Mail → App → Einstellungen → Familienzugang → **Freigeben**. Sie tippt **Erneut prüfen**.
3. Erst **nach** dem Anmelden: Teilen → **Zum Home-Bildschirm**. Die Anmeldung wird mitgenommen (60 Tage, verlängert sich bei Nutzung).

## 5. Optional: KI-Diktat (OpenAI)

1. https://platform.openai.com → Billing: Guthaben aufladen (ab 5 $; das ist **nicht** ChatGPT Plus).
2. API keys → **Create new secret key** → kopieren.
3. Apps Script → Projekteinstellungen → Skripteigenschaft `OPENAI_API_KEY` = Schlüssel. *(Nirgends sonst eintragen, nicht in den Chat.)*
4. Im Editor `kiTesten` ausführen → im Protokoll erscheinen zwei erkannte Aktionen.

Kosten (Preise laut OpenAI, Stand November 2026): Verschriftung `gpt-transcribe` 0,0045 $ pro Minute, Auswertung `gpt-6-luna` 0,10 $ / 0,50 $ je 1 Mio. Ein- / Ausgabe-Token.
Ein Sprachbefehl von etwa 10 Sekunden kostet damit rund 0,1 Cent; bei 10 Befehlen am Tag etwa 0,30 € im Monat.
Modelle lassen sich über die Skripteigenschaften `OPENAI_TRANSCRIBE_MODEL` und `OPENAI_TEXT_MODEL` ändern.

## Schneller Tabellenzugriff einschalten (einmalig, wichtig fürs Tempo)

Im Apps-Script-Editor links bei **Dienste** auf **+** → **Google Sheets API** wählen → **Hinzufügen** (Kennung `Sheets` so lassen).
Damit liest und schreibt das Backend alle Blätter mit je einem Aufruf statt Blatt für Blatt.
`einrichtungPruefen` zeigt danach: `Schneller Tabellenzugriff …: aktiv`. (Falls Google erneut nach Berechtigungen fragt: zulassen.)

## Bei neuen Versionen des Backends

1. `Code.gs` komplett ersetzen durch https://raw.githubusercontent.com/manuelhankeai/einkaufsplaner/main/backend/Code.gs → Speichern.
2. **Bereitstellen → Bereitstellungen verwalten** → Stift → Version: **Neue Version** → Bereitstellen. Die Adresse bleibt gleich.
3. Kontrolle: Backend-Adresse im Browser öffnen → dort steht die Versionsnummer (aktuell `1.1.0`).

## Prüfungen (für Entwicklung)

```
tests/alle.sh
```
Fachlogik (22), Wochen-Testlauf (23), Backend gegen nachgebaute Google-Dienste (28), Klicktest im Browser mit zwei Personen (13).
