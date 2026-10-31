import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const rooms = sqliteTable("rooms", {
  code: text("code").primaryKey(),
  whiteHash: text("white_hash").notNull().unique(),
  blackHash: text("black_hash"),
  revision: integer("revision").notNull(),
  state: text("state").notNull(),
  log: text("log").notNull(),
  outcome: text("outcome"),
});
