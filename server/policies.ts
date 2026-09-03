import { join } from "node:path";
import { LIMITS, config } from "./config";
import { sql, dbReady } from "./db";
import { WorldsError } from "./errors";
import type { Identity } from "./identity";
import { LEXICAL_COMMON_ATTRS, SCHEMA_DEFAULTS, type AttrRule, type DocSchema, type NodeRule } from "./docschema";

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

export interface BackendPolicy {
  url: string;
  prefix: string;
}

export interface SitePolicies {
  collections: Record<string, CollectionPolicy>;
  uploads: { maxTotalBytes?: number };
  docs: Record<string, DocSchema>; // glob on the document name → its tree schema
  backend: BackendPolicy | null;
}

export const NO_POLICIES: SitePolicies = { collections: {}, uploads: {}, docs: {}, backend: null };

const COLLECTION = /^[a-z0-9_-]{1,64}$/;
const WRITER = /^(\*|(user|service):[a-z0-9][a-z0-9._-]{0,63})$/;
const FIELD_PATH = /^[\w-]+(\[\])?(\.[\w-]+(\[\])?)*$/;
const DEFAULT_BACKEND_PREFIX = "/_api/";

function bad(msg: string): never {
  throw new WorldsError("invalid_request", `.world.json: ${msg}`);
}

// A broken policy fails the deploy. Dropping it silently would leave a collection the
// owner believes is protected wide open.
const ATTR_RULE_KEYS = new Set(["type", "enum", "maxLen", "min", "max", "urlPrefix", "ref", "nullable"]);
const ATTR_TYPES = new Set(["string", "int", "number", "bool", "json", "any"]);

function parseAttrRule(where: string, raw: unknown): AttrRule {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) bad(`${where} must be an object`);
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!ATTR_RULE_KEYS.has(k)) bad(`${where}.${k} is not a known attribute rule`);
  const rule: AttrRule = {};
  if (r.type !== undefined) {
    if (typeof r.type !== "string" || !ATTR_TYPES.has(r.type)) bad(`${where}.type must be one of ${[...ATTR_TYPES].join(", ")}`);
    rule.type = r.type as AttrRule["type"];
  }
  if (r.enum !== undefined) {
    if (!Array.isArray(r.enum) || !r.enum.length || !r.enum.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v))) {
      bad(`${where}.enum must be a non-empty array of scalars`);
    }
    rule.enum = r.enum as AttrRule["enum"];
  }
  for (const k of ["maxLen", "min", "max"] as const) {
    if (r[k] !== undefined) {
      if (typeof r[k] !== "number" || !Number.isFinite(r[k])) bad(`${where}.${k} must be a number`);
      rule[k] = r[k] as number;
    }
  }
  if (r.urlPrefix !== undefined) {
    if (!Array.isArray(r.urlPrefix) || !r.urlPrefix.length || !r.urlPrefix.every((p) => typeof p === "string" && p)) bad(`${where}.urlPrefix must be a non-empty array of prefixes`);
    rule.urlPrefix = r.urlPrefix as string[];
  }
  if (r.ref !== undefined) {
    if (typeof r.ref !== "string" || !COLLECTION.test(r.ref)) bad(`${where}.ref must be a collection name`);
    rule.ref = r.ref;
  }
  if (r.nullable !== undefined) {
    if (typeof r.nullable !== "boolean") bad(`${where}.nullable must be a boolean`);
    rule.nullable = r.nullable;
  }
  return rule;
}

