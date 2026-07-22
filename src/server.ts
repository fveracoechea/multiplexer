import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Adapter } from "./adapter/types.ts";
import type { MuxConfig } from "./config.ts";
import { assignCrew } from "./crew/assign.ts";
import { appendReport, REPORT_STATUSES } from "./crew/report.ts";
import { crewDetail, crewOverview } from "./crew/status.ts";
import { steerCrew } from "./crew/steer.ts";
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
  /**
   * The crew this connection belongs to, bound to the MCP connection URL
   * (ADR-0001); undefined for the orchestrator's session-scoped connection.
   * Only a crew connection may `report`.
   */
  readonly connectedCrew?: string;
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
        "Spawn (or, for an existing name, retask) a named crew agent with a (skill, scope) " +
        "assignment. Read-only skills provision no worktree.",
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

  // Crew-facing: append a progress/milestone/blocked/done report to the calling
  // crew's current assignment. The caller is identified by the connection.
  server.registerTool(
    "report",
    {
      title: "Report progress",
      description:
        "Append a progress, milestone, blocked, or done report against your current assignment. " +
        "blocked is a hard halt awaiting a steer; done is terminal.",
      inputSchema: {
        summary: z.string().min(1).describe("Short human-readable progress summary."),
        status: z.enum(REPORT_STATUSES).describe("progress | milestone | blocked | done."),
        reportPath: z
          .string()
          .optional()
          .describe("Free-form pointer to an artifact the skill produced, if any."),
        prUrl: z.string().optional().describe("URL of an opened pull request, if any."),
      },
    },
    (args) => {
      if (!deps.connectedCrew) {
        throw new Error("report is only callable by a crew agent");
      }
      const event = appendReport(deps, { connectedCrew: deps.connectedCrew, ...args });
      return {
        content: [
          { type: "text", text: `Recorded ${event.status} report (event #${event.id}).` },
          { type: "text", text: JSON.stringify(event) },
        ],
      };
    },
  );

  // Orchestrator-facing: deliver a steering message to a crew's pane. Valid at
  // any crew status; resumes an assignment halted by report(blocked).
  server.registerTool(
    "steer_crew",
    {
      title: "Steer crew",
      description:
        "Deliver a message to a running crew agent's pane as send-keys input. Fire-and-forget " +
        "and valid at any crew status; resumes a crew halted by report(blocked).",
      inputSchema: {
        name: z.string().min(1).describe("Crew name to steer."),
        message: z.string().min(1).describe("Message to send into the crew's pane."),
      },
    },
    async (args) => {
      const result = await steerCrew(deps, args);
      return {
        content: [
          {
            type: "text",
            text: result.resumed
              ? `Steered ${args.name}; resumed from blocked.`
              : `Steered ${args.name}.`,
          },
          { type: "text", text: JSON.stringify(result) },
        ],
      };
    },
  );

  // Orchestrator-facing: fleet overview (no name) or one crew's capped detail.
  server.registerTool(
    "crew_status",
    {
      title: "Crew status",
      description:
        "Without a name, a bounded overview of all crew in the session. With a name, that " +
        "crew's detail capped to its most recent events.",
      inputSchema: {
        name: z.string().optional().describe("Crew name for detail; omit for the fleet overview."),
      },
    },
    (args) => {
      if (args.name) {
        const detail = crewDetail(deps, args.name);
        if (!detail) {
          throw new Error(`unknown crew "${args.name}" in this session`);
        }
        return { content: [{ type: "text", text: JSON.stringify(detail) }] };
      }
      const overview = crewOverview(deps);
      return { content: [{ type: "text", text: JSON.stringify(overview) }] };
    },
  );

  return server;
}
