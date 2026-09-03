import { sql, requireDb, dbReady, emitChange } from "./db";
import type { Identity } from "./identity";
import { config } from "./config";
import { WorldsError } from "./errors";
import { asText, ILIKE, jsonArg, jsonArrayAppend, jsonArrayHas, jsonParam, NOW } from "./dialect";
import { invalidatePolicies, NO_POLICIES, type SitePolicies } from "./policies";

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
  policies: SitePolicies | null;
  created_at: string;
  updated_at: string;
}

// Frozen v1 category set (additive later). `.world.json` may set one; default misc.
export const CATEGORIES = new Set(["games", "work", "tools", "experiments", "misc"]);

export function siteUrl(name: string): string {
  const scheme = config.dev ? "http" : "https";
  const port = config.dev ? `:${config.port}` : "";
  if (config.routing === "path") return `${scheme}://${config.baseDomain}${port}/app/${name}/`;
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
  await sql.unsafe(`UPDATE sites SET embed_pos = ${jsonArg("$1")} WHERE name = $2`, [jsonParam(pos), name]);
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
  await sql.unsafe(
    `INSERT INTO documents (site, collection, id, data, created_by)
     VALUES ('home', 'sites', $1, ${jsonArg("$2")}, 'world')
     ON CONFLICT (site, collection, id) DO UPDATE SET data = ${jsonArg("$2")}, updated_at = ${NOW}`,
    [`site_${site}`, jsonParam(doc)],
  );
  await emitChange("home", "sites", created ? "create" : "update", doc);
}

export async function upsertSite(
  name: string,
  who: Identity,
  meta: { description?: string; spa_fallback?: boolean; category?: string; policies?: SitePolicies },
): Promise<{ created: boolean }> {
  requireDb();
  const category = CATEGORIES.has(meta.category ?? "") ? meta.category! : "misc";
  // Read first rather than `RETURNING (xmax = 0)`: xmax is a Postgres system column
  // with no SQLite equivalent, and `created` only decides whether the change feed
  // reports a create or an update.
  const [existing] = await sql`SELECT 1 AS present FROM sites WHERE name = ${name}`;
  const created = !existing;
  // Policies always reflect the manifest that was just deployed: a bundle without them
  // means the site has none, unlike description/category which keep their last value.
  await sql.unsafe(
    `INSERT INTO sites (name, description, creator, contributors, spa_fallback, category, policies)
     VALUES ($1, $2, $3, ${jsonArg("$4")}, $5, $6, ${jsonArg("$8")})
     ON CONFLICT (name) DO UPDATE SET
       description = COALESCE(NULLIF($2, ''), sites.description),
       spa_fallback = $5,
       category = CASE WHEN $7 = '' THEN sites.category ELSE $6 END,
       contributors = CASE
         WHEN ${jsonArrayHas("sites.contributors", "$3")} THEN sites.contributors
         ELSE ${jsonArrayAppend("sites.contributors", "$3", "$4")}
       END,
       policies = ${jsonArg("$8")},
       updated_at = ${NOW}`,
    [
      name, meta.description ?? "", who.handle, jsonParam([who.handle]),
      meta.spa_fallback ?? false, category, meta.category ?? "",
      jsonParam(meta.policies ?? NO_POLICIES),
    ],
  );
  invalidatePolicies(name);
  return { created };
}

export async function getSite(name: string): Promise<SiteRow | null> {
  if (!dbReady()) return null;
  const rows = await sql`SELECT * FROM sites WHERE name = ${name}`;
  return (rows[0] as SiteRow) ?? null;
}

export async function getSiteOr404(name: string): Promise<SiteRow> {
  requireDb();
  const s = await getSite(name);
  if (!s) throw new WorldsError("not_found", `no site named "${name}"`);
  return s;
}

export async function listSites(q: {
  creator?: string;
  search?: string;
  limit: number;
}): Promise<SiteRow[]> {
  requireDb();
  return (await sql.unsafe(
    `SELECT * FROM sites
     WHERE (${asText("$1")} IS NULL OR creator = $1)
       AND (${asText("$2")} IS NULL OR name ${ILIKE} $3 OR description ${ILIKE} $3)
     ORDER BY updated_at DESC
     LIMIT $4`,
    [q.creator ?? null, q.search ?? null, `%${q.search ?? ""}%`, q.limit],
  )) as SiteRow[];
}

export async function spaFallback(name: string): Promise<boolean> {
  const s = await getSite(name);
  return s?.spa_fallback ?? false;
}

export async function bumpVisit(name: string): Promise<void> {
  if (!dbReady()) return;
  await sql`UPDATE sites SET visits = visits + 1 WHERE name = ${name}`;
}
