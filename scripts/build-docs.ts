// Generates docs/reference.md from the SDK source (sdk/src/*.ts) and the server's
// contract files, so the reference fed to LLMs (/llms-full.txt, MCP read_docs) is
// derived from the shipped code rather than maintained by hand. Exported
// declarations are printed verbatim (their inline comments are the field docs); the
// `//` block above each export becomes its prose. Run: `bun run build:docs`.
import * as ts from "typescript";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SDK = join(ROOT, "sdk/src");
const OUT = join(ROOT, "docs/reference.md");

// One section per SDK module, in the order they hang off the `worlds` global.
// `only` restricts a module to the exports that are part of the public surface.
const MODULES: { file: string; title: string; only?: string[] }[] = [
  { file: "db.ts", title: "worlds.db — database" },
  { file: "ai.ts", title: "worlds.ai — AI" },
  { file: "uploads.ts", title: "worlds.uploads — file storage" },
  { file: "channels.ts", title: "worlds.ws — realtime channels" },
  { file: "room.ts", title: "worlds.room — one shared room" },
  { file: "rooms.ts", title: "worlds.rooms — many rooms (lobby browser)" },
  { file: "actors.ts", title: "worlds.actors — zoned per-member presence" },
  { file: "doc.ts", title: "worlds.doc / worlds.docs — server-held collaborative documents" },
  { file: "idle.ts", title: "worlds.idle — offline progress" },
  { file: "notify.ts", title: "worlds.notify — Slack" },
  { file: "util.ts", title: "utilities — id, colorFor, uniqByHandle, esc, countdown" },
  { file: "toast.ts", title: "worlds.toast" },
  { file: "error.ts", title: "WorldsError" },
  { file: "socket.ts", title: "shared types", only: ["Person"] },
];

const program = ts.createProgram(
  [join(SDK, "index.ts"), join(ROOT, "server/errors.ts"), join(ROOT, "server/config.ts"), join(ROOT, "server/ai.ts"), join(ROOT, "server/mcp.ts")],
  { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true, types: [] },
);
const checker = program.getTypeChecker();

function source(path: string): ts.SourceFile {
  const sf = program.getSourceFile(path);
  if (!sf) throw new Error(`not in program: ${path}`);
  return sf;
}

