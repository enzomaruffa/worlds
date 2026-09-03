import * as Y from "yjs";
import { sql } from "./db";
import { sitePolicies } from "./policies";

// Declarative validation of a collaborative document's tree, declared per site in
// `.world.json` (`docs`) and enforced on every commit. The server never learns what a
// heading or a decision *means*; it checks that the tree only contains node types,
// attributes, nesting and sizes the site declared. Anything not declared is refused.
//
// The tree shape is the one Lexical's Yjs binding writes (and any editor can mimic):
//   • a root Y.XmlText, one per document (`root`)
//   • element nodes: embedded Y.XmlText, attributes `__type` + `__*` properties
//   • text runs: a Y.Map {__type: "text", __format, …} followed by the string it styles
//   • leaves without children (line breaks, decorators): a Y.Map or Y.XmlElement with `__type`
//
//   "docs": {"plan-*": {"nodes": {
//     "root":      {"children": ["heading", "paragraph"]},
//     "heading":   {"attrs": {"__tag": {"enum": ["h1", "h2"]}}, "children": ["text"], "maxText": 500},
//     "paragraph": {"children": ["text", "linebreak", "link"]},
//     "text":      {},
//     "linebreak": {},
//     "link":      {"attrs": {"__url": {"urlPrefix": ["https://"]}}, "children": ["text"]},
//     "decision":  {"attrs": {"__id": {"ref": "decisions"}}}
//   }, "limits": {"depth": 20, "bytes": 4194304, "perType": {"decision": 100}}}}

export interface AttrRule {
  type?: "string" | "int" | "number" | "bool" | "json" | "any";
  enum?: (string | number | boolean | null)[];
  maxLen?: number;
  min?: number;
  max?: number;
  urlPrefix?: string[];
  ref?: string; // a document id in this site collection
  nullable?: boolean;
}

export interface NodeRule {
  attrs?: Record<string, AttrRule>;
  children?: string[]; // node types allowed directly beneath; absent = no children
  maxText?: number; // characters of text directly inside this node
}

export interface DocSchema {
  root: string;
  typeAttr: string;
  nodes: Record<string, NodeRule>;
  // Attributes every node may carry without listing them (Lexical's base fields).
  commonAttrs: Record<string, AttrRule>;
  limits: { depth: number; bytes: number; nodes: number; textChars: number; perType: Record<string, number> };
}

export interface Violation {
  rule: string;
  message: string;
}

export interface Ref {
  collection: string;
  id: string;
}

// Lexical writes these on every element and text node; sites shouldn't have to repeat them.
export const LEXICAL_COMMON_ATTRS: Record<string, AttrRule> = {
  __format: { type: "int", min: 0, max: 1 << 20 },
  __style: { type: "string", maxLen: 512 },
  __indent: { type: "int", min: 0, max: 50 },
  __dir: { enum: ["ltr", "rtl", null], nullable: true },
  __textFormat: { type: "int", min: 0, max: 1 << 20 },
  __textStyle: { type: "string", maxLen: 512 },
  __mode: { type: "int", min: 0, max: 3 },
  __detail: { type: "int", min: 0, max: 15 },
};

export const SCHEMA_DEFAULTS = {
  root: "root",
  typeAttr: "__type",
  depth: 20,
  bytes: 4 * 1024 * 1024,
  nodes: 50_000,
  textChars: 1_000_000,
};

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

// The schema that applies to a document, from the site's deployed manifest. First
// matching pattern wins; no match means no rules.
export async function docSchemaFor(site: string, name: string): Promise<DocSchema | null> {
  const { docs } = await sitePolicies(site);
  for (const [pattern, schema] of Object.entries(docs)) {
    if (globToRegExp(pattern).test(name)) return schema;
  }
  return null;
}

type Walk = {
  schema: DocSchema;
  refs: Ref[];
  counts: Map<string, number>;
  nodes: number;
  textChars: number;
};

function typeOf(attrs: Record<string, unknown>, schema: DocSchema): string | null {
  const t = attrs[schema.typeAttr];
  return typeof t === "string" ? t : null;
}

