import { sql, requireDb } from "./db";
import { json, WorldsError } from "./errors";
import { listSites, publicSite, type SiteRow } from "./sites";
import { resolveHandle, resolveProfile, overlayCreators } from "./profile";

// Layout: embedding-derived [x,y,z] when the post-deploy worker has set it (so
// similar sites cluster), else a deterministic name-hash placeholder on a disc.
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const BIOMES = ["lush", "desert", "ice", "volcanic", "archipelago"] as const;

export function universeEntry(s: SiteRow) {
  const h = hash(s.name);
  const angle = (h % 6283) / 1000;
  const radius = 0.25 + ((h >> 8) % 700) / 1000;
  const pos =
    s.embed_pos && s.embed_pos.length === 3
      ? s.embed_pos
      : [Math.cos(angle) * radius, (((h >> 16) % 200) - 100) / 500, Math.sin(angle) * radius];
  return {
    ...publicSite(s),
    universe: {
      seed: h,
      pos,
      biome: BIOMES[h % BIOMES.length],
      palette: null as string[] | null,
    },
  };
}

export async function universe(): Promise<Response> {
  requireDb();
  const sites = await listSites({ limit: 100 });
  const items = sites.map(universeEntry);
  await overlayCreators(items);
  return json({ items, next_cursor: null }, { headers: { "cache-control": "max-age=30" } });
}

export async function creator(handle: string): Promise<Response> {
  requireDb();
  const res = await resolveHandle(handle);
  if (!res) throw new WorldsError("not_found", `no creator "${handle}"`);
  const sites = (await sql`
    SELECT * FROM sites
    WHERE creator = ${res.canonical} OR contributors ? ${res.canonical}
    ORDER BY updated_at DESC`) as SiteRow[];
  const [d] = await sql`
    SELECT count(*)::int AS n FROM deploys
    WHERE by_handle = ${res.canonical} AND at > now() - interval '90 days'`;
  const prof = await resolveProfile(res.canonical, res.canonical);
  const items = sites.map(publicSite);
  await overlayCreators(items);
  return json({
    handle: res.handle,
    redirect_to: res.redirect_to,
    name: prof.name,
    avatar_url: prof.avatar_url,
    sites: items,
    deploys_90d: Number(d?.n ?? 0),
  });
}
