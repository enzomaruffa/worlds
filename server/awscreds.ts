// Bun's S3 client takes static keys and nothing else — it implements no credential
// provider chain, so a pod holding container-delivered credentials (EKS Pod Identity,
// an ECS task role) reads to it as having no credentials at all. Resolve them here and
// hand them over explicitly.

export interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

// The relative-URI form is resolved against this fixed link-local address; the
// full-URI form (what Pod Identity injects) carries its own host.
const ECS_CREDENTIALS_HOST = "http://169.254.170.2";

// Renew this far ahead of the stated expiry. A site swap uploads one file per request
// and a database snapshot streams the whole file, so credentials fetched at the wire
// would expire mid-operation.
const RENEW_BEFORE_MS = 5 * 60_000;

const TIMEOUT_MS = 5_000;

let cached: { creds: AwsCreds; renewAt: number } | null = null;
let inFlight: Promise<AwsCreds | null> | null = null;

// Tests drive this through several environments in one process.
export function resetAwsCreds(): void {
  cached = null;
  inFlight = null;
}

function staticCreds(): AwsCreds | null {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  return { accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SESSION_TOKEN };
}

export function credentialsUrl(): string | null {
  const full = process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  if (full) return full;
  const relative = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  return relative ? ECS_CREDENTIALS_HOST + relative : null;
}

// Read the token on every fetch, never once at boot: the agent rotates the file, and a
// token cached alongside the credentials would go stale at its own pace.
async function authorization(): Promise<string | null> {
  const file = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE;
  if (file) return (await Bun.file(file).text()).trim();
  return process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN ?? null;
}

// An error body is an envelope like {"message":"..."} from the agent's own upstream. Only
// that field is surfaced, with the token stripped back out of it: an arbitrary body could
// echo the Authorization header straight back, and a status on its own leaves nothing to
// debug a rejected association with.
async function reason(res: Response, token: string | null): Promise<string> {
  try {
    const message = (JSON.parse((await res.text()).slice(0, 2_000)) as Record<string, unknown>).message;
    if (typeof message !== "string" || !message) return "";
    const safe = token ? message.replaceAll(token, "<token>") : message;
    return ` — ${safe.slice(0, 300)}`;
  } catch {
    return "";
  }
}

async function fetchContainerCreds(url: string): Promise<AwsCreds | null> {
  const token = await authorization();
  const res = await fetch(url, {
    headers: token ? { authorization: token } : {},
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`credential endpoint returned ${res.status}${await reason(res, token)}`);
  const body = (await res.json()) as Record<string, unknown>;
  const accessKeyId = typeof body.AccessKeyId === "string" ? body.AccessKeyId : "";
  const secretAccessKey = typeof body.SecretAccessKey === "string" ? body.SecretAccessKey : "";
  if (!accessKeyId || !secretAccessKey) throw new Error("credential endpoint returned no key pair");

  const expiration = typeof body.Expiration === "string" ? Date.parse(body.Expiration) : NaN;
  // A credential already inside the renew window lands a renewAt in the past, so the next
  // call fetches again — which is what should happen, since the provider answers a second
  // request with a fresh pair. An absent expiry is the only case that needs a guess.
  const renewAt = Number.isFinite(expiration) ? expiration - RENEW_BEFORE_MS : Date.now() + RENEW_BEFORE_MS;

  cached = {
    creds: { accessKeyId, secretAccessKey, sessionToken: typeof body.Token === "string" ? body.Token : undefined },
    renewAt,
  };
  return cached.creds;
}

// Credentials for the S3 client, or null when this process has none to offer — in which
// case the caller constructs a client without them and Bun fails the same way it always
// did. Concurrent callers share one fetch.
export function awsCreds(): Promise<AwsCreds | null> {
  const statik = staticCreds();
  if (statik) return Promise.resolve(statik);

  if (cached && Date.now() < cached.renewAt) return Promise.resolve(cached.creds);

  const url = credentialsUrl();
  if (!url) return Promise.resolve(null);

  return (inFlight ??= fetchContainerCreds(url)
    .catch((e) => {
      console.warn(`aws: could not resolve container credentials (${(e as Error).message})`);
      // Serve the expired pair rather than nothing: it may still be inside the
      // provider's own grace window, and the alternative is a guaranteed failure.
      return cached?.creds ?? null;
    })
    .finally(() => {
      inFlight = null;
    }));
}
