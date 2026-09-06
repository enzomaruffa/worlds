import { RESERVED_SITES } from "./config";
import { WorldsError, json } from "./errors";
import { store } from "./blobstore";
import { identityFrom, requireCsrf, type Identity } from "./identity";
import { sql, requireDb, emitChange } from "./db";
import { getSite } from "./sites";
import { deleteDoc, listDocs } from "./docs";

export async function deleteSite(name: string, who: Identity): Promise<{ deleted: true; site: string }> {
  requireDb();
  if (RESERVED_SITES.has(name)) throw new WorldsError("reserved_name", `"${name}" is reserved`);
  const existing = await getSite(name);
  if (!existing) throw new WorldsError("not_found", `no site named "${name}"`);
  if (existing.creator !== who.handle) {
    throw new WorldsError("forbidden", `"${name}" is owned by @${existing.creator} — only the owner can delete it`);
  }

  // Live rooms first, so a subscriber is told the document is gone instead of keeping a copy.
  for (const d of await listDocs(name)) await deleteDoc(name, d.name);
  await store.removeSite(name);
  await sql`DELETE FROM doc_updates WHERE site = ${name}`;
  await sql`DELETE FROM docs WHERE site = ${name}`;
  await sql`DELETE FROM events WHERE site = ${name}`;
  await sql`DELETE FROM documents WHERE site = ${name}`;
  await sql`DELETE FROM deploys WHERE site = ${name}`;
  await sql`DELETE FROM sites WHERE name = ${name}`;
  // The registry entry the universe map (and anything on worlds.db.site("home")) follows.
  const registryId = `site_${name}`;
  await sql`DELETE FROM documents WHERE site = 'home' AND collection = 'sites' AND id = ${registryId}`;
  await emitChange("home", "sites", "delete", { id: registryId, name });
  return { deleted: true, site: name };
}

export async function handleDeleteSite(req: Request, name: string): Promise<Response> {
  requireCsrf(req);
  return json(await deleteSite(name, identityFrom(req)));
}
