# Einkaufsplaner (Claude-Variante)

Privater Familien-Einkaufs- und Abendessenplaner: Vorrat, Kochbuch, Wochenplan, Einkaufsliste, Kassenbons.

**Dieses Repository enthält nur Programmcode.** Keine Daten, keine Zugangsschlüssel. Alle Daten liegen in einer privaten Google-Tabelle und sind nur nach Anmeldung und Freigabe durch den Besitzer erreichbar.

## Aufbau

| Ordner | Inhalt |
|---|---|
| `core/` | Gemeinsame Fachlogik (Buchungsjournal, Chargen/Packungen, Kochen, Einkaufsliste, Bon-Dubletten, Sprachparser). Läuft in Apps Script, Node und Browser. |
| `tests/` | Automatisierte Tests, u. a. für alle 15 kritischen Fehlerfälle der Spezifikation. |
| `index.html`, `app.js`, `app.css`, `seed.js` | Web-App (PWA). Läuft derzeit im Demo-Modus mit Beispieldaten im Browser. |
| `backend/` (Google Apps Script) | folgt |

## Tests ausführen

```
node tests/run.js
```

## Status

| Baustein | Status |
|---|---|
| Fachlogik | getestet (lokal), 21/21 Tests |
| Web-App (Demo mit Beispieldaten) | gebaut, Klick-Test ohne Fehler |
| Apps-Script-Backend | geplant |
| Bon-Erkennung | geplant |

## App öffnen

https://manuelhankeai.github.io/einkaufsplaner/ – auf dem iPhone in Safari öffnen, dann Teilen → „Zum Home-Bildschirm“.
