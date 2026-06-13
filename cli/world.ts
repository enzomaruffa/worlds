#!/usr/bin/env bun
// world — deploy a folder, get a website.
// Auth: in prod the gateway handles it (Cloudflare Access service token via
// `world login`); in dev there is no auth. The adapter lives behind authHeaders().

import { readdir, stat } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

const API = process.env.WORLD_URL ?? "http://world.localhost:8420";
const CREDS = join(homedir(), ".world", "credentials.json");

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "x-world-csrf": "1" };
  try {
    const creds = await Bun.file(CREDS).json();
    if (creds.mode === "cloudflared") {
      // Ask cloudflared for a fresh Access token (it manages login + expiry).
      const cf = Bun.which("cloudflared");
      const tok = cf && Bun.spawnSync([cf, "access", "token", `-app=${creds.app ?? API}`]).stdout.toString().trim();
      if (tok) headers["cf-access-token"] = tok;
    } else if (creds.cf_access_client_id) {
      headers["cf-access-client-id"] = creds.cf_access_client_id;
      headers["cf-access-client-secret"] = creds.cf_access_client_secret;
    }
  } catch {
    /* dev mode or not logged in; the server will say so */
  }
  return headers;
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function api(method: string, path: string, body?: FormData): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${path}`, { method, headers: await authHeaders(), body }).catch((e) =>
    fail(`cannot reach ${API} (${e.message}) — is the server up?`),
  );
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (data.error ?? {}) as { code?: string; message?: string };
    fail(`${err.code ?? res.status}: ${err.message ?? "request failed"}`);
  }
  return data;
}

function siteNameFromCwd(dir: string): string {
  return basename(dir).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
}

async function cmdInit(name?: string): Promise<void> {
  const dir = name ? resolve(name) : process.cwd();
  if (name) await Bun.spawn(["mkdir", "-p", dir]).exited;
  const index = join(dir, "index.html");
  if (await Bun.file(index).exists()) fail("index.html already exists here");
  const site = siteNameFromCwd(dir);
  await Bun.write(
    index,
    `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${site}</title></head>
<body style="font-family: system-ui; max-width: 60ch; margin: 4rem auto">
  <h1>${site}</h1>
  <p>It's alive. Edit <code>index.html</code> and run <code>world deploy</code> again.</p>
  <script src="/world.js"></script>
  <script>world.me().then(me => document.body.insertAdjacentHTML("beforeend", "<p>hi, " + me.name + "</p>"))</script>
</body>
</html>
`,
  );
  await Bun.write(join(dir, ".world.json"), JSON.stringify({ description: "", category: "misc" }, null, 2) + "\n");
  console.log(`✓ scaffolded ${site} — run \`world deploy\`${name ? ` from ${name}/` : ""}`);
}

async function cmdDeploy(siteArg?: string): Promise<void> {
  const dir = process.cwd();
  if (!(await Bun.file(join(dir, "index.html")).exists())) fail("no index.html here — run `world init` first");
  const site = siteArg ?? siteNameFromCwd(dir);

  // build the bundle in tmp, not the project dir, so a crash never leaves an artifact behind
  const tarPath = join(tmpdir(), `world-deploy-${Date.now()}.tgz`);
  const tar = Bun.spawnSync(["tar", "-czf", tarPath, "--exclude", ".git", "-C", dir, "."]);
  if (tar.exitCode !== 0) fail("tar failed");
  try {
    const form = new FormData();
    form.set("site", site);
    form.set("bundle", new Blob([await Bun.file(tarPath).arrayBuffer()]), "bundle.tgz");
    const out = await api("POST", "/api/v1/deploy", form);
    console.log(`✓ live at ${out.url}  (${out.files} files, ${Math.round(Number(out.bytes) / 1024)}KB)`);
  } finally {
    await Bun.spawn(["rm", "-f", tarPath]).exited;
  }
}

async function cmdList(): Promise<void> {
  const out = await api("GET", "/api/v1/sites");
  const items = out.items as { name: string; url: string; creator: { handle: string }; updated_at: string }[];
  if (!items.length) return console.log("no worlds yet — `world deploy` the first one");
  for (const s of items) {
    console.log(`${s.name.padEnd(24)} ${s.creator.handle.padEnd(16)} ${s.updated_at.slice(0, 10)}  ${s.url}`);
  }
}

async function cmdOpen(siteArg?: string): Promise<void> {
  const site = siteArg ?? siteNameFromCwd(process.cwd());
  const out = await api("GET", `/api/v1/sites/${site}`);
  Bun.spawn(["open", String(out.url)]);
  console.log(`✓ ${out.url}`);
}

async function cmdLogin(): Promise<void> {
  if (API.includes("localhost") || API.includes("127.0.0.1")) {
    console.log(`✓ local dev (${API}) — no login needed; you are dev@localhost`);
    return;
  }
  const cf = Bun.which("cloudflared");
  if (cf) {
    console.log(`opening a browser to sign in to ${API} …`);
    if (Bun.spawnSync([cf, "access", "login", API], { stdout: "inherit", stderr: "inherit" }).exitCode !== 0) {
      fail("cloudflared login failed");
    }
    if (!Bun.spawnSync([cf, "access", "token", `-app=${API}`]).stdout.toString().trim()) {
      fail("signed in, but couldn't mint an Access token — check the app URL");
    }
    await Bun.write(CREDS, `${JSON.stringify({ mode: "cloudflared", app: API }, null, 2)}\n`);
    console.log(`✓ logged in — cloudflared holds the token; \`world deploy\` will use it automatically`);
    return;
  }
  console.log(`cloudflared isn't installed. Install it (\`brew install cloudflared\`) and re-run \`world login\`,
or create an Access service token and save it:

  mkdir -p ~/.world && cat > ~/.world/credentials.json <<'EOF'
  {"cf_access_client_id": "…", "cf_access_client_secret": "…"}
  EOF`);
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "init": await cmdInit(arg); break;
  case "deploy": await cmdDeploy(arg); break;
  case "list": await cmdList(); break;
  case "open": await cmdOpen(arg); break;
  case "login": await cmdLogin(); break;
  default:
    console.log(`world — deploy a folder, get a website

  world init [name]     scaffold an index.html (+ .world.json)
  world deploy [site]   tar the folder, ship it (defaults to folder name)
  world open [site]     open the site in a browser
  world list            all worlds
  world login           CLI auth setup

server: ${API} (override with WORLD_URL)`);
}
