import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeAdapter, opencodeConfigDir } from "./opencode.ts";

describe("OpencodeAdapter", () => {
  const adapter = new OpencodeAdapter();
  let serverPwd: string;

  beforeEach(() => {
    serverPwd = mkdtempSync(join(tmpdir(), "mux-opencode-"));
  });

  afterEach(() => {
    rmSync(serverPwd, { recursive: true, force: true });
  });

  function read(path: string): string {
    if (!existsSync(path)) throw new Error(`expected file at ${path}`);
    return readFileSync(path, "utf8");
  }

  const baseSpec = {
    role: "You are a crew agent in a tmux-based orchestration system.",
    initialPrompt: "Use the research skill.\n\nsurvey the auth flow",
    mcpServerName: "mux",
    mcpUrl: "http://localhost:4123/mcp/ripley",
  };

  test("declares the opencode agent type", () => {
    expect(adapter.agentType).toBe("opencode");
  });

  test("emits an opencode --agent launch referencing the crew name", () => {
    const { argv } = adapter.prepare({
      ...baseSpec,
      crewName: "ripley",
      worktreePath: null,
      serverPwd,
      sessionKey: "proj-a",
    });
    expect(argv[0]).toBe("opencode");
    const idx = argv.indexOf("--agent");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("ripley");
    expect(argv).toContain(baseSpec.initialPrompt);
  });

  test("writes a per-crew agent config file (frontmatter + body-as-prompt)", () => {
    const crewName = "ripley";
    adapter.prepare({
      ...baseSpec,
      crewName,
      worktreePath: null,
      serverPwd,
      sessionKey: "proj-a",
    });

    const agentFile = read(
      join(
        opencodeConfigDir(serverPwd, "proj-a", crewName),
        ".opencode",
        "agents",
        `${crewName}.md`,
      ),
    );
    // Frontmatter declares a primary-mode agent.
    expect(agentFile).toContain("---");
    expect(agentFile).toContain("mode: primary");
    expect(agentFile).toContain(`description: mux crew agent ${crewName}`);
    // Body is the role.
    expect(agentFile).toContain(baseSpec.role);
  });

  test("writes an opencode.json mcp entry with type remote + the per-crew localhost url", () => {
    const { mcpServerName, mcpUrl } = baseSpec;
    adapter.prepare({
      ...baseSpec,
      crewName: "ripley",
      worktreePath: null,
      serverPwd,
      sessionKey: "proj-a",
    });

    const config = read(join(opencodeConfigDir(serverPwd, "proj-a", "ripley"), "opencode.json"));
    expect(JSON.parse(config)).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: { [mcpServerName]: { type: "remote", url: mcpUrl, enabled: true } },
    });
  });

  test("directs the launch cwd at the per-crew config dir so opencode finds its config", () => {
    const { cwd } = adapter.prepare({
      ...baseSpec,
      crewName: "ripley",
      worktreePath: null,
      serverPwd,
      sessionKey: "proj-a",
    });
    expect(cwd).toBe(opencodeConfigDir(serverPwd, "proj-a", "ripley"));
  });

  test("a file-mutating crew's role preamble names its worktree path", () => {
    const worktreePath = "/srv/.mux/worktrees/proj-a/ripley";
    adapter.prepare({
      ...baseSpec,
      crewName: "ripley",
      worktreePath,
      serverPwd,
      sessionKey: "proj-a",
    });
    const agentFile = read(
      join(opencodeConfigDir(serverPwd, "proj-a", "ripley"), ".opencode", "agents", "ripley.md"),
    );
    expect(agentFile).toContain(`Your project worktree is at ${worktreePath}`);
  });

  test("a read-only crew's role preamble names the server pwd as its project root", () => {
    adapter.prepare({
      ...baseSpec,
      crewName: "bishop",
      worktreePath: null,
      serverPwd,
      sessionKey: "proj-a",
    });
    const agentFile = read(
      join(opencodeConfigDir(serverPwd, "proj-a", "bishop"), ".opencode", "agents", "bishop.md"),
    );
    expect(agentFile).toContain(`Your project root is ${serverPwd}`);
  });

  test("each crew gets an isolated config dir namespaced by session and name", () => {
    adapter.prepare({
      ...baseSpec,
      crewName: "ripley",
      worktreePath: null,
      serverPwd,
      sessionKey: "proj-a",
    });
    adapter.prepare({
      ...baseSpec,
      crewName: "ripley",
      worktreePath: null,
      serverPwd,
      sessionKey: "proj-b",
    });

    expect(
      existsSync(join(opencodeConfigDir(serverPwd, "proj-a", "ripley"), "opencode.json")),
    ).toBe(true);
    expect(
      existsSync(join(opencodeConfigDir(serverPwd, "proj-b", "ripley"), "opencode.json")),
    ).toBe(true);
  });
});
