# Tischlein – Familien-Einkaufsplaner (Claude-Variante)

Privater Familien-Einkaufs- und Abendessenplaner: Vorrat, Kochbuch, Wochenplan, Einkaufsliste, Kassenbons.

**Dieses Repository enthält nur Programmcode.** Keine Daten, keine Zugangsschlüssel. Alle Daten liegen in einer privaten Google-Tabelle und sind nur nach Anmeldung und Freigabe durch den Besitzer erreichbar.

## Aufbau

| Ordner | Inhalt |
|---|---|
| `core/` | Gemeinsame Fachlogik (Buchungsjournal, Chargen/Packungen, Kochen, Einkaufsliste, Bon-Dubletten, Sprachparser). Läuft in Apps Script, Node und Browser. |
| `tests/` | Automatisierte Tests, u. a. für alle 15 kritischen Fehlerfälle der Spezifikation. |
| `index.html`, `app.js`, `app.css`, `illus.js`, `seed.js`, `net.js`, `config.js` | Web-App (PWA). Ohne Verbindung Demo-Modus, mit Verbindung Google-Anmeldung und eigene Google-Tabelle. |
| `backend/server.js` → `backend/Code.gs` | Google-Apps-Script-Backend (`node tools/build-backend.js` fügt Fachlogik + Backend zu einer Datei zusammen). |
| `img/`, `fonts/` | Bilder (Canva, WebP) und selbst gehostete Schrift (Bricolage Grotesque, OFL). |
| `EINRICHTUNG.md` | Schritt-für-Schritt-Anleitung: Google-Anmeldung, Backend, iPhone, KI. |

## Tests ausführen

```
tests/alle.sh
```
Fachlogik, durchgehender Wochen-Testlauf, Backend gegen nachgebaute Google-Dienste, Klicktest im Browser mit zwei Personen.

## Status

| Baustein | Status |
|---|---|
| Fachlogik inkl. Teilpackungen | getestet (lokal): 22 Einzeltests + 23-Schritte-Wochenlauf |
| Apps-Script-Backend, Anmeldung, Familienfreigabe | getestet (lokal gegen nachgebaute Google-Dienste): 29 Tests |
| Web-App online + Demo | getestet (lokal im Browser, zwei Personen): 13 Schritte |
| KI-Diktat (OpenAI) | gebaut, Aufrufformat getestet; echter Aufruf erst nach Einrichtung |
| Live bei Google | wartet auf Einrichtung (EINRICHTUNG.md) |
| Bon-Erkennung | geplant (PENNY-Belege fehlen) |

## App öffnen

https://manuelhankeai.github.io/einkaufsplaner/ – auf dem iPhone in Safari öffnen, dann Teilen → „Zum Home-Bildschirm“.
