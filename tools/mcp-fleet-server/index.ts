#!/usr/bin/env node
/**
 * Marveen Fleet MCP Server -- exposes the marveen agent-fleet tools to the Claude
 * Desktop app (and, via /rc, the mobile app) over a local stdio MCP transport.
 *
 * It is a thin, read-mostly wrapper over the already-running dashboard HTTP API
 * (http://localhost:3420, Bearer token from store/.dashboard-token). No new state,
 * no secrets on stdout -- the token is read at call time and only ever put in the
 * Authorization header.
 *
 * Claude Desktop launches this through wsl.exe; see claude_desktop_config.json in
 * this folder's README for the exact snippet.
 *
 * Tools (per Orin spec, msg 7261):
 *   fleet_status               GET  /api/agents
 *   get_kanban                 GET  /api/kanban        (client-side status/agent filter)
 *   search_memory              GET  /api/memories?q=&agent=&category=
 *   send_inter_agent_message   POST /api/messages
 *   get_daily_log              GET  /api/daily-log     (most-recent N)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// This file lives at <root>/tools/mcp-fleet-server/index.ts -> root is two dirs up.
// Resolve from the file's own location so it works regardless of the launch cwd
// (Claude Desktop starts it via wsl.exe with an unpredictable working directory).
const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.MARVEEN_ROOT ?? join(HERE, "..", "..");
const DASHBOARD = process.env.MARVEEN_DASHBOARD ?? "http://localhost:3420";

function getToken(): string {
  return readFileSync(join(PROJECT_ROOT, "store", ".dashboard-token"), "utf8").trim();
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${DASHBOARD}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API ${method} ${path} -> ${res.status} ${res.statusText}`);
  return res.json();
}

function textResult(payload: unknown) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

const server = new McpServer({ name: "marveen-fleet", version: "1.0.0" });

// ── fleet_status ───────────────────────────────────────────────────────────
server.registerTool(
  "fleet_status",
  {
    description:
      "List the marveen agent fleet with each agent's model, running-state and security profile.",
    inputSchema: {},
  },
  async () => {
    const agents = (await api("GET", "/api/agents")) as Array<Record<string, unknown>>;
    const slim = agents.map((a) => ({
      name: a.name,
      displayName: a.displayName,
      model: a.activeModel ?? a.model,
      running: typeof a.runningSince === "number" && a.runningSince > 0,
      securityProfile: a.securityProfile,
    }));
    return textResult(slim);
  }
);

// ── get_kanban ─────────────────────────────────────────────────────────────
server.registerTool(
  "get_kanban",
  {
    description:
      "List kanban cards. Optionally filter by status (planned|in_progress|waiting|done) and/or agent.",
    inputSchema: {
      status: z
        .string()
        .optional()
        .describe("planned | in_progress | waiting | done"),
      agent: z.string().optional().describe("Filter by assigned agent id"),
    },
  },
  async ({ status, agent }) => {
    // The dashboard returns every card in one call; filter client-side (Orin spec).
    let cards = (await api("GET", "/api/kanban")) as Array<Record<string, unknown>>;
    if (status) cards = cards.filter((c) => c.status === status);
    if (agent) cards = cards.filter((c) => c.agent_id === agent);
    const slim = cards.map((c) => ({
      id: c.id,
      card_number: c.card_number,
      title: c.title,
      status: c.status,
      priority: c.priority,
      agent: c.agent_id,
    }));
    return textResult(slim);
  }
);

// ── search_memory ──────────────────────────────────────────────────────────
server.registerTool(
  "search_memory",
  {
    description:
      "Search an agent's memories by keyword. Category filters hot|warm|cold|shared.",
    inputSchema: {
      query: z.string().describe("Search keyword(s)"),
      agent: z.string().optional().describe("Agent id (default: orin)"),
      category: z.string().optional().describe("hot | warm | cold | shared"),
    },
  },
  async ({ query, agent, category }) => {
    const params = new URLSearchParams({ q: query, agent: agent ?? "orin" });
    if (category) params.set("category", category);
    const memories = await api("GET", `/api/memories?${params.toString()}`);
    return textResult(memories);
  }
);

// ── send_inter_agent_message ───────────────────────────────────────────────
server.registerTool(
  "send_inter_agent_message",
  {
    description:
      "Send a task/message to a fleet agent (orin, atlas, dex, iris, nova). The agent processes it and replies via its own channel.",
    inputSchema: {
      to: z.string().describe("Target agent id, e.g. orin"),
      content: z.string().describe("Message or task description"),
    },
  },
  async ({ to, content }) => {
    const result = (await api("POST", "/api/messages", {
      from: "desktop",
      to,
      content,
    })) as { id?: number };
    return textResult(`Message sent to ${to} (id: ${result?.id ?? "?"}).`);
  }
);

// ── get_daily_log ──────────────────────────────────────────────────────────
server.registerTool(
  "get_daily_log",
  {
    description: "Return the most recent daily-log entries across the fleet.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("How many recent entries (default 5)"),
    },
  },
  async ({ limit }) => {
    const rows = (await api("GET", "/api/daily-log")) as Array<Record<string, unknown>>;
    const n = limit ?? 5;
    // Highest id = most recent; return the top N by id descending.
    const recent = [...rows]
      .sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0))
      .slice(0, n);
    return textResult(recent);
  }
);

// ── fleet_inbox ────────────────────────────────────────────────────────────
// The RETURN direction: the fleet addresses this Desktop app as the "desktop"
// agent (POST /api/messages to:"desktop"). Those messages sit pending in the
// queue -- there is no push into the Desktop app. This tool pulls them and, by
// default, closes each one (PUT status:done), which also fires the fleet-side
// "[Eredmény]" acknowledgement back to the sender so they know it landed.
server.registerTool(
  "fleet_inbox",
  {
    description:
      "Check for messages the fleet sent to this Desktop app (identity 'desktop'). Returns pending messages and, unless peek=true, marks them done (which acknowledges the sender). Call this to see if any agent needs something from you on the machine.",
    inputSchema: {
      peek: z
        .boolean()
        .optional()
        .describe("If true, only read without marking done (messages stay pending). Default false."),
    },
  },
  async ({ peek }) => {
    const pending = (await api(
      "GET",
      "/api/messages?agent=desktop&status=pending"
    )) as Array<Record<string, unknown>>;
    if (!pending.length) return textResult("Inbox empty -- no pending messages from the fleet.");
    const items = pending.map((m) => ({
      id: m.id,
      from: m.from_agent,
      content: m.content,
      at: m.created_at,
    }));
    if (!peek) {
      for (const m of pending) {
        try {
          await api("PUT", `/api/messages/${m.id}`, {
            status: "done",
            result: "delivered to Windows Claude Desktop",
          });
        } catch {
          // Non-fatal: leave it pending, the next inbox call retries the close.
        }
      }
    }
    return textResult(items);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
