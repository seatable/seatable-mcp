# Vermarktung SeaTable MCP Server — Stand 2026-03-20

## Ziel

Sichtbarkeit des offiziellen SeaTable MCP Servers (`@seatable/mcp-seatable`, `seatable/seatable-mcp`) in allen relevanten MCP-Verzeichnissen und Kanälen maximieren.

MCP-Ökosystem wächst schnell (10.000+ Server), Discovery läuft über Registries und Listen. Frühzeitige Präsenz sichert Sichtbarkeit.

## Listings — Aktueller Stand

### Bereits gelistet

| Plattform | URL / Status |
|---|---|
| **npm** | `@seatable/mcp-seatable` v1.5.1 |
| **GitHub** | `seatable/seatable-mcp` |
| **OpenAI App Store** | Eingereicht (Status offen) |
| **Smithery.ai** | Eingetragen |
| **Glama.ai** | https://glama.ai/mcp/servers/@seatable/sea-table-mcp (automatisch) |
| **Zapier MCP** | https://zapier.com/mcp/seatable (Zapiers eigener Wrapper) |
| **Pipedream MCP** | https://mcp.pipedream.com/app/seatable (Pipedreams eigener Wrapper) |
| **punkpeye/awesome-mcp-servers** | Gelistet unter "Databases" — offizielle Version `seatable/seatable-mcp`. Beschreibung ist aber knapp, könnte per PR aufgewertet werden. |

### Fehlt / Handlungsbedarf

| Plattform | Status | Aktion |
|---|---|---|
| **Official MCP Registry** (registry.modelcontextprotocol.io) | 404 — entweder nicht registriert oder nicht live | Prüfen ob `mcp-publisher`-Eintrag durchgegangen ist. Ggf. neu einreichen via `mcp-publisher` CLI. Namespace: `io.github.seatable/seatable` |
| **mcp.so** | "Project not found" | Eintrag einreichen |
| **mcpservers.org** | Nur veraltete brianmoney-Version gelistet | Eintrag für offizielles Repo einreichen |
| **appcypher/awesome-mcp-servers** | Nicht gelistet | PR erstellen |
| **wong2/awesome-mcp-servers** | Nicht gelistet | PR erstellen |
| **TensorBlock/awesome-mcp-servers** | Nicht gelistet (7.260 Server, SeaTable fehlt) | PR erstellen |
| **Augment Code Registry** | Nicht gelistet (Airtable ist dort) | Listing einreichen |
| **mcpevals.io** | Nicht geprüft | Prüfen und ggf. einreichen |

## Weitere Vermarktungsmaßnahmen (noch offen)

### Content Marketing

- **Blog-Post auf seatable.com**: Tutorial "How to connect SeaTable to Claude/ChatGPT/Cursor with MCP"
- **Dev.to / Medium Artikel**: Technischer Deep-Dive für SEO
- **YouTube Demo-Video**: 2-3 Min, AI-Agent arbeitet mit SeaTable-Daten
- **SeaTable Forum**: Bestehender Thread prominenter verlinken (https://forum.seatable.com/t/mcp-server-for-seatable/6668)

### IDE-Marketplaces

- **Cursor**: Prüfen ob SeaTable im MCP-Verzeichnis gelistet ist
- **VS Code / Copilot**: Extension oder Empfehlung prüfen
- **Windsurf/Codeium**: Weitere IDE mit MCP-Support

### Differenzierung kommunizieren

Der SeaTable MCP Server ist der einzige Spreadsheet/Database-MCP-Server, der vom Hersteller selbst gebaut wird. Airtable hat 5+ Community-Server, keinen offiziellen. Differenzierungsmerkmale:

- Offiziell von SeaTable GmbH
- Managed Multi-Tenant mit OAuth & Rate Limiting
- Hosted Endpoint (mcp.seatable.com)
- Schema-Validierung auf Writes
- Batch-Operationen
- File Upload/Download mit PDF-Extraktion
- SQL-Queries
- Prometheus Metrics
- Multi-Base Support
- Docker-Deployment
- 202 Tests

### Partnerschaften

- **n8n**: MCP-Node-Support — Kombination dokumentieren
- **LangChain / LlamaIndex**: MCP-Tool-Adapter
- **AI Gateway Anbieter**: 75% planen MCP-Integration bis Ende 2026

### SeaTable-Produkt-Integration

- In der offiziellen SeaTable-Doku einen prominenten "AI / MCP"-Bereich einrichten
- Im SeaTable Cloud Admin-Panel Hinweis auf MCP-Server
- API-Token-Erstellung für MCP-Nutzer vereinfachen

## Priorisierte Nächste Schritte

1. **Official MCP Registry** klären (ist der Eintrag durchgegangen?)
2. PRs für awesome-mcp-servers Listen (appcypher, wong2, TensorBlock)
3. mcp.so + mcpservers.org + Augment Code einreichen
4. punkpeye/awesome-mcp-servers Beschreibung per PR aufwerten
5. Blog-Post auf seatable.com
6. SeaTable-Docs AI/MCP-Sektion
