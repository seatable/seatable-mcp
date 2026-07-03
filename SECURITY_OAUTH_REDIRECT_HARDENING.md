# OAuth redirect_uri Hardening (Posture D)

Härtung des OAuth-Authorize-Flows gegen Phishing/Token-Diebstahl über nicht
validierte `redirect_uri`. Betrifft ausschließlich den **`managed`-Modus**
(SeaTable-Cloud); im `selfhosted`-Default ist der OAuth-Stack inaktiv.

## Problem

Der `/authorize`-Flow sammelt das SeaTable-API-Token des Users und leitete den
resultierenden Auth-Code (der das Token freischaltet) an eine **beliebige,
ungeprüfte `redirect_uri`** weiter. Ein Angreifer konnte damit einen Link auf die
echte Cloud-Domain bauen (`.../authorize?redirect_uri=https://evil.example/cb`),
ein Opfer zum Eintippen seines Tokens verleiten und den Code abgreifen.

PKCE, der `redirect_uri`-Match am `/token` und die offene Dynamic Client
Registration verhindern das nicht, da der Angreifer den gesamten Flow selbst
initiiert.

## Lösung: Klassifizierung des redirect_uri (Posture D)

`kuratieren statt enumerieren` — keine vollständige Client-Allowlist nötig:

| redirect_uri | Verhalten |
|---|---|
| Loopback (`localhost`/`127.0.0.1`/`::1`, http/https) | erlaubt, **keine Warnung** (Code landet auf dem Rechner des Users, sicher by design) |
| Konfigurierter Trusted-Host (https) | erlaubt, **keine Warnung** |
| Unbekannter https-Host | **erlaubt, aber Warn-Banner** vor der Token-Eingabe |
| Remote http / fremdes Schema / kaputte URL | **abgelehnt (400)** |

Zusätzlich:

- **Ziel-Host** wird auf der Token-Seite immer angezeigt.
- Enforcement bei **GET und POST** `/authorize` (direkter POST umgeht die Prüfung nicht).
- **PKCE nur noch S256** (`plain` abgelehnt, Metadata entsprechend).

## Konfiguration

```bash
# Komma-separierte https-Hosts, die ohne Warnung angezeigt werden.
# Leer = nur Loopback ist trusted.
SEATABLE_OAUTH_TRUSTED_REDIRECT_HOSTS=claude.ai,claude.com,chatgpt.com
```

## Geänderte Dateien

- `src/auth/oauthProvider.ts` — `classifyRedirectUri()`, Ziel-/Warn-Anzeige, Error-Page, S256-only
- `src/http/httpServer.ts` — `SEATABLE_OAUTH_TRUSTED_REDIRECT_HOSTS` parsen und übergeben
- `.env.example`, `CLAUDE.md` — Doku
- `tests/oauthProvider.spec.ts` — bestehende Tests angepasst + 8 neue

## Bekannte Grenze

Entschärft den gemeldeten Vektor proportional (Angreifer-Ziel wird abgelehnt bzw.
laut gewarnt), beseitigt aber nicht das Grundmodell „langlebiges Token in ein
Webformular tippen". Der robuste Umbau (Delegation der Authentifizierung an
cloud.seatable.io mit echter Session/Consent) bleibt der langfristige Weg und
setzt einen OAuth-Authorization-Server im SeaTable-Core voraus.
