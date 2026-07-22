/**
 * Skill classification.
 *
 * A skill is the primary unit of delegation (spec #11). What matters at spawn
 * time is whether a skill mutates files: read-only skills (research, review)
 * need no git worktree, while file-mutating skills each get their own so that
 * parallel crew can't collide on the working tree. This is the single source of
 * truth for that distinction.
 */
const READ_ONLY_SKILLS: ReadonlySet<string> = new Set(["research", "review", "code-review"]);

/** True when a skill only reads the codebase and therefore needs no worktree. */
export function isReadOnlySkill(skill: string): boolean {
  return READ_ONLY_SKILLS.has(skill.trim().toLowerCase());
}