function isExported(node: ts.Node): boolean {
  return !!ts.getCombinedModifierFlags(node as ts.Declaration) && (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

// ---- comments → markdown -----------------------------------------------------

function stripComment(raw: string): string[] {
  if (raw.startsWith("/*")) {
    return raw
      .replace(/^\/\*\*?/, "")
      .replace(/\*\/$/, "")
      .split("\n")
      .map((l) => l.replace(/^\s*\* ?/, ""));
  }
  return raw.split("\n").map((l) => l.replace(/^\s*\/\/ ?/, ""));
}

// Comment prose keeps its line structure: `•` bullets become list items (their
// indented continuation lines fold into the item) and any other run of indented
// lines (the inline examples in the module headers) becomes a js fence.
function proseFrom(lines: string[]): string {
  const out: string[] = [];
  let code: string[] | null = null;
  let bullet: { indent: number; text: string; first: boolean } | null = null;
  const flushCode = () => {
    if (code) {
      const indent = Math.min(...code.map((l) => l.match(/^\s*/)![0].length));
      out.push("```js", ...code.map((l) => l.slice(indent)), "```");
      code = null;
    }
  };
  // A list is fenced by blank lines: Markdown otherwise reads the line before it as
  // the list's opener and the line after it as a lazy continuation of the last item.
  const flushBullet = (endOfList: boolean) => {
    if (bullet) {
      if (bullet.first && out.length && out.at(-1) !== "") out.push("");
      out.push(`- ${bullet.text}`);
      if (endOfList) out.push("");
    }
    bullet = null;
  };
  for (const raw of lines) {
    const l = raw.trimEnd();
    const indent = l.match(/^\s*/)![0].length;
    const m = l.match(/^\s*•\s+(.*)$/);
    if (m) {
      flushCode();
      const first: boolean = bullet === null;
      flushBullet(false);
      bullet = { indent, text: m[1]!, first };
      continue;
    }
    if (bullet && indent > bullet.indent && l.trim()) {
      bullet.text += ` ${l.trim()}`;
      continue;
    }
    flushBullet(true);
    if (indent >= 2 && l.trim()) {
      (code ??= []).push(l);
      continue;
    }
    flushCode();
    out.push(l);
  }
  flushCode();
  flushBullet(true);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

interface Ranged { text: string; pos: number; end: number }

function commentRanges(sf: ts.SourceFile, node: ts.Node): Ranged[] {
  const text = sf.getFullText();
  return (ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []).map((r) => ({ text: text.slice(r.pos, r.end), pos: r.pos, end: r.end }));
}

function blankBetween(sf: ts.SourceFile, a: number, b: number): boolean {
  return /\n[ \t]*\n/.test(sf.getFullText().slice(a, b));
}

// The comment block directly above a node (no blank line in between).
function attached(sf: ts.SourceFile, node: ts.Node): string {
  const ranges = commentRanges(sf, node);
  const kept: string[] = [];
  // Walk back from the node: ranges stay attached while no blank line separates them.
  let cursor = node.getStart(sf);
  for (const r of [...ranges].reverse()) {
    if (blankBetween(sf, r.end, cursor)) break;
    kept.unshift(...stripComment(r.text));
    cursor = r.pos;
  }
  return proseFrom(kept);
}

// Comments above a node that a blank line separates from it (the file/module header).
// Each `//` line is its own range, so ranges only start a new paragraph when a blank
// line sits between them.
function floating(sf: ts.SourceFile, node: ts.Node): string {
  const ranges = commentRanges(sf, node);
  const kept: string[] = [];
  let cursor = node.getStart(sf);
  let sawGap = false;
  for (const r of [...ranges].reverse()) {
    const gap = blankBetween(sf, r.end, cursor);
    if (!sawGap && gap) sawGap = true;
    else if (sawGap && gap) kept.unshift("");
    if (sawGap) kept.unshift(...stripComment(r.text));
    cursor = r.pos;
  }
  return proseFrom(kept);
}

// ---- declarations → markdown -------------------------------------------------

function declName(node: ts.Statement): string | null {
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
    return node.name?.text ?? null;
  }
  if (ts.isVariableStatement(node)) {
    const d = node.declarationList.declarations[0];
    return d && ts.isIdentifier(d.name) ? d.name.text : null;
  }
  return null;
}

const FMT = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

// `?: string | undefined` is how strict mode spells an optional; the source says `?: string`.
function tidy(type: string): string {
  return type.replace(/\?: (.+?) \| undefined(?=[;,)}\n]|$)/g, "?: $1");
}

function typeOf(node: ts.Node): string {
  return tidy(checker.typeToString(checker.getTypeAtLocation(node), undefined, FMT));
}

// An object literal's members as `name: type` lines, so `export const ai = {...}`
// reads as an API table instead of an implementation. A member that is itself a
// plain object (a nested namespace like `worlds.ai`) is expanded one level.
function objectMembers(prefix: string, lit: ts.ObjectLiteralExpression, sf: ts.SourceFile): string[] {
  const lines: string[] = [];
  for (const p of lit.properties) {
    const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
    if (!name) continue;
    const doc = attached(sf, p);
    if (doc) lines.push(...doc.split("\n").map((l) => `// ${l}`));
    if (ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer)) {
      lines.push(...objectMembers(`${prefix}${name}.`, p.initializer, sf));
      continue;
    }
    const node = ts.isShorthandPropertyAssignment(p) ? p.name : p;
    const type = checker.getTypeAtLocation(node);
    const isNamespace = type.getCallSignatures().length === 0 && type.getConstructSignatures().length === 0 && type.getProperties().length > 0 && !type.isClassOrInterface();
    if (isNamespace) {
      for (const sym of type.getProperties()) {
        lines.push(`${prefix}${name}.${sym.name}: ${tidy(checker.typeToString(checker.getTypeOfSymbolAtLocation(sym, node), undefined, FMT))}`);
      }
      continue;
    }
    lines.push(`${prefix}${name}: ${typeOf(node)}`);
  }
  return lines;
}

