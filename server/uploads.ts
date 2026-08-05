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
  const deleted = await store.deleteUpload(site, decodeName(name));
  return json({ deleted, name });
}

export async function serveUpload(site: string, name: string): Promise<Response> {
  const decoded = decodeName(name);
  const st = await store.readUpload(site, decoded);
  if (!st) throw new WorldsError("not_found", "no such upload");
  return new Response(st.body, {
    headers: {
      "cache-control": "max-age=60, stale-while-revalidate=600",
      // /u/ answers on every host, the apex (which serves the deploy + profile UI)
      // included, so markup here would run as same-origin script on the platform
      // itself. Uploads are user data — served as bytes, never as an active document.
      "content-type": contentType(decoded),
      "content-disposition": ACTIVE.test(decoded) ? "attachment" : "inline",
      "x-content-type-options": "nosniff",
    },
  });
}

// Types a browser will execute or treat as same-origin markup.
const ACTIVE = /\.(html?|xhtml|svg|xml|js|mjs|css)$/i;

const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", ico: "image/x-icon",
  mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4",
  mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf",
  json: "application/json", txt: "text/plain; charset=utf-8", csv: "text/csv",
  glb: "model/gltf-binary", gltf: "model/gltf+json",
};

function contentType(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return TYPES[ext] ?? "application/octet-stream";
}

// Reads and deletes validate the name the same way writes do. Upload names are flat
// by construction, so anything with a path separator in it is an attempt to address a
// different site's bucket — the store would refuse, but as a silent "nothing deleted".
function decodeName(name: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    throw new WorldsError("invalid_request", "bad upload name");
  }
  if (!UPLOAD_NAME.test(decoded)) throw new WorldsError("invalid_request", "bad upload name");
  return decoded;
}
