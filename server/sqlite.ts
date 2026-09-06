import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// A SQLite driver wearing Bun.SQL's clothes: the rest of the server keeps writing
// `await sql`SELECT …${value}`` and `sql.unsafe(text, args)` without caring which
// engine is underneath. Statements are synchronous here, but the API stays
// promise-based so call sites are identical across both backends.

export interface SqlDriver {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<any[]>;
  unsafe(text: string, params?: unknown[]): Promise<any[]>;
  close(): void;
}

// Bun binds only these; everything else (objects, arrays, booleans, Date) has to be
// converted on the way in. JSON columns are TEXT here, so objects arrive stringified.
function bind(v: unknown): string | number | bigint | boolean | null | Uint8Array {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

// Columns that hold JSON. SQLite hands them back as text, but Postgres hands back
// parsed values, so parse here to keep row shapes identical across backends.
const JSON_COLUMNS = new Set(["data", "doc", "contributors", "embed_pos", "policies"]);
const BOOLEAN_COLUMNS = new Set(["spa_fallback"]);

function revive(row: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(row)) {
    const v = row[key];
    if (JSON_COLUMNS.has(key) && typeof v === "string") {
      try {
        row[key] = JSON.parse(v);
      } catch { /* not JSON after all — hand back the raw text */ }
    } else if (BOOLEAN_COLUMNS.has(key) && typeof v === "number") {
      row[key] = v === 1;
    }
  }
  return row;
}

export function openSqlite(file: string): SqlDriver {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { create: true, strict: false });
  // WAL keeps readers off the writer's back; busy_timeout covers the brief lock a
  // concurrent request can hit. One process owns this file (see deploy/PLEX.md).
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");

  function run(text: string, params: unknown[]): Promise<any[]> {
    // Statements are cached by Bun, so preparing per call is cheap.
    const stmt = db.query(text);
    const bound = params.map(bind);
    // `.all()` throws on statements that return nothing (DDL), so fall back to run().
    try {
      const rows = stmt.all(...(bound as never[])) as Record<string, unknown>[];
      return Promise.resolve(rows.map(revive));
    } catch (e) {
      if (!(e instanceof Error) || !/does not return data/i.test(e.message)) throw e;
      stmt.run(...(bound as never[]));
      return Promise.resolve([]);
    }
  }

  const driver = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    // Bun.SQL uses $1/$2; bun:sqlite uses ?. The template is ours either way.
    let text = strings[0] ?? "";
    for (let i = 0; i < values.length; i++) text += "?" + (strings[i + 1] ?? "");
    return run(text, values);
  }) as SqlDriver;

  driver.unsafe = (text: string, params: unknown[] = []) => {
    const q = positional(text, params);
    return run(q.text, q.params);
  };
  driver.close = () => db.close();
  return driver;
}

// dbapi builds its filter/sort SQL with Postgres $N placeholders. A single $N may
// appear more than once (the JSON-path accessor is memoised and reused across the
// operators of one filter), and Postgres is happy to reuse a parameter — SQLite's
// `?` consumes the next one instead. So rebuild the list in order of appearance.
export function positional(text: string, params: unknown[]): { text: string; params: unknown[] } {
  const out: unknown[] = [];
  const rewritten = text.replace(/\$(\d+)/g, (_m, n: string) => {
    out.push(params[Number(n) - 1]);
    return "?";
  });
  return { text: rewritten, params: out };
}
