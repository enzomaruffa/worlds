import { sql, dbReady } from "./db";
import { avatarFor, deriveName } from "./identity";
import { RESERVED_SITES } from "./config";
import { WorldsError } from "./errors";

// canonical = email local-part (immutable identity key, used for all attribution).
// handle = mutable, unique display/URL alias; defaults to canonical. "Custom
// replaces canonical": the custom handle is primary, the canonical /@handle redirects.
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;

export interface ResolvedProfile {
  handle: string;
  name: string;
  avatar_url: string;
}

interface ProfileRow {
  canonical: string;
  handle: string;
  name: string | null;
  avatar: string | null;
}

function withDefaults(canonical: string, row: ProfileRow | undefined, email?: string): ResolvedProfile {
  const handle = row?.handle || canonical;
  return {
    handle,
    name: row?.name || deriveName(handle),
    avatar_url: row?.avatar || avatarFor(email ?? canonical),
  };
}

export async function resolveProfile(canonical: string, email: string): Promise<ResolvedProfile> {
  if (!dbReady()) return { handle: canonical, name: deriveName(canonical), avatar_url: avatarFor(email) };
  const [row] = await sql`SELECT canonical, handle, name, avatar FROM profiles WHERE canonical = ${canonical}`;
  return withDefaults(canonical, row as ProfileRow | undefined, email);
}

export async function updateProfile(
  canonical: string,
  email: string,
  patch: { handle?: unknown; name?: unknown; avatar_url?: unknown },
): Promise<ResolvedProfile> {
  if (!dbReady()) throw new WorldsError("maintenance", "database unavailable");
  const [existing] = await sql`SELECT canonical, handle, name, avatar FROM profiles WHERE canonical = ${canonical}`;
  const cur = existing as ProfileRow | undefined;

  let handle = cur?.handle ?? canonical;
  if (patch.handle !== undefined) {
    const h = String(patch.handle).toLowerCase().trim();
    if (!HANDLE_RE.test(h)) throw new WorldsError("invalid_request", "handle must be 2–39 chars: a–z, 0–9, dashes (no leading dash)");
    if (RESERVED_SITES.has(h)) throw new WorldsError("invalid_request", `"${h}" is reserved`);
    const [taken] = await sql`SELECT canonical FROM profiles WHERE handle = ${h} AND canonical <> ${canonical}`;
    if (taken) throw new WorldsError("conflict", `@${h} is already taken`);
    handle = h;
  }

  let name = cur?.name ?? null;
  if (patch.name !== undefined) name = String(patch.name).trim().slice(0, 80) || null;

  let avatar = cur?.avatar ?? null;
  if (patch.avatar_url !== undefined) {
    const a = String(patch.avatar_url).trim();
    if (a && !/^(https:\/\/|\/u\/)/.test(a)) {
      throw new WorldsError("invalid_request", "avatar_url must be an https URL or a /u/ upload path");
    }
    avatar = a || null;
  }

  await sql`
    INSERT INTO profiles (canonical, handle, name, avatar, updated_at)
    VALUES (${canonical}, ${handle}, ${name}, ${avatar}, now())
    ON CONFLICT (canonical) DO UPDATE SET handle = ${handle}, name = ${name}, avatar = ${avatar}, updated_at = now()`;
  return withDefaults(canonical, { canonical, handle, name, avatar }, email);
}

export interface HandleResolution {
  canonical: string;
  handle: string;
  redirect_to: string | null; // set when an old/canonical alias was requested
}

export async function resolveHandle(requested: string): Promise<HandleResolution | null> {
  if (!dbReady()) return null;
  const q = requested.toLowerCase();
  const [byHandle] = await sql`SELECT canonical, handle FROM profiles WHERE handle = ${q}`;
  if (byHandle) return { canonical: byHandle.canonical, handle: byHandle.handle, redirect_to: null };
  const [byCanon] = await sql`SELECT canonical, handle FROM profiles WHERE canonical = ${q}`;
  if (byCanon) return { canonical: byCanon.canonical, handle: byCanon.handle, redirect_to: byCanon.handle === q ? null : byCanon.handle };
  const [hasSites] = await sql`SELECT 1 FROM sites WHERE creator = ${q} OR contributors ? ${q} LIMIT 1`;
  if (hasSites) return { canonical: q, handle: q, redirect_to: null };
  return null;
}

// Rewrite the `creator` of publicSite-shaped entries (whose creator.handle is the
// canonical) to the creator's current display handle/name/avatar. One query.
export async function overlayCreators(entries: { creator: { handle: string } }[]): Promise<void> {
  if (!entries.length) return;
  const byCanon = new Map<string, ProfileRow>();
  if (dbReady()) {
    const rows = await sql`SELECT canonical, handle, name, avatar FROM profiles`;
    for (const r of rows as ProfileRow[]) byCanon.set(r.canonical, r);
  }
  for (const e of entries) {
    const canonical = e.creator.handle;
    e.creator = withDefaults(canonical, byCanon.get(canonical)) as unknown as { handle: string };
  }
}
