import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";
import { config } from "../lib/config";

let _db: NeonHttpDatabase<typeof schema> | null = null;

export function getDb(): NeonHttpDatabase<typeof schema> {
  if (!_db) {
    if (!config.databaseUrl) {
      throw new Error(
        "DATABASE_URL is not set. Set it in your environment or .env file."
      );
    }
    const sql = neon(config.databaseUrl);
    _db = drizzle(sql, { schema });
  }
  return _db;
}

// Re-export as `db` for convenience — will throw on access without DATABASE_URL
export const db = new Proxy({} as NeonHttpDatabase<typeof schema>, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});
