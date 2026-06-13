import { call } from "./http";
import { WorldError } from "./error";

interface CompleteOpts {
  prompt?: string;
  messages?: { role: string; content: string }[];
  system?: string;
  model?: "fast" | "smart";
  max_tokens?: number;
  stream?: boolean;
  onToken?: (chunk: string) => void;
}

// Models are stable aliases ("fast", "smart"); the server maps them to providers.
export const ai = {
  complete: (promptOrOpts: string | CompleteOpts) => {
    const opts = typeof promptOrOpts === "string" ? { prompt: promptOrOpts } : promptOrOpts;
    return opts.stream ? streamComplete(opts) : call("POST", "/api/v1/ai/complete", opts);
  },
  embed: (text: string) => call("POST", "/api/v1/ai/embed", { text }),
  image: (prompt: string, opts: Record<string, unknown> = {}) => call("POST", "/api/v1/ai/image", { prompt, ...opts }),
  models: () => call("GET", "/api/v1/ai/models"),
};

// SSE streaming: fires onToken per chunk and resolves with the full {text, model}.
async function streamComplete(opts: CompleteOpts): Promise<{ text: string; model: string }> {
  const { onToken, ...body } = opts;
  const res = await fetch("/api/v1/ai/complete", {
    method: "POST",
    headers: { "x-world-csrf": "1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    location.assign(`/auth/login?rd=${encodeURIComponent(location.href)}`);
    throw new WorldError("unauthorized", "session expired, redirecting", 401);
  }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    const err = (data && data.error) || {};
    throw new WorldError(err.code || "internal", err.message || res.statusText, res.status, err.retry_after);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let model = body.model || "fast";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, sep).split("\n").find((l) => l.startsWith("data:"));
      buf = buf.slice(sep + 2);
      if (!line) continue;
      try {
        const obj = JSON.parse(line.slice(5).trim());
        if (obj.delta) { text += obj.delta; onToken?.(obj.delta); }
        if (obj.model) model = obj.model;
      } catch { /* ignore keepalives */ }
    }
  }
  return { text, model };
}
