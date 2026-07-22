import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Adapter } from "./adapter/types.ts";
import type { MuxConfig } from "./config.ts";
import { assignCrew } from "./crew/assign.ts";
import type { MuxDb } from "./db/index.ts";
import type { GitExecutor } from "./git/executor.ts";
import type { TmuxExecutor } from "./tmux/executor.ts";

/** Everything an MCP server instance needs to serve one shared, session-aware surface. */
export interface MuxServerDeps {
  readonly db: MuxDb;
  readonly tmux: TmuxExecutor;
  readonly git: GitExecutor;
  readonly adapters: ReadonlyMap<string, Adapter>;
  readonly config: MuxConfig;
}

/**
 * Build the mux MCP server and register its tool surface.
 *
 * This is the single seam the whole system is tested through: tools are driven
 * against a real server + real in-memory DB, asserting resulting DB rows and
 * emitted tmux argv (spec #11).
 */
export function createMuxServer(deps: MuxServerDeps): McpServer {
  const server = new McpServer(
    { name: deps.config.mcpServerName, version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "assign_crew",
    {
      title: "Assign crew",
      description:
        "Spawn (or, later, retask) a named crew agent with a (skill, scope) assignment. " +
        "Read-only skills provision no worktree.",
      inputSchema: {
        name: z.string().min(1).describe("Stable lowercase sci-fi crew name, unique per session."),
        skill: z.string().min(1).describe("Skill to run (e.g. research, implement, review)."),
        scope: z.string().min(1).describe("What the crew agent should do."),
        agentType: z.string().optional().describe("Agent CLI to launch; defaults to claude."),
        issue: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Optional issue number for PR linkage; a shared issue implies a shared branch.",
          ),
      },
    },
    async (args) => {
      const result = await assignCrew(deps, args);
      return {
        content: [
          {
            type: "text",
            text: `Assigned ${result.name} (crew #${result.crewId}, assignment #${result.assignmentId}) in pane ${result.paneId}.`,
          },
          { type: "text", text: JSON.stringify(result) },
        ],
      };
    },
  );

  return server;
}