const NODE_TYPE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function parseDocSchema(where: string, raw: unknown): DocSchema {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) bad(`${where} must be an object`);
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!["root", "typeAttr", "nodes", "commonAttrs", "limits"].includes(k)) bad(`${where}.${k} is not a known schema key`);
  const root = r.root === undefined ? SCHEMA_DEFAULTS.root : r.root;
  const typeAttr = r.typeAttr === undefined ? SCHEMA_DEFAULTS.typeAttr : r.typeAttr;
  if (typeof root !== "string" || !NODE_TYPE.test(root)) bad(`${where}.root must be a name`);
  if (typeof typeAttr !== "string" || !typeAttr) bad(`${where}.typeAttr must be a name`);
  if (typeof r.nodes !== "object" || r.nodes === null || Array.isArray(r.nodes)) bad(`${where}.nodes must be an object keyed by node type`);
  const nodes: Record<string, NodeRule> = {};
  for (const [type, spec] of Object.entries(r.nodes as Record<string, unknown>)) {
    if (!NODE_TYPE.test(type)) bad(`${where}.nodes."${type}" is not a valid node type`);
    if (typeof spec !== "object" || spec === null || Array.isArray(spec)) bad(`${where}.nodes.${type} must be an object`);
    const s = spec as Record<string, unknown>;
    for (const k of Object.keys(s)) if (!["attrs", "children", "maxText"].includes(k)) bad(`${where}.nodes.${type}.${k} is not a known node rule`);
    const rule: NodeRule = {};
    if (s.attrs !== undefined) {
      if (typeof s.attrs !== "object" || s.attrs === null || Array.isArray(s.attrs)) bad(`${where}.nodes.${type}.attrs must be an object`);
      rule.attrs = {};
      for (const [name, ar] of Object.entries(s.attrs as Record<string, unknown>)) rule.attrs[name] = parseAttrRule(`${where}.nodes.${type}.attrs.${name}`, ar);
    }
    if (s.children !== undefined) {
      if (!Array.isArray(s.children) || !s.children.every((c) => typeof c === "string" && NODE_TYPE.test(c))) bad(`${where}.nodes.${type}.children must be an array of node types`);
      rule.children = s.children as string[];
    }
    if (s.maxText !== undefined) {
      if (!Number.isInteger(s.maxText) || (s.maxText as number) < 0) bad(`${where}.nodes.${type}.maxText must be a non-negative integer`);
      rule.maxText = s.maxText as number;
    }
    nodes[type] = rule;
  }
  if (!nodes[root]) bad(`${where}.nodes must declare the root node "${root}"`);
  for (const [type, rule] of Object.entries(nodes)) {
    for (const c of rule.children ?? []) if (!nodes[c]) bad(`${where}.nodes.${type}.children names undeclared type "${c}"`);
  }
  const commonAttrs: Record<string, AttrRule> = { ...LEXICAL_COMMON_ATTRS };
  if (r.commonAttrs !== undefined) {
    if (typeof r.commonAttrs !== "object" || r.commonAttrs === null || Array.isArray(r.commonAttrs)) bad(`${where}.commonAttrs must be an object`);
    for (const [name, ar] of Object.entries(r.commonAttrs as Record<string, unknown>)) commonAttrs[name] = parseAttrRule(`${where}.commonAttrs.${name}`, ar);
  }
  const limits: DocSchema["limits"] = { depth: SCHEMA_DEFAULTS.depth, bytes: SCHEMA_DEFAULTS.bytes, nodes: SCHEMA_DEFAULTS.nodes, textChars: SCHEMA_DEFAULTS.textChars, perType: {} };
  if (r.limits !== undefined) {
    if (typeof r.limits !== "object" || r.limits === null || Array.isArray(r.limits)) bad(`${where}.limits must be an object`);
    const l = r.limits as Record<string, unknown>;
    for (const k of Object.keys(l)) if (!["depth", "bytes", "nodes", "textChars", "perType"].includes(k)) bad(`${where}.limits.${k} is not a known limit`);
    for (const k of ["depth", "bytes", "nodes", "textChars"] as const) {
      if (l[k] !== undefined) {
        if (!Number.isInteger(l[k]) || (l[k] as number) < 1) bad(`${where}.limits.${k} must be a positive integer`);
        limits[k] = l[k] as number;
      }
    }
    if (l.perType !== undefined) {
      if (typeof l.perType !== "object" || l.perType === null || Array.isArray(l.perType)) bad(`${where}.limits.perType must be an object`);
      for (const [type, n] of Object.entries(l.perType as Record<string, unknown>)) {
        if (!nodes[type]) bad(`${where}.limits.perType names undeclared type "${type}"`);
        if (!Number.isInteger(n) || (n as number) < 0) bad(`${where}.limits.perType.${type} must be a non-negative integer`);
        limits.perType[type] = n as number;
      }
    }
  }
  return { root, typeAttr, nodes, commonAttrs, limits };
}

