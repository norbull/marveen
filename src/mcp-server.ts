#!/usr/bin/env node
/**
 * Marveen MCP Server -- exposes the marveen HTTP API as MCP tools.
 * Use this with Claude Desktop (claude_desktop_config.json) to let the
 * Desktop Claude send messages to agents, read/write memories, and
 * manage kanban cards.
 *
 * Config snippet for claude_desktop_config.json:
 * {
 *   "mcpServers": {
 *     "marveen": {
 *       "command": "npx",
 *       "args": ["tsx", "/home/karma/marveen/src/mcp-server.ts"]
 *     }
 *   }
 * }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "fs";
import { join } from "path";

const PROJECT_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const DASHBOARD = "http://localhost:3420";

function getToken(): string {
  return readFileSync(join(PROJECT_ROOT, "store", ".dashboard-token"), "utf8").trim();
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${DASHBOARD}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${getToken()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API ${method} ${path} -> ${res.status}`);
  return res.json();
}

const server = new McpServer({ name: "marveen", version: "1.0.0" });

server.registerTool(
  "send_message",
  {
    description: "Send a message or task to an agent (orin, atlas, dex, iris, nova). The agent will process it and reply via Telegram.",
    inputSchema: {
      to: z.string().describe("Target agent name, e.g. orin"),
      content: z.string().describe("Message or task description"),
    },
  },
  async ({ to, content }) => {
    const result = await api("POST", "/api/messages", { from: "desktop", to, content }) as { id?: number };
    return { content: [{ type: "text" as const, text: `Message sent (id: ${result?.id ?? "?"}). The agent will process it shortly.` }] };
  }
);

server.registerTool(
  "list_agents",
  {
    description: "List all registered agents and their current status.",
    inputSchema: {},
  },
  async () => {
    const agents = await api("GET", "/api/agents") as unknown[];
    return { content: [{ type: "text" as const, text: JSON.stringify(agents, null, 2) }] };
  }
);

server.registerTool(
  "search_memories",
  {
    description: "Search agent memories by keyword.",
    inputSchema: {
      query: z.string().describe("Search keyword"),
      agent: z.string().optional().describe("Filter by agent (default: orin)"),
      category: z.string().optional().describe("hot | warm | cold | shared"),
    },
  },
  async ({ query, agent, category }) => {
    const params = new URLSearchParams({ q: query, agent: agent ?? "orin" });
    if (category) params.set("category", category);
    const memories = await api("GET", `/api/memories?${params}`) as unknown[];
    return { content: [{ type: "text" as const, text: JSON.stringify(memories, null, 2) }] };
  }
);

server.registerTool(
  "write_memory",
  {
    description: "Write a memory entry for an agent.",
    inputSchema: {
      content: z.string().describe("Memory content"),
      category: z.string().describe("hot | warm | cold | shared"),
      keywords: z.string().optional().describe("Comma-separated keywords"),
      agent: z.string().optional().describe("Agent id (default: orin)"),
    },
  },
  async ({ content, category, keywords, agent }) => {
    const result = await api("POST", "/api/memories", {
      agent_id: agent ?? "orin",
      content,
      category,
      keywords: keywords ?? "",
    }) as { id?: number };
    return { content: [{ type: "text" as const, text: `Memory saved (id: ${result?.id ?? "?"})` }] };
  }
);

server.registerTool(
  "create_kanban_card",
  {
    description: "Create a new kanban task card.",
    inputSchema: {
      title: z.string().describe("Card title"),
      description: z.string().optional().describe("Detailed description"),
      priority: z.string().optional().describe("low | normal | high | urgent (default: normal)"),
      agent: z.string().optional().describe("Assign to agent (default: orin)"),
    },
  },
  async ({ title, description, priority, agent }) => {
    const result = await api("POST", "/api/kanban/cards", {
      title,
      description: description ?? "",
      priority: priority ?? "normal",
      status: "planned",
      agent_id: agent ?? "orin",
    }) as { id?: string };
    return { content: [{ type: "text" as const, text: `Card created (id: ${result?.id ?? "?"})` }] };
  }
);

server.registerTool(
  "list_kanban_cards",
  {
    description: "List kanban cards, optionally filtered by status or agent.",
    inputSchema: {
      status: z.string().optional().describe("planned | in_progress | waiting | done"),
      agent: z.string().optional().describe("Filter by agent"),
    },
  },
  async ({ status, agent }) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (agent) params.set("agent", agent);
    const q = params.toString();
    const cards = await api("GET", `/api/kanban/cards${q ? `?${q}` : ""}`) as unknown[];
    return { content: [{ type: "text" as const, text: JSON.stringify(cards, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
