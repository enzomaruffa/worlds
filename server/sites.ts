import { sql, requireDb, dbReady, emitChange } from "./db";
import type { Identity } from "./identity";
import { config } from "./config";
import { WorldError } from "./errors";

export interface SiteRow {
  name: string;
  description: string;
  creator: string;
  contributors: string[];
  spa_fallback: boolean;
  status: string;
  category: string;
  visits: number;
  embed_pos: number[] | null;
  screenshot: string | null;
  created_at: string;
  updated_at: string;
}

// Frozen v1 category set (additive later). `.world.json` may set one; default misc.
export const CATEGORIES = new Set(["games", "work", "tools", "experiments", "misc"]);

export function siteUrl(name: string): string {
  const scheme = config.dev ? "http" : "https";
  const port = config.dev ? `:${config.port}` : "";
  return `${scheme}://${name}.${config.baseDomain}${port}`;
}

export function publicSite(s: SiteRow) {
  return {
    name: s.name,
    url: siteUrl(s.name),
    description: s.description,
    creator: { handle: s.creator },
    contributors: s.contributors,
    status: s.status,
    category: s.category ?? "misc",
    visits_30d: Number(s.visits),
    created_at: s.created_at,
    updated_at: s.updated_at,
    screenshot_url: s.screenshot ?? null,
  };
}

// Post-deploy worker results (universe pipeline) — set asynchronously after a deploy.
export async function setEmbedPos(name: string, pos: number[]): Promise<void> {
  if (!dbReady()) return;
  // Bind the array directly — Bun.sql encodes it as jsonb (don't pre-stringify or
  // it stores a JSON string scalar, not an array).
  await sql`UPDATE sites SET embed_pos = ${pos as never} WHERE name = ${name}`;
}

export async function setScreenshot(name: string, url: string): Promise<void> {
  if (!dbReady()) return;
  await sql`UPDATE sites SET screenshot = ${url} WHERE name = ${name}`;
}

// "sites" is a real, world-readable collection in home — platform-written. Upsert
// the site's doc and emit a change so the universe pops/refines the planet live.
export async function publishSiteDoc(site: string, created: boolean): Promise<void> {
  if (!dbReady()) return;
  const s = await getSite(site);
  if (!s) return;
  const doc = publicSite(s);
  await sql`
    INSERT INTO documents (site, collection, id, data, created_by)
    VALUES ('home', 'sites', ${`site_${site}`}, ${doc as never}, 'world')
    ON CONFLICT (site, collection, id) DO UPDATE SET data = ${doc as never}, updated_at = now()`;
  await emitChange("home", "sites", created ? "create" : "update", doc);
}

export async function upsertSite(
  name: string,
  who: Identity,
  meta: { description?: string; spa_fallback?: boolean; category?: string },
): Promise<{ created: boolean }> {
  requireDb();
  const category = CATEGORIES.has(meta.category ?? "") ? meta.category! : "misc";
  const rows = await sql`
    INSERT INTO sites (name, description, creator, contributors, spa_fallback, category)
    VALUES (${name}, ${meta.description ?? ""}, ${who.handle}, ${JSON.stringify([who.handle]) as never}, ${meta.spa_fallback ?? false}, ${category})
    ON CONFLICT (name) DO UPDATE SET
      description = COALESCE(NULLIF(${meta.description ?? ""}, ''), sites.description),
      spa_fallback = ${meta.spa_fallback ?? false},
      category = CASE WHEN ${meta.category ?? ""} = '' THEN sites.category ELSE ${category} END,
      contributors = CASE
        WHEN sites.contributors ? ${who.handle} THEN sites.contributors
        ELSE sites.contributors || ${JSON.stringify([who.handle]) as never}
      END,
      updated_at = now()
    RETURNING (xmax = 0) AS created`;
  return { created: Boolean(rows[0]?.created) };
}

export async function getSite(name: string): Promise<SiteRow | null> {
  if (!dbReady()) return null;
  const rows = await sql`SELECT * FROM sites WHERE name = ${name}`;
  return (rows[0] as SiteRow) ?? null;
}

export async function getSiteOr404(name: string): Promise<SiteRow> {
  requireDb();
  const s = await getSite(name);
  if (!s) throw new WorldError("not_found", `no site named "${name}"`);
  return s;
}

export async function listSites(q: {
  creator?: string;
  search?: string;
  limit: number;
}): Promise<SiteRow[]> {
  requireDb();
  return (await sql`
    SELECT * FROM sites
    WHERE (${q.creator ?? null}::text IS NULL OR creator = ${q.creator ?? null})
      AND (${q.search ?? null}::text IS NULL
           OR name ILIKE '%' || ${q.search ?? ""} || '%'
           OR description ILIKE '%' || ${q.search ?? ""} || '%')
    ORDER BY updated_at DESC
    LIMIT ${q.limit}`) as SiteRow[];
}

export async function spaFallback(name: string): Promise<boolean> {
  const s = await getSite(name);
  return s?.spa_fallback ?? false;
}

export async function bumpVisit(name: string): Promise<void> {
  if (!dbReady()) return;
  await sql`UPDATE sites SET visits = visits + 1 WHERE name = ${name}`;
}
