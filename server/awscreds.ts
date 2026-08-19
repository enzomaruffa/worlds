// EKS Pod Identity credentials for Bun's S3Client.
//
// Bun's S3Client takes static keys only — it has no credential provider chain — while the
// cluster hands the pod a short-lived token to exchange at a link-local endpoint. Without
// this bridge every S3 call fails with "Missing S3 credentials" no matter how the IAM is
// set up. Returns null when the endpoint isn't present, which leaves Bun's own AWS_* env
// fallback in charge (local dev, or any deploy using static keys).
//
// The pod identity association carries a target_role_arn, so EKS performs the cross-account
// role chain itself and what comes back is already scoped to the bucket's account.

export interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAt: number;
}

// Re-fetch this far ahead of expiry. The endpoint is link-local and cheap, and running to
// the wire means every S3 call in the gap fails.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const FALLBACK_TTL_MS = 15 * 60 * 1000;

let cached: AwsCreds | null = null;
let inflight: Promise<AwsCreds | null> | null = null;

function usable(c: AwsCreds | null): c is AwsCreds {
  return !!c && c.expiresAt - Date.now() > REFRESH_MARGIN_MS;
}

async function fetchCreds(): Promise<AwsCreds | null> {
  const uri = process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  if (!uri) return null; // not running under pod identity
  const headers: Record<string, string> = {};
  const tokenFile = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE;
  if (tokenFile) headers.Authorization = (await Bun.file(tokenFile).text()).trim();

  const res = await fetch(uri, { headers });
  if (!res.ok) throw new Error(`credentials endpoint returned ${res.status}`);
  const j = (await res.json()) as Record<string, string>;
  if (!j.AccessKeyId || !j.SecretAccessKey) throw new Error("credentials endpoint returned no keys");
  return {
    accessKeyId: j.AccessKeyId,
    secretAccessKey: j.SecretAccessKey,
    sessionToken: j.Token ?? j.SessionToken ?? "",
    expiresAt: j.Expiration ? Date.parse(j.Expiration) : Date.now() + FALLBACK_TTL_MS,
  };
}

/** Current credentials, or null if this deploy doesn't use pod identity. */
export function awsCreds(): Promise<AwsCreds | null> {
  if (usable(cached)) return Promise.resolve(cached);
  // One fetch in flight at a time — a cold start hits this from the restore and the first
  // few requests at once, and they should share the result rather than race for it.
  inflight ??= fetchCreds()
    .then((c) => {
      if (c) cached = c;
      return c;
    })
    .catch((e: Error) => {
      console.warn(`aws: pod identity credentials unavailable (${e.message})`);
      return cached; // stale beats nothing; the next call retries
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Changes whenever the credentials do — clients keyed on this get rebuilt on rotation. */
export function awsCredsKey(c: AwsCreds | null): string {
  return c ? `${c.accessKeyId}:${c.expiresAt}` : "env";
}

/** Test seam: forget the cache so a test can exercise a refresh. */
export function resetAwsCreds(): void {
  cached = null;
  inflight = null;
}
