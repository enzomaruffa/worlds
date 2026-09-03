import { sql, requireDb, emitChange } from "./db";
import { LIMITS } from "./config";
import { WorldsError, json } from "./errors";
import type { Identity } from "./identity";
import {
  collectionPolicy, maxDocBytes, requireAppendable, requireDocBytes, requireUrlFields, requireWriter,
} from "./policies";
import {
  asText, eqParam, jsonArg, jsonEq, jsonIncrement, jsonMerge, jsonNumber, jsonParam, jsonPath, jsonSize, jsonText,
  jsonValue, monotonicNow, NOW, timestampEq,
} from "./dialect";

const COLLECTION = /^[a-z0-9_-]{1,64}$/;

interface DocRow {
  id: string;
  data: unknown;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function envelope(r: DocRow) {
  return {
    id: r.id,
    data: r.data,
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function checkCollection(c: string): void {
  if (!COLLECTION.test(c)) throw new WorldsError("invalid_request", "bad collection name");
}

function checkDoc(data: unknown): void {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new WorldsError("invalid_request", "document must be a JSON object");
  }
  if (JSON.stringify(data).length > LIMITS.docBytes) {
    throw new WorldsError("payload_too_large", `document exceeds ${LIMITS.docBytes / 1024}KB`);
  }
}

async function checkQuotas(site: string, collection: string): Promise<void> {
  const [c] = await sql`
    SELECT count(DISTINCT collection) AS collections,
           count(*) FILTER (WHERE collection = ${collection}) AS docs
    FROM documents WHERE site = ${site}`;
  if (Number(c.docs) >= LIMITS.docsPerCollection) {
    throw new WorldsError("quota_exceeded", `collection has ${LIMITS.docsPerCollection} docs`);
  }
  if (Number(c.collections) >= LIMITS.collectionsPerSite && Number(c.docs) === 0) {
    throw new WorldsError("quota_exceeded", `site has ${LIMITS.collectionsPerSite} collections`);
  }
}

export async function createDoc(site: string, collection: string, body: unknown, who: Identity) {
  requireDb();
  checkCollection(collection);
  checkDoc(body);
  const policy = await collectionPolicy(site, collection);
  requireWriter(policy, who);
  requireDocBytes(policy, body);
  requireUrlFields(policy, body);
  await checkQuotas(site, collection);
  const id = `doc_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const [row] = await sql.unsafe(
    `INSERT INTO documents (site, collection, id, data, created_by)
     VALUES ($1, $2, $3, ${jsonArg("$4")}, $5)
     RETURNING id, data, created_by, created_at, updated_at`,
    [site, collection, id, jsonParam(body), who.handle],
  );
  const doc = envelope(row as DocRow);
  await emitChange(site, collection, "create", doc);
  return json(doc);
}

export async function getDoc(site: string, collection: string, id: string) {
  requireDb();
  checkCollection(collection);
  const [row] = await sql`
    SELECT id, data, created_by, created_at, updated_at FROM documents
    WHERE site = ${site} AND collection = ${collection} AND id = ${id}`;
  if (!row) throw new WorldsError("not_found", "no such document");
  return json(envelope(row as DocRow));
}

export async function patchDoc(
  site: string,
  collection: string,
  id: string,
  body: unknown,
  mode: "merge" | "replace",
  precondition: string | null,
  who: Identity,
) {
  requireDb();
  checkCollection(collection);
  checkDoc(body);
  const policy = await collectionPolicy(site, collection);
  requireAppendable(policy, "updated");
  requireWriter(policy, who);
  requireUrlFields(policy, body);
  if (mode === "replace") requireDocBytes(policy, body);
  const maxBytes = maxDocBytes(policy);
  if (precondition && Number.isNaN(Date.parse(precondition))) {
    throw new WorldsError("invalid_request", "if-unmodified-since-version must be an ISO timestamp");
  }
  // The precondition is part of the UPDATE, not a SELECT before it: checked separately,
  // two concurrent writers both pass and both write — the exact race the header exists
  // to lose. Both backends store `updated_at` at millisecond precision, which is what
  // survives the JS Date round trip clients echo back.
  // Merge also caps the *result*: a patch that fits can still push the doc past the
  // limit, and unlike a replace the final size isn't knowable before the write.
  const merged = jsonMerge("data", jsonArg("$5"));
  const guard = `AND (${asText("$4")} IS NULL OR ${timestampEq("updated_at", "$4")})`;
  const [row] = mode === "merge"
    ? await sql.unsafe(
        `UPDATE documents SET data = ${merged}, updated_at = ${monotonicNow("updated_at")}
         WHERE site = $1 AND collection = $2 AND id = $3 ${guard}
           AND ${jsonSize(merged)} <= $6
         RETURNING id, data, created_by, created_at, updated_at`,
        [site, collection, id, precondition, jsonParam(body), maxBytes],
      )
    : await sql.unsafe(
        `UPDATE documents SET data = ${jsonArg("$5")}, updated_at = ${monotonicNow("updated_at")}
         WHERE site = $1 AND collection = $2 AND id = $3 ${guard}
         RETURNING id, data, created_by, created_at, updated_at`,
        [site, collection, id, precondition, jsonParam(body)],
      );
  if (!row) await explainFailedPatch(site, collection, id, precondition, maxBytes);
  const doc = envelope(row as DocRow);
  await emitChange(site, collection, "update", doc);
  return json(doc);
}

// A patch matched no row for one of three reasons; re-read to say which. Always throws.
async function explainFailedPatch(site: string, collection: string, id: string, precondition: string | null, maxBytes: number): Promise<never> {
  const [cur] = await sql`
    SELECT id, data, created_by, created_at, updated_at FROM documents
    WHERE site = ${site} AND collection = ${collection} AND id = ${id}`;
  if (!cur) throw new WorldsError("not_found", "no such document");
  if (precondition && new Date(cur.updated_at).toISOString() !== precondition) {
    throw new WorldsError("conflict", "document changed since read", undefined, { doc: envelope(cur as DocRow) });
  }
  throw new WorldsError("payload_too_large", `merged document would exceed ${maxBytes} bytes`);
}

export async function incrementDoc(site: string, collection: string, id: string, body: unknown, who: Identity) {
  requireDb();
  checkCollection(collection);
  const policy = await collectionPolicy(site, collection);
  requireAppendable(policy, "incremented");
  requireWriter(policy, who);
  const { field, by = 1 } = (body ?? {}) as { field?: string; by?: number };
  // Number.isFinite, not typeof: NaN and Infinity are numbers that postgres rejects
  // mid-statement, which would surface as a 500 rather than a bad request.
  if (!field || typeof field !== "string" || !/^[\w.-]{1,128}$/.test(field) || !Number.isFinite(by)) {
    throw new WorldsError("invalid_request", "expected {field, by?} with a finite number");
  }
  // dot paths drill into nested keys, consistent with list/filter (e.g. "score.total")
  const [row] = await sql.unsafe(
    `UPDATE documents
     SET data = ${jsonIncrement("data", "$4", "$5")}, updated_at = ${monotonicNow("updated_at")}
     WHERE site = $1 AND collection = $2 AND id = $3
     RETURNING id, data, created_by, created_at, updated_at`,
    [site, collection, id, jsonPath(field), by],
  );
  if (!row) throw new WorldsError("not_found", "no such document");
  const doc = envelope(row as DocRow);
  await emitChange(site, collection, "update", doc);
  return json(doc);
}

export async function deleteDoc(site: string, collection: string, id: string, who: Identity) {
  requireDb();
  checkCollection(collection);
  const policy = await collectionPolicy(site, collection);
  requireAppendable(policy, "deleted");
  requireWriter(policy, who);
  const rows = await sql`
    DELETE FROM documents
    WHERE site = ${site} AND collection = ${collection} AND id = ${id}
    RETURNING id`;
  const deleted = rows.length > 0;
  if (deleted) await emitChange(site, collection, "delete", { id });
  return json({ deleted, id });
}

// Filter grammar (frozen, deliberately small): {field: value | {gt,gte,lt,lte,ne,in}}, AND only.
const OPS: Record<string, string> = { gt: ">", gte: ">=", lt: "<", lte: "<=", ne: "<>" };

// Reject rather than clamp: `?limit=abc` is a caller bug, and a silent fallback to 50
// hides it. The value is interpolated into LIMIT, so it must be a real integer.
export function clampLimit(raw: string | null): number {
  if (raw === null || raw === "") return 50;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new WorldsError("invalid_request", "limit must be an integer between 1 and 100");
  }
  return n;
}

export async function listDocs(site: string, collection: string, params: URLSearchParams) {
  requireDb();
  checkCollection(collection);
  const limit = clampLimit(params.get("limit"));
  const cursor = params.get("cursor");
  const sort = params.get("sort");

  let filter: Record<string, unknown> = {};
  if (params.get("filter")) {
    try {
      filter = JSON.parse(params.get("filter")!);
    } catch {
      throw new WorldsError("invalid_request", "filter must be JSON");
    }
  }

  const conds: string[] = [];
  const args: unknown[] = [site, collection];
  const arg = (v: unknown) => `$${args.push(v)}`;
  const pathArg = (field: string) => arg(jsonPath(field));

  for (const [field, spec] of Object.entries(filter)) {
    if (!/^[\w.-]{1,128}$/.test(field)) throw new WorldsError("invalid_request", `bad filter field "${field}"`);
    // Lazy so an empty `in` (which compiles to a constant `false`) never allocates
    // a dangling path param the SQL won't reference.
    let pathSql: string | null = null;
    const path = () => (pathSql ??= pathArg(field));
    if (spec !== null && typeof spec === "object" && !Array.isArray(spec)) {
      for (const [op, v] of Object.entries(spec as Record<string, unknown>)) {
        if (op === "in" && Array.isArray(v)) {
          conds.push(
            v.length
              ? `(${v.map((x) => jsonEq("data", path(), arg(eqParam(x)))).join(" OR ")})`
              : "false",
          );
        } else if (op === "ne") {
          conds.push(`NOT ${jsonEq("data", path(), arg(eqParam(v)))}`);
        } else if (OPS[op]) {
          conds.push(
            typeof v === "number"
              ? `${jsonNumber("data", path())} ${OPS[op]} ${arg(v)}`
              : `${jsonText("data", path())} ${OPS[op]} ${arg(String(v))}`,
          );
        } else throw new WorldsError("invalid_request", `unknown filter op "${op}"`);
      }
    } else {
      conds.push(jsonEq("data", path(), arg(eqParam(spec))));
    }
  }

  // Default order is insertion order via the internal sequence `n` (keyset
  // cursors; timestamps are not precise enough after a JS Date round-trip).
  let order = "n ASC";
  if (sort) {
    const desc = sort.startsWith("-");
    const key = desc ? sort.slice(1) : sort;
    if (!/^[\w.-]{1,128}$/.test(key)) throw new WorldsError("invalid_request", "bad sort key");
    // Order on the typed JSON value, not its text: numbers then compare numerically,
    // so a leaderboard on `-score` puts 10 above 9 instead of "9" above "10".
    order = `${jsonValue("data", pathArg(key))} ${desc ? "DESC" : "ASC"}, n ASC`;
  }
  if (cursor) {
    // Sorted lists also page by the insertion-order tiebreak (documented v1 behavior).
    const n = Number(Buffer.from(cursor, "base64").toString());
    if (!Number.isFinite(n)) throw new WorldsError("invalid_request", "bad cursor");
    conds.push(`n > ${arg(n)}`);
  }

  const where = conds.length ? `AND ${conds.join(" AND ")}` : "";
  const rows = (await sql.unsafe(
    `SELECT n, id, data, created_by, created_at, updated_at FROM documents
     WHERE site = $1 AND collection = $2 ${where}
     ORDER BY ${order} LIMIT ${limit + 1}`,
    args as never[],
  )) as (DocRow & { n: string })[];

  const items = rows.slice(0, limit).map(envelope);
  let next: string | null = null;
  if (rows.length > limit) {
    next = Buffer.from(String(rows[limit - 1]!.n)).toString("base64");
  }
  return json({ items, next_cursor: next });
}

export async function listCollections(site: string) {
  requireDb();
  const rows = await sql`
    SELECT collection AS name, count(*) AS docs
    FROM documents WHERE site = ${site}
    GROUP BY collection ORDER BY collection`;
  const items = rows.map((r: { name: string; docs: unknown }) => ({ name: r.name, docs: Number(r.docs) }));
  return json({ items, next_cursor: null });
}