export function parseManifestPolicies(manifest: unknown): SitePolicies {
  const out: SitePolicies = { collections: {}, uploads: {}, docs: {}, backend: null };
  if (typeof manifest !== "object" || manifest === null) return out;
  const m = manifest as Record<string, unknown>;

  if (m.docs !== undefined) {
    if (typeof m.docs !== "object" || m.docs === null || Array.isArray(m.docs)) bad("docs must be an object keyed by document name pattern");
    for (const [pattern, schema] of Object.entries(m.docs as Record<string, unknown>)) {
      if (!/^[a-z0-9*][a-z0-9._*-]{0,63}$/.test(pattern)) bad(`docs."${pattern}" is not a valid document name pattern`);
      out.docs[pattern] = parseDocSchema(`docs.${pattern}`, schema);
    }
  }

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

  if (m.backend !== undefined && m.backend !== null) {
    if (typeof m.backend !== "object" || Array.isArray(m.backend)) bad("backend must be an object");
    const b = m.backend as Record<string, unknown>;
    for (const key of Object.keys(b)) if (!["url", "prefix"].includes(key)) bad(`backend.${key} is not a known setting`);
    if (typeof b.url !== "string") bad("backend.url must be a string");
    let parsed: URL;
    try {
      parsed = new URL(b.url);
    } catch {
      bad("backend.url must be an absolute URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") bad("backend.url must be http or https");
    if (parsed.search || parsed.hash) bad("backend.url must not include a query or hash");
    const prefix = b.prefix === undefined ? DEFAULT_BACKEND_PREFIX : b.prefix;
    if (typeof prefix !== "string" || !prefix.startsWith("/") || !prefix.endsWith("/")) bad(`backend.prefix must start and end with "/"`);
    if (prefix.length > 64) bad("backend.prefix must be at most 64 characters");
    out.backend = { url: b.url, prefix };
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

// Dev mounts (WORLDS_DEV_SITES) have no deploy step, so their manifest can change on disk
// between requests — cache briefly (not 5s like a real deploy) so an edit shows up fast.
const DEV_MANIFEST_CACHE_MS = 1_000;
const devManifestCache = new Map<string, { at: number; raw: Record<string, unknown> | null; policies: SitePolicies }>();

async function loadDevManifest(site: string, dir: string): Promise<{ raw: Record<string, unknown> | null; policies: SitePolicies }> {
  const hit = devManifestCache.get(site);
  if (hit && Date.now() - hit.at < DEV_MANIFEST_CACHE_MS) return hit;
  let raw: Record<string, unknown> | null = null;
  let policies: SitePolicies = NO_POLICIES;
  const f = Bun.file(join(dir, ".world.json"));
  if (await f.exists()) {
    try {
      raw = (await f.json()) as Record<string, unknown>;
      policies = parseManifestPolicies(raw);
    } catch (e) {
      console.warn(`worlds: dev site "${site}" has a malformed .world.json — treating as no policies (${(e as Error).message})`);
      raw = null;
      policies = NO_POLICIES;
    }
  }
  const entry = { at: Date.now(), raw, policies };
  devManifestCache.set(site, entry);
  return entry;
}

// null means "not a dev mount" — the caller falls back to the deployed site's spa_fallback.
export async function devSpaFallback(site: string): Promise<boolean | null> {
  const dir = config.devSites[site];
  if (!dir) return null;
  const { raw } = await loadDevManifest(site, dir);
  return typeof raw?.spa_fallback === "boolean" ? raw.spa_fallback : false;
}

export async function sitePolicies(site: string): Promise<SitePolicies> {
  const dir = config.devSites[site];
  if (dir) return (await loadDevManifest(site, dir)).policies;
  if (!dbReady()) return NO_POLICIES;
  const hit = cache.get(site);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.policies;
  const [row] = await sql`SELECT policies FROM sites WHERE name = ${site}`;
  const raw = row?.policies;
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  const policies: SitePolicies = parsed && typeof parsed === "object"
    ? { collections: parsed.collections ?? {}, uploads: parsed.uploads ?? {}, docs: parsed.docs ?? {}, backend: parsed.backend ?? null }
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
