# TODOs

## API-Verhalten

- **`addRow` gibt Column-Keys statt Namen zurück**: Der `POST /rows/` Endpoint ignoriert `convert_keys` im Request-Body. Die Antwort enthält Column-Keys (`0000`, `33uo`) statt Spaltennamen (`Name`, `Age`). Workaround: nach `addRow` ein `getRow` nachschalten, um die Zeile mit Spaltennamen zu erhalten. Betrifft auch `updateRow` (nicht verifiziert).

## Nicht vergessen

- deployment on smithery.ai prüfen
- eigenes deployment auf https://mcp.seatable.com/mcp
- Library von Docker Desktop
- easy installation from docker hub
- 429 status code testen
- read-only api token testen
- seite wie hier: https://support.airtable.com/docs/using-the-airtable-mcp-server
- blogbeitrag wie hier: https://rashidazarang.com/c/i-built-an-airtable-mcp-that-lets-you-chat-with-your-database
