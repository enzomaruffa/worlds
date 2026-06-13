import { timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { WorldsError } from "./errors";

// Built-in Google sign-in (OAuth 2.0 authorization-code flow) + a signed session
// cookie shared across *.<baseDomain>, so one sign-in covers every world. Active
// when WORLDS_AUTH=google (the self-host default). With WORLDS_AUTH=gateway an
// upstream proxy injects the verified email instead and these routes are unused.

const COOKIE = "world_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISS = ["https://accounts.google.com", "accounts.google.com"];

// Two google sign-in flows share the same signed session cookie:
//   • code flow (loginUrl/callback) — needs a client id AND secret; classic redirect.
//   • GIS flow (signinPage + /auth/google) — needs ONLY a (public) client id: the
//     Google Identity Services button hands us an ID token we verify against Google's
//     JWKS. Lets a deploy reuse an existing public web client (no secret to obtain).
// GIS is used when a client id is set but no secret; code flow when both are set.
export function gisMode(): boolean {
  return config.authMode === "google" && !!config.googleClientId && !config.googleClientSecret;
}

export interface Session {
  email: string;
  name: string;
  picture: string;
}

function sign(payload: string): string {
  return new Bun.CryptoHasher("sha256", config.sessionSecret).update(payload).digest("hex");
}

function verify(payload: string, sig: string): boolean {
  const expected = sign(payload);
  if (expected.length !== sig.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

// payload.sig where payload = base64url(JSON), carrying its own expiry.
function seal(obj: object): string {
  const payload = Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function unseal<T>(token: string | undefined | null): T | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  if (!verify(payload, token.slice(dot + 1))) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString()) as { exp?: number };
    if (!obj.exp || obj.exp < Date.now()) return null;
    return obj as T;
  } catch {
    return null;
  }
}

function readCookie(req: Request, name: string): string | null {
  const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]!) : null;
}

function cookieAttrs(req: Request): string {
  const host = config.baseDomain.split(":")[0]!;
  const domain = host === "localhost" ? "" : `; Domain=.${host}`;
  // Behind a TLS-terminating proxy/tunnel the server sees http; trust the configured
  // public origin (or the forwarded proto) so the cookie is still marked Secure.
  const https =
    new URL(req.url).protocol === "https:" ||
    req.headers.get("x-forwarded-proto") === "https" ||
    (config.publicOrigin?.startsWith("https:") ?? false);
  return `; Path=/; HttpOnly; SameSite=Lax${domain}${https ? "; Secure" : ""}`;
}

export function sessionFrom(req: Request): Session | null {
  return unseal<Session & { exp: number }>(readCookie(req, COOKIE));
}

function allowed(email: string): boolean {
  const e = email.toLowerCase();
  if (config.allowedEmails.includes(e)) return true;
  if (config.allowedDomains.includes(e.split("@")[1] ?? "")) return true;
  return config.allowedDomains.length === 0 && config.allowedEmails.length === 0; // no lists → any account
}

function origin(req: Request): string {
  return config.publicOrigin ?? new URL(req.url).origin;
}

// Only allow same-app redirect targets (relative, or a host under baseDomain).
function safeReturn(rd: string | undefined): string {
  if (!rd) return "/";
  if (rd.startsWith("/")) return rd;
  try {
    const u = new URL(rd);
    const host = u.hostname;
    const base = config.baseDomain.split(":")[0]!;
    if (host === base || host.endsWith(`.${base}`)) return rd;
  } catch { /* not a URL */ }
  return "/";
}

