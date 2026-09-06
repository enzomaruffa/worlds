import { config } from "./config";

// The two backends agree on almost everything — both do `ON CONFLICT … DO UPDATE`,
// `RETURNING`, and `count(*) FILTER (WHERE …)`. What differs is how they spell JSON
// access, "now", and interval arithmetic. Those fragments live here so the queries
// themselves stay readable and there is exactly one place to look when a third
// backend or a new operator shows up.

export const isSqlite = config.db === "sqlite";

// How a JSON value is bound. Bun.SQL JSON-encodes whatever it is handed, so Postgres
// must receive the live object — passing a string and casting it with ::jsonb stores a
// JSON *string* scalar instead of the object. SQLite's JSON columns are plain TEXT.
export const jsonParam = (v: unknown): unknown => (isSqlite ? JSON.stringify(v ?? null) : v);
export const jsonArg = (param: string): string => param;

// A dotted field ("score.total") as a JSON path. Postgres wants a text[] literal,
// SQLite wants a '$.a.b' path string.
export function jsonPath(field: string): string {
  return isSqlite ? `$.${field}` : `{${field.split(".").join(",")}}`;
}

// Value at `path` as TEXT, for ordering and range comparisons against strings.
export function jsonText(col: string, pathParam: string): string {
  // SQLite's json_extract returns the value's own type, so it needs the cast to line
  // up with Postgres's `#>>`, which always yields text.
  return isSqlite ? `CAST(json_extract(${col}, ${pathParam}) AS TEXT)` : `${col} #>> ${pathParam}::text[]`;
}

// Equality against a filter value. Postgres compares the text form; SQLite compares
// JSON value to JSON value, so `{n: 1}` and `{ok: true}` match the stored number and
// boolean instead of failing against the strings "1" and "true".
export function jsonEq(col: string, pathParam: string, valueParam: string): string {
  return isSqlite
    ? `json_extract(${col}, ${pathParam}) = json_extract(${valueParam}, '$')`
    : `${col} #>> ${pathParam}::text[] = ${valueParam}`;
}

// The binding that goes with jsonEq.
export const eqParam = (v: unknown): string => (isSqlite ? JSON.stringify(v ?? null) : String(v));

// Value at `path` with its own type kept, so numbers order numerically rather than
// lexicographically ("10" before "9").
export function jsonValue(col: string, pathParam: string): string {
  return isSqlite ? `json_extract(${col}, ${pathParam})` : `${col} #> ${pathParam}::text[]`;
}

// Numeric comparison of a JSON value.
export function jsonNumber(col: string, pathParam: string): string {
  return isSqlite ? `CAST(json_extract(${col}, ${pathParam}) AS REAL)` : `(${col} #>> ${pathParam}::text[])::numeric`;
}

// Shallow merge of a patch object onto a JSON column.
export function jsonMerge(col: string, patchParam: string): string {
  // json_patch is RFC-7386 merge — like `||` it is shallow-by-key, but unlike `||` a
  // null value deletes the key. Callers reject nulls before this point.
  return isSqlite ? `json_patch(${col}, ${patchParam})` : `${col} || ${patchParam}`;
}

// Byte size of a JSON column (for the document size cap).
export function jsonSize(expr: string): string {
  return isSqlite ? `length(${expr})` : `octet_length((${expr})::text)`;
}

// Add `byParam` to the number at `pathParam`, treating a missing key as 0.
export function jsonIncrement(col: string, pathParam: string, byParam: string): string {
  return isSqlite
    ? `json_set(${col}, ${pathParam}, COALESCE(CAST(json_extract(${col}, ${pathParam}) AS REAL), 0) + ${byParam})`
    : `jsonb_set(${col}, ${pathParam}::text[], (COALESCE((${col} #>> ${pathParam}::text[])::numeric, 0) + ${byParam})::text::jsonb, true)`;
}

// Does a JSON array column contain this scalar?
export function jsonArrayHas(col: string, param: string): string {
  return isSqlite
    ? `EXISTS (SELECT 1 FROM json_each(${col}) WHERE value = ${param})`
    : `${col} ? ${param}`;
}

// "Now", as an ISO-8601 string with milliseconds in both backends. Millisecond
// precision is deliberate: clients echo `updated_at` back through a JS Date for
// optimistic concurrency, and microseconds would never survive the round trip.
export const NOW = isSqlite ? `strftime('%Y-%m-%dT%H:%M:%fZ','now')` : `date_trunc('milliseconds', now())`;

// `updated_at` doubles as the optimistic-concurrency version, so it has to move on
// every write. Two updates inside the same millisecond would otherwise share a
// version and a stale precondition would be accepted — easy to hit on SQLite, which
// is fast enough to serve both requests within one tick, and a latent race on
// Postgres. Step to at least one millisecond past the row's current value.
export function monotonicNow(col: string): string {
  return isSqlite
    ? `MAX(${NOW}, strftime('%Y-%m-%dT%H:%M:%fZ', ${col}, '+0.001 seconds'))`
    : `GREATEST(${NOW}, ${col} + interval '1 millisecond')`;
}

// A timestamp N hours in the past, for the event retention window.
export function hoursAgo(n: number): string {
  return isSqlite ? `datetime('now', '-${n} hours')` : `now() - make_interval(hours => ${n})`;
}

// Append one element to a JSON array column. The backends want the new element in
// different shapes — SQLite inserts the bare scalar, Postgres concatenates a
// one-element array — so both spellings are passed in.
export function jsonArrayAppend(col: string, scalarParam: string, arrayParam: string): string {
  return isSqlite ? `json_insert(${col}, '$[#]', ${scalarParam})` : `${col} || ${jsonArg(arrayParam)}`;
}

// Case-insensitive LIKE. SQLite's LIKE already ignores case for ASCII.
export const ILIKE = isSqlite ? "LIKE" : "ILIKE";

// Postgres cannot infer the type of a bare placeholder in `$1 IS NULL`, so it needs
// the annotation; SQLite has no such notion.
export const asText = (param: string): string => (isSqlite ? param : `${param}::text`);

// Compare a stored timestamp against a caller-supplied ISO string.
export function timestampEq(col: string, param: string): string {
  return isSqlite ? `${col} = ${param}` : `date_trunc('milliseconds', ${col}) = ${param}::timestamptz`;
}

// Keyset page on a newest-first timestamp column. The id tiebreak is what makes it a
// keyset and not a guess: rows sharing a millisecond would otherwise be skipped or
// repeated across pages.
export function timestampKeysetBefore(col: string, idCol: string, tsParam: string, idParam: string): string {
  const ts = isSqlite ? tsParam : `${tsParam}::timestamptz`;
  const c = isSqlite ? col : `date_trunc('milliseconds', ${col})`;
  return `(${c} < ${ts} OR (${c} = ${ts} AND ${idCol} < ${idParam}))`;
}
