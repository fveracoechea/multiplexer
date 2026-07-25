import { describe, expect, test } from "bun:test";
import {
  buildCrewRole,
  buildDismissPrompt,
  buildInitialPrompt,
  buildOrchestratorRole,
} from "./roles.ts";

describe("crew role prompt", () => {
  const role = buildCrewRole();

  test("is the portable markdown loaded from roles/crew.md, not a stub", () => {
    expect(role).toContain("# Crew Agent Role");
    expect(role.length).toBeGreaterThan(500);
  });

  test("encodes the reporting contract", () => {
    expect(role).toContain("progress");
    expect(role).toContain("milestone");
    expect(role).toMatch(/blocked.*hard halt/i);
    expect(role).toMatch(/report\(status: "done"\)/);
    expect(role).toMatch(/wrap-up.*report\(done\)/i);
  });

  test("encodes the PR / landing contract", () => {
    expect(role).toMatch(/direct merge.*default/i);
    expect(role).toMatch(/Closes #<n>.*only when an issue number was given/i);
    expect(role).toMatch(/repo.*guidelines/i);
    expect(role).toMatch(/integration branch/i);
    expect(role).toMatch(/never force-push/i);
  });

  test("encodes the guardrails", () => {
    expect(role).toMatch(/never inspect another crew/i);
    expect(role).toMatch(/never impersonate/i);
    expect(role).toMatch(/authored by the human Engineer/i);
  });

  test("encodes the interjection classification", () => {
    expect(role).toContain("answer-to-blocked");
    expect(role).toContain("redirect");
    expect(role).toContain("wrap-up-dismiss");
    expect(role).toContain("new-info");
  });
});

describe("buildInitialPrompt", () => {
  test("combines the skill and the prose scope", () => {
    expect(buildInitialPrompt("implement", "build the settings page")).toBe(
      "Use the implement skill.\n\nbuild the settings page",
    );
  });
});

describe("buildDismissPrompt", () => {
  test("tells the crew to wrap up and call report(done)", () => {
    expect(buildDismissPrompt()).toContain("report(done)");
  });
});

describe("orchestrator role prompt", () => {
  const role = buildOrchestratorRole();

  test("is the portable markdown loaded from roles/orchestrator.md, not a stub", () => {
    expect(role).toContain("# Orchestrator Role");
    expect(role.length).toBeGreaterThan(500);
  });

  test("declares itself the single point of contact for the Engineer", () => {
    expect(role).toMatch(/single point of contact/i);
    expect(role).toMatch(/crew never talk to the Engineer/i);
  });

  test("encodes conditional decomposition: direct dispatch, in-context grill, never a decomposition crew", () => {
    expect(role).toMatch(/directly/i);
    expect(role).toMatch(/\/to-tickets/);
    expect(role).toMatch(/\/to-spec/);
    expect(role).toMatch(/never.*decomposition crew/i);
  });

  test("permits firing exploratory research/prototype crew mid-grill", () => {
    expect(role).toMatch(/mid-grill/i);
    expect(role).toMatch(/research|prototype/i);
  });

  test("encodes conversational steering: resolve name -> steer_crew, clarifying question on ambiguity", () => {
    expect(role).toContain("steer_crew");
    expect(role).toMatch(/ambiguous/i);
    expect(role).toMatch(/clarifying question/i);
  });

  test("encodes pull-based: bounded crew_status digests, never raw pane scrollback", () => {
    expect(role).toMatch(/pull-based/i);
    expect(role).toMatch(/crew_status/);
    expect(role).toMatch(/never.*raw pane scrollback/i);
  });

  test("never does the delegated work itself", () => {
    expect(role).toMatch(/never do the delegated work yourself/i);
  });
});
