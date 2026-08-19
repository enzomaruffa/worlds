import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awsCreds, awsCredsKey, resetAwsCreds } from "../server/awscreds";

// config.ts refuses to load without a session secret, so flip dev mode on before the
// blobstore module (and its config import) is evaluated.
process.env.WORLDS_DEV ??= "1";
const { S3BlobStore } = await import("../server/blobstore");

// A stand-in for the EKS pod identity agent. Counts hits so the tests can tell a cached
// read from a refetch, and records the Authorization header it was given.
let server: ReturnType<typeof Bun.serve> | null = null;
let hits = 0;
let lastAuth: string | null = null;
let expiresInMs = 60 * 60 * 1000;

const saved = {
  uri: process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
  token: process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE,
};

beforeEach(async () => {
  hits = 0;
  lastAuth = null;
  expiresInMs = 60 * 60 * 1000;
  resetAwsCreds();
  server = Bun.serve({
    port: 0,
    fetch(req) {
      hits++;
      lastAuth = req.headers.get("authorization");
      return Response.json({
        AccessKeyId: `AKIA${hits}`,
        SecretAccessKey: "secret",
        Token: "session-token",
        Expiration: new Date(Date.now() + expiresInMs).toISOString(),
      });
    },
  });
  const dir = await mkdtemp(join(tmpdir(), "awscreds-"));
  const tokenPath = join(dir, "token");
  await writeFile(tokenPath, "pod-jwt\n");
  process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = `http://localhost:${server.port}/v1/credentials`;
  process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE = tokenPath;
});

afterEach(() => {
  server?.stop(true);
  server = null;
  resetAwsCreds();
  if (saved.uri === undefined) delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  else process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = saved.uri;
  if (saved.token === undefined) delete process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE;
  else process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE = saved.token;
});

test("exchanges the pod token for credentials", async () => {
  const c = await awsCreds();
  expect(c?.accessKeyId).toBe("AKIA1");
  expect(c?.secretAccessKey).toBe("secret");
  expect(c?.sessionToken).toBe("session-token");
  // the token goes in the Authorization header, trimmed of the file's trailing newline
  expect(lastAuth).toBe("pod-jwt");
});

test("caches while the credentials are still good", async () => {
  await awsCreds();
  await awsCreds();
  await awsCreds();
  expect(hits).toBe(1);
});

test("concurrent callers share one fetch", async () => {
  const all = await Promise.all([awsCreds(), awsCreds(), awsCreds(), awsCreds()]);
  expect(hits).toBe(1);
  expect(new Set(all.map((c) => c?.accessKeyId))).toEqual(new Set(["AKIA1"]));
});

// The one that matters: credentials inside the refresh window must be replaced, or S3
// works for an hour and then quietly stops.
test("refetches once inside the refresh window", async () => {
  expiresInMs = 60 * 1000; // already inside the 5-minute margin
  const first = await awsCreds();
  const second = await awsCreds();
  expect(hits).toBe(2);
  expect(first?.accessKeyId).toBe("AKIA1");
  expect(second?.accessKeyId).toBe("AKIA2");
  expect(awsCredsKey(first)).not.toBe(awsCredsKey(second));
});

test("no endpoint means no credentials, so Bun's own env fallback applies", async () => {
  delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  resetAwsCreds();
  expect(await awsCreds()).toBeNull();
  expect(hits).toBe(0);
  expect(awsCredsKey(null)).toBe("env");
});

test("an endpoint failure degrades instead of throwing", async () => {
  server?.stop(true);
  server = null;
  resetAwsCreds();
  expect(await awsCreds()).toBeNull();
});

// The blobstore builds its client once and holds it. Bun bakes credentials in at
// construction, so a rotation has to produce a NEW client — otherwise the store keeps
// signing with expired keys and every call fails.
test("the S3 store rebuilds its client when credentials rotate", async () => {
  const store = new S3BlobStore({ bucket: "b", region: "us-east-1" }) as unknown as {
    client(): Promise<unknown>;
    cliKey: string;
  };

  expiresInMs = 60 * 60 * 1000;
  const a = await store.client();
  const b = await store.client();
  expect(a).toBe(b); // stable credentials → same client, no churn
  expect(hits).toBe(1);
  const keyBefore = store.cliKey;

  expiresInMs = 60 * 1000; // now inside the refresh window
  resetAwsCreds();
  const c = await store.client();
  expect(c).not.toBe(a); // rotated → rebuilt
  expect(store.cliKey).not.toBe(keyBefore);
});

test("with no pod identity the store still builds a client", async () => {
  delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  resetAwsCreds();
  const store = new S3BlobStore({ bucket: "b" }) as unknown as { client(): Promise<unknown>; cliKey: string };
  expect(await store.client()).toBeDefined();
  expect(store.cliKey).toBe("env");
});
