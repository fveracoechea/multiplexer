import { describe, expect, test } from "bun:test";
import { greet } from "./example.ts";

// Scaffolding example — proves the red-green loop and the `check` gate work.
// Safe to delete once real modules land (tracer bullet, #13).
describe("greet", () => {
  test("addresses the given name", () => {
    expect(greet("Ripley")).toBe("Hello, Ripley!");
  });

  test("trims surrounding whitespace", () => {
    expect(greet("  Bishop  ")).toBe("Hello, Bishop!");
  });
});
