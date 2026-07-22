import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ClaudeAdapter } from "../adapter/claude.ts";
import type { MuxConfig } from "../config.ts";
import { createDb, type MuxDb } from "../db/index.ts";
import { FakeGitExecutor } from "../git/executor.ts";
import { createMuxServer } from "../server.ts";
import { FakeTmuxExecutor } from "../tmux/executor.ts";
import { MAX_DETAIL_EVENTS } from "./status.ts";

interface CrewOverviewItem {
  name: string;
  status: string | null;
  lastSummary: string | null;
  skill: string | null;
}
interface CrewDetail {
  name: string;
  events: Array<{ status: string; summary: string; reportPath: string | null }>;
}

function makeConfig(sessionKey: string): MuxConfig {
  return {
    sessionKey,
    mcpUrl: "http://localhost:4123/mcp",
    mcpServerName: "mux",
    serverPwd: "/tmp/mux",
  };
}

describe("report + crew_status tool surface", () => {
  let db: MuxDb;
  let tmux: FakeTmuxExecutor;
  let git: FakeGitExecutor;
  const adapters = new Map([["claude", new ClaudeAdapter()]]);

  /** Connect a client scoped as the orchestrator or as a specific crew. */
  async function connect(config: MuxConfig, connectedCrew?: string): Promise<Client> {
    const server = createMuxServer({ db, tmux, git, adapters, config, connectedCrew });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  function parse<T>(result: unknown): T {
    const { content } = result as { content: Array<{ type: string; text: string }> };
    const json = content.find((c) => c.type === "text" && c.text.startsWith("{"));
    const arr = content.find((c) => c.type === "text" && c.text.startsWith("["));
    const text = (json ?? arr)?.text;
    if (!text) throw new Error("no JSON content in result");
    return JSON.parse(text) as T;
  }

  async function assign(orchestrator: Client, name: string, skill = "implement", scope = "work") {
    await orchestrator.callTool({ name: "assign_crew", arguments: { name, skill, scope } });
  }

  beforeEach(() => {
    db = createDb();
    tmux = new FakeTmuxExecutor();
    git = new FakeGitExecutor();
  });

  test("the tool surface has no way to read raw pane scrollback", async () => {
    const client = await connect(makeConfig("p"));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["assign_crew", "crew_status", "report"]);
    // No capture-pane / scrollback tool exists (spec #11 anti-context-bloat).
    expect(names.some((n) => /capture|scrollback|pane/.test(n))).toBe(false);
  });

  test("a crew report is appended and read back through crew_status detail", async () => {
    const config = makeConfig("p");
    const orchestrator = await connect(config);
    await assign(orchestrator, "ripley", "research", "survey auth");

    const ripley = await connect(config, "ripley");
    await ripley.callTool({
      name: "report",
      arguments: { summary: "found three flows", status: "milestone", reportPath: "notes.md" },
    });

    const detail = parse<CrewDetail>(
      await orchestrator.callTool({ name: "crew_status", arguments: { name: "ripley" } }),
    );
    expect(detail.name).toBe("ripley");
    expect(detail.events).toHaveLength(1);
    expect(detail.events[0]).toMatchObject({
      status: "milestone",
      summary: "found three flows",
      reportPath: "notes.md",
    });
  });

  test("crew_status detail is capped to the last ~15 events, most recent kept", async () => {
    const config = makeConfig("p");
    const orchestrator = await connect(config);
    await assign(orchestrator, "bishop");

    const bishop = await connect(config, "bishop");
    for (let i = 1; i <= 20; i++) {
      await bishop.callTool({
        name: "report",
        arguments: { summary: `step ${i}`, status: "progress" },
      });
    }

    const detail = parse<CrewDetail>(
      await orchestrator.callTool({ name: "crew_status", arguments: { name: "bishop" } }),
    );
    expect(detail.events).toHaveLength(MAX_DETAIL_EVENTS);
    // The 15 most recent, in chronological order (steps 6..20).
    expect(detail.events[0]?.summary).toBe("step 6");
    expect(detail.events.at(-1)?.summary).toBe("step 20");
  });

  test("crew_status overview is one bounded line per crew, no event history", async () => {
    const config = makeConfig("p");
    const orchestrator = await connect(config);
    await assign(orchestrator, "ripley", "research", "one");
    await assign(orchestrator, "hicks", "implement", "two");

    const hicks = await connect(config, "hicks");
    await hicks.callTool({
      name: "report",
      arguments: { summary: "building", status: "progress" },
    });

    const overview = parse<CrewOverviewItem[]>(
      await orchestrator.callTool({ name: "crew_status", arguments: {} }),
    );
    expect(overview.map((c) => c.name)).toEqual(["ripley", "hicks"]);
    // Overview reflects latest status and last summary but carries no event array.
    const hicksItem = overview.find((c) => c.name === "hicks");
    expect(hicksItem?.status).toBe("progress");
    expect(hicksItem?.lastSummary).toBe("building");
    expect(hicksItem as unknown as { events?: unknown }).not.toHaveProperty("events");
    // A crew that hasn't reported yet falls back to its assignment status.
    expect(overview.find((c) => c.name === "ripley")?.status).toBe("active");
  });

  test("report is rejected on an orchestrator (non-crew) connection", async () => {
    const config = makeConfig("p");
    const orchestrator = await connect(config);
    await assign(orchestrator, "ripley");

    const result = await orchestrator.callTool({
      name: "report",
      arguments: { summary: "should fail", status: "progress" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  test("session key isolates reports and status between project sessions", async () => {
    const configA = makeConfig("proj-a");
    const configB = makeConfig("proj-b");
    const orchA = await connect(configA);
    const orchB = await connect(configB);
    await assign(orchA, "ripley", "research", "a-work");
    await assign(orchB, "ripley", "research", "b-work");

    const ripleyA = await connect(configA, "ripley");
    await ripleyA.callTool({
      name: "report",
      arguments: { summary: "a-progress", status: "progress" },
    });

    // Session B's ripley has no events; session A's does. No cross-leak.
    const detailB = parse<CrewDetail>(
      await orchB.callTool({ name: "crew_status", arguments: { name: "ripley" } }),
    );
    expect(detailB.events).toHaveLength(0);

    const overviewB = parse<CrewOverviewItem[]>(
      await orchB.callTool({ name: "crew_status", arguments: {} }),
    );
    expect(overviewB).toHaveLength(1);
    expect(overviewB[0]?.skill).toBe("research");
    expect(overviewB[0]?.lastSummary).toBeNull();
  });
});
