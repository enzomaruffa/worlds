export const config = {
  port: Number(process.env.WORLD_PORT ?? 8420),
  dataDir: process.env.WORLD_DATA_DIR ?? "./data",
  // In dev any "<site>.<baseDomain>" Host works, e.g. mysite.world.localhost:8420.
  baseDomain: process.env.WORLD_BASE_DOMAIN ?? "world.localhost",
  // dev stubs identity (no real auth) — explicit opt-in.
  dev: process.env.WORLD_DEV === "1",
  databaseUrl: process.env.DATABASE_URL ?? "postgres://world:world@localhost:5499/world",
  geminiKey: process.env.GEMINI_API_KEY,
  slackToken: process.env.SLACK_BOT_TOKEN,
  // When set, unrecognized hosts (e.g. a Cloudflare/ngrok tunnel) serve this site
  // at their root — lets you forward a single site over a non-wildcard tunnel.
  forwardSite: process.env.WORLD_FORWARD_SITE || null,

  // Auth: "google" = built-in Google sign-in (self-host default), "gateway" =
  // trust a verified-email header from an upstream proxy (e.g. behind IAP/CF Access).
  authMode: (process.env.WORLD_AUTH ?? "google") as "google" | "gateway",
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  // Restrict sign-in to these comma-separated domains/emails; empty = any Google account.
  allowedDomains: (process.env.WORLD_ALLOWED_DOMAINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  allowedEmails: (process.env.WORLD_ALLOWED_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  // HMAC key for the session cookie — MUST be set to a random value in production.
  sessionSecret: process.env.WORLD_SESSION_SECRET ?? "insecure-dev-secret-change-me",
  // External origin for OAuth redirect_uri, e.g. https://world.example.com. Derived from the request if unset.
  publicOrigin: process.env.WORLD_PUBLIC_ORIGIN || null,
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
