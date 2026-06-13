/* worlds.js v1 — GENERATED from sdk/src/ by 'bun run build:sdk'. Do not edit by hand. */
(() => {

  // sdk/src/error.ts
  class WorldsError extends Error {
    code;
    status;
    retry_after;
    constructor(code, message, status = 0, retryAfter) {
      super(message);
      this.name = "WorldsError";
      this.code = code;
      this.status = status;
      this.retry_after = retryAfter;
    }
  }

  // sdk/src/http.ts
  function siteHeaders() {
    if (typeof location === "undefined")
      return {};
    const m = location.pathname.match(/^\/app\/([^/]+)/);
    return m ? { "x-worlds-site": m[1] } : {};
  }
  var HEADERS = { "x-worlds-csrf": "1", ...siteHeaders() };
  async function call(method, path, body, opts = {}) {
    const init = { method, headers: { ...HEADERS, ...opts.headers ?? {} } };
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      throw new WorldsError("internal", `network error: ${e.message}`, 0);
    }
    if (res.status === 401) {
      location.assign(`/auth/login?rd=${encodeURIComponent(location.href)}`);
      throw new WorldsError("unauthorized", "session expired, redirecting", 401);
    }
    if (res.status === 204)
      return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data && data.error || {};
      throw new WorldsError(err.code || "internal", err.message || res.statusText, res.status, err.retry_after);
    }
    return data;
  }

  // sdk/src/socket.ts
  var sock = {
    ws: null,
    backoff: 1000,
    nextId: 1,
    subs: new Map,
    outbox: [],
    open() {
      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1))
        return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const m = location.pathname.match(/^\/app\/([^/]+)/);
      const q = m ? `?site=${encodeURIComponent(m[1])}` : "";
      this.ws = new WebSocket(`${proto}//${location.host}/api/v1/socket${q}`, "worlds.v1");
      this.ws.onopen = () => {
        this.backoff = 1000;
        for (const [id, sub] of this.subs) {
          const frame = { ...sub.frame, id };
          if (sub.cursor)
            frame.since = sub.cursor;
          this.ws.send(JSON.stringify(frame));
        }
        for (const f of this.outbox)
          this.ws.send(f);
        this.outbox = [];
      };
      this.ws.onmessage = (m2) => {
        let f;
        try {
          f = JSON.parse(m2.data);
        } catch {
          return;
        }
        const sub = f.id && this.subs.get(f.id);
        if (!sub)
          return;
        if (f.op === "event") {
          sub.cursor = f.cursor || sub.cursor;
          sub.handler({ type: f.type, doc: f.doc });
        } else if (f.op === "msg") {
          sub.handler({ payload: f.payload, from: f.from, at: f.at });
        } else if (f.op === "presence" && sub.onPresence) {
          sub.onPresence(f.members);
        } else if (f.op === "error" && f.error?.code === "replay_expired" && sub.onExpired) {
          sub.cursor = null;
          sub.onExpired();
        }
      };
      this.ws.onclose = () => {
        if (this.subs.size === 0)
          return;
        setTimeout(() => this.open(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 30000);
      };
    },
    send(frame) {
      this.open();
      const s = JSON.stringify(frame);
      if (this.ws && this.ws.readyState === 1)
        this.ws.send(s);
      else
        this.outbox.push(s);
    },
    subscribe(frame, handler, extras = {}) {
      const id = `s${this.nextId++}`;
      this.subs.set(id, { frame, handler, cursor: null, ...extras });
      this.send({ ...frame, id });
      return () => {
        this.subs.delete(id);
        if (this.ws && this.ws.readyState === 1)
          this.ws.send(JSON.stringify({ op: "unsub", id }));
      };
    }
  };

  // sdk/src/db.ts
  function collection(name, otherSite) {
    const base = `/api/v1/db/${encodeURIComponent(name)}`;
    const siteQ = otherSite ? `site=${encodeURIComponent(otherSite)}` : "";
    const withSite = (path) => siteQ ? `${path}${path.includes("?") ? "&" : "?"}${siteQ}` : path;
    const readOnly = () => Promise.reject(new WorldsError("invalid_request", "cross-world access is read-only", 400));
    return {
      create: (data) => otherSite ? readOnly() : call("POST", base, data),
      get: (id) => call("GET", withSite(`${base}/${encodeURIComponent(id)}`)),
      update: (id, patch, opts = {}) => otherSite ? readOnly() : call("PATCH", `${base}/${encodeURIComponent(id)}`, patch, opts.if_updated_at ? { headers: { "if-unmodified-since-version": opts.if_updated_at } } : {}),
      replace: (id, data) => otherSite ? readOnly() : call("PUT", `${base}/${encodeURIComponent(id)}`, data),
      delete: (id) => otherSite ? readOnly() : call("DELETE", `${base}/${encodeURIComponent(id)}`),
      increment: (id, field, by = 1) => otherSite ? readOnly() : call("POST", `${base}/${encodeURIComponent(id)}/increment`, { field, by }),
      list: (opts = {}) => {
        const q = new URLSearchParams;
        if (opts.filter)
          q.set("filter", JSON.stringify(opts.filter));
        if (opts.sort)
          q.set("sort", opts.sort);
        if (opts.limit)
          q.set("limit", String(opts.limit));
        if (opts.cursor)
          q.set("cursor", opts.cursor);
        const qs = q.toString();
        return call("GET", withSite(qs ? `${base}?${qs}` : base));
      },
      subscribe: (handler) => sock.subscribe({ op: "sub", kind: "db", collection: name, ...otherSite ? { site: otherSite } : {} }, handler, {
        onExpired: async () => {
          let cursor;
          do {
            const url = cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base;
            const page = await call("GET", withSite(url));
            for (const doc of page.items)
              handler({ type: "update", doc });
            cursor = page.next_cursor ?? undefined;
          } while (cursor);
        }
      })
    };
  }

  // sdk/src/ai.ts
  var ai = {
    complete: (promptOrOpts) => {
      const opts = typeof promptOrOpts === "string" ? { prompt: promptOrOpts } : promptOrOpts;
      return opts.stream ? streamComplete(opts) : call("POST", "/api/v1/ai/complete", opts);
    },
    embed: (text) => call("POST", "/api/v1/ai/embed", { text }),
    image: (prompt, opts = {}) => call("POST", "/api/v1/ai/image", { prompt, ...opts }),
    models: () => call("GET", "/api/v1/ai/models")
  };
  async function streamComplete(opts) {
    const { onToken, ...body } = opts;
    const res = await fetch("/api/v1/ai/complete", {
      method: "POST",
      headers: { ...HEADERS, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (res.status === 401) {
      location.assign(`/auth/login?rd=${encodeURIComponent(location.href)}`);
      throw new WorldsError("unauthorized", "session expired, redirecting", 401);
    }
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      const err = data && data.error || {};
      throw new WorldsError(err.code || "internal", err.message || res.statusText, res.status, err.retry_after);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder;
    let buf = "";
    let text = "";
    let model = body.model || "fast";
    for (;; ) {
      const { done, value } = await reader.read();
      if (done)
        break;
      buf += dec.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf(`

`)) >= 0) {
        const line = buf.slice(0, sep).split(`
`).find((l) => l.startsWith("data:"));
        buf = buf.slice(sep + 2);
        if (!line)
          continue;
        try {
          const obj = JSON.parse(line.slice(5).trim());
          if (obj.delta) {
            text += obj.delta;
            onToken?.(obj.delta);
          }
          if (obj.model)
            model = obj.model;
        } catch {}
      }
    }
    return { text, model };
  }

  // sdk/src/uploads.ts
  var uploads = {
    put: (file, opts = {}) => {
      const form = new FormData;
      form.set("file", file);
      if (opts.name)
        form.set("name", opts.name);
      return call("POST", "/api/v1/uploads", form);
    },
    list: () => call("GET", "/api/v1/uploads"),
    delete: (name) => call("DELETE", `/api/v1/uploads/${encodeURIComponent(name)}`)
  };

  // sdk/src/channels.ts
  var ws = {
    channel(name) {
      return {
        publish: (payload) => sock.send({ op: "pub", id: `p${sock.nextId++}`, channel: name, payload }),
        subscribe: (handler) => sock.subscribe({ op: "sub", kind: "channel", channel: name }, handler),
        presence: (handler) => sock.subscribe({ op: "sub", kind: "channel", channel: name, presence: true }, () => {}, { onPresence: handler })
      };
    }
  };

  // sdk/src/notify.ts
  var notify = {
    slack: (target, text) => call("POST", "/api/v1/notify/slack", { target, text })
  };

  // sdk/src/index.ts
  var worlds = {
    WorldsError,
    site: { name: null, url: null },
    me: () => call("GET", "/api/v1/me"),
    db: {
      collection,
      site: (name) => ({ collection: (c) => collection(c, name) })
    },
    ai,
    uploads,
    ws,
    notify
  };
  worlds.ready = call("GET", "/api/v1/site").then((s) => {
    worlds.site = s;
    return s;
  }).catch(() => worlds.site);
  try {
    const site = location.hostname.split(".")[0];
    if (navigator.sendBeacon && site && site !== "worlds") {
      navigator.sendBeacon("/api/v1/beacon/visit", new Blob([JSON.stringify({ site })], { type: "application/json" }));
    }
  } catch {}
  globalThis.worlds = worlds;
})();
