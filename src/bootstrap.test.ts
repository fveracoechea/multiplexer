import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "./adapter/claude.ts";
import { bootstrap, ORCHESTRATOR_WINDOW, pidFilePath, SERVER_TMUX_SESSION } from "./bootstrap.ts";
import { FakeTmuxExecutor } from "./tmux/executor.ts";

/**
 * The bootstrap uses tmux + health-check + PID file. tmux is faked so we assert
 * the exact argv for server start and orchestrator launch; the health check is
 * faked so we can exercise both the reuse and start paths deterministically;
 * the PID file lives in a real temp HOME so isOurServerAlive is exercised for
 * real (spec #22).
 */
describe("multiplexer bootstrap", () => {
  let tmux: FakeTmuxExecutor;
  let home: string;
  let healthy: boolean;

  beforeEach(() => {
    tmux = new FakeTmuxExecutor();
    home = mkdtempSync(join(tmpdir(), "multiplexer-bootstrap-"));
    process.env.HOME = home;
    healthy = false;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function deps() {
    return {
      tmux,
      adapters: new Map([["claude", new ClaudeAdapter()]]),
      isHealthy: () => Promise.resolve(tmux.callsOf("new-session").length > 0 || healthy),
      sleep: () => Promise.resolve(),
    };
  }

  function config(
    overrides: Partial<{ projectPwd: string; tmuxSession: string; sessionKey: string }> = {},
  ) {
    return {
      projectPwd: join(home, "project"),
      tmuxSession: "myproj",
      sessionKey: "myproj",
      ...overrides,
    };
  }

  test("when no healthy server is running, starts one in its own tmux session then launches the orchestrator", async () => {
    // The server becomes healthy after the start command is emitted.
    let started = false;
    const d = {
      ...deps(),
      isHealthy: () => {
        if (started) return Promise.resolve(true);
        // The first health check fails (no server yet); the second (after start) passes.
        const startedNow = tmux.callsOf("new-session").length > 0;
        started = startedNow;
        return Promise.resolve(startedNow);
      },
    };

    await bootstrap(d, config());

    // The server starts in its own dedicated tmux session.
    const [start] = tmux.callsOf("new-session");
    expect(start?.slice(0, 4)).toEqual(["new-session", "-d", "-s", SERVER_TMUX_SESSION]);
    expect(start).toContain("bun");
    expect(start).toContain("src/index.ts");

    // The Orchestrator window is created in the user's session.
    const [win] = tmux.callsOf("new-window");
    expect(win).toEqual([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      "myproj",
      "-n",
      ORCHESTRATOR_WINDOW,
      "-c",
      join(home, "project"),
    ]);

    // The Orchestrator is launched into that pane, pre-wired to the MCP server.
    const [respawn] = tmux.callsOf("respawn-pane");
    expect(respawn?.[0]).toBe("respawn-pane");
    expect(respawn).toContain("claude");
    expect(respawn).toContain("--append-system-prompt");
    expect(respawn).toContain("--strict-mcp-config");
    // The orchestrator connects to its session endpoint: /mcp/<sessionKey>.
    if (!respawn) throw new Error("expected respawn-pane");
    const mcpIdx = respawn.indexOf("--mcp-config");
    const mcpConfig = JSON.parse(respawn[mcpIdx + 1] as string);
    expect(mcpConfig).toEqual({
      mcpServers: { multiplexer: { type: "http", url: "http://localhost:4123/mcp/myproj" } },
    });
  });

  test("a healthy server that is ours (PID file matches a live process) is reused, not restarted", async () => {
    // Write a PID file pointing at our own test process (which is alive).
    mkdirSync(join(home, ".multiplexer"), { recursive: true });
    writeFileSync(pidFilePath(), String(process.pid));
    healthy = true;

    await bootstrap(deps(), config());

    // No server start.
    expect(tmux.callsOf("new-session")).toHaveLength(0);
    // The Orchestrator window is still created and the agent launched.
    expect(tmux.callsOf("new-window")).toHaveLength(1);
    expect(tmux.callsOf("respawn-pane")).toHaveLength(1);
  });

  test("a healthy server whose PID file points at a dead process is restarted", async () => {
    // A stale PID file pointing at a dead process.
    mkdirSync(join(home, ".multiplexer"), { recursive: true });
    writeFileSync(pidFilePath(), "999999");
    healthy = true;

    await bootstrap(deps(), config());

    // Even though the port responds, the stale PID means it isn't ours: start.
    expect(tmux.callsOf("new-session")).toHaveLength(1);
  });

  test("a missing PID file means the server is not ours, even if the port responds", async () => {
    healthy = true;
    // No PID file written.

    await bootstrap(deps(), config());

    expect(tmux.callsOf("new-session")).toHaveLength(1);
  });

  test("the orchestrator launches in the project's working directory", async () => {
    const projectPwd = join(home, "my-repo");
    await bootstrap(deps(), config({ projectPwd }));

    const [win] = tmux.callsOf("new-window");
    expect(win?.at(-1)).toBe(projectPwd);

    const [respawn] = tmux.callsOf("respawn-pane");
    if (!respawn) throw new Error("expected respawn-pane");
    const cIdx = respawn.indexOf("-c");
    expect(respawn[cIdx + 1]).toBe(projectPwd);
  });

  test("the session key is baked into the orchestrator's MCP URL", async () => {
    await bootstrap(deps(), config({ sessionKey: "custom-key" }));

    const [respawn] = tmux.callsOf("respawn-pane");
    if (!respawn) throw new Error("expected respawn-pane");
    const mcpIdx = respawn.indexOf("--mcp-config");
    const mcpConfig = JSON.parse(respawn[mcpIdx + 1] as string);
    expect(mcpConfig.mcpServers.multiplexer.url).toBe("http://localhost:4123/mcp/custom-key");
  });

  test("a custom port is honored for both discovery and the orchestrator's MCP URL", async () => {
    await bootstrap(deps(), { ...config(), port: 9999 });

    const [respawn] = tmux.callsOf("respawn-pane");
    if (!respawn) throw new Error("expected respawn-pane");
    const mcpIdx = respawn.indexOf("--mcp-config");
    const mcpConfig = JSON.parse(respawn[mcpIdx + 1] as string);
    expect(mcpConfig.mcpServers.multiplexer.url).toBe("http://localhost:9999/mcp/myproj");
  });

  test("the server start command runs from a dedicated, non-project state directory", async () => {
    await bootstrap(deps(), config());

    const [start] = tmux.callsOf("new-session");
    if (!start) throw new Error("expected new-session");
    const cIdx = start.indexOf("-c");
    expect(cIdx).toBeGreaterThan(-1);
    const serverDir = start[cIdx + 1];
    if (!serverDir) throw new Error("expected -c value");
    // The server's state dir is under ~/.multiplexer/server, not the project dir.
    expect(serverDir).toContain(".multiplexer");
    expect(serverDir).not.toContain("project");
    expect(existsSync(serverDir)).toBe(true);
  });
});
