import { existsSync } from "node:fs";

const DEV_SESSION_SECRET = "insecure-dev-secret-change-me";

export interface ServiceAccount {
  email: string;
  handle: string;
  name?: string;
}

// WORLDS_SERVICE_TOKENS is JSON: {"<token>": {"email": "app@example.com", "handle": "app", "name": "App"}}.
// A malformed value refuses to boot — a half-parsed table would silently lock services out.
function parseServiceTokens(raw: string | undefined): Record<string, ServiceAccount> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("WORLDS_SERVICE_TOKENS is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("WORLDS_SERVICE_TOKENS must be an object keyed by token");
  }
  const out: Record<string, ServiceAccount> = {};
  for (const [token, v] of Object.entries(parsed as Record<string, unknown>)) {
    const acct = v as Partial<ServiceAccount> | null;
    if (token.length < 16) throw new Error("WORLDS_SERVICE_TOKENS: tokens must be at least 16 characters");
    if (!acct || typeof acct.email !== "string" || !acct.email.includes("@")) throw new Error(`WORLDS_SERVICE_TOKENS: entry needs an email`);
    if (typeof acct.handle !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(acct.handle)) {
      throw new Error(`WORLDS_SERVICE_TOKENS: "${acct.email}" needs a handle matching ^[a-z0-9][a-z0-9._-]*$`);
    }
    out[token] = { email: acct.email, handle: acct.handle, ...(typeof acct.name === "string" ? { name: acct.name } : {}) };
  }
  return out;
}

// WORLDS_DEV_SITES="name=/abs/path,other=/abs/path2" — dev-only folder mounts (see AGENTS.md).
// A bad entry (or a dir that doesn't exist) refuses to boot rather than silently 404ing later.
function parseDevSites(raw: string | undefined, dev: boolean): Record<string, string> {
  if (!dev || !raw) return {};
  const out: Record<string, string> = {};
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    if (eq < 1) throw new Error(`WORLDS_DEV_SITES: bad entry "${entry}" (expected name=/abs/path)`);
    const name = entry.slice(0, eq).trim();
    const dir = entry.slice(eq + 1).trim();
    if (!dir || !existsSync(dir)) throw new Error(`WORLDS_DEV_SITES: "${name}" points at "${dir}", which does not exist`);
    out[name] = dir;
  }
  return out;
}

const DEV = process.env.WORLDS_DEV === "1";

