import { call } from "./http";
import { sock } from "./socket";
import { WorldError } from "./error";

export interface ListOpts {
  filter?: Record<string, unknown>;
  sort?: string;
  limit?: number;
  cursor?: string;
}

// otherSite (via world.db.site("x")) gives cross-world READ access; writes are
// rejected and always stay with the calling site.
export function collection(name: string, otherSite?: string) {
  const base = `/api/v1/db/${encodeURIComponent(name)}`;
  const siteQ = otherSite ? `site=${encodeURIComponent(otherSite)}` : "";
  const withSite = (path: string) => (siteQ ? `${path}${path.includes("?") ? "&" : "?"}${siteQ}` : path);
  const readOnly = () => Promise.reject(new WorldError("invalid_request", "cross-world access is read-only", 400));

  return {
    create: (data: unknown) => (otherSite ? readOnly() : call("POST", base, data)),
    get: (id: string) => call("GET", withSite(`${base}/${encodeURIComponent(id)}`)),
    update: (id: string, patch: unknown, opts: { if_updated_at?: string } = {}) =>
      otherSite ? readOnly() : call("PATCH", `${base}/${encodeURIComponent(id)}`, patch,
        opts.if_updated_at ? { headers: { "if-unmodified-since-version": opts.if_updated_at } } : {}),
    replace: (id: string, data: unknown) => (otherSite ? readOnly() : call("PUT", `${base}/${encodeURIComponent(id)}`, data)),
    delete: (id: string) => (otherSite ? readOnly() : call("DELETE", `${base}/${encodeURIComponent(id)}`)),
    increment: (id: string, field: string, by = 1) =>
      otherSite ? readOnly() : call("POST", `${base}/${encodeURIComponent(id)}/increment`, { field, by }),
    list: (opts: ListOpts = {}) => {
      const q = new URLSearchParams();
      if (opts.filter) q.set("filter", JSON.stringify(opts.filter));
      if (opts.sort) q.set("sort", opts.sort);
      if (opts.limit) q.set("limit", String(opts.limit));
      if (opts.cursor) q.set("cursor", opts.cursor);
      const qs = q.toString();
      return call("GET", withSite(qs ? `${base}?${qs}` : base));
    },
    subscribe: (handler: (ev: { type: string; doc: any }) => void) =>
      sock.subscribe({ op: "sub", kind: "db", collection: name, ...(otherSite ? { site: otherSite } : {}) }, handler, {
        onExpired: async () => {
          // Gap too old to replay: hand the full current state back through the
          // handler, paging through every doc (not just the first page).
          let cursor: string | undefined;
          do {
            const url = cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base;
            const page = await call("GET", withSite(url));
            for (const doc of page.items) handler({ type: "update", doc });
            cursor = page.next_cursor ?? undefined;
          } while (cursor);
        },
      }),
  };
}
