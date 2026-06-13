import { timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { WorldError } from "./errors";

// Built-in Google sign-in (OAuth 2.0 authorization-code flow) + a signed session
// cookie shared across *.<baseDomain>, so one sign-in covers every world. Active
// when WORLD_AUTH=google (the self-host default). With WORLD_AUTH=gateway an
// upstream proxy injects the verified email instead and these routes are unused.

const COOKIE = "world_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

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
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `; Path=/; HttpOnly; SameSite=Lax${domain}${secure}`;
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
    throw new WorldError("internal", "sign-in is not configured (GOOGLE_CLIENT_ID unset)");
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

export async function handleAuth(req: Request, path: string): Promise<Response> {
  if (path === "/auth/login") {
    const rd = new URL(req.url).searchParams.get("rd") ?? "/";
    return redirect(loginUrl(req, rd));
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
