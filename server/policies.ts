import { LIMITS, config } from "./config";
import { sql, dbReady } from "./db";
import { WorldsError } from "./errors";
import type { Identity } from "./identity";

// Per-site rules declared in `.world.json` and applied by the server on every write.
// Without them every collection is open to every signed-in caller, which is right for
// a game leaderboard and wrong for a decision log. The site owner declares them, so a
// browser client can't flip them off.
//
//   "collections": {
//     "decisions": {"appendOnly": true, "writers": ["service:app"]},
//     "chat":      {"maxBytes": 16384, "urlFields": {"attachments[].url": ["/u/<site>/"]}}
//   },
//   "uploads": {"maxTotalBytes": 5368709120}

export interface CollectionPolicy {
  appendOnly?: boolean; // documents can be created, never updated, incremented or deleted
  writers?: string[]; // "<kind>:<handle>" entries (user:enzo, service:app) or "*"; absent = anyone
  maxBytes?: number; // tighter than the platform document limit, never looser
  urlFields?: Record<string, string[]>; // dotted path ("a.b", "items[].url") → allowed prefixes
}

export interface SitePolicies {
  collections: Record<string, CollectionPolicy>;
  uploads: { maxTotalBytes?: number };
}

export const NO_POLICIES: SitePolicies = { collections: {}, uploads: {} };

const COLLECTION = /^[a-z0-9_-]{1,64}$/;
const WRITER = /^(\*|(user|service):[a-z0-9][a-z0-9._-]{0,63})$/;
const FIELD_PATH = /^[\w-]+(\[\])?(\.[\w-]+(\[\])?)*$/;

function bad(msg: string): never {
  throw new WorldsError("invalid_request", `.world.json: ${msg}`);
}

// A broken policy fails the deploy. Dropping it silently would leave a collection the
// owner believes is protected wide open.
export function parseManifestPolicies(manifest: unknown): SitePolicies {
  const out: SitePolicies = { collections: {}, uploads: {} };
  if (typeof manifest !== "object" || manifest === null) return out;
  const m = manifest as Record<string, unknown>;

  if (m.collections !== undefined) {
    if (typeof m.collections !== "object" || m.collections === null || Array.isArray(m.collections)) {
      bad("collections must be an object keyed by collection name");
    }
    for (const [name, raw] of Object.entries(m.collections as Record<string, unknown>)) {
      if (!COLLECTION.test(name)) bad(`collections."${name}" is not a valid collection name`);
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) bad(`collections.${name} must be an object`);
      const r = raw as Record<string, unknown>;
      const p: CollectionPolicy = {};
      for (const key of Object.keys(r)) {
        if (!["appendOnly", "writers", "maxBytes", "urlFields"].includes(key)) bad(`collections.${name}.${key} is not a known policy`);
      }
      if (r.appendOnly !== undefined) {
        if (typeof r.appendOnly !== "boolean") bad(`collections.${name}.appendOnly must be a boolean`);
        p.appendOnly = r.appendOnly;
      }
      if (r.writers !== undefined) {
        if (!Array.isArray(r.writers) || !r.writers.every((w) => typeof w === "string" && WRITER.test(w))) {
          bad(`collections.${name}.writers must be an array of "user:<handle>" / "service:<handle>" / "*"`);
        }
        p.writers = r.writers as string[];
      }
      if (r.maxBytes !== undefined) {
        if (!Number.isInteger(r.maxBytes) || (r.maxBytes as number) < 1 || (r.maxBytes as number) > LIMITS.docBytes) {
          bad(`collections.${name}.maxBytes must be an integer between 1 and ${LIMITS.docBytes}`);
        }
        p.maxBytes = r.maxBytes as number;
      }
      if (r.urlFields !== undefined) {
        if (typeof r.urlFields !== "object" || r.urlFields === null || Array.isArray(r.urlFields)) {
          bad(`collections.${name}.urlFields must be an object of field path → prefixes`);
        }
        const fields: Record<string, string[]> = {};
        for (const [path, prefixes] of Object.entries(r.urlFields as Record<string, unknown>)) {
          if (!FIELD_PATH.test(path)) bad(`collections.${name}.urlFields."${path}" is not a valid field path`);
          if (!Array.isArray(prefixes) || !prefixes.length || !prefixes.every((x) => typeof x === "string" && x.length > 0)) {
            bad(`collections.${name}.urlFields."${path}" must be a non-empty array of prefixes`);
          }
          fields[path] = prefixes as string[];
        }
        p.urlFields = fields;
      }
      out.collections[name] = p;
    }
  }

  if (m.uploads !== undefined) {
    if (typeof m.uploads !== "object" || m.uploads === null || Array.isArray(m.uploads)) bad("uploads must be an object");
    const u = m.uploads as Record<string, unknown>;
    for (const key of Object.keys(u)) if (key !== "maxTotalBytes") bad(`uploads.${key} is not a known setting`);
    if (u.maxTotalBytes !== undefined) {
      if (!Number.isInteger(u.maxTotalBytes) || (u.maxTotalBytes as number) < 1) bad("uploads.maxTotalBytes must be a positive integer");
      out.uploads.maxTotalBytes = u.maxTotalBytes as number;
    }
  }
  return out;
}

