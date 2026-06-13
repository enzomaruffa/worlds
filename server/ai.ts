import { config } from "./config";
import { WorldsError, json } from "./errors";
import { identityFrom, requireCsrf } from "./identity";
import { takeQuota } from "./ratelimit";
import { store } from "./blobstore";

// Models are exposed as stable aliases only (frozen contract): providers
// retire model ids, aliases are forever and remap here.
// `noThink` disables thinking for snappy short replies; pro models require
// thinking, so they keep it on and get a generous output floor instead.
const CHAT_MODELS: Record<string, { id: string; noThink: boolean; minOut?: number }> = {
  fast: { id: "gemini-3.5-flash", noThink: true },
  smart: { id: "gemini-3.1-pro-preview", noThink: false, minOut: 2048 },
};
const EMBED_MODEL = "gemini-embedding-001";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

function requireKey(): string {
  if (!config.geminiKey) throw new WorldsError("upstream_error", "AI is not configured (no GEMINI_API_KEY)");
  return config.geminiKey;
}

async function gemini(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": requireKey() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error("gemini error", res.status, text.slice(0, 500));
    throw new WorldsError("upstream_error", `model provider returned ${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

interface CompleteBody {
  prompt?: string;
  messages?: { role: "user" | "assistant"; content: string }[];
  system?: string;
  model?: string;
  max_tokens?: number;
  stream?: boolean;
}

export async function complete(req: Request): Promise<Response> {
  requireCsrf(req);
  const who = identityFrom(req);
  takeQuota("ai", who.handle);
  const body = (await req.json().catch(() => ({}))) as CompleteBody;
  const alias = body.model ?? "fast";
  const cfg = CHAT_MODELS[alias];
  if (!cfg) throw new WorldsError("invalid_request", `unknown model alias "${alias}"`);

  const contents = body.messages
    ? body.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }))
    : [{ role: "user", parts: [{ text: String(body.prompt ?? "") }] }];

  let maxOut = Math.min(body.max_tokens ?? 2048, 8192);
  const generationConfig: Record<string, unknown> = {};
  // Flash disables thinking for snappy short replies; thinking models (pro) must
  // keep it on, so give them an output floor that leaves room for reasoning.
  if (cfg.noThink) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  else if (cfg.minOut) maxOut = Math.max(maxOut, cfg.minOut);
  generationConfig.maxOutputTokens = maxOut;

  const reqBody = {
    contents,
    systemInstruction: body.system ? { parts: [{ text: body.system }] } : undefined,
    generationConfig,
  };

  if (body.stream) return streamComplete(alias, cfg.id, reqBody);

  const out = await gemini(`models/${cfg.id}:generateContent`, reqBody);
  const candidates = out.candidates as { content?: { parts?: { text?: string }[] } }[] | undefined;
  const text = candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const usage = out.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
  return json({
    text,
    model: alias,
    usage: { input_tokens: usage?.promptTokenCount ?? 0, output_tokens: usage?.candidatesTokenCount ?? 0 },
  });
}

// SSE passthrough: re-emit Gemini's stream as `data: {"delta": "..."}` events, then
// a final `{"done": true, "model": alias}`. The SDK accumulates and resolves the full text.
async function streamComplete(alias: string, modelId: string, reqBody: unknown): Promise<Response> {
  const upstream = await fetch(`${BASE}/models/${modelId}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": requireKey() },
    body: JSON.stringify(reqBody),
  });
  if (!upstream.ok || !upstream.body) {
    console.error("gemini stream error", upstream.status, (await upstream.text().catch(() => "")).slice(0, 500));
    throw new WorldsError("upstream_error", `model provider returned ${upstream.status}`);
  }
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const reader = upstream.body.getReader();
  const stream = new ReadableStream({
    async start(controller) {
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const obj = JSON.parse(payload) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
              const delta = obj.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
              if (delta) controller.enqueue(enc.encode(`data: ${JSON.stringify({ delta })}\n\n`));
            } catch { /* skip partial/non-JSON keepalive lines */ }
          }
        }
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ done: true, model: alias })}\n\n`));
      } catch {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: "stream interrupted" })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-worlds-api-version": "1" },
  });
}

// Internal embed (no HTTP/quota) — used by the post-deploy universe layout worker.
export async function embedText(text: string): Promise<number[]> {
  const out = await gemini(`models/${EMBED_MODEL}:embedContent`, {
    content: { parts: [{ text }] },
    outputDimensionality: 768,
  });
  return (out.embedding as { values?: number[] })?.values ?? [];
}

export async function embed(req: Request): Promise<Response> {
  requireCsrf(req);
  const who = identityFrom(req);
  takeQuota("ai", who.handle);
  const { text } = (await req.json().catch(() => ({}))) as { text?: string };
  if (!text) throw new WorldsError("invalid_request", "expected {text}");
  const vector = await embedText(text);
  return json({ vector, dim: vector.length, model: "embed-1" });
}

export async function image(req: Request, site: string): Promise<Response> {
  requireCsrf(req);
  const who = identityFrom(req);
  takeQuota("ai_image", who.handle);
  const { prompt } = (await req.json().catch(() => ({}))) as { prompt?: string };
  if (!prompt) throw new WorldsError("invalid_request", "expected {prompt}");
  const out = await gemini(`models/gemini-3.1-flash-image:generateContent`, {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });
  const candidates = out.candidates as { content?: { parts?: { inlineData?: { data?: string } }[] } }[] | undefined;
  const b64 = candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
  if (!b64) throw new WorldsError("upstream_error", "model returned no image");
  const name = `ai_img_${crypto.randomUUID().slice(0, 8)}.png`;
  const blob = new Blob([Buffer.from(b64, "base64")], { type: "image/png" });
  await store.putUpload(site, name, blob);
  return json({ url: `/u/${site}/${encodeURIComponent(name)}`, name });
}

export function models(): Response {
  return json({
    items: [
      { alias: "fast", kind: "chat" },
      { alias: "smart", kind: "chat" },
      { alias: "embed-1", kind: "embedding" },
    ],
    next_cursor: null,
  });
}
