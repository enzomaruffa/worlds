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
  tags: string[];
  thumbnail: string;
  visits: number;
  embed_pos: number[] | null;
  screenshot: string | null;
  policies: SitePolicies | null;
  created_at: string;
  updated_at: string;
}

// Frozen v1 category set (additive later). A category is a *place*: the universe gives
// each one a star with a hand-picked position and its own prose, so adding one here
// means adding it there too. Free-form classification goes in `tags`, which never
// becomes a spatial axis. Served at /api/v1/meta so the homepage and universe read one
// list instead of each carrying their own copy.
export const CATEGORIES: Record<string, { color: string }> = {
  games: { color: "#f0abfc" },
  work: { color: "#93c5fd" },
  tools: { color: "#fcd34d" },
  experiments: { color: "#5eead4" },
  misc: { color: "#cbd5e1" },
};

// Tags are lowercase slugs so `?q=` matches them the way people type them.
const TAG = /^[a-z0-9][a-z0-9-]{0,23}$/;
const MAX_TAGS = 8;

// How a site's card picture is made. A bundle path is also accepted (`cover.png`).
export const THUMBNAIL_MODES = new Set(["screenshot", "ai", "none"]);
const THUMBNAIL_FILE = /^(?!\.\.?(?:\/|$))[\w.-]+(?:\/[\w.-]+)*\.(png|jpe?g|webp|gif)$/i;

export interface SiteMeta {
  description?: string;
  spa_fallback?: boolean;
  category?: string;
  tags?: string[];
  thumbnail?: string;
  policies?: SitePolicies;
}

// Reads the site-level keys of `.world.json`. Structural problems reject the deploy;
// an unknown category is only a warning, because a typo there should not take a
// working site down — but it must not be silent either, or the author never learns
// their world is orbiting the wrong star.
export function parseManifestMeta(
  manifest: unknown,
  bundleFiles: Set<string>,
): { meta: SiteMeta; warnings: string[] } {
  const warnings: string[] = [];
  const meta: SiteMeta = {};
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return { meta, warnings };
  const m = manifest as Record<string, unknown>;

  if (typeof m.description === "string") meta.description = m.description;
  if (typeof m.spa_fallback === "boolean") meta.spa_fallback = m.spa_fallback;

  if (m.category !== undefined) {
    const c = String(m.category);
    if (c in CATEGORIES) meta.category = c;
    else warnings.push(`category "${c}" is not one of ${Object.keys(CATEGORIES).join("|")} — filed under misc`);
  }

  if (m.tags !== undefined) {
    if (!Array.isArray(m.tags)) throw new WorldsError("invalid_request", ".world.json: tags must be an array of strings");
    const seen = new Set<string>();
    for (const raw of m.tags) {
      if (typeof raw !== "string") throw new WorldsError("invalid_request", ".world.json: tags must be strings");
      const t = raw.trim().toLowerCase();
      if (!TAG.test(t)) throw new WorldsError("invalid_request", `.world.json: tag "${raw}" must be a lowercase slug (a-z, 0-9, dashes, max 24)`);
      seen.add(t);
    }
    if (seen.size > MAX_TAGS) throw new WorldsError("invalid_request", `.world.json: at most ${MAX_TAGS} tags`);
    meta.tags = [...seen];
  }

  if (m.thumbnail !== undefined) {
    const t = String(m.thumbnail);
    if (THUMBNAIL_MODES.has(t)) meta.thumbnail = t;
    else if (THUMBNAIL_FILE.test(t)) {
      if (!bundleFiles.has(t)) throw new WorldsError("invalid_request", `.world.json: thumbnail "${t}" is not in the bundle`);
      meta.thumbnail = t;
    } else {
      throw new WorldsError("invalid_request", `.world.json: thumbnail must be screenshot, ai, none, or an image file in the bundle`);
    }
  }

  return { meta, warnings };
}

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
    tags: s.tags ?? [],
    thumbnail: s.thumbnail ?? "screenshot",
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

export async function upsertSite(name: string, who: Identity, meta: SiteMeta): Promise<{ created: boolean }> {
  requireDb();
  const category = meta.category && meta.category in CATEGORIES ? meta.category : "misc";
  // Read first rather than `RETURNING (xmax = 0)`: xmax is a Postgres system column
  // with no SQLite equivalent, and `created` only decides whether the change feed
  // reports a create or an update.
  const [existing] = await sql`SELECT 1 AS present FROM sites WHERE name = ${name}`;
  const created = !existing;
  await sql.unsafe(
    `INSERT INTO sites (name, description, creator, contributors, spa_fallback, category, policies, tags, thumbnail)
     VALUES ($1, $2, $3, ${jsonArg("$4")}, $5, $6, ${jsonArg("$8")}, ${jsonArg("$9")}, $10)
     ON CONFLICT (name) DO UPDATE SET
       description = COALESCE(NULLIF($2, ''), sites.description),
       spa_fallback = $5,
       category = CASE WHEN $7 = '' THEN sites.category ELSE $6 END,
       contributors = CASE
         WHEN ${jsonArrayHas("sites.contributors", "$3")} THEN sites.contributors
         ELSE ${jsonArrayAppend("sites.contributors", "$3", "$4")}
       END,
       policies = ${jsonArg("$8")},
       tags = ${jsonArg("$9")},
       thumbnail = $10,
       updated_at = ${NOW}`,
    [
      name, meta.description ?? "", who.handle, jsonParam([who.handle]),
      meta.spa_fallback ?? false, category, meta.category ?? "",
      jsonParam(meta.policies ?? NO_POLICIES),
      jsonParam(meta.tags ?? []), meta.thumbnail ?? "screenshot",
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
  // Tags match on the whole slug, so `?q=linear` finds a site tagged `linear` but not one
  // tagged `nonlinear-editor`; name and description keep their substring match.
  return (await sql.unsafe(
    `SELECT * FROM sites
     WHERE (${asText("$1")} IS NULL OR creator = $1)
       AND (${asText("$2")} IS NULL OR name ${ILIKE} $3 OR description ${ILIKE} $3
            OR ${jsonArrayHas("tags", "$5")})
     ORDER BY updated_at DESC
     LIMIT $4`,
    [q.creator ?? null, q.search ?? null, `%${q.search ?? ""}%`, q.limit, (q.search ?? "").toLowerCase()],
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
