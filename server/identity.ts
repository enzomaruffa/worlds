import { config } from "./config";
import { WorldsError } from "./errors";
import { sessionFrom } from "./auth";

export interface Identity {
  email: string;
  handle: string; // email local-part, lowercased — frozen rule (creator URLs)
  name: string;
  avatar: string;
  kind: "user" | "service"; // service = a bearer-token caller (an app or agent), never a person
}

// Deterministic avatar from the email (Gravatar if they have one, identicon
// fallback) — no avatar header exists on the gateway, so derive one.
export function avatarFor(email: string): string {
  const hash = new Bun.CryptoHasher("md5").update(email.trim().toLowerCase()).digest("hex");
  return `https://www.gravatar.com/avatar/${hash}?d=identicon&s=200`;
}

// Title-case a handle into a default display name (overridable via profile).
export function deriveName(handle: string): string {
  return handle
    .split(".")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

// In gateway mode an upstream proxy (oauth2-proxy / IAP / CF Access) injects a
// verified email header; in google mode we read our own signed session cookie.
const EMAIL_HEADERS = ["x-auth-request-email", "cf-access-authenticated-user-email"];

function mk(email: string, name?: string, picture?: string): Identity {
  const handle = email.split("@")[0]!.toLowerCase();
  return { email, handle, name: name || deriveName(handle), avatar: picture || avatarFor(email), kind: "user" };
}

// Services and agents can't hold a browser session. They present a bearer token that the
// operator mapped to a fixed identity (WORLDS_SERVICE_TOKENS). A token that is present but
// unknown is refused outright rather than falling through to another scheme.
function serviceFrom(req: Request): Identity | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) throw new WorldsError("unauthorized", "malformed authorization header");
  const svc = config.serviceTokens[m[1]!];
  if (!svc) throw new WorldsError("unauthorized", "unknown service token");
  return { email: svc.email, handle: svc.handle, name: svc.name ?? deriveName(svc.handle), avatar: avatarFor(svc.email), kind: "service" };
}

export function identityFrom(req: Request): Identity {
  const svc = serviceFrom(req);
  if (svc) return svc;

  // Dev: stub identity (a header may still override, for impersonation in tests).
  if (config.dev) return mk(req.headers.get("x-auth-request-email") || "dev@localhost");

  if (config.authMode === "gateway") {
    for (const h of EMAIL_HEADERS) {
      const email = req.headers.get(h);
      if (email) return mk(email);
    }
    throw new WorldsError("unauthorized", "no verified identity on request");
  }

  // google: our signed session cookie carries the verified Google identity.
  const s = sessionFrom(req);
  if (!s) throw new WorldsError("unauthorized", "sign in required");
  return mk(s.email, s.name, s.picture);
}

export function requireCsrf(req: Request): void {
  // Custom header forces a CORS preflight; same-origin only by design.
  if (!req.headers.get("x-worlds-csrf")) {
    throw new WorldsError("invalid_request", "missing X-Worlds-Csrf header");
  }
}
