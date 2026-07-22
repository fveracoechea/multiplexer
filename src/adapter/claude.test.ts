import { describe, expect, test } from "bun:test";
import { ClaudeAdapter } from "./claude.ts";

describe("ClaudeAdapter", () => {
  const adapter = new ClaudeAdapter();

  const spec = {
    crewName: "ripley",
    role: "You are a crew agent.",
    initialPrompt: "Use the research skill.\n\nsurvey the auth flow",
    mcpServerName: "mux",
    mcpUrl: "http://localhost:4123/mcp",
  };

  test("declares the claude agent type", () => {
    expect(adapter.agentType).toBe("claude");
  });

  test("injects the role inline via --append-system-prompt", () => {
    const argv = adapter.buildLaunchCommand(spec);
    const idx = argv.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe(spec.role);
  });

  test("passes the initial prompt as claude's positional argument", () => {
    const argv = adapter.buildLaunchCommand(spec);
    expect(argv[0]).toBe("claude");
    expect(argv[1]).toBe(spec.initialPrompt);
  });

  test("wires the MCP server hermetically with an http url entry", () => {
    const argv = adapter.buildLaunchCommand(spec);
    expect(argv).toContain("--strict-mcp-config");

    const idx = argv.indexOf("--mcp-config");
    expect(idx).toBeGreaterThan(-1);
    // A URL entry with no `type` is a config error in Claude Code; type is set.
    expect(JSON.parse(argv[idx + 1] as string)).toEqual({
      mcpServers: { mux: { type: "http", url: "http://localhost:4123/mcp" } },
    });
  });
});
