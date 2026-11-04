# Running behind OpenAI's Secure MCP Tunnel

OpenAI's [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) lets ChatGPT reach an MCP server that is not exposed to the internet. A small `tunnel-client` runs next to the MCP server and opens an outbound HTTPS connection to `api.openai.com`; OpenAI sends MCP requests through that connection. No open port, no DNS entry, no TLS certificate.

This works with the stock `seatable/seatable-mcp` image — no code changes are needed.

## Limitations

Read these before choosing the tunnel over a public endpoint:

- **OpenAI products only.** ChatGPT, Codex and the Responses API can use the tunnel. Claude, Cursor and every other MCP client cannot. If another client is needed later, the server needs a public hostname after all (see `docker-compose.yml`).
- **Custom connector, not the store app.** The server is added as a custom MCP server in ChatGPT developer mode, not via the SeaTable app in the ChatGPT app directory. That requires a ChatGPT Business, Enterprise or Edu workspace whose admin has enabled developer mode.
- **One shared identity.** The server runs in `selfhosted` mode with base API tokens from its environment. Everyone in the workspace who may use the connector works with the same SeaTable permissions; who may use it is controlled in ChatGPT. Per-user SeaTable login (managed mode with OAuth) is possible in principle, but OAuth's authorization endpoint is not tunneled — it would have to be publicly reachable.
- **Base API tokens, one per base.** Account tokens are not supported. Every base the connector should see needs its own API token in `SEATABLE_BASES`. Adding a base means editing `.env` and restarting the container; sharing a base with a SeaTable user has no effect on the MCP server.
- **No authentication on `/mcp`.** In selfhosted mode the HTTP endpoint accepts any caller. The only protection is that nothing but `tunnel-client` can reach port 3000. Never publish that port.
- **`tunnel-client` is early software** (0.0.x releases, frequent updates). Pin an exact version and read the release notes before upgrading.

## Who does what

**On the OpenAI side** (whoever owns the ChatGPT workspace):

1. Create a tunnel at platform.openai.com → Settings → Organization → Tunnels. Requires the *Tunnels Read + Manage* role in the Platform organization.
2. Associate the tunnel with the ChatGPT workspace. Without this the tunnel does not appear in ChatGPT.
3. Create a runtime API key for `tunnel-client` (account needs *Tunnels Read + Use*).
4. Make sure developer mode is enabled in the workspace.
5. Hand over the **tunnel ID** and the **runtime API key** — over a secure channel, not plain email.

New role assignments can take up to 30 minutes to take effect.

**On the server side:**

1. Create a SeaTable service account, share the relevant bases with it, and create one API token per base with the permissions ChatGPT should have.
2. Make sure the host can reach `api.openai.com:443` outbound.
3. Deploy both containers as below.

## Deployment

`/opt/seatable-mcp/.env` (`chmod 600`):

```env
SEATABLE_SERVER_URL=https://seatable.example.com
SEATABLE_BASES=[{"base_name":"CRM","api_token":"..."},{"base_name":"Projects","api_token":"..."}]
# or, for a single base: SEATABLE_API_TOKEN=...

CONTROL_PLANE_API_KEY=sk-...
CONTROL_PLANE_TUNNEL_ID=tunnel_...
```

`SEATABLE_SERVER_URL` must include `https://` and have no trailing slash.

`/opt/seatable-mcp/docker-compose.yml`:

```yaml
services:
  seatable-mcp:
    image: seatable/seatable-mcp:1.8.0
    container_name: seatable-mcp
    restart: unless-stopped
    # No "ports:" — the server is reachable only from the Docker network.
    environment:
      - SEATABLE_MODE=selfhosted
      - SEATABLE_SERVER_URL
      - SEATABLE_API_TOKEN
      - SEATABLE_BASES
    read_only: true
    tmpfs:
      - /tmp:size=16m,noexec,nosuid,nodev
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    pids_limit: 128
    mem_limit: 512m
    networks: [mcp-net]

  tunnel-client:
    image: ghcr.io/openai/tunnel-client:v0.0.19
    container_name: openai-tunnel-client
    restart: unless-stopped
    depends_on: [seatable-mcp]
    environment:
      - CONTROL_PLANE_API_KEY
      - CONTROL_PLANE_TUNNEL_ID
      - MCP_SERVER_URL=http://seatable-mcp:3000/mcp
    networks: [mcp-net]

networks:
  # Not "internal: true": both containers need outbound access
  # (tunnel-client to OpenAI, the MCP server to SeaTable).
  mcp-net:
```

The versions above were current in November 2026. Check [seatable/seatable-mcp on Docker Hub](https://hub.docker.com/r/seatable/seatable-mcp/tags) and [openai/tunnel-client releases](https://github.com/openai/tunnel-client/releases) for newer ones.

### Start and verify

The MCP server can be started and tested before the tunnel exists:

```bash
docker compose up -d seatable-mcp
docker compose logs seatable-mcp      # expect "Streamable HTTP server listening"

docker run --rm --network seatable-mcp_mcp-net curlimages/curl -s \
  -X POST http://seatable-mcp:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
```

Once tunnel ID and key are in `.env`:

```bash
docker compose up -d tunnel-client
docker compose logs -f tunnel-client

# Diagnostics
docker compose run --rm --entrypoint tunnel-client tunnel-client doctor --explain
```

### Connect in ChatGPT

Done by someone in the workspace with developer mode access and *Tunnels Read + Use*:

1. chatgpt.com/plugins → **+** → **Add custom MCP server**
2. Connection: **Tunnel**, select the tunnel (or paste the tunnel ID)
3. Authentication: **none**
4. Confirm the risk warning → **Create as a plugin**

## Troubleshooting

| Symptom | Check |
|---|---|
| Tunnel not listed in ChatGPT | Tunnel associated with the workspace? Creator has *Tunnels Read + Use*? Role assigned less than 30 minutes ago? |
| `tunnel-client` cannot connect | Outbound `api.openai.com:443` allowed? Correct runtime key and tunnel ID? Run `doctor --explain`. |
| Tools list loads, tool calls fail | `docker compose logs seatable-mcp` — usually a wrong `SEATABLE_SERVER_URL` or a token that is not a base API token. |
| A base is missing | Its token is not in `SEATABLE_BASES`, or the container was not restarted after adding it. |

## Open points

- Not yet verified end to end: whether `tunnel-client` passes the `mcp-session-id` header through correctly. The server is stateful and reclaims unused sessions after 30 seconds; problems would show up in the `seatable-mcp` logs on the first connection.
- The `tunnel-client` image's entrypoint (`tunnel-client run`) and environment variable names are taken from OpenAI's repository and documentation, not from a running deployment.

Update this file once a deployment has confirmed or corrected these points.
