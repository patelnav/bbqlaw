import { createHash, generateKeyPairSync, verify, X509Certificate } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateSigningFiles } from "../../app/scripts/ota-keygen.ts";
import {
  buildManifest, embeddedRuntime, loadSigner, parseResolvedRuntime, promoteUpdate, publishUpdate,
  rollBackToEmbedded, rollbackUpdate, type BuildInput, type Signer,
} from "../../app/scripts/publish-ota.ts";
import { handleRequest } from "../src/app.ts";
import { CONFIGURATION, temporaryDirectory, throwawaySigner, writeExport } from "./helpers.ts";
import { MemoryBucket } from "./memory-bucket.ts";

describe("OTA publisher", () => {
  let directory: Awaited<ReturnType<typeof temporaryDirectory>>;
  let signing: Awaited<ReturnType<typeof throwawaySigner>>;
  let signer: Signer;
  let bucket: MemoryBucket;
  const runtimeVersion = "runtime-a";
  const promotion = { from: "preview", to: "production", runtimeVersion, targetRuntimeVersion: runtimeVersion } as const;

  beforeAll(async () => {
    directory = await temporaryDirectory();
    signing = await throwawaySigner(directory.path);
    signer = signing.signer;
    await writeExport(join(directory.path, "one"), "bundle one");
    await writeExport(join(directory.path, "two"), "bundle two");
  }, 5_000);
  afterAll(() => directory.remove());
  beforeEach(() => { bucket = new MemoryBucket(); });

  const input = (name: string, id: string, createdAt: string): BuildInput => ({
    exportDirectory: join(directory.path, name), configuration: CONFIGURATION, runtimeVersion, id, createdAt,
  });
  /** What an installed app on this channel receives from the real host. */
  async function served(channel: string) {
    const response = await handleRequest(new Request("https://updates.bbqlaw.app/manifest", {
      headers: {
        "expo-protocol-version": "1", "expo-platform": "ios", "expo-runtime-version": runtimeVersion,
        "expo-channel-name": channel, accept: "application/json",
      },
    }), bucket);
    if (response.status !== 200) return null;
    const body = await response.text();
    const header = response.headers.get("expo-signature")!;
    const signature = header.slice('sig="'.length, header.indexOf('"', 'sig="'.length));
    expect(verify("RSA-SHA256", Buffer.from(body), signer.certificate, Buffer.from(signature, "base64"))).toBe(true);
    return JSON.parse(body);
  }

  it("writes a 0600 key and a non-CA code-signing certificate, and never overwrites them", async () => {
    expect((await stat(signing.keyPath)).mode & 0o777).toBe(0o600);
    const certificate = new X509Certificate(signer.certificate);
    expect(certificate.ca).toBe(false);
    expect(certificate.keyUsage).toContain("1.3.6.1.5.5.7.3.3");
    await expect(generateSigningFiles(signing.keyPath, signing.certificatePath, 2048)).rejects.toThrow(/overwrite/);
  });

  it("refuses a private key that does not match the certificate", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => loadSigner(other, signer.certificate)).toThrow(/does not match/);
  });

  it("builds a manifest with exact hashes, asset keys and URLs", async () => {
    const { manifest, uploads } = await buildManifest(input("one", "update-1", "2026-11-26T00:00:00.000Z"));
    const digest = createHash("sha256").update("bundle one").digest();
    expect(manifest.launchAsset).toEqual({
      key: "entry-abc", hash: digest.toString("base64url"), contentType: "application/javascript",
      url: `https://updates.bbqlaw.app/assets/${digest.toString("hex")}`,
    });
    expect(manifest.assets).toMatchObject([{ key: "0123abc", fileExtension: ".ttf", contentType: "font/ttf" }]);
    expect(manifest.extra).toEqual({ expoClient: CONFIGURATION });
    expect(uploads).toHaveLength(2);
    await expect(buildManifest({ ...input("one", "x", "now"), configuration: { updates: { url: "https://other.example/manifest" } } }))
      .rejects.toThrow(/updates.url/);
  });

  it("publishes a signed update that the host serves, with the pointer written last", async () => {
    const published = await publishUpdate(bucket, signer, "preview", input("one", "update-1", "2026-11-26T00:00:00.000Z"));
    expect(bucket.writes.at(-1)).toBe(`pointers/preview/ios/${runtimeVersion}.json`);
    expect(await served("preview")).toEqual(published);
    expect(await served("production")).toBeNull();
    for (const asset of [published.launchAsset, ...published.assets]) {
      const response = await handleRequest(new Request(asset.url), bucket);
      const hash = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("base64url");
      expect(hash).toBe(asset.hash);
    }
  });

  it("promotes the same release, and refuses an older one or a different runtime", async () => {
    await publishUpdate(bucket, signer, "preview", input("one", "update-1", "2026-11-26T00:00:00.000Z"));
    await expect(promoteUpdate(bucket, signer.certificate, { ...promotion, targetRuntimeVersion: "runtime-b" }))
      .rejects.toThrow(/Runtime versions differ/);
    await promoteUpdate(bucket, signer.certificate, promotion);
    expect((await served("production")).id).toBe("update-1");
    await publishUpdate(bucket, signer, "production", input("two", "update-2", "2026-11-27T00:00:00.000Z"));
    await expect(promoteUpdate(bucket, signer.certificate, promotion)).rejects.toThrow(/newer/);
    expect((await served("production")).id).toBe("update-2");
  });

  it("rolls back by publishing old code under a new id and a new time", async () => {
    const first = await publishUpdate(bucket, signer, "production", input("one", "update-1", "2026-11-26T00:00:00.000Z"));
    await publishUpdate(bucket, signer, "production", input("two", "update-2", "2026-11-27T00:00:00.000Z"));
    await rollbackUpdate(bucket, signer, "production", "update-1", new Date("2026-11-28T00:00:00.000Z"));
    const current = await served("production");
    expect(current.id).not.toBe("update-1");
    expect(current.createdAt).toBe("2026-11-28T00:00:00.000Z");
    expect(current.launchAsset).toEqual(first.launchAsset);
  });

  it("will not republish a stored release that someone changed", async () => {
    await publishUpdate(bucket, signer, "production", input("one", "update-1", "2026-11-26T00:00:00.000Z"));
    const envelope = JSON.parse(String(await bucket.get("releases/update-1/ios.json").then((item) => item!.text())));
    envelope.manifest = envelope.manifest.replace("entry-abc", "entry-evil");
    await bucket.put("releases/update-1/ios.json", JSON.stringify(envelope));
    await expect(rollbackUpdate(bucket, signer, "production", "update-1")).rejects.toThrow(/signature/);
  });

  it("writes a signed rollBackToEmbedded directive", async () => {
    await rollBackToEmbedded(bucket, signer, "production", runtimeVersion, new Date("2026-11-28T00:00:00.000Z"));
    const pointer = JSON.parse(await (await bucket.get(`pointers/production/ios/${runtimeVersion}.json`))!.text());
    expect(JSON.parse(pointer.directive)).toEqual({ type: "rollBackToEmbedded", parameters: { commitTime: "2026-11-28T00:00:00.000Z" } });
    expect(verify("RSA-SHA256", Buffer.from(pointer.directive), signer.certificate, Buffer.from(pointer.signature, "base64"))).toBe(true);
  });

  it("reads the runtime from a built app or from the resolver output, and fails otherwise", async () => {
    const app = join(directory.path, "BBQlaw.app");
    await mkdir(join(app, "EXUpdates.bundle"), { recursive: true });
    await expect(embeddedRuntime(app)).rejects.toThrow(/found 0/);
    await writeFile(join(app, "EXUpdates.bundle/fingerprint"), "abc123\n");
    expect(await embeddedRuntime(app)).toBe("abc123");
    expect(parseResolvedRuntime('{"runtimeVersion":"def456","fingerprintSources":[]}')).toBe("def456");
    expect(() => parseResolvedRuntime('{"runtimeVersion":null}')).toThrow();
    expect(() => parseResolvedRuntime("not json")).toThrow();
    expect(await readFile(join(app, "EXUpdates.bundle/fingerprint"), "utf8")).toBe("abc123\n");
  });
});
