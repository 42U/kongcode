/**
 * KongCode MCP Server — entry point.
 *
 * Long-lived stdio process that owns:
 * - SurrealDB connection
 * - BGE-M3 embedding model
 * - Session state
 * - MCP tools: recall, core_memory, introspect
 * - Internal Unix socket HTTP API for hook communication
 *
 * Spawned by Claude Code via .mcp.json (stdio transport).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { parsePluginConfig } from "./engine/config.js";
import { SurrealStore } from "./engine/surreal.js";
import { EmbeddingService } from "./engine/embeddings.js";
import { GlobalPluginState } from "./engine/state.js";
import { startHttpApi, stopHttpApi, registerHookHandler } from "./http-api.js";
import { handleSessionStart } from "./hook-handlers/session-start.js";
import { handleSessionEnd } from "./hook-handlers/session-end.js";
import { handleUserPromptSubmit } from "./hook-handlers/user-prompt-submit.js";
import { handlePreToolUse } from "./hook-handlers/pre-tool-use.js";
import { handlePostToolUse } from "./hook-handlers/post-tool-use.js";
import { handleStop } from "./hook-handlers/stop.js";
import { handlePreCompact } from "./hook-handlers/pre-compact.js";
import { handlePostCompact } from "./hook-handlers/post-compact.js";
import { handleTaskCreated, handleSubagentStop } from "./hook-handlers/subagent.js";
import { handleRecall } from "./tools/recall.js";
import { handleCoreMemory } from "./tools/core-memory.js";
import { handleIntrospect } from "./tools/introspect.js";
import { handleFetchPendingWork, handleCommitWorkResults } from "./tools/pending-work.js";
import { log } from "./engine/log.js";

// ── Global state ──────────────────────────────────────────────────────────────

let globalState: GlobalPluginState | null = null;

export function getGlobalState(): GlobalPluginState | null {
  return globalState;
}

// ── MCP Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "recall",
    description: "Search the persistent memory graph for past knowledge, concepts, artifacts, skills, and conversation history.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Natural language search query" },
        scope: {
          type: "string",
          enum: ["all", "memories", "concepts", "turns", "artifacts", "skills"],
          description: "Narrow search to a specific knowledge type (default: all)",
        },
        limit: {
          type: "number",
          description: "Max results to return (1-15, default: 5)",
          minimum: 1,
          maximum: 15,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "core_memory",
    description: "Manage always-loaded memory directives. Tier 0 entries appear every turn (identity, rules). Tier 1 entries are session-pinned.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["list", "add", "update", "deactivate"],
          description: "Operation to perform",
        },
        tier: { type: "number", enum: [0, 1], description: "Memory tier (0=always, 1=session)" },
        category: {
          type: "string",
          enum: ["identity", "rules", "tools", "operations", "general"],
          description: "Category for the directive",
        },
        text: { type: "string", description: "Content of the directive (for add/update)" },
        priority: { type: "number", description: "Priority 0-100 (higher = loaded first)" },
        id: { type: "string", description: "Record ID (for update/deactivate)" },
      },
      required: ["action"],
    },
  },
  {
    name: "introspect",
    description: "Inspect the memory database: health status, table counts, record verification, and predefined reports.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["status", "count", "verify", "query", "migrate"],
          description: "Diagnostic action to perform",
        },
        table: { type: "string", description: "Table name (for count/verify)" },
        filter: {
          type: "string",
          enum: ["active", "inactive", "recent_24h", "with_embedding", "unresolved"],
          description: "Filter preset (for count)",
        },
        record_id: { type: "string", description: "Record ID (for verify)" },
      },
      required: ["action"],
    },
  },
  {
    name: "fetch_pending_work",
    description: "Claim the next pending background work item for processing. Returns instructions and data for extraction, reflection, skill, or soul work. Call repeatedly until it returns empty.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "commit_work_results",
    description: "Submit processed results for a pending work item. Persists extracted knowledge, reflections, skills, or soul documents to the memory database.",
    inputSchema: {
      type: "object" as const,
      properties: {
        work_id: { type: "string", description: "The work item ID from fetch_pending_work" },
        results: { description: "The extraction results — JSON object or plain text depending on work type" },
      },
      required: ["work_id", "results"],
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

/** Get or create a session for tool calls. Uses KONGCODE_SESSION_ID env var or a default. */
function getSession(): import("./engine/state.js").SessionState {
  const sessionId = process.env.KONGCODE_SESSION_ID ?? "mcp-default";
  return globalState!.getOrCreateSession(sessionId, sessionId);
}

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (!globalState) {
    return { content: [{ type: "text", text: "KongCode not initialized. Is SurrealDB running?" }] };
  }

  const session = getSession();

  switch (name) {
    case "recall":
      return handleRecall(globalState, session, args);
    case "core_memory":
      return handleCoreMemory(globalState, session, args);
    case "introspect":
      return handleIntrospect(globalState, session, args);
    case "fetch_pending_work":
      return handleFetchPendingWork(globalState, session, args);
    case "commit_work_results":
      return handleCommitWorkResults(globalState, session, args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

async function initialize(): Promise<void> {
  log.info("Initializing KongCode MCP server...");

  // Parse config from env vars
  const config = parsePluginConfig();

  // Create services
  const store = new SurrealStore(config.surreal);
  const embeddings = new EmbeddingService(config.embedding);

  // Build global state
  globalState = new GlobalPluginState(config, store, embeddings);
  globalState.workspaceDir = process.env.KONGCODE_PROJECT_DIR ?? process.cwd();

  // Connect to SurrealDB
  try {
    await store.initialize();
    log.info("SurrealDB connected");
  } catch (err) {
    log.error("SurrealDB connection failed — running in degraded mode:", err);
  }

  // Initialize embedding model
  try {
    await embeddings.initialize();
    log.info("Embedding model loaded");
  } catch (err) {
    log.error("Embedding model failed — running without vector search:", err);
  }

  // Register hook handlers
  registerHookHandler("session-start", handleSessionStart);
  registerHookHandler("session-end", handleSessionEnd);
  registerHookHandler("user-prompt-submit", handleUserPromptSubmit);
  registerHookHandler("pre-tool-use", handlePreToolUse);
  registerHookHandler("post-tool-use", handlePostToolUse);
  registerHookHandler("stop", handleStop);
  registerHookHandler("pre-compact", handlePreCompact);
  registerHookHandler("post-compact", handlePostCompact);
  registerHookHandler("task-created", handleTaskCreated);
  registerHookHandler("subagent-stop", handleSubagentStop);

  // Start internal HTTP API for hook communication.
  // Socket lives in user's home dir — stable, project-independent location.
  const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const socketPath = `${homeDir}/.kongcode.sock`;
  await startHttpApi(globalState, socketPath, homeDir);

  log.info("KongCode MCP server ready");
}

async function shutdown(): Promise<void> {
  log.info("Shutting down KongCode MCP server...");
  await stopHttpApi();
  if (globalState) {
    await globalState.shutdown();
    globalState = null;
  }
  log.info("KongCode shutdown complete");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const server = new Server(
    { name: "kongcode", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(name, (args ?? {}) as Record<string, unknown>);
  });

  // Initialize services
  await initialize();

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    await shutdown();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    await shutdown();
    process.exit(0);
  });

  // Start MCP stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("KongCode MCP server running on stdio");
}

main().catch((err) => {
  log.error("Fatal error:", err);
  process.exit(1);
});
