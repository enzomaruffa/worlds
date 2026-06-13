import { LIMITS } from "./config";
import { WorldsError, json } from "./errors";
import { store } from "./blobstore";
import { identityFrom, requireCsrf } from "./identity";

const UPLOAD_NAME = /^[\w][\w. -]{0,127}$/;

export async function putUpload(req: Request, site: string): Promise<Response> {
  requireCsrf(req);
  identityFrom(req);
  const form = await req.formData().catch(() => {
    throw new WorldsError("invalid_request", "expected multipart form data");
  });
  const file = form.get("file");
  if (!(file instanceof Blob)) throw new WorldsError("invalid_request", "missing file");
  if (file.size > LIMITS.uploadBytes) {
    throw new WorldsError("payload_too_large", `file exceeds ${LIMITS.uploadBytes / 1024 / 1024}MB`);
  }
  const name = String(form.get("name") ?? (file instanceof File ? file.name : "")) || "upload.bin";
  if (!UPLOAD_NAME.test(name) || name.includes("..")) {
    throw new WorldsError("invalid_request", "bad upload name");
  }
  const used = await store.uploadsBytes(site);
  if (used + file.size > LIMITS.uploadsPerSiteBytes) {
    throw new WorldsError("quota_exceeded", "site upload quota (1GB) reached");
  }
  const { size } = await store.putUpload(site, name, file);
  return json({
    url: `/u/${site}/${encodeURIComponent(name)}`,
    name,
    size,
    content_type: file.type || "application/octet-stream",
  });
}

export async function listUploads(site: string): Promise<Response> {
  const items = (await store.listUploads(site)).map((f) => ({
    ...f,
    url: `/u/${site}/${encodeURIComponent(f.name)}`,
  }));
  return json({ items, next_cursor: null });
}

export async function deleteUpload(req: Request, site: string, name: string): Promise<Response> {
  requireCsrf(req);
  identityFrom(req);
  const deleted = await store.deleteUpload(site, decodeURIComponent(name));
  return json({ deleted, name });
}

export async function serveUpload(site: string, name: string): Promise<Response> {
  const file = store.openUpload(site, decodeURIComponent(name));
  if (!file || !(await file.exists())) throw new WorldsError("not_found", "no such upload");
  return new Response(file, {
    headers: { "cache-control": "max-age=60, stale-while-revalidate=600" },
  });
}
