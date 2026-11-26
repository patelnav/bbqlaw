import { createHash, randomUUID, verify } from "node:crypto";
import { parseDictionary } from "structured-headers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Signer } from "../../app/scripts/publish-ota.ts";
import { handleRequest } from "../src/app.ts";
import { temporaryDirectory, throwawaySigner } from "./helpers.ts";
import { MemoryBucket } from "./memory-bucket.ts";

describe("Expo protocol v1 over an R2-shaped bucket", () => {
  const bucket = new MemoryBucket();
  const runtime = "test-runtime";
  const headers = {
    "expo-protocol-version": "1",
    "expo-platform": "ios",
    "expo-runtime-version": runtime,
    "expo-channel-name": "production",
    "expo-expect-signature": 'sig, keyid="root", alg="rsa-v1_5-sha256"',
    accept: "application/expo+json;q=0.8, application/json;q=0.9, multipart/mixed",
  };
  let signer: Signer;
  let directory: Awaited<ReturnType<typeof temporaryDirectory>>;

  beforeAll(async () => {
    directory = await temporaryDirectory();
    ({ signer } = await throwawaySigner(directory.path));
  }, 5_000);
  afterAll(() => directory.remove());

  const get = (path: string, change: Record<string, string | undefined> = {}) => {
    const merged = Object.entries({ ...headers, ...change }).filter((entry): entry is [string, string] => entry[1] !== undefined);
    return handleRequest(new Request(`https://updates.bbqlaw.app${path}`, { headers: merged }), bucket);
  };
  async function publish(release: string, body: string, channel = "production", platform = "ios") {
    await bucket.put(`releases/${release}/${platform}.json`, JSON.stringify({ manifest: body, keyid: "root", signature: signer.sign(body) }));
    await bucket.put(`pointers/${channel}/${platform}/${runtime}.json`, JSON.stringify({ release }));
  }
  // The platform multipart parser checks CRLF, delimiters and Content-Disposition.
  async function multipart(response: Response) {
    const text = await response.text();
    const type = response.headers.get("content-type")!.replace("multipart/mixed", "multipart/form-data");
    const form = await new Response(text, { headers: { "content-type": type } }).formData();
    const line = text.split("\r\n").find((item) => item.startsWith("expo-signature: "))!;
    return { form, signature: parseDictionary(line.slice("expo-signature: ".length)) };
  }

  it("serves a health check and nothing else outside the two routes", async () => {
    const health = await get("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    expect((await get("/healthz")).status).toBe(404);
    expect((await handleRequest(new Request("https://updates.bbqlaw.app/manifest", { method: "POST" }), bucket)).status).toBe(405);
  });

  it("returns 204 with protocol headers and no server-defined headers", async () => {
    const response = await get("/manifest", { "expo-runtime-version": "native-change" });
    expect(response.status).toBe(204);
    expect(response.headers.get("expo-protocol-version")).toBe("1");
    expect(response.headers.get("expo-sfv-version")).toBe("0");
    expect(response.headers.get("expo-manifest-filters")).toBe("");
    expect(response.headers.has("expo-server-defined-headers")).toBe(false);
  });

  it("round-trips signed manifest bytes and isolates channel and platform", async () => {
    const body = JSON.stringify({ id: randomUUID(), createdAt: new Date().toISOString(), runtimeVersion: runtime });
    await publish("release-one", body);
    const response = await get("/manifest");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("multipart/mixed;");
    const parsed = await multipart(response);
    expect(parsed.form.get("manifest")).toBe(body);
    const sig = parsed.signature.get("sig")?.[0] as string;
    expect(parsed.signature.get("keyid")?.[0]).toBe("root");
    expect(parsed.signature.get("alg")?.[0]).toBe("rsa-v1_5-sha256");
    expect(verify("RSA-SHA256", Buffer.from(body), signer.certificate, Buffer.from(sig, "base64"))).toBe(true);
    expect((await get("/manifest", { "expo-platform": "android" })).status).toBe(204);
    expect((await get("/manifest", { "expo-channel-name": "preview" })).status).toBe(204);
    const json = await get("/manifest", { accept: "application/json" });
    expect(json.status).toBe(200);
    expect(await json.text()).toBe(body);
    expect(json.headers.get("expo-signature")).toContain(`sig="${sig}"`);
  });

  it("serves hash-addressed assets with their stored type", async () => {
    const bytes = Buffer.from("globalThis.otaProtocolProof = true;\n");
    const hex = createHash("sha256").update(bytes).digest("hex");
    await bucket.put(`assets/${hex}`, bytes, "application/javascript");
    const asset = await get(`/assets/${hex}`);
    expect(Buffer.from(await asset.arrayBuffer())).toEqual(bytes);
    expect(asset.headers.get("content-type")).toBe("application/javascript");
    expect(asset.headers.get("content-length")).toBe(String(bytes.length));
    expect(asset.headers.get("cache-control")).toContain("immutable");
    for (const path of ["/assets/not-a-hash", `/assets/${"f".repeat(64)}`, `/assets/${"F".repeat(64)}`]) {
      expect((await get(path)).status).toBe(404);
    }
  });

  it("serves a signed rollback directive as multipart only", async () => {
    const body = JSON.stringify({ type: "rollBackToEmbedded", parameters: { commitTime: new Date().toISOString() } });
    await bucket.put("pointers/production/ios/rollback-runtime.json", JSON.stringify({ directive: body, signature: signer.sign(body), keyid: "root" }));
    const change = { "expo-runtime-version": "rollback-runtime" };
    const parsed = await multipart(await get("/manifest", change));
    expect(parsed.form.get("directive")).toBe(body);
    const sig = parsed.signature.get("sig")?.[0] as string;
    expect(verify("RSA-SHA256", Buffer.from(body), signer.certificate, Buffer.from(sig, "base64"))).toBe(true);
    expect((await get("/manifest", { ...change, accept: "application/json" })).status).toBe(406);
  });

  it("rejects unsupported protocol, signing keys, q=0, malformed requests and unknown channels", async () => {
    await publish("negotiation", JSON.stringify({ runtimeVersion: runtime }));
    const cases: [Record<string, string | undefined>, number][] = [
      [{ "expo-protocol-version": "0" }, 406],
      [{ "expo-platform": "web" }, 400],
      [{ "expo-runtime-version": "../other" }, 400],
      [{ "expo-runtime-version": "a".repeat(129) }, 400],
      [{ "expo-channel-name": "staging" }, 400],
      [{ "expo-channel-name": undefined }, 400],
      [{ accept: "multipart/mixed;q=0, text/html" }, 406],
      [{ "expo-expect-signature": 'sig, keyid="wrong-key"' }, 406],
      [{ "expo-expect-signature": 'keyid="' }, 400],
    ];
    for (const [change, status] of cases) {
      expect((await get("/manifest", change)).status).toBe(status);
    }
  });

  it.each([
    ["a release for a different runtime", { manifest: JSON.stringify({ runtimeVersion: "native-change" }), signature: "AAAA", keyid: "root" }],
    ["a signature that could break the header", { manifest: JSON.stringify({ runtimeVersion: runtime }), signature: 'AA"\r\nx', keyid: "root" }],
    ["an oversized envelope", { manifest: "x".repeat(1024 * 1024), signature: "AAAA", keyid: "root" }],
  ])("fails closed with 503 on %s", async (_name, envelope) => {
    await bucket.put("releases/bad/ios.json", JSON.stringify(envelope));
    await bucket.put(`pointers/production/ios/${runtime}.json`, JSON.stringify({ release: "bad" }));
    const response = await get("/manifest");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("native-change");
  });
});
