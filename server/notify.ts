import { config } from "./config";
import { WorldError, json } from "./errors";
import { identityFrom, requireCsrf } from "./identity";
import { takeQuota } from "./ratelimit";
import { siteUrl } from "./sites";

export async function notifySlack(req: Request, site: string): Promise<Response> {
  requireCsrf(req);
  const who = identityFrom(req);
  takeQuota("slack", who.handle);
  const { target, text } = (await req.json().catch(() => ({}))) as { target?: string; text?: string };
  if (!target || !text) throw new WorldError("invalid_request", "expected {target, text}");
  if (text.length > 4000) throw new WorldError("payload_too_large", "message over 4000 chars");

  // Every message is stamped — sites can notify, never impersonate.
  const stamped = `${text}\n_via ${siteUrl(site)} · sent by ${who.name}_`;

  if (!config.slackToken) {
    if (config.dev) {
      console.log(`[notify.slack dev] to=${target}: ${stamped}`);
      return json({ ok: true, dev: true });
    }
    throw new WorldError("upstream_error", "Slack is not configured");
  }

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.slackToken}` },
    body: JSON.stringify({ channel: target, text: stamped }),
  });
  const out = (await res.json()) as { ok: boolean; error?: string };
  if (!out.ok) throw new WorldError("upstream_error", `slack: ${out.error ?? "unknown error"}`);
  return json({ ok: true });
}