function signatureText(fn: ts.FunctionDeclaration, sf: ts.SourceFile): string {
  const end = fn.body ? fn.body.getStart(sf) : fn.getEnd();
  return sf.getFullText().slice(fn.getStart(sf), end).trim();
}

function fence(lang: string, body: string): string {
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

function renderDecl(node: ts.Statement, sf: ts.SourceFile, doc: string): string[] {
  const name = declName(node)!;
  const out: string[] = [];
  const text = node.getText(sf);
  if (ts.isFunctionDeclaration(node)) {
    out.push(`### \`${name}()\``, "", fence("ts", signatureText(node, sf)));
  } else if (ts.isInterfaceDeclaration(node)) {
    out.push(`### \`interface ${name}\``, "", fence("ts", text));
  } else if (ts.isTypeAliasDeclaration(node)) {
    out.push(`### \`type ${name}\``, "", fence("ts", text));
  } else if (ts.isClassDeclaration(node)) {
    out.push(`### \`class ${name}\``, "", fence("ts", text));
  } else if (ts.isVariableStatement(node)) {
    const d = node.declarationList.declarations[0]!;
    if (d.initializer && ts.isObjectLiteralExpression(d.initializer)) {
      out.push(`### \`${name}\``, "", fence("ts", objectMembers(`${name}.`, d.initializer, sf).join("\n")));
    } else {
      out.push(`### \`${name}\``, "", fence("ts", `${name}: ${typeOf(d.name)}`));
    }
  }
  if (doc) out.push("", doc);
  return out;
}

function renderModule(m: (typeof MODULES)[number]): string[] {
  const sf = source(join(SDK, m.file));
  const out: string[] = [`## ${m.title}`, "", `Source: \`sdk/src/${m.file}\``, ""];
  const stmts = sf.statements.filter((s) => !ts.isImportDeclaration(s));
  const first = stmts[0];
  if (first) {
    // The module header is whatever floats above the first real statement, plus the
    // block attached to it when that statement is private (a helper, not an export) —
    // unless the export right below borrows that block as its own doc.
    const next = stmts[1];
    const borrowed = !!next && isExported(next) && !blankBetween(sf, first.getEnd(), next.getStart(sf));
    const header = [floating(sf, first), isExported(first) || borrowed ? "" : attached(sf, first)].filter(Boolean).join("\n\n");
    if (header) out.push(header, "");
  }
  for (let i = 0; i < stmts.length; i++) {
    const node = stmts[i]!;
    if (!isExported(node)) continue;
    const name = declName(node);
    if (!name || (m.only && !m.only.includes(name))) continue;
    let doc = attached(sf, node);
    // An export with no comment of its own borrows the one on the private statement
    // right above it (`let _id …` then `export function id()`), when the two touch.
    const prev = stmts[i - 1];
    if (!doc && prev && !isExported(prev) && i > 0 && !blankBetween(sf, prev.getEnd(), node.getStart(sf))) doc = attached(sf, prev);
    out.push(...renderDecl(node, sf, doc), "");
  }
  return out;
}

// ---- the `worlds` global (sdk/src/index.ts) ----------------------------------

function renderSurface(): string[] {
  const sf = source(join(SDK, "index.ts"));
  const out: string[] = ["## The `worlds` global", ""];
  const header = floating(sf, sf.statements.find((s) => !ts.isImportDeclaration(s))!);
  if (header) out.push(header, "");
  const lines: string[] = [];
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      const d = st.declarationList.declarations[0];
      if (d && ts.isIdentifier(d.name) && d.name.text === "worlds" && d.initializer && ts.isObjectLiteralExpression(d.initializer)) {
        lines.push(...objectMembers("worlds.", d.initializer, sf));
      }
    }
    // `worlds.ready = …` style additions after the literal.
    if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && ts.isPropertyAccessExpression(st.expression.left)) {
      const target = st.expression.left;
      if (ts.isIdentifier(target.expression) && target.expression.text === "worlds") {
        const doc = attached(sf, st);
        if (doc) lines.push(...doc.split("\n").map((l) => `// ${l}`));
        lines.push(`worlds.${target.name.text}: ${typeOf(st.expression.right)}`);
      }
    }
  }
  out.push(fence("ts", lines.join("\n")), "");
  return out;
}

