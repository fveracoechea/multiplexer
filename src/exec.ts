export interface SpawnResult {
  readonly stdout: string;
  readonly exitCode: number;
}

/**
 * Spawn an external command, capture its trimmed stdout, and throw with stderr
 * on a non-zero exit. Shared plumbing behind the real tmux and git executors so
 * spawn hardening (cwd, stdin, timeouts) lives in one place.
 */
export async function spawnCapture(bin: string, args: string[]): Promise<SpawnResult> {
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`${bin} ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return { stdout: stdout.trim(), exitCode };
}