function checkAttr(path: string, name: string, value: unknown, rule: AttrRule, w: Walk): Violation | null {
  const at = `${path} attribute "${name}"`;
  if (value === null || value === undefined) {
    if (rule.nullable || (rule.enum && rule.enum.includes(null))) return null;
    return { rule: "attr", message: `${at} must not be null` };
  }
  if (rule.enum) {
    if (!rule.enum.includes(value as never)) return { rule: "attr", message: `${at} must be one of ${rule.enum.map(String).join(", ")}` };
    return null;
  }
  if (rule.ref) {
    if (typeof value !== "string" || !value || value.length > 128) return { rule: "ref", message: `${at} must be a record id` };
    w.refs.push({ collection: rule.ref, id: value });
    return null;
  }
  const type = rule.type ?? (rule.urlPrefix || rule.maxLen !== undefined ? "string" : rule.min !== undefined || rule.max !== undefined ? "number" : "any");
  switch (type) {
    case "string":
      if (typeof value !== "string") return { rule: "attr", message: `${at} must be a string` };
      if (rule.maxLen !== undefined && value.length > rule.maxLen) return { rule: "attr", message: `${at} is longer than ${rule.maxLen} characters` };
      if (rule.urlPrefix && !rule.urlPrefix.some((p) => value.startsWith(p))) {
        return { rule: "url", message: `${at} must start with one of: ${rule.urlPrefix.join(", ")}` };
      }
      return null;
    case "int":
      if (!Number.isInteger(value)) return { rule: "attr", message: `${at} must be an integer` };
    // fallthrough
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return { rule: "attr", message: `${at} must be a number` };
      if (rule.min !== undefined && value < rule.min) return { rule: "attr", message: `${at} is below ${rule.min}` };
      if (rule.max !== undefined && value > rule.max) return { rule: "attr", message: `${at} is above ${rule.max}` };
      return null;
    case "bool":
      return typeof value === "boolean" ? null : { rule: "attr", message: `${at} must be a boolean` };
    case "json": {
      if (typeof value !== "string") return { rule: "attr", message: `${at} must be a JSON string` };
      if (rule.maxLen !== undefined && value.length > rule.maxLen) return { rule: "attr", message: `${at} is longer than ${rule.maxLen} characters` };
      try {
        JSON.parse(value);
      } catch {
        return { rule: "attr", message: `${at} is not valid JSON` };
      }
      return null;
    }
    default:
      if (typeof value === "string" && rule.maxLen !== undefined && value.length > rule.maxLen) {
        return { rule: "attr", message: `${at} is longer than ${rule.maxLen} characters` };
      }
      return null;
  }
}

function checkNode(path: string, type: string, attrs: Record<string, unknown>, w: Walk): Violation | null {
  const rule = w.schema.nodes[type];
  if (!rule) return { rule: "type", message: `${path}: node type "${type}" is not allowed` };
  w.nodes += 1;
  if (w.nodes > w.schema.limits.nodes) return { rule: "limit", message: `document has more than ${w.schema.limits.nodes} nodes` };
  const n = (w.counts.get(type) ?? 0) + 1;
  w.counts.set(type, n);
  const cap = w.schema.limits.perType[type];
  if (cap !== undefined && n > cap) return { rule: "limit", message: `more than ${cap} "${type}" nodes` };
  for (const [name, value] of Object.entries(attrs)) {
    if (name === w.schema.typeAttr) continue;
    const attrRule = rule.attrs?.[name] ?? w.schema.commonAttrs[name];
    if (!attrRule) return { rule: "attr", message: `${path}: attribute "${name}" is not allowed on "${type}"` };
    const v = checkAttr(path, name, value, attrRule, w);
    if (v) return v;
  }
  return null;
}

function childAllowed(parentType: string, childType: string, w: Walk): boolean {
  return (w.schema.nodes[parentType]?.children ?? []).includes(childType);
}