export function loginUrl(req: Request, rd: string): string {
  if (!config.googleClientId) {
    throw new WorldsError("internal", "sign-in is not configured (GOOGLE_CLIENT_ID unset)");
  }
  const state = seal({ rd: safeReturn(rd), exp: Date.now() + 10 * 60 * 1000 });
  const q = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: `${origin(req)}/auth/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return `${GOOGLE_AUTH}?${q}`;
}

function redirect(location: string, setCookie?: string): Response {
  const headers: Record<string, string> = { location };
  if (setCookie) headers["set-cookie"] = setCookie;
  return new Response(null, { status: 302, headers });
}

// Google's signing keys, cached per the certs endpoint's Cache-Control max-age.
interface Jwk { kid: string; n: string; e: string; kty: string; alg?: string; use?: string }
let jwksCache: { keys: Jwk[]; exp: number } | null = null;

async function googleJwks(): Promise<Jwk[]> {
  if (jwksCache && jwksCache.exp > Date.now()) return jwksCache.keys;
  const res = await fetch(GOOGLE_CERTS);
  if (!res.ok) throw new WorldsError("upstream_error", "could not fetch Google signing keys");
  const { keys } = (await res.json()) as { keys: Jwk[] };
  const m = (res.headers.get("cache-control") ?? "").match(/max-age=(\d+)/);
  jwksCache = { keys, exp: Date.now() + (m ? Number(m[1]) * 1000 : 60 * 60 * 1000) };
  return keys;
}

// Verify a Google ID token (RS256) against the JWKS + iss/aud/exp/email_verified.
async function verifyGoogleIdToken(jwt: string): Promise<GoogleClaims> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new WorldsError("unauthorized", "malformed credential");
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString());
  } catch {
    throw new WorldsError("unauthorized", "bad credential header");
  }
  if (header.alg !== "RS256" || !header.kid) throw new WorldsError("unauthorized", "unexpected token alg");
  const jwk = (await googleJwks()).find((k) => k.kid === header.kid);
  if (!jwk) throw new WorldsError("unauthorized", "unknown signing key");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk as unknown as JsonWebKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    Buffer.from(s, "base64url"),
    Buffer.from(`${h}.${p}`),
  );
  if (!ok) throw new WorldsError("unauthorized", "credential signature invalid");
  const claims = (decodeJwt(jwt) ?? {}) as GoogleClaims & { iss?: string; aud?: string; exp?: number };
  if (!claims.iss || !GOOGLE_ISS.includes(claims.iss)) throw new WorldsError("unauthorized", "wrong issuer");
  if (claims.aud !== config.googleClientId) throw new WorldsError("unauthorized", "wrong audience");
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new WorldsError("unauthorized", "credential expired");
  if (!claims.email || claims.email_verified === false) throw new WorldsError("unauthorized", "no verified email");
  return claims;
}

// The GIS sign-in wall page: a Google button that POSTs the ID token to /auth/google,
// then navigates to the (sanitized) return target. Self-contained, no build step.
function signinPage(rd: string): Response {
  const cid = config.googleClientId ?? "";
  const target = JSON.stringify(safeReturn(rd));
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in · Worlds</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#09090b; color:#e4e4e7;
         font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif }
  .card { text-align:center; padding:40px 32px; border:1px solid #27272a; border-radius:16px; background:#0c0c0f;
          box-shadow:0 20px 60px rgba(0,0,0,.5); max-width:340px }
  h1 { margin:0 0 4px; font-size:28px; letter-spacing:-.02em; background:linear-gradient(90deg,#fbbf24,#f59e0b);
       -webkit-background-clip:text; background-clip:text; color:transparent }
  p { margin:0 0 24px; color:#a1a1aa; font-size:14px }
  #btn { display:flex; justify-content:center; min-height:44px }
  #err { margin-top:16px; color:#f87171; font-size:13px; min-height:1em }
</style></head><body>
<div class="card">
  <h1>Worlds</h1>
  <p>Sign in with Google to continue</p>
  <div id="g_id_onload" data-client_id="${cid}" data-callback="onCred" data-auto_prompt="true"></div>
  <div id="btn" class="g_id_signin" data-type="standard" data-theme="filled_black" data-size="large" data-shape="rectangular" data-text="signin_with" data-logo_alignment="center" data-width="280"></div>
  <div id="err"></div>
</div>
<script>
  const RD = ${target};
  function onCred(resp) {
    fetch("/auth/google", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ credential: resp.credential }) })
      .then(r => r.ok ? (location.href = RD) : r.json().then(j => { document.getElementById("err").textContent = (j.error && j.error.message) || "sign-in failed"; }).catch(() => { document.getElementById("err").textContent = "sign-in failed"; }))
      .catch(() => { document.getElementById("err").textContent = "network error"; });
  }
</script>
<script src="https://accounts.google.com/gsi/client" async></script>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export async function handleAuth(req: Request, path: string): Promise<Response> {
  if (path === "/auth/login") {
    const rd = new URL(req.url).searchParams.get("rd") ?? "/";
    if (gisMode()) return signinPage(rd);
    return redirect(loginUrl(req, rd));
  }

  if (path === "/auth/google" && req.method === "POST") {
    const { credential } = (await req.json().catch(() => ({}))) as { credential?: string };
    if (!credential) throw new WorldsError("invalid_request", "missing credential");
    const claims = await verifyGoogleIdToken(credential);
    if (!allowed(claims.email!)) throw new WorldsError("forbidden", `${claims.email} is not allowed on this instance`);
    const session = seal({
      email: claims.email,
      name: claims.name ?? "",
      picture: claims.picture ?? "",
      exp: Date.now() + SESSION_TTL_MS,
    });
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json",
        "set-cookie": `${COOKIE}=${session}; Max-Age=${SESSION_TTL_MS / 1000}${cookieAttrs(req)}`,
      },
    });
  }

  if (path === "/auth/logout") {
    return redirect("/", `${COOKIE}=; Max-Age=0${cookieAttrs(req)}`);
  }

  if (path === "/auth/callback") {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = unseal<{ rd: string; exp: number }>(url.searchParams.get("state"));
    if (!code || !state) return new Response("bad sign-in state", { status: 400 });

    const form = new URLSearchParams({
      code,
      client_id: config.googleClientId ?? "",
      client_secret: config.googleClientSecret ?? "",
      redirect_uri: `${origin(req)}/auth/callback`,
      grant_type: "authorization_code",
    });
    const tokenRes = await fetch(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!tokenRes.ok) return new Response("sign-in failed at provider", { status: 502 });
    const { id_token } = (await tokenRes.json()) as { id_token?: string };
    // Trust the id_token: it came from Google directly over TLS via the code
    // exchange, so decoding the claims (no separate JWKS verify) is sufficient.
    const claims = id_token ? decodeJwt(id_token) : null;
    if (!claims?.email || claims.email_verified === false) {
      return new Response("sign-in failed: no verified email", { status: 403 });
    }
    if (!allowed(claims.email)) {
      return new Response(`${claims.email} is not allowed on this instance`, { status: 403 });
    }
    const session = seal({
      email: claims.email,
      name: claims.name ?? "",
      picture: claims.picture ?? "",
      exp: Date.now() + SESSION_TTL_MS,
    });
    return redirect(safeReturn(state.rd), `${COOKIE}=${session}; Max-Age=${SESSION_TTL_MS / 1000}${cookieAttrs(req)}`);
  }

  return new Response("not found", { status: 404 });
}

interface GoogleClaims {
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

function decodeJwt(jwt: string): GoogleClaims | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as GoogleClaims;
  } catch {
    return null;
  }
}