export const config = {
  port: Number(process.env.WORLDS_PORT ?? 8420),
  dataDir: process.env.WORLDS_DATA_DIR ?? "./data",
  // Remote app source: when set, deploys + uploads go to this S3 bucket and reads
  // fall through to the local bundle. Creds come from the standard AWS_* env vars.
  s3Bucket: process.env.WORLDS_S3_BUCKET,
  s3Region: process.env.WORLDS_S3_REGION,
  s3Endpoint: process.env.WORLDS_S3_ENDPOINT,
  // In dev any "<site>.<baseDomain>" Host works, e.g. mysite.worlds.localhost:8420.
  baseDomain: process.env.WORLDS_BASE_DOMAIN ?? "worlds.localhost",
  // dev stubs identity (no real auth) — explicit opt-in.
  dev: DEV,
  // Dev-only: mount local folders straight onto site names, no deploy needed (see AGENTS.md).
  devSites: parseDevSites(process.env.WORLDS_DEV_SITES, DEV),
  // Postgres by default. `sqlite` runs the whole platform off one file under
  // WORLDS_DATA_DIR — no database server to operate, which is the point for a small
  // self-host or a single-pod deploy. Inferred from DATABASE_URL when it names a file.
  db: (process.env.WORLDS_DB ?? (/^(sqlite:|file:|\.?\/|[^:]+\.(db|sqlite3?)$)/.test(process.env.DATABASE_URL ?? "") ? "sqlite" : "postgres")) as "postgres" | "sqlite",
  databaseUrl: process.env.DATABASE_URL ?? "postgres://world:world@localhost:5499/world",
  // sqlite + WORLDS_S3_BUCKET: how often the database is snapshotted to the bucket, and
  // therefore how much a hard crash can lose. A graceful stop always snapshots first.
  dbSnapshotSeconds: Math.max(10, Number(process.env.WORLDS_DB_SNAPSHOT_SECONDS ?? 60)),
  geminiKey: process.env.GEMINI_API_KEY,
  slackToken: process.env.SLACK_BOT_TOKEN,
  // When set, unrecognized hosts (e.g. a Cloudflare/ngrok tunnel) serve this site
  // at their root — lets you forward a single site over a non-wildcard tunnel.
  forwardSite: process.env.WORLDS_FORWARD_SITE || null,

  // "subdomain" (default): sites at <name>.<base>. "path": sites at <base>/app/<name>
  // — one origin, no wildcard DNS/cert needed (free behind Cloudflare). Trades
  // per-site origin isolation; fine inside the sign-in boundary.
  routing: (process.env.WORLDS_ROUTING ?? "subdomain") as "subdomain" | "path",

  // Auth: "google" = built-in Google sign-in (self-host default), "gateway" =
  // trust a verified-email header from an upstream proxy (e.g. behind IAP/CF Access).
  authMode: (process.env.WORLDS_AUTH ?? "google") as "google" | "gateway",
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  // Restrict sign-in to these comma-separated domains/emails; empty = any Google account.
  allowedDomains: (process.env.WORLDS_ALLOWED_DOMAINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  allowedEmails: (process.env.WORLDS_ALLOWED_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  // HMAC key for the session cookie — MUST be set to a random value in production.
  // `||` so a present-but-empty var takes the dev value and trips the guard below.
  sessionSecret: process.env.WORLDS_SESSION_SECRET || DEV_SESSION_SECRET,
  // External origin for OAuth redirect_uri, e.g. https://world.example.com. Derived from the request if unset.
  publicOrigin: process.env.WORLDS_PUBLIC_ORIGIN || null,
  serviceTokens: parseServiceTokens(process.env.WORLDS_SERVICE_TOKENS),
  // HMAC key for signing requests forwarded to a site's declared backend (see policies.ts).
  // Unset = the proxy refuses every request with 503 rather than forwarding unsigned ones.
  proxySecret: process.env.WORLDS_PROXY_SECRET || null,
  // Ceiling for a site's `.world.json` uploads.maxTotalBytes; unset = the platform default is the ceiling.
  uploadQuotaMax: process.env.WORLDS_UPLOAD_QUOTA_MAX ? Number(process.env.WORLDS_UPLOAD_QUOTA_MAX) : null,
};

// Google mode HMACs the session cookie and the screenshot render token with this key,
// so a known value lets anyone mint a session for any email. Refuse to boot instead.
// (Gateway mode takes identity from a proxy header and never consults it.)
if (config.authMode === "google" && !config.dev && config.sessionSecret === DEV_SESSION_SECRET) {
  throw new Error(
    "WORLDS_SESSION_SECRET is unset — set it to a random value (openssl rand -hex 32) " +
      "or run with WORLDS_DEV=1. Refusing to start with a publicly-known session key.",
  );
}

export const RESERVED_SITES = new Set([
  "api", "www", "home", "hello", "assets", "uploads", "list", "mcp", "docs", "u",
]);

export const LIMITS = {
  docBytes: 256 * 1024,
  collectionsPerSite: 50,
  docsPerCollection: 50_000,
  uploadBytes: 25 * 1024 * 1024,
  uploadsPerSiteBytes: 1024 * 1024 * 1024,
  deployBytes: 100 * 1024 * 1024,
  deployFiles: 2000,
  deploysPerSitePerHour: 60,
  aiCompletionsPerUserPerDay: 200,
  aiImagesPerUserPerDay: 50,
  aiInputChars: 200_000,
  wsPayloadBytes: 16 * 1024,
  slackPerUserPerDay: 50,
};
