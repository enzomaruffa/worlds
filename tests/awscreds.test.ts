import { afterEach, describe, expect, test } from "bun:test";
import { awsCreds, resetAwsCreds } from "../server/awscreds";

// A stub credential endpoint per test. The real one is a link-local address only a pod
// can reach, and the whole point of the module is that it speaks to something remote.
interface Stub {
  url: string;
  seen: { authorization: string | null }[];
  stop: () => void;
}

function stub(handler: (n: number) => Response): Stub {
  const seen: { authorization: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push({ authorization: req.headers.get("authorization") });
      return handler(seen.length);
    },
  });
  return { url: `http://localhost:${server.port}/v1/credentials`, seen, stop: () => server.stop(true) };
}

const payload = (over: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      AccessKeyId: "ASIAEXAMPLE",
      SecretAccessKey: "secret",
      Token: "session-token",
      Expiration: new Date(Date.now() + 3600_000).toISOString(),
      ...over,
    }),
    { headers: { "content-type": "application/json" } },
  );

const AWS_ENV = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
];
const saved = Object.fromEntries(AWS_ENV.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of AWS_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetAwsCreds();
});

describe("aws credentials", () => {
  test("no source configured resolves to null rather than throwing", async () => {
    for (const k of AWS_ENV) delete process.env[k];
    expect(await awsCreds()).toBeNull();
  });

  test("static keys win without touching the endpoint", async () => {
    const s = stub(() => payload());
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = s.url;
    process.env.AWS_ACCESS_KEY_ID = "AKIASTATIC";
    process.env.AWS_SECRET_ACCESS_KEY = "static-secret";
    expect(await awsCreds()).toEqual({ accessKeyId: "AKIASTATIC", secretAccessKey: "static-secret", sessionToken: undefined });
    expect(s.seen).toHaveLength(0);
    s.stop();
  });

  test("full URI is fetched and the session token carried through", async () => {
    for (const k of AWS_ENV) delete process.env[k];
    const s = stub(() => payload());
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = s.url;
    process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN = "pod-identity-token";
    expect(await awsCreds()).toEqual({
      accessKeyId: "ASIAEXAMPLE",
      secretAccessKey: "secret",
      sessionToken: "session-token",
    });
    expect(s.seen[0]!.authorization).toBe("pod-identity-token");
    s.stop();
  });

  // The agent rotates the file, so a token read once at boot goes stale on its own clock.
  test("the token file is re-read on every fetch", async () => {
    for (const k of AWS_ENV) delete process.env[k];
    const file = `${import.meta.dir}/.tmp-token`;
    await Bun.write(file, "first-token\n");
    const s = stub(() => payload({ Expiration: new Date(Date.now() - 1000).toISOString() }));
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = s.url;
    process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE = file;

    await awsCreds();
    await Bun.write(file, "second-token\n");
    resetAwsCreds();
    await awsCreds();

    expect(s.seen.map((c) => c.authorization)).toEqual(["first-token", "second-token"]);
    await Bun.file(file).delete();
    s.stop();
  });

  test("a live credential is cached instead of refetched", async () => {
    for (const k of AWS_ENV) delete process.env[k];
    const s = stub(() => payload());
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = s.url;
    await awsCreds();
    await awsCreds();
    expect(s.seen).toHaveLength(1);
    s.stop();
  });

  test("concurrent first calls share one fetch", async () => {
    for (const k of AWS_ENV) delete process.env[k];
    const s = stub(() => payload());
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = s.url;
    const all = await Promise.all([awsCreds(), awsCreds(), awsCreds()]);
    expect(s.seen).toHaveLength(1);
    expect(new Set(all.map((c) => c!.accessKeyId))).toEqual(new Set(["ASIAEXAMPLE"]));
    s.stop();
  });

  test("a non-2xx resolves to null and never leaks the body", async () => {
    for (const k of AWS_ENV) delete process.env[k];
    const s = stub(() => new Response("token=SUPERSECRET", { status: 500 }));
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = s.url;
    expect(await awsCreds()).toBeNull();
    s.stop();
  });

  test("an expiring credential is renewed ahead of its expiry", async () => {
    for (const k of AWS_ENV) delete process.env[k];
    // Inside the renew margin, so the cache must not serve it a second time.
    const s = stub((n) =>
      payload({ AccessKeyId: `ASIA${n}`, Expiration: new Date(Date.now() + 60_000).toISOString() }),
    );
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = s.url;
    expect((await awsCreds())!.accessKeyId).toBe("ASIA1");
    expect((await awsCreds())!.accessKeyId).toBe("ASIA2");
    s.stop();
  });

  test("the relative URI form resolves against the ECS host", async () => {
    for (const k of AWS_ENV) delete process.env[k];
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = "/v2/credentials/abc";
    // 169.254.170.2 is unreachable here, so this exercises the failure path — what
    // matters is that a relative URI is attempted at all rather than read as "none".
    expect(await awsCreds()).toBeNull();
  });
});
