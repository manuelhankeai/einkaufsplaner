# Einkaufsplaner (Claude-Variante)

Privater Familien-Einkaufs- und Abendessenplaner: Vorrat, Kochbuch, Wochenplan, Einkaufsliste, Kassenbons.

**Dieses Repository enthält nur Programmcode.** Keine Daten, keine Zugangsschlüssel. Alle Daten liegen in einer privaten Google-Tabelle und sind nur nach Anmeldung und Freigabe durch den Besitzer erreichbar.

## Aufbau

| Ordner | Inhalt |
|---|---|
| `core/` | Gemeinsame Fachlogik (Buchungsjournal, Chargen/Packungen, Kochen, Einkaufsliste, Bon-Dubletten, Sprachparser). Läuft in Apps Script, Node und Browser. |
| `tests/` | Automatisierte Tests, u. a. für alle 15 kritischen Fehlerfälle der Spezifikation. |
| Web-App / PWA | folgt |
| `backend/` (Google Apps Script) | folgt |

## Tests ausführen

```
node tests/run.js
```

## Status

| Baustein | Status |
|---|---|
| Fachlogik | getestet (lokal), 18/18 Tests |
| Web-App (Demo) | in Arbeit |
| Apps-Script-Backend | geplant |
| Bon-Erkennung | geplant |
