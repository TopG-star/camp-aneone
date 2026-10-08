import type Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase, runMigrations } from "../connection.js";

export type ControlDb = Database.Database & { readonly __control: unique symbol };

const __dirname = dirname(fileURLToPath(import.meta.url));

// Same convention as the personal migrations: SQL files are read from src, also when running from dist.
function getControlMigrationsDir(): string {
  if (__dirname.includes("dist")) {
    return join(__dirname, "..", "..", "..", "src", "database", "control-migrations");
  }
  return join(__dirname, "..", "control-migrations");
}

export function openControlDb(path: string): ControlDb {
  const db = createDatabase(path);
  runMigrations(db, getControlMigrationsDir());
  return db as ControlDb;
}
