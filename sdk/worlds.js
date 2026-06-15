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
        } else if (f.op === "actors_snapshot" && sub.onSnapshot) {
          sub.onSnapshot(f.actors || []);
        } else if (f.op === "actors" && sub.onActors) {
          sub.onActors(f.updates || []);
        } else if (f.op === "actor_event" && sub.onActorEvent) {
          sub.onActorEvent(f.from, f.payload);
        } else if (f.op === "actors_leave" && sub.onActorLeave) {
          sub.onActorLeave(f.ids || []);
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

  // sdk/src/room.ts
  function room(name, opts = {}) {
    const chan = ws.channel(opts.channel || name);
    const hasState = opts.initial !== undefined;
    const col = hasState ? collection(name) : null;
    const key = opts.key || `${name}-main`;
    const cid = globalThis.crypto && typeof globalThis.crypto.randomUUID === "function" ? globalThis.crypto.randomUUID() : `c${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const autoStart = opts.autoStart !== false;
    const minPlayers = Math.max(1, opts.minPlayers ?? 1);
    const maxPlayers = Math.max(0, opts.maxPlayers ?? 0);
    let me = opts.me ? { handle: opts.me.handle, name: opts.me.name || opts.me.handle } : null;
    let presence = [];
    let loaded = false;
    let started = false;
    let dead = false;
    const ready = {};
    let docId = null;
    let state = hasState ? null : null;
    let rev = 0;
    const listeners = new Set;
    if (opts.onChange)
      listeners.add(opts.onChange);
    function seed() {
      const init = typeof opts.initial === "function" ? opts.initial() : opts.initial ?? {};
      return { ...init };
    }
    function uniq(list) {
      const seen = new Set;
      const out = [];
      for (const m of list || []) {
        if (m && m.handle && !seen.has(m.handle)) {
          seen.add(m.handle);
          out.push({ handle: m.handle, name: m.name || m.handle });
        }
      }
      return out;
    }
    function roster() {
      return uniq([...me ? [me] : [], ...presence]);
    }
    function hostHandle() {
      const r = roster().map((p) => p.handle).sort();
      return r.length ? r[0] : null;
    }
    function isHost() {
      return !!me && hostHandle() === me.handle;
    }
    function readyCount() {
      return roster().filter((p) => ready[p.handle]).length;
    }
    function allReady() {
      const r = roster();
      return r.length >= minPlayers && r.every((p) => ready[p.handle]);
    }
    function snapshot() {
      const r = roster();
      const host = hostHandle();
      return {
        me,
        host: host ? r.find((p) => p.handle === host) ?? null : null,
        isHost: isHost(),
        ready: !!(me && ready[me.handle]),
        readyCount: readyCount(),
        total: r.length,
        allReady: allReady(),
        full: maxPlayers > 0 && r.length >= maxPlayers,
        started,
        loaded,
        state: hasState ? state : null,
        members: r.map((p) => ({
          handle: p.handle,
          name: p.name,
          ready: !!ready[p.handle],
          isMe: !!(me && p.handle === me.handle),
          isHost: p.handle === host
        }))
      };
    }
    function emit() {
      if (dead)
        return;
      const s = snapshot();
      for (const fn of listeners) {
        try {
          fn(s);
        } catch {}
      }
    }
    function pub(msg) {
      chan.publish({ _p: 1, cid, ...msg });
    }
    function maybeAutoStart() {
      if (autoStart && isHost() && !started && allReady())
        start();
    }
    function setReady(val) {
      if (!me)
        return;
      ready[me.handle] = !!val;
      pub({ t: "ready", handle: me.handle, name: me.name, ready: !!val });
      emit();
      maybeAutoStart();
    }
    function toggleReady() {
      setReady(!(me && ready[me.handle]));
    }
    function start() {
      if (!isHost() || started)
        return;
      if (roster().length < minPlayers)
        return;
      started = true;
      pub({ t: "start", handle: me.handle });
      emit();
      opts.onStart?.(snapshot());
    }
    function returnToLobby() {
      started = false;
      for (const k of Object.keys(ready))
        ready[k] = false;
      pub({ t: "return", handle: me?.handle });
      emit();
      opts.onReturn?.(snapshot());
    }
    function setStarted(val) {
      started = !!val;
    }
    function adopt(doc, own) {
      if (!doc || !doc.data)
        return;
      const incoming = doc.data;
      if (incoming._room !== key && doc.id !== docId)
        return;
      if (!own && state && (incoming._rev || 0) < rev)
        return;
      docId = doc.id;
      state = incoming;
      rev = incoming._rev || 0;
      emit();
    }
    async function loadState() {
      if (!col)
        return;
      const page = await col.list({ filter: { _room: key }, sort: "-created_at", limit: 1 });
      const found = page.items[0];
      if (found) {
        docId = found.id;
        state = found.data;
        rev = state._rev || 0;
      } else {
        const created = await col.create({ ...seed(), _room: key, _rev: 0 });
        docId = created.id;
        state = created.data;
        rev = 0;
      }
      col.subscribe((ev) => {
        if (!ev || !ev.doc)
          return;
        const d = ev.doc;
        if (d.id === docId || d.data && d.data._room === key) {
          if (ev.type === "delete") {
            state = { ...seed(), _room: key, _rev: rev };
            emit();
            return;
          }
          adopt(d, false);
        }
      });
    }
    async function write(next) {
      if (!col)
        return false;
      if (!docId) {
        try {
          await opened;
        } catch {}
      }
      if (!docId)
        return false;
      const payload = { ...next, _room: key, _rev: rev + 1 };
      try {
        const res = await col.replace(docId, payload);
        adopt(res, true);
        return true;
      } catch {
        return false;
      }
    }
    const unsubPresence = chan.presence((members) => {
      presence = uniq(members || []);
      const live = new Set(roster().map((p) => p.handle));
      for (const h of Object.keys(ready))
        if (!live.has(h))
          delete ready[h];
      loaded = true;
      emit();
      maybeAutoStart();
    });
    const unsubMsg = chan.subscribe((msg) => {
      const p = msg && msg.payload;
      if (!p || !p._p || p.cid === cid)
        return;
      if (p.t === "ready" && p.handle) {
        ready[p.handle] = !!p.ready;
        emit();
        maybeAutoStart();
      } else if (p.t === "start") {
        if (!started) {
          started = true;
          emit();
          opts.onStart?.(snapshot());
        }
      } else if (p.t === "return") {
        started = false;
        for (const k of Object.keys(ready))
          ready[k] = false;
        emit();
        opts.onReturn?.(snapshot());
      } else if (p.t === "hello" && p.handle) {
        if (me)
          pub({ t: "ready", handle: me.handle, name: me.name, ready: !!ready[me.handle] });
      }
    });
    function announce() {
      if (!me)
        return;
      if (!(me.handle in ready))
        ready[me.handle] = false;
      pub({ t: "hello", handle: me.handle, name: me.name });
      emit();
      maybeAutoStart();
    }
    const opened = (async () => {
      if (!me) {
        try {
          const m = await call("GET", "/api/v1/me");
          if (!dead)
            me = { handle: m.handle, name: m.name || m.handle };
        } catch {}
      }
      if (hasState) {
        try {
          await loadState();
        } catch {}
      }
      if (!dead)
        announce();
      return snapshot();
    })();
    return {
      ready: opened,
      setReady,
      toggleReady,
      start,
      returnToLobby,
      setStarted,
      set: (next) => write(next),
      merge: (patch) => write({ ...state || {}, ...patch }),
      reset: (overrides) => write({ ...seed(), ...overrides || {} }),
      refetch: async () => {
        try {
          if (col && docId)
            adopt(await col.get(docId), true);
        } catch {}
      },
      snapshot,
      onChange(fn) {
        listeners.add(fn);
        if (loaded || hasState && state) {
          try {
            fn(snapshot());
          } catch {}
        }
        return () => listeners.delete(fn);
      },
      get me() {
        return me;
      },
      get isHost() {
        return isHost();
      },
      get members() {
        return snapshot().members;
      },
      get state() {
        return hasState ? state : null;
      },
      leave() {
        this.destroy();
      },
      destroy() {
        dead = true;
        try {
          unsubPresence?.();
        } catch {}
        try {
          unsubMsg?.();
        } catch {}
      }
    };
  }

  // sdk/src/rooms.ts
  var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  function randInts(n) {
    const out = [];
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
      const buf = new Uint32Array(n);
      globalThis.crypto.getRandomValues(buf);
      for (let i = 0;i < n; i++)
        out.push(buf[i]);
    } else {
      for (let i = 0;i < n; i++)
        out.push(Math.floor(Math.random() * 4294967295));
    }
    return out;
  }
  function makeCode() {
    return randInts(4).map((r) => CODE_ALPHABET[r % CODE_ALPHABET.length]).join("");
  }
  function makeId() {
    return randInts(3).map((r) => r.toString(36)).join("").slice(0, 10);
  }
  function rooms(name, opts = {}) {
    const dir = collection(name);
    const hasState = opts.initial !== undefined;
    const ttlMs = Math.max(5000, opts.ttlMs ?? 45000);
    const docs = new Map;
    const listeners = new Set;
    let current = null;
    let currentDbId = null;
    let stopMirror = null;
    let heartbeat = null;
    let lastMirror = "";
    let dead = false;
    function toInfo(doc) {
      const d = doc.data || {};
      const max = Number(d.max || 0);
      const count = Number(d.count || (d.members ? d.members.length : 0));
      return {
        id: d.id,
        code: d.code,
        name: d.name || d.id,
        host: d.host || null,
        members: Array.isArray(d.members) ? d.members : [],
        count,
        max,
        status: d.status === "playing" ? "playing" : "open",
        full: max > 0 && count >= max,
        private: !!d.private,
        createdAt: doc.created_at,
        updatedAt: doc.updated_at
      };
    }
    function fresh(doc) {
      const t = Date.parse(doc.updated_at || doc.created_at || "");
      return !Number.isFinite(t) || Date.now() - t < ttlMs;
    }
    function computeList() {
      const out = [];
      for (const doc of docs.values()) {
        if (!doc.data || !doc.data._dir || doc.data.private)
          continue;
        if (!fresh(doc))
          continue;
        out.push(toInfo(doc));
      }
      out.sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
      return out;
    }
    function pushList() {
      if (dead)
        return;
      const list = computeList();
      for (const fn of listeners) {
        try {
          fn(list);
        } catch {}
      }
    }
    async function sweep() {
      for (const [dbId, doc] of [...docs.entries()]) {
        if (doc.data && doc.data._dir && !fresh(doc)) {
          docs.delete(dbId);
          try {
            await dir.delete(dbId);
          } catch {}
          try {
            await deleteStateDoc(doc.data.id);
          } catch {}
        }
      }
    }
    async function deleteStateDoc(instId) {
      if (!hasState)
        return;
      try {
        const page = await dir.list({ filter: { _room: `inst:${instId}` }, limit: 1 });
        if (page.items[0])
          await dir.delete(page.items[0].id);
      } catch {}
    }
    const unsubDir = dir.subscribe((ev) => {
      if (!ev || !ev.doc)
        return;
      if (ev.type === "delete") {
        if (docs.delete(ev.doc.id))
          pushList();
        return;
      }
      if (!ev.doc.data || !ev.doc.data._dir)
        return;
      docs.set(ev.doc.id, ev.doc);
      pushList();
    });
    if (opts.onList)
      listeners.add(opts.onList);
    (async () => {
      try {
        const page = await dir.list({ filter: { _dir: 1 }, sort: "-created_at", limit: 100 });
        for (const doc of page.items)
          docs.set(doc.id, doc);
        pushList();
      } catch {}
    })();
    const sweeper = setInterval(() => {
      sweep().then(pushList);
    }, Math.min(ttlMs, 20000));
    function detach() {
      if (stopMirror) {
        try {
          stopMirror();
        } catch {}
        stopMirror = null;
      }
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (current) {
        try {
          current.destroy();
        } catch {}
      }
      current = null;
      currentDbId = null;
      lastMirror = "";
    }
    function open(id, code, dbId, max) {
      detach();
      const r = room(name, {
        channel: `${name}:${id}`,
        key: `inst:${id}`,
        initial: hasState ? opts.initial : undefined,
        minPlayers: opts.minPlayers,
        maxPlayers: max || opts.maxPlayers,
        autoStart: opts.autoStart,
        onChange: opts.onChange,
        onStart: opts.onStart,
        onReturn: opts.onReturn
      });
      r.id = id;
      r.code = code;
      current = r;
      currentDbId = dbId;
      function mirror(s) {
        if (!s.isHost || currentDbId !== dbId)
          return;
        const patch = {
          host: s.host,
          members: s.members.map((m) => ({ handle: m.handle, name: m.name })),
          count: s.total,
          status: s.started ? "playing" : "open"
        };
        const sig = JSON.stringify(patch);
        if (sig === lastMirror)
          return;
        lastMirror = sig;
        dir.update(dbId, patch).catch(() => {});
      }
      stopMirror = r.onChange(mirror);
      heartbeat = setInterval(() => {
        const s = r.snapshot();
        if (s.isHost && currentDbId === dbId)
          dir.update(dbId, { count: s.total }).catch(() => {});
      }, 15000);
      return r;
    }
    async function findByInstanceId(id) {
      for (const doc of docs.values())
        if (doc.data && doc.data._dir && doc.data.id === id)
          return doc;
      try {
        const page = await dir.list({ filter: { _dir: 1, id }, limit: 1 });
        return page.items[0] || null;
      } catch {
        return null;
      }
    }
    return {
      list: () => computeList(),
      onList(fn) {
        listeners.add(fn);
        try {
          fn(computeList());
        } catch {}
        return () => listeners.delete(fn);
      },
      async create(o = {}) {
        const id = makeId();
        const used = new Set;
        for (const doc of docs.values())
          if (doc.data?.code)
            used.add(doc.data.code);
        let code = makeCode();
        for (let i = 0;i < 8 && used.has(code); i++)
          code = makeCode();
        const max = Math.max(0, o.max ?? opts.maxPlayers ?? 0);
        const data = {
          _dir: 1,
          id,
          code,
          name: o.name || `Room ${code}`,
          private: !!o.private,
          status: "open",
          host: null,
          members: [],
          count: 0,
          max
        };
        const created = await dir.create(data);
        docs.set(created.id, created);
        pushList();
        return open(id, code, created.id, max);
      },
      async join(id) {
        const doc = await findByInstanceId(id);
        if (!doc)
          throw new WorldsError("not_found", "no such room", 404);
        const info = toInfo(doc);
        if (info.full)
          throw new WorldsError("conflict", "room is full", 409);
        return open(info.id, info.code, doc.id, info.max);
      },
      async joinByCode(code) {
        const want = String(code || "").toUpperCase().trim();
        let doc = null;
        for (const d of docs.values())
          if (d.data && d.data._dir && d.data.code === want)
            doc = d;
        if (!doc) {
          try {
            const page = await dir.list({ filter: { _dir: 1, code: want }, limit: 1 });
            doc = page.items[0] || null;
          } catch {}
        }
        if (!doc)
          throw new WorldsError("not_found", "no room with that code", 404);
        const info = toInfo(doc);
        if (info.full)
          throw new WorldsError("conflict", "room is full", 409);
        return open(info.id, info.code, doc.id, info.max);
      },
      async leave() {
        const r = current;
        const dbId = currentDbId;
        if (!r || !dbId)
          return;
        const s = r.snapshot();
        const instId = r.id;
        detach();
        if (s.isHost && s.total <= 1) {
          try {
            await dir.delete(dbId);
          } catch {}
          docs.delete(dbId);
          await deleteStateDoc(instId);
          pushList();
        }
      },
      get current() {
        return current;
      },
      destroy() {
        dead = true;
        detach();
        try {
          unsubDir?.();
        } catch {}
        clearInterval(sweeper);
        listeners.clear();
      }
    };
  }

  // sdk/src/util.ts
  var _id = null;
  function id() {
    if (!_id) {
      _id = globalThis.crypto && typeof globalThis.crypto.randomUUID === "function" ? globalThis.crypto.randomUUID() : `c-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    }
    return _id;
  }
  function colorFor(seed) {
    let h = 0;
    const s = String(seed ?? "");
    for (let i = 0;i < s.length; i++)
      h = h * 31 + s.charCodeAt(i) >>> 0;
    return `hsl(${h % 360} 68% 56%)`;
  }
  function uniqByHandle(list) {
    const seen = new Set;
    const out = [];
    for (const m of list || []) {
      if (m && m.handle && !seen.has(m.handle)) {
        seen.add(m.handle);
        out.push({ handle: m.handle, name: m.name || m.handle });
      }
    }
    return out;
  }
  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }
  function countdown(endsAt, opts) {
    const interval = opts.interval ?? 250;
    let h = null;
    let ended = false;
    function stop() {
      if (h) {
        clearInterval(h);
        h = null;
      }
    }
    function tick() {
      const left = Math.max(0, endsAt - Date.now());
      opts.onTick(left);
      if (left <= 0 && !ended) {
        ended = true;
        stop();
        opts.onEnd?.();
      }
    }
    h = setInterval(tick, interval);
    tick();
    return { stop };
  }

  // sdk/src/actors.ts
  function actors(name, opts = {}) {
    const cid = id();
    const states = new Map;
    const changeFns = new Set;
    const eventFns = new Set;
    const leaveFns = new Set;
    let zone = opts.zone != null ? String(opts.zone) : "";
    let stopped = false;
    function emitChange(rec) {
      for (const fn of changeFns)
        try {
          fn(rec.id, rec.state, rec);
        } catch {}
    }
    function emitLeave(peer) {
      for (const fn of leaveFns)
        try {
          fn(peer);
        } catch {}
    }
    function emitEvent(from, payload) {
      for (const fn of eventFns)
        try {
          fn(from.id, payload, from);
        } catch {}
    }
    function ingest(list) {
      if (!Array.isArray(list))
        return;
      for (const a of list) {
        if (!a || typeof a.id !== "string" || a.id === cid)
          continue;
        let rec = states.get(a.id);
        if (!rec)
          rec = { id: a.id, handle: a.handle || a.id, name: a.handle || a.id, state: undefined, metadata: {} };
        if (a.handle)
          rec.handle = a.handle;
        if (a.name)
          rec.name = a.name;
        if (a.state !== undefined)
          rec.state = a.state;
        if (a.meta)
          rec.metadata = { ...rec.metadata, ...a.meta };
        states.set(a.id, rec);
        emitChange(rec);
      }
    }
    const stopSub = sock.subscribe({ op: "sub", kind: "actors", channel: name, zone, cid, rate: opts.rate, meta: opts.metadata }, () => {}, {
      onSnapshot: (list) => {
        const keep = new Set((list || []).map((a) => a && a.id).filter(Boolean));
        for (const peer of [...states.keys()])
          if (!keep.has(peer)) {
            states.delete(peer);
            emitLeave(peer);
          }
        ingest(list);
      },
      onActors: (list) => ingest(list),
      onActorEvent: (from, payload) => {
        if (from && from.id !== cid)
          emitEvent(from, payload);
      },
      onActorLeave: (ids) => {
        if (!Array.isArray(ids))
          return;
        for (const peer of ids)
          if (states.delete(peer))
            emitLeave(peer);
      }
    });
    return {
      set(state) {
        if (stopped)
          return;
        if (opts.zoneKey)
          zone = String(opts.zoneKey(state));
        sock.send({ op: "set", id: "set", channel: name, cid, state, zone });
      },
      setMetadata(patch) {
        if (stopped || !patch)
          return;
        sock.send({ op: "ameta", id: "ameta", channel: name, cid, meta: patch });
      },
      send(payload) {
        if (stopped)
          return;
        sock.send({ op: "aevent", id: "aevent", channel: name, cid, payload });
      },
      others: () => [...states.values()],
      onChange(fn) {
        changeFns.add(fn);
        return () => changeFns.delete(fn);
      },
      onEvent(fn) {
        eventFns.add(fn);
        return () => eventFns.delete(fn);
      },
      onLeave(fn) {
        leaveFns.add(fn);
        return () => leaveFns.delete(fn);
      },
      destroy() {
        stopped = true;
        try {
          stopSub();
        } catch {}
        states.clear();
        changeFns.clear();
        eventFns.clear();
        leaveFns.clear();
      }
    };
  }

  // sdk/src/toast.ts
  var el = null;
  var timer = null;
  function ensure() {
    if (el)
      return el;
    if (typeof document === "undefined" || !document.body)
      return null;
    const style = document.createElement("style");
    style.textContent = ".worlds-toast{position:fixed;left:50%;bottom:1.2rem;transform:translateX(-50%) translateY(8px);" + "background:#0c0c0f;border:1px solid #27272a;color:#e4e4e7;padding:.6rem 1rem;border-radius:10px;" + "font:500 .85rem/1.4 ui-sans-serif,system-ui,sans-serif;z-index:2147483647;box-shadow:0 10px 30px rgba(0,0,0,.5);" + "opacity:0;pointer-events:none;transition:opacity .2s ease,transform .2s ease;max-width:min(92vw,420px);text-align:center}" + ".worlds-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}";
    document.head.appendChild(style);
    el = document.createElement("div");
    el.className = "worlds-toast";
    document.body.appendChild(el);
    return el;
  }
  function toast(text, ms = 2400) {
    const t = ensure();
    if (!t)
      return;
    t.textContent = String(text ?? "");
    t.classList.add("show");
    if (timer)
      clearTimeout(timer);
    timer = setTimeout(() => t.classList.remove("show"), ms);
  }

  // sdk/src/leave.ts
  function leaveHref() {
    try {
      if (location.pathname.startsWith("/app/"))
        return "/";
      const parts = location.hostname.split(".");
      if (parts.length > 2)
        return `${location.protocol}//${parts.slice(1).join(".")}/`;
      return "/";
    } catch {
      return "/";
    }
  }
  function mountLeave(site) {
    try {
      if (typeof document === "undefined")
        return;
      if (globalThis.__worldsNoLeave)
        return;
      const name = site && site.name;
      if (name === "home" || name === "universe" || name === "worlds")
        return;
      if (!document.body) {
        document.addEventListener("DOMContentLoaded", () => mountLeave(site), { once: true });
        return;
      }
      if (document.getElementById("__worlds_leave"))
        return;
      const style = document.createElement("style");
      style.textContent = "#__worlds_leave{position:fixed;top:12px;left:12px;z-index:2147483646;display:flex;align-items:center;" + "gap:.45rem;padding:.42rem .8rem .42rem .55rem;border-radius:999px;background:rgba(12,12,15,.72);" + "-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border:1px solid #27272a;color:#e4e4e7;" + "font:600 13px/1 ui-sans-serif,system-ui,sans-serif;text-decoration:none;box-shadow:0 6px 20px rgba(0,0,0,.4);" + "opacity:.5;transition:opacity .15s ease,transform .15s ease}" + "#__worlds_leave:hover{opacity:1;transform:translateY(-1px);border-color:#f59e0b}" + "#__worlds_leave .wl-ring{width:15px;height:15px;border-radius:50%;border:2px solid #f59e0b;position:relative;flex:none}" + "#__worlds_leave .wl-ring::after{content:'';position:absolute;inset:3.5px;border-radius:50%;background:#fbbf24}" + "@media print{#__worlds_leave{display:none}}";
      document.head.appendChild(style);
      const a = document.createElement("a");
      a.id = "__worlds_leave";
      a.href = leaveHref();
      a.title = "Back to the Worlds universe";
      a.setAttribute("aria-label", "Back to Worlds");
      a.innerHTML = '<span class="wl-ring"></span><span>Worlds</span>';
      document.body.appendChild(a);
    } catch {}
  }

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
    notify,
    room,
    rooms,
    actors,
    id,
    colorFor,
    uniqByHandle,
    esc,
    countdown,
    toast
  };
  worlds.ready = call("GET", "/api/v1/site").then((s) => {
    worlds.site = s;
    return s;
  }).catch(() => worlds.site);
  worlds.ready.then((s) => mountLeave(s));
  try {
    const site = location.hostname.split(".")[0];
    if (navigator.sendBeacon && site && site !== "worlds") {
      navigator.sendBeacon("/api/v1/beacon/visit", new Blob([JSON.stringify({ site })], { type: "application/json" }));
    }
  } catch {}
  globalThis.worlds = worlds;
})();
