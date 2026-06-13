import { sql, requireDb, emitChange } from "./db";
import { LIMITS } from "./config";
import { WorldError, json } from "./errors";
import type { Identity } from "./identity";

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
  if (!COLLECTION.test(c)) throw new WorldError("invalid_request", "bad collection name");
}

function checkDoc(data: unknown): void {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new WorldError("invalid_request", "document must be a JSON object");
  }
  if (JSON.stringify(data).length > LIMITS.docBytes) {
    throw new WorldError("payload_too_large", `document exceeds ${LIMITS.docBytes / 1024}KB`);
  }
}

async function checkQuotas(site: string, collection: string): Promise<void> {
  const [c] = await sql`
    SELECT count(DISTINCT collection)::int AS collections,
           count(*) FILTER (WHERE collection = ${collection})::int AS docs
    FROM documents WHERE site = ${site}`;
  if (Number(c.docs) >= LIMITS.docsPerCollection) {
    throw new WorldError("quota_exceeded", `collection has ${LIMITS.docsPerCollection} docs`);
  }
  if (Number(c.collections) >= LIMITS.collectionsPerSite && Number(c.docs) === 0) {
    throw new WorldError("quota_exceeded", `site has ${LIMITS.collectionsPerSite} collections`);
  }
}

export async function createDoc(site: string, collection: string, body: unknown, who: Identity) {
  requireDb();
  checkCollection(collection);
  checkDoc(body);
  await checkQuotas(site, collection);
  const id = `doc_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const [row] = await sql`
    INSERT INTO documents (site, collection, id, data, created_by)
    VALUES (${site}, ${collection}, ${id}, ${body as never}, ${who.handle})
    RETURNING id, data, created_by, created_at, updated_at`;
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
  if (!row) throw new WorldError("not_found", "no such document");
  return json(envelope(row as DocRow));
}

export async function patchDoc(
  site: string,
  collection: string,
  id: string,
  body: unknown,
  mode: "merge" | "replace",
  precondition: string | null,
) {
  requireDb();
  checkCollection(collection);
  checkDoc(body);
  if (precondition) {
    const [cur] = await sql`
      SELECT id, data, created_by, created_at, updated_at FROM documents
      WHERE site = ${site} AND collection = ${collection} AND id = ${id}`;
    if (!cur) throw new WorldError("not_found", "no such document");
    if (new Date(cur.updated_at).toISOString() !== precondition) {
      throw new WorldError("conflict", "document changed since read", undefined, {
        doc: envelope(cur as DocRow),
      });
    }
  }
  const [row] = mode === "merge"
    ? await sql`
        UPDATE documents SET data = data || ${body as never}, updated_at = now()
        WHERE site = ${site} AND collection = ${collection} AND id = ${id}
        RETURNING id, data, created_by, created_at, updated_at`
    : await sql`
        UPDATE documents SET data = ${body as never}, updated_at = now()
        WHERE site = ${site} AND collection = ${collection} AND id = ${id}
        RETURNING id, data, created_by, created_at, updated_at`;
  if (!row) throw new WorldError("not_found", "no such document");
  const doc = envelope(row as DocRow);
  await emitChange(site, collection, "update", doc);
  return json(doc);
}

export async function incrementDoc(site: string, collection: string, id: string, body: unknown) {
  requireDb();
  checkCollection(collection);
  const { field, by = 1 } = (body ?? {}) as { field?: string; by?: number };
  if (!field || typeof field !== "string" || !/^[\w.-]{1,128}$/.test(field) || typeof by !== "number") {
    throw new WorldError("invalid_request", "expected {field, by?}");
  }
  // dot paths drill into nested keys, consistent with list/filter (e.g. "score.total")
  const pgPath = `{${field.split(".").join(",")}}`;
  const [row] = await sql`
    UPDATE documents
    SET data = jsonb_set(data, ${pgPath}::text[],
          (COALESCE((data #>> ${pgPath}::text[])::numeric, 0) + ${by})::text::jsonb, true),
        updated_at = now()
    WHERE site = ${site} AND collection = ${collection} AND id = ${id}
    RETURNING id, data, created_by, created_at, updated_at`;
  if (!row) throw new WorldError("not_found", "no such document");
  const doc = envelope(row as DocRow);
  await emitChange(site, collection, "update", doc);
  return json(doc);
}

export async function deleteDoc(site: string, collection: string, id: string) {
  requireDb();
  checkCollection(collection);
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

export async function listDocs(site: string, collection: string, params: URLSearchParams) {
  requireDb();
  checkCollection(collection);
  const limit = Math.min(Math.max(Number(params.get("limit") ?? 50), 1), 100);
  const cursor = params.get("cursor");
  const sort = params.get("sort");

  let filter: Record<string, unknown> = {};
  if (params.get("filter")) {
    try {
      filter = JSON.parse(params.get("filter")!);
    } catch {
      throw new WorldError("invalid_request", "filter must be JSON");
    }
  }

  const conds: string[] = [];
  const args: unknown[] = [site, collection];
  const arg = (v: unknown) => `$${args.push(v)}`;
  // Bun's sql.unsafe sends JS arrays as JSON, so JSON paths go as PG array literals.
  const pathArg = (field: string) => `${arg(`{${field.split(".").join(",")}}`)}::text[]`;

  for (const [field, spec] of Object.entries(filter)) {
    if (!/^[\w.-]{1,128}$/.test(field)) throw new WorldError("invalid_request", `bad filter field "${field}"`);
    // Lazy so an empty `in` (which compiles to a constant `false`) never allocates
    // a dangling path param the SQL won't reference.
    let accessSql: string | null = null;
    const access = () => (accessSql ??= `data #>> ${pathArg(field)}`);
    if (spec !== null && typeof spec === "object" && !Array.isArray(spec)) {
      for (const [op, v] of Object.entries(spec as Record<string, unknown>)) {
        if (op === "in" && Array.isArray(v)) conds.push(v.length ? `${access()} IN (${v.map((x) => arg(String(x))).join(", ")})` : "false");
        else if (OPS[op]) {
          conds.push(
            typeof v === "number"
              ? `(${access()})::numeric ${OPS[op]} ${arg(v)}`
              : `${access()} ${OPS[op]} ${arg(String(v))}`,
          );
        } else throw new WorldError("invalid_request", `unknown filter op "${op}"`);
      }
    } else {
      conds.push(`${access()} = ${arg(String(spec))}`);
    }
  }

  // Default order is insertion order via the internal sequence `n` (keyset
  // cursors; timestamps are not precise enough after a JS Date round-trip).
  let order = "n ASC";
  if (sort) {
    const desc = sort.startsWith("-");
    const key = desc ? sort.slice(1) : sort;
    if (!/^[\w.-]{1,128}$/.test(key)) throw new WorldError("invalid_request", "bad sort key");
    order = `data #>> ${pathArg(key)} ${desc ? "DESC" : "ASC"}, n ASC`;
  }
  if (cursor) {
    // Sorted lists also page by the insertion-order tiebreak (documented v1 behavior).
    const n = Number(Buffer.from(cursor, "base64").toString());
    if (!Number.isFinite(n)) throw new WorldError("invalid_request", "bad cursor");
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
    SELECT collection AS name, count(*)::int AS docs
    FROM documents WHERE site = ${site}
    GROUP BY collection ORDER BY collection`;
  return json({ items: rows, next_cursor: null });
}
