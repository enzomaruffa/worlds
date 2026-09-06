import { sql, dbReady } from "./db";
import { WorldsError } from "./errors";
import { LEXICAL_COMMON_ATTRS, SCHEMA_DEFAULTS, type AttrRule, type DocSchema, type NodeRule } from "./docschema";

// Per-site document schemas declared in `.world.json` and enforced by the server on every
// `worlds.doc` commit. A document is a Yjs tree the server never interprets, so without a
// schema any client can put anything in it; the site owner declares what may appear, so a
// browser client can't corrupt the document.
//
//   "docs": {"plan-*": {"nodes": {...}, "limits": {...}}}
//
// See docs/quickstart.md "Document schemas" for the rule vocabulary.

export interface SitePolicies {
  docs: Record<string, DocSchema>; // glob on the document name → its tree schema
}

export const NO_POLICIES: SitePolicies = { docs: {} };

function bad(msg: string): never {
  throw new WorldsError("invalid_request", `.world.json: ${msg}`);
}

// A broken schema fails the deploy. Dropping it silently would leave a document the
// owner believes is guarded wide open.
const COLLECTION = /^[a-z0-9_-]{1,64}$/;
const ATTR_RULE_KEYS = new Set(["type", "enum", "maxLen", "min", "max", "urlPrefix", "ref", "nullable", "props", "open"]);
const ATTR_TYPES = new Set(["string", "int", "number", "bool", "json", "object", "any"]);

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
  if (r.props !== undefined) {
    if (typeof r.props !== "object" || r.props === null || Array.isArray(r.props)) bad(`${where}.props must be an object of key → rule`);
    if (rule.type !== "object") bad(`${where}.props needs type "object"`);
    rule.props = {};
    for (const [key, sub] of Object.entries(r.props as Record<string, unknown>)) rule.props[key] = parseAttrRule(`${where}.props.${key}`, sub);
  }
  if (r.open !== undefined) {
    if (typeof r.open !== "boolean") bad(`${where}.open must be a boolean`);
    rule.open = r.open;
  }
  if (rule.type === "object" && !rule.props && !rule.open) bad(`${where} of type "object" needs props or open: true`);
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


// Everything the server enforces from a manifest. Only `docs` is read; the rest of the
// manifest (description, category, spa_fallback) is the deploy's business. A rule the
// manifest gets wrong fails the deploy instead of being dropped.
export function parseManifestPolicies(manifest: unknown): SitePolicies {
  const out: SitePolicies = { docs: {} };
  if (typeof manifest !== "object" || manifest === null) return out;
  const m = manifest as Record<string, unknown>;
  if (m.docs !== undefined) {
    if (typeof m.docs !== "object" || m.docs === null || Array.isArray(m.docs)) bad("docs must be an object keyed by document name pattern");
    for (const [pattern, schema] of Object.entries(m.docs as Record<string, unknown>)) {
      if (!/^[a-z0-9*][a-z0-9._*-]{0,63}$/.test(pattern)) bad(`docs."${pattern}" is not a valid document name pattern`);
      out.docs[pattern] = parseDocSchema(`docs.${pattern}`, schema);
    }
  }
  return out;
}

// Schemas are read on every commit, so cache them briefly. The deploy path invalidates.
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
  const policies: SitePolicies = parsed && typeof parsed === "object" ? { docs: parsed.docs ?? {} } : NO_POLICIES;
  cache.set(site, { at: Date.now(), policies });
  return policies;
}
