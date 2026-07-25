/**
 * Role prompt + task prompt construction.
 *
 * Roles (personas) are shipped as portable markdown in `roles/` and loaded at
 * runtime. Each role encodes the behavioral contract for one role (orchestrator
 * or crew); the adapter injects it per CLI (Claude via `--append-system-prompt`,
 * opencode as the agent file body). Keeping roles as markdown lets them be read
 * and edited independently of the code that loads them.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CREW_ROLE_PATH = fileURLToPath(new URL("../roles/crew.md", import.meta.url));

let cachedCrewRole: string | undefined;

/** The crew role prompt, loaded from `roles/crew.md` (portable markdown, spec #24). */
export function buildCrewRole(): string {
  if (cachedCrewRole === undefined) {
    cachedCrewRole = readFileSync(CREW_ROLE_PATH, "utf8");
  }
  return cachedCrewRole;
}

/** The task prompt handed to a freshly launched crew agent. */
export function buildInitialPrompt(skill: string, scope: string): string {
  return `Use the ${skill} skill.\n\n${scope}`;
}

/** The wrap-up instruction sent into a crew's pane on a graceful `dismiss_crew`. */
export function buildDismissPrompt(): string {
  return "You are being dismissed. Wrap up your current work now and call report(done).";
}
