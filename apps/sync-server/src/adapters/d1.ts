import type { Database, Statement } from "../storage.js";

interface Prepared {
  bind(...values: Statement extends [string, ...infer Bindings] ? Bindings : never): Prepared;
}

export interface D1Binding {
  prepare(sql: string): Prepared;
  batch(statements: Prepared[]): Promise<{ results: object[] }[]>;
}

export function d1Database(binding: D1Binding): Database {
  return {
    async batch(statements) {
      const results = await binding.batch(statements.map(([sql, ...values]) => binding.prepare(sql).bind(...values)));
      return results.map(({ results }) => results);
    },
  };
}