// ---- server contract: errors, limits, reserved names, model aliases, MCP -----

function findConst(sf: ts.SourceFile, name: string): ts.Expression | null {
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return d.initializer;
    }
  }
  return null;
}

function literalProps(expr: ts.Expression): { name: string; init: ts.Expression }[] {
  if (!ts.isObjectLiteralExpression(expr)) return [];
  const out: { name: string; init: ts.Expression }[] = [];
  for (const p of expr.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) out.push({ name: p.name.text, init: p.initializer });
  }
  return out;
}

// Arithmetic-only initializers (`256 * 1024`) evaluated to a number; anything else is
// left as source text so the table never lies about a value it could not compute.
function numeric(expr: ts.Expression, sf: ts.SourceFile): number | null {
  const text = expr.getText(sf).replace(/_/g, "");
  if (!/^[\d\s*+\-/().]+$/.test(text)) return null;
  return Number(new Function(`return (${text})`)());
}

function humanBytes(n: number): string {
  if (n % (1024 * 1024 * 1024) === 0) return `${n / (1024 * 1024 * 1024)} GB`;
  if (n % (1024 * 1024) === 0) return `${n / (1024 * 1024)} MB`;
  if (n % 1024 === 0) return `${n / 1024} KB`;
  return `${n} bytes`;
}

function renderErrors(): string[] {
  const sf = source(join(ROOT, "server/errors.ts"));
  const status = findConst(sf, "STATUS");
  const out = [
    "## Error codes",
    "",
    "Every failed request is `{ error: { code, message, retry_after? } }` with one of these codes; the SDK rethrows it as a `WorldsError` carrying the same `code` plus the HTTP `status`. The registry is frozen: codes are never removed or renumbered.",
    "",
    "| code | HTTP status |",
    "|---|---|",
  ];
  if (status) for (const p of literalProps(status)) out.push(`| \`${p.name}\` | ${p.init.getText(sf)} |`);
  out.push("");
  return out;
}

function renderLimits(): string[] {
  const sf = source(join(ROOT, "server/config.ts"));
  const out = ["## Limits", "", "Quotas are floors: they can go up, never down for existing behavior.", "", "| limit | value |", "|---|---|"];
  const limits = findConst(sf, "LIMITS");
  if (limits) {
    for (const p of literalProps(limits)) {
      const n = numeric(p.init, sf);
      const shown = n === null ? p.init.getText(sf) : /Bytes$/.test(p.name) ? humanBytes(n) : String(n);
      out.push(`| \`${p.name}\` | ${shown} |`);
    }
  }
  const reserved = findConst(sf, "RESERVED_SITES");
  if (reserved && ts.isNewExpression(reserved) && reserved.arguments?.[0] && ts.isArrayLiteralExpression(reserved.arguments[0])) {
    const names = reserved.arguments[0].elements.filter(ts.isStringLiteral).map((e) => `\`${e.text}\``);
    out.push("", `Reserved site names (cannot be deployed to): ${names.join(", ")}.`);
  }
  out.push("");
  return out;
}

function renderModels(): string[] {
  const sf = source(join(ROOT, "server/ai.ts"));
  const models = findConst(sf, "CHAT_MODELS");
  const aliases = models ? literalProps(models).map((p) => `\`${p.name}\``) : [];
  return [
    "## AI model aliases",
    "",
    `Chat completions accept \`model\` as one of ${aliases.join(", ")} (default \`fast\`). Aliases are the contract; the provider model behind each one is remapped server-side and never exposed. \`worlds.ai.models()\` lists the live set, including the embedding model.`,
    "",
  ];
}

