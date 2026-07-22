/**
 * Role prompt + task prompt construction.
 *
 * Roles (personas) are shipped as portable markdown in the full system; the
 * tracer bullet uses a minimal inline crew role so the spawn path is complete
 * end-to-end. Richer role content is layered in by the crew-role ticket without
 * changing this seam.
 */

/** Minimal crew persona injected via the adapter's system-prompt mechanism. */
export function buildCrewRole(): string {
  return [
    "You are a crew agent in a tmux-based orchestration system.",
    "You take one (skill, scope) assignment at a time from the Orchestrator.",
    "Report progress and a terminal result through the mux MCP tools.",
    "Never talk to the Engineer directly; the Orchestrator is your only channel.",
  ].join(" ");
}

/** The task prompt handed to a freshly launched crew agent. */
export function buildInitialPrompt(skill: string, scope: string): string {
  return `Use the ${skill} skill.\n\n${scope}`;
}
