import { DatabaseSync } from "node:sqlite";

/**
 * A D1Database over node:sqlite, so the whole suite runs offline with real SQL
 * rather than a hand-written fake that agrees with whatever the code does.
 * D1 *is* SQLite, so this exercises the actual queries.
 */
export function makeD1(schema: string): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);

  const stmt = (sql: string, params: unknown[] = []): D1PreparedStatement => ({
    bind: (...args: unknown[]) => stmt(sql, args),
    async first<T>(column?: string) {
      const row = db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined;
      if (!row) return null;
      return (column ? (row[column] as T) : (row as T)) ?? null;
    },
    async all<T>() {
      const results = db.prepare(sql).all(...(params as never[])) as T[];
      return { results, success: true, meta: {} } as D1Result<T>;
    },
    async run() {
      const info = db.prepare(sql).run(...(params as never[]));
      return {
        results: [],
        success: true,
        meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
      } as unknown as D1Result;
    },
    async raw<T>() {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  }) as D1PreparedStatement;

  return {
    prepare: (sql: string) => stmt(sql),
    async batch<T>(statements: D1PreparedStatement[]) {
      const out: D1Result<T>[] = [];
      for (const s of statements) out.push((await s.run()) as D1Result<T>);
      return out;
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
    withSession: () => {
      throw new Error("not used");
    },
  } as unknown as D1Database;
}