function renderMcp(): string[] {
  const sf = source(join(ROOT, "server/mcp.ts"));
  const tools = findConst(sf, "TOOLS");
  const out = [
    "## MCP tools",
    "",
    "The server speaks MCP (JSON-RPC 2.0 over HTTP) at `/mcp`. The tools are sugar over the same `/api/v1` contract, so an agent can build and deploy a site without a browser.",
    "",
  ];
  if (!tools) return out;
  for (const t of literalProps(tools)) {
    const props = literalProps(t.init);
    const desc = props.find((p) => p.name === "description")?.init;
    const schema = props.find((p) => p.name === "inputSchema")?.init;
    out.push(`### \`${t.name}\``, "");
    if (desc && ts.isStringLiteral(desc)) out.push(desc.text, "");
    if (schema && ts.isCallExpression(schema) && schema.arguments[0] && ts.isObjectLiteralExpression(schema.arguments[0])) {
      const required = new Set(
        schema.arguments[1] && ts.isArrayLiteralExpression(schema.arguments[1]) ? schema.arguments[1].elements.filter(ts.isStringLiteral).map((e) => e.text) : [],
      );
      const args = literalProps(schema.arguments[0]);
      if (args.length) {
        out.push("| argument | type | |", "|---|---|---|");
        for (const a of args) {
          const fields = literalProps(a.init);
          const type = fields.find((f) => f.name === "type")?.init;
          const d = fields.find((f) => f.name === "description")?.init;
          out.push(`| \`${a.name}\`${required.has(a.name) ? " (required)" : ""} | ${type && ts.isStringLiteral(type) ? type.text : ""} | ${d && ts.isStringLiteral(d) ? d.text : ""} |`);
        }
        out.push("");
      }
    }
  }
  return out;
}

async function renderHttp(): Promise<string[]> {
  const spec = Bun.YAML.parse(await Bun.file(join(ROOT, "spec/world-v1.yaml")).text()) as {
    paths: Record<string, Record<string, { summary?: string }>>;
  };
  const out = [
    "## HTTP API (`/api/v1`)",
    "",
    "The SDK is a thin client over these endpoints (`spec/world-v1.yaml`, frozen and additive-only). Mutations need the `x-worlds-csrf: 1` header; in path-routing mode a page also sends `x-worlds-site: <site>`.",
    "",
    "| method | path | |",
    "|---|---|---|",
  ];
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(ops)) out.push(`| ${method.toUpperCase()} | \`${path}\` | ${op.summary ?? ""} |`);
  }
  out.push("");
  return out;
}

// ---- assemble -----------------------------------------------------------------

export async function generate(): Promise<string> {
  const parts: string[] = [
    "<!-- GENERATED from sdk/src, server/ and spec/ by `bun run build:docs`. Do not edit by hand. -->",
    "# worlds.js — generated reference",
    "",
    "The complete public surface of the SDK, printed from the source that ships with this server, so it can never be newer or older than the `/worlds.js` you load. Declarations are verbatim TypeScript; the prose is the comment block above each one. For the narrative guide see `sdk.md`; for the HTTP shapes behind the SDK see the tables at the end.",
    "",
    ...renderSurface(),
    ...MODULES.flatMap(renderModule),
    ...renderErrors(),
    ...renderLimits(),
    ...renderModels(),
    ...(await renderHttp()),
    ...renderMcp(),
  ];
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

if (import.meta.main) {
  const md = await generate();
  if (process.argv.includes("--check")) {
    const current = await Bun.file(OUT).text().catch(() => "");
    if (current !== md) {
      console.error("docs/reference.md is stale — run `bun run build:docs`");
      process.exit(1);
    }
    console.log("docs/reference.md is up to date");
  } else {
    await Bun.write(OUT, md);
    console.log(`wrote ${OUT} (${md.length} bytes)`);
  }
}
