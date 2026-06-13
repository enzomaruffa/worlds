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
  dev: process.env.WORLDS_DEV === "1",
  databaseUrl: process.env.DATABASE_URL ?? "postgres://world:world@localhost:5499/world",
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
  sessionSecret: process.env.WORLDS_SESSION_SECRET ?? "insecure-dev-secret-change-me",
  // External origin for OAuth redirect_uri, e.g. https://world.example.com. Derived from the request if unset.
  publicOrigin: process.env.WORLDS_PUBLIC_ORIGIN || null,
};

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
  wsPayloadBytes: 16 * 1024,
  slackPerUserPerDay: 50,
};
