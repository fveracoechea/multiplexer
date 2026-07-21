/**
 * Scaffolding example module. Proves the toolchain (typecheck + Biome + bun:test)
 * is wired end-to-end. Safe to delete once real modules land (tracer bullet, #13).
 */
export function greet(name: string): string {
  return `Hello, ${name.trim()}!`;
}
