import Sqlite from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import type { Database, Statement } from "../storage.js";

export function openSqlite(path: string) {
  const conn = new Sqlite(path);
  conn.pragma("journal_mode = WAL");
  const migrations = new URL("../../migrations/", import.meta.url);
  conn.transaction(() => {
    conn.exec("CREATE TABLE IF NOT EXISTS sync_migrations (name TEXT PRIMARY KEY) STRICT");
    const applied = conn.prepare("SELECT 1 FROM sync_migrations WHERE name = ?");
    const mark = conn.prepare("INSERT INTO sync_migrations VALUES (?)");
    for (const name of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort()) {
      if (applied.get(name)) continue;
      conn.exec(readFileSync(new URL(name, migrations), "utf8"));
      mark.run(name);
    }
  }).immediate();

  const run = conn.transaction((statements: Statement[]) =>
    statements.map(([sql, ...values]) => {
      const statement = conn.prepare(sql);
      if (statement.reader) return statement.all(...values) as object[];
      statement.run(...values);
      return [];
    }),
  );

  return {
    batch: async (statements) => statements.length === 1 && /^SELECT\b/.test(statements[0][0])
      ? run(statements)
      : run.immediate(statements),
    close: () => conn.close(),
  } satisfies Database & { close(): void };
}
