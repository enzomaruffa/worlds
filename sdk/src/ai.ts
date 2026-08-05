import { call, HEADERS } from "./http";
import { WorldsError } from "./error";

export interface CompleteOpts {
  prompt?: string;
  messages?: { role: string; content: string }[];
  system?: string;
  model?: "fast" | "smart";
  max_tokens?: number;
  stream?: boolean;
  onToken?: (chunk: string) => void;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface Completion {
  text: string;
  model: string;
  usage: Usage;
}

export interface ImageOpts {
  size?: string;
  name?: string; // upload name for the generated file
}

// Models are stable aliases ("fast", "smart"); the server maps them to providers.
export const ai = {
  complete: (promptOrOpts: string | CompleteOpts): Promise<Completion> => {
    const opts = typeof promptOrOpts === "string" ? { prompt: promptOrOpts } : promptOrOpts;
    return opts.stream ? streamComplete(opts) : call("POST", "/api/v1/ai/complete", opts);
  },
  embed: (text: string) => call("POST", "/api/v1/ai/embed", { text }),
  image: (prompt: string, opts: ImageOpts = {}) => call("POST", "/api/v1/ai/image", { prompt, ...opts }),
  models: () => call("GET", "/api/v1/ai/models"),
};

// SSE streaming: fires onToken per chunk, then resolves with the same shape the
// non-streaming call returns, so `stream: true` never changes what a caller reads.
async function streamComplete(opts: CompleteOpts): Promise<Completion> {
  const { onToken, ...body } = opts;
  const res = await fetch("/api/v1/ai/complete", {
    method: "POST",
    headers: { ...HEADERS, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    location.assign(`/auth/login?rd=${encodeURIComponent(location.href)}`);
    throw new WorldsError("unauthorized", "session expired, redirecting", 401);
  }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    const err = (data && data.error) || {};
    throw new WorldsError(err.code || "internal", err.message || res.statusText, res.status, err.retry_after);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let model: string = body.model || "fast";
  let usage: Usage = { input_tokens: 0, output_tokens: 0 };
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
        if (obj.usage) usage = obj.usage;
      } catch { /* ignore keepalives */ }
    }
  }
  return { text, model, usage };
}