function walkText(t: Y.XmlText, path: string, parentType: string, depth: number, w: Walk): Violation | null {
  if (depth > w.schema.limits.depth) return { rule: "limit", message: `${path}: nesting deeper than ${w.schema.limits.depth}` };
  let ownText = 0;
  // A text run is a {__type:"text"} map followed by string inserts; the string belongs
  // to that run, so a bare string with no run before it is a violation.
  let run: string | null = null;
  let index = 0;
  for (const op of t.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
    const here = `${path}[${index}]`;
    if (typeof op.insert === "string") {
      if (run === null) return { rule: "shape", message: `${here}: text outside of a text run` };
      ownText += op.insert.length;
      w.textChars += op.insert.length;
      if (w.textChars > w.schema.limits.textChars) return { rule: "limit", message: `document has more than ${w.schema.limits.textChars} characters` };
      continue;
    }
    index += 1;
    const child = op.insert;
    if (child instanceof Y.Map) {
      const attrs = Object.fromEntries(child.entries()) as Record<string, unknown>;
      const type = typeOf(attrs, w.schema);
      if (!type) return { rule: "shape", message: `${here}: node without a type` };
      const v = checkNode(`${here}<${type}>`, type, attrs, w);
      if (v) return v;
      if (!childAllowed(parentType, type, w)) return { rule: "nesting", message: `${here}: "${type}" is not allowed inside "${parentType}"` };
      run = type;
      continue;
    }
    run = null;
    if (child instanceof Y.XmlText || child instanceof Y.XmlElement) {
      const attrs = child.getAttributes() as Record<string, unknown>;
      const type = typeOf(attrs, w.schema);
      if (!type) return { rule: "shape", message: `${here}: node without a type` };
      const v = checkNode(`${here}<${type}>`, type, attrs, w);
      if (v) return v;
      if (!childAllowed(parentType, type, w)) return { rule: "nesting", message: `${here}: "${type}" is not allowed inside "${parentType}"` };
      if (child instanceof Y.XmlText) {
        const inner = walkText(child, `${here}<${type}>`, type, depth + 1, w);
        if (inner) return inner;
      } else if (child.length > 0) {
        return { rule: "shape", message: `${here}: "${type}" may not have element children` };
      }
      continue;
    }
    return { rule: "shape", message: `${here}: unsupported embedded value` };
  }
  const maxText = w.schema.nodes[parentType]?.maxText;
  if (maxText !== undefined && ownText > maxText) return { rule: "limit", message: `${path}: more than ${maxText} characters of text` };
  return null;
}

export interface TreeCheck {
  violation: Violation | null;
  refs: Ref[];
}

// Walk the whole tree. Full walks are cheap at document sizes (hundreds of KB); a
// changed-subtree walk can come later if it ever shows up in latency.
export function validateTree(doc: Y.Doc, schema: DocSchema, stateBytes?: number): TreeCheck {
  const w: Walk = { schema, refs: [], counts: new Map(), nodes: 0, textChars: 0 };
  if (stateBytes !== undefined && stateBytes > schema.limits.bytes) {
    return { violation: { rule: "limit", message: `document state exceeds ${schema.limits.bytes} bytes` }, refs: [] };
  }
  for (const key of doc.share.keys()) {
    if (key !== schema.root) return { violation: { rule: "shape", message: `unexpected top-level type "${key}"` }, refs: [] };
  }
  const root = doc.get(schema.root, Y.XmlText);
  if (!schema.nodes[schema.root]) return { violation: { rule: "type", message: `schema declares no "${schema.root}" node` }, refs: [] };
  const v = walkText(root, schema.root, schema.root, 1, w);
  return { violation: v, refs: w.refs };
}

// Every `ref` attribute must point at an existing record in its collection. One query
// per collection, not per node.
export async function checkRefs(site: string, refs: Ref[]): Promise<Violation | null> {
  const byCollection = new Map<string, Set<string>>();
  for (const r of refs) {
    if (!byCollection.has(r.collection)) byCollection.set(r.collection, new Set());
    byCollection.get(r.collection)!.add(r.id);
  }
  for (const [collection, ids] of byCollection) {
    const wanted = [...ids];
    const rows = await sql.unsafe(
      `SELECT id FROM documents WHERE site = $1 AND collection = $2 AND id IN (${wanted.map((_, i) => `$${i + 3}`).join(",")})`,
      [site, collection, ...wanted],
    );
    const found = new Set((rows as { id: string }[]).map((r) => r.id));
    const missing = wanted.find((id) => !found.has(id));
    if (missing) return { rule: "ref", message: `"${missing}" is not a record in "${collection}"` };
  }
  return null;
}
