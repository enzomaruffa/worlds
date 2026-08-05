import { call } from "./http";
import { sock } from "./socket";
import { WorldsError } from "./error";

export interface ListOpts {
  filter?: Record<string, unknown>;
  sort?: string;
  limit?: number;
  cursor?: string;
}

export interface UpdateOpts {
  ifUpdatedAt?: string; // the doc's `updated_at` you read — rejects with `conflict` if it moved
  /** @deprecated snake_case spelling of ifUpdatedAt, kept for v1 callers. */
  if_updated_at?: string;
}

export interface Doc<T = any> {
  id: string;
  data: T;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Page<T = any> {
  items: Doc<T>[];
  next_cursor: string | null;
}

export interface ChangeEvent<T = any> {
  type: "create" | "update" | "delete";
  doc: Doc<T>;
}

export interface Collection<T = any> {
  create(data: T): Promise<Doc<T>>;
  get(id: string): Promise<Doc<T>>;
  update(id: string, patch: Partial<T>, opts?: UpdateOpts): Promise<Doc<T>>;
  replace(id: string, data: T): Promise<Doc<T>>;
  delete(id: string): Promise<{ deleted: boolean; id: string }>;
  increment(id: string, field: string, by?: number): Promise<Doc<T>>;
  list(opts?: ListOpts): Promise<Page<T>>;
  subscribe(handler: (ev: ChangeEvent<T>) => void): () => void;
}

// Collections a site has written to. Reads only, so it accepts a cross-world site.
export function collections(
  otherSite?: string,
): Promise<{ items: { name: string; docs: number }[]; next_cursor: string | null }> {
  const q = otherSite ? `?site=${encodeURIComponent(otherSite)}` : "";
  return call("GET", `/api/v1/db${q}`);
}

// otherSite (via worlds.db.site("x")) gives cross-world READ access; writes are
// rejected and always stay with the calling site.
export function collection<T = any>(name: string, otherSite?: string): Collection<T> {
  const base = `/api/v1/db/${encodeURIComponent(name)}`;
  const siteQ = otherSite ? `site=${encodeURIComponent(otherSite)}` : "";
  const withSite = (path: string) => (siteQ ? `${path}${path.includes("?") ? "&" : "?"}${siteQ}` : path);
  const readOnly = () => Promise.reject(new WorldsError("invalid_request", "cross-world access is read-only", 400));

  return {
    create: (data: unknown) => (otherSite ? readOnly() : call("POST", base, data)),
    get: (id: string) => call("GET", withSite(`${base}/${encodeURIComponent(id)}`)),
    update: (id: string, patch: unknown, opts: UpdateOpts = {}) => {
      if (otherSite) return readOnly();
      const version = opts.ifUpdatedAt ?? opts.if_updated_at;
      return call("PATCH", `${base}/${encodeURIComponent(id)}`, patch,
        version ? { headers: { "if-unmodified-since-version": version } } : {});
    },
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
    subscribe: (handler: (ev: ChangeEvent<T>) => void) =>
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
