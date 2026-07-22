import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDb } from "./index.ts";
import { assignments, crew, events } from "./schema.ts";

describe("schema + migrations", () => {
  test("createDb applies migrations so all three tables exist", () => {
    const db = createDb();
    // A select against each table would throw if the table were missing.
    expect(db.select().from(crew).all()).toEqual([]);
    expect(db.select().from(assignments).all()).toEqual([]);
    expect(db.select().from(events).all()).toEqual([]);
  });

  test("crew name is unique within a session but reusable across sessions", () => {
    const db = createDb();
    db.insert(crew).values({ sessionKey: "a", name: "ripley", agentType: "claude" }).run();
    db.insert(crew).values({ sessionKey: "b", name: "ripley", agentType: "claude" }).run();

    expect(() =>
      db.insert(crew).values({ sessionKey: "a", name: "ripley", agentType: "claude" }).run(),
    ).toThrow();

    expect(db.select().from(crew).all()).toHaveLength(2);
  });

  test("assignments and events reference their parents and default sensibly", () => {
    const db = createDb();
    const c = db
      .insert(crew)
      .values({ sessionKey: "a", name: "ripley", agentType: "claude" })
      .returning()
      .get();
    const a = db
      .insert(assignments)
      .values({ sessionKey: "a", crewId: c.id, skill: "research", scope: "x", agentType: "claude" })
      .returning()
      .get();

    // status defaults to active; issue is nullable.
    expect(a.status).toBe("active");
    expect(a.issue).toBeNull();
    expect(a.createdAt).toBeInstanceOf(Date);

    const e = db
      .insert(events)
      .values({ sessionKey: "a", assignmentId: a.id, status: "progress", summary: "started" })
      .returning()
      .get();
    expect(e.assignmentId).toBe(a.id);
    expect(db.select().from(events).where(eq(events.assignmentId, a.id)).all()).toHaveLength(1);
  });
});