// Policies are read on every write, so cache them briefly. The deploy path invalidates
// its own process; other pods pick the change up when their entry ages out.
const CACHE_MS = 5_000;
const cache = new Map<string, { at: number; policies: SitePolicies }>();

export function invalidatePolicies(site: string): void {
  cache.delete(site);
}

export async function sitePolicies(site: string): Promise<SitePolicies> {
  if (!dbReady()) return NO_POLICIES;
  const hit = cache.get(site);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.policies;
  const [row] = await sql`SELECT policies FROM sites WHERE name = ${site}`;
  const raw = row?.policies;
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  const policies: SitePolicies = parsed && typeof parsed === "object"
    ? { collections: parsed.collections ?? {}, uploads: parsed.uploads ?? {} }
    : NO_POLICIES;
  cache.set(site, { at: Date.now(), policies });
  return policies;
}

export async function collectionPolicy(site: string, collection: string): Promise<CollectionPolicy> {
  return (await sitePolicies(site)).collections[collection] ?? {};
}

export function requireWriter(policy: CollectionPolicy, who: Identity): void {
  if (!policy.writers) return;
  const me = `${who.kind}:${who.handle}`;
  if (policy.writers.includes("*") || policy.writers.includes(me)) return;
  throw new WorldsError("forbidden", `only ${policy.writers.join(", ")} may write to this collection`);
}

export function requireAppendable(policy: CollectionPolicy, verb: string): void {
  if (policy.appendOnly) throw new WorldsError("forbidden", `collection is append-only: documents cannot be ${verb}`);
}

export function maxDocBytes(policy: CollectionPolicy): number {
  return Math.min(LIMITS.docBytes, policy.maxBytes ?? LIMITS.docBytes);
}

export function requireDocBytes(policy: CollectionPolicy, data: unknown): void {
  const max = maxDocBytes(policy);
  if (JSON.stringify(data).length > max) {
    throw new WorldsError("payload_too_large", `document exceeds this collection's ${max} byte limit`);
  }
}

// Every value reachable through a dotted path; "[]" descends into each array element.
function valuesAt(value: unknown, path: string[]): unknown[] {
  if (path.length === 0) return [value];
  if (typeof value !== "object" || value === null) return [];
  const seg = path[0]!;
  const rest = path.slice(1);
  const key = seg.endsWith("[]") ? seg.slice(0, -2) : seg;
  const next = (value as Record<string, unknown>)[key];
  if (next === undefined) return [];
  if (!seg.endsWith("[]")) return valuesAt(next, rest);
  // A non-array where the policy expects one is itself a violation: hand the value
  // back so the string check below rejects it.
  if (!Array.isArray(next)) return [next];
  return next.flatMap((item) => valuesAt(item, rest));
}

export function requireUrlFields(policy: CollectionPolicy, data: unknown): void {
  if (!policy.urlFields) return;
  for (const [path, prefixes] of Object.entries(policy.urlFields)) {
    for (const v of valuesAt(data, path.split("."))) {
      if (typeof v !== "string" || !prefixes.some((p) => v.startsWith(p))) {
        throw new WorldsError("invalid_request", `"${path}" must be a URL starting with one of: ${prefixes.join(", ")}`);
      }
    }
  }
}

// The site's override can lower the platform default, and raise it only up to the
// operator ceiling. Without a ceiling set, the default is the ceiling.
export async function uploadQuotaBytes(site: string): Promise<number> {
  const ceiling = config.uploadQuotaMax ?? LIMITS.uploadsPerSiteBytes;
  const { uploads } = await sitePolicies(site);
  return Math.min(uploads.maxTotalBytes ?? LIMITS.uploadsPerSiteBytes, ceiling);
}
