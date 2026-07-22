import { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema.ts";

export type MuxDb = ReturnType<typeof drizzle<typeof schema>>;

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Open a mux database and apply migrations.
 *
 * @param path `:memory:` in tests, a file under the server's PWD in production.
 */
export function createDb(path = ":memory:"): MuxDb {
  const db = drizzle(new Database(path), { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

export { schema };
