#!/usr/bin/env node
// Static checks for example sites. An inline script that contains the literal closing
// script tag splits the element in two, which parses as HTML but breaks in a browser —
// so the block count is checked as well as each block's syntax.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const CATEGORIES = new Set(["games", "work", "tools", "experiments", "misc"]);
const roots = process.argv.slice(2).length ? process.argv.slice(2) : ["examples/tools", "examples/games"];

let failed = 0;
let checked = 0;
const warnings = [];
const warn = (dir, msg) => warnings.push(`${dir}: ${msg}`);

for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    const problems = [];
    checked++;

    const manifest = join(dir, ".world.json");
    if (!existsSync(manifest)) problems.push("no .world.json");
    else {
      try {
        const j = JSON.parse(readFileSync(manifest, "utf8"));
        if (!j.description) problems.push(".world.json has no description");
        if (!CATEGORIES.has(j.category)) problems.push(`.world.json category "${j.category}" is not one of ${[...CATEGORIES].join("|")}`);
      } catch {
        problems.push(".world.json does not parse");
      }
    }

    const index = join(dir, "index.html");
    if (!existsSync(index)) problems.push("no index.html");
    else {
      const html = readFileSync(index, "utf8");
      if (!/<script[^>]*src=["']\/worlds\.js["']/.test(html)) warn(dir, "no /worlds.js script tag");
      // Only classic inline scripts. An importmap is JSON and a module can carry `import`,
      // neither of which `new Function` accepts.
      const inline = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
        .filter(([, attrs]) => !/\bsrc=/.test(attrs) && !/\btype\s*=\s*["'](?!text\/javascript)/.test(attrs));
      // A stray "</script>" inside a string shows up as extra blocks whose halves don't
      // parse — the symptom a browser reports as "Invalid or unexpected token".
      for (const [i, m] of inline.entries()) {
        try {
          new Function(m[2]);
        } catch (e) {
          problems.push(`inline script block ${i + 1}/${inline.length} does not parse: ${e.message}` +
            (inline.length > 1 ? ' — a literal "</script>" in a string splits the element' : ""));
        }
      }
    }

    if (problems.length) {
      failed++;
      console.error(`FAIL ${dir}`);
      for (const p of problems) console.error(`     ${p}`);
    }
  }
}

for (const w of warnings) console.error(`warn ${w}`);
console.log(`${checked} sites checked, ${failed} failing, ${warnings.length} warnings`);
process.exit(failed ? 1 : 0);
