import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const firstMigration = new URL("../drizzle/0000_melodic_shadow_king.sql", import.meta.url);

/** Open a persistent local SQLite store with the same schema and query interface as D1. */
export function openRoomStore(filename = ":memory:") {
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
  const sqlite = new DatabaseSync(filename);
  try {
    sqlite.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
    const version = sqlite.prepare("PRAGMA user_version").get().user_version;
    if (version === 0) {
      sqlite.exec(readFileSync(firstMigration, "utf8"));
      sqlite.exec("PRAGMA user_version = 1");
    } else if (version !== 1) {
      throw new Error("Unrecognized room database schema version: " + version);
    }
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.close();
    throw error;
  }
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return { first: async () => sqlite.prepare(sql).get(...params) ?? null };
        },
      };
    },
    close: () => sqlite.close(),
  };
}
