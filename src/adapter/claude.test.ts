import { describe, expect, test } from "bun:test";
import { ClaudeAdapter } from "./claude.ts";

describe("ClaudeAdapter", () => {
  const adapter = new ClaudeAdapter();

  const spec = {
    crewName: "ripley",
    role: "You are a crew agent.",
    initialPrompt: "Use the research skill.\n\nsurvey the auth flow",
    mcpServerName: "multiplexer",
    mcpUrl: "http://localhost:4123/mcp",
    worktreePath: null,
    serverPwd: "/tmp/multiplexer",
    sessionKey: "proj-a",
  };

  test("declares the claude agent type", () => {
    expect(adapter.agentType).toBe("claude");
  });

  test("injects the role inline via --append-system-prompt", () => {
    const { argv } = adapter.prepare(spec);
    const idx = argv.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe(spec.role);
  });

  test("passes the initial prompt as claude's positional argument", () => {
    const { argv } = adapter.prepare(spec);
    expect(argv[0]).toBe("claude");
    expect(argv[1]).toBe(spec.initialPrompt);
  });

  test("wires the MCP server hermetically with an http url entry", () => {
    const { argv } = adapter.prepare(spec);
    expect(argv).toContain("--strict-mcp-config");

    const idx = argv.indexOf("--mcp-config");
    expect(idx).toBeGreaterThan(-1);
    // A URL entry with no `type` is a config error in Claude Code; type is set.
    expect(JSON.parse(argv[idx + 1] as string)).toEqual({
      mcpServers: { multiplexer: { type: "http", url: "http://localhost:4123/mcp" } },
    });
  });

  test("does not redirect the launch cwd; the worktree path is used by the caller", () => {
    const { cwd } = adapter.prepare(spec);
    expect(cwd).toBeUndefined();
  });

  test("isIdle detects Claude's prompt cursor as ready, spinner as busy", () => {
    expect(adapter.isIdle(">")).toBe(true);
    expect(adapter.isIdle("some output\n> ")).toBe(true);
    expect(adapter.isIdle("⠋ working...\n")).toBe(false);
    expect(adapter.isIdle("")).toBe(false);
  });
});
