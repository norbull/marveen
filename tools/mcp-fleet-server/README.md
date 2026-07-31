# marveen-fleet MCP server

Local **stdio** MCP server that exposes the marveen agent-fleet tools to the Claude
Desktop app (and, through `/rc`, the mobile app). It is a thin wrapper over the
already-running dashboard HTTP API (`http://localhost:3420`); the Bearer token is
read from `store/.dashboard-token` at call time and never printed.

## Tools

| tool | endpoint | notes |
|------|----------|-------|
| `fleet_status` | `GET /api/agents` | agents + model + running-state + profile |
| `get_kanban` | `GET /api/kanban` | client-side `status` / `agent` filter |
| `search_memory` | `GET /api/memories?q=&agent=&category=` | default agent `orin` |
| `send_inter_agent_message` | `POST /api/messages` | `from:"desktop"` (fleet -> Windows) |
| `get_daily_log` | `GET /api/daily-log` | most-recent N (default 5) |
| `fleet_inbox` | `GET /api/messages?agent=desktop&status=pending` + `PUT :id done` | the RETURN direction: pulls messages the fleet sent to `desktop`, closes them (acks the sender). `peek:true` reads without closing. |

## Identity

`send_inter_agent_message` posts as `from:"desktop"`. The dashboard authenticates
`from` against `isKnownAgent`, so a marker folder `agents/desktop/` exists purely
to whitelist that id. It is deliberately NOT in `store/agents-desired.json`, so no
tmux session is ever spawned for it -- `desktop` is a pull-only identity. The fleet
addresses the Windows app as `to:"desktop"`; those messages wait pending (no push)
until `fleet_inbox` pulls them.

## Claude Desktop config

Add to `claude_desktop_config.json`
(`%APPDATA%\Claude\claude_desktop_config.json` on Windows). Claude Desktop launches
the WSL side via `wsl.exe`:

```json
{
  "mcpServers": {
    "marveen-fleet": {
      "command": "wsl.exe",
      "args": [
        "bash", "-lc",
        "exec /home/karma/marveen/node_modules/.bin/tsx /home/karma/marveen/tools/mcp-fleet-server/index.ts"
      ]
    }
  }
}
```

`exec` makes the tsx process replace the shell so Claude Desktop's stop signal
reaches it cleanly. The server resolves the project root from its own file location,
so the launch working directory does not matter. To point it elsewhere set
`MARVEEN_ROOT` / `MARVEEN_DASHBOARD` in the args' env if ever needed.

After editing the config, fully quit and reopen Claude Desktop. The five tools
appear under the `marveen-fleet` server; try *"list the fleet status"*.

## Local test (no Claude Desktop needed)

```bash
node /tmp/mcp_test.mjs        # stdio handshake: initialize + tools/list + live calls
```

or a raw one-liner handshake:

```bash
cd /home/karma/marveen
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node_modules/.bin/tsx tools/mcp-fleet-server/index.ts
```

## Note

An older near-duplicate lives at `src/mcp-server.ts` (2026-07-06). Its kanban tools
target the removed `/api/kanban/cards` endpoint and 404. Prefer this server; the old
one should be retired or realigned to avoid two fleet MCP servers in one config.
