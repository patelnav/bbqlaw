import { timingSafeEqual } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";

// Node has no crypto.subtle.timingSafeEqual (a Workers extension). Back it with
// the Node primitive, which has the same contract.
Object.assign(crypto.subtle, {
  timingSafeEqual: (a: ArrayBuffer, b: ArrayBuffer) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b)),
});

class MemoryKV {
  readonly entries = new Map<string, { value: string; ttl?: number }>();
  async get(key: string) {
    return this.entries.get(key)?.value ?? null;
  }
  async put(key: string, value: string, options?: { expirationTtl?: number }) {
    this.entries.set(key, { value, ttl: options?.expirationTtl });
  }
}

type Stored = { bytes: Uint8Array; customMetadata?: Record<string, string> };

class MemoryR2 {
  readonly objects = new Map<string, Stored>();
  pageSize = 1000;
  async put(key: string, bytes: Uint8Array, options?: { customMetadata?: Record<string, string> }) {
    this.objects.set(key, { bytes: bytes.slice(), customMetadata: options?.customMetadata });
  }
  async head(key: string) {
    return this.objects.has(key) ? { key } : null;
  }
  async get(key: string) {
    const stored = this.objects.get(key);
    return stored ? { body: new Blob([new Uint8Array(stored.bytes)]).stream() } : null;
  }
  async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = Number(cursor ?? 0);
    const end = start + this.pageSize;
    return {
      objects: keys.slice(start, end).map((key) => ({
        key,
        size: this.objects.get(key)!.bytes.byteLength,
        uploaded: new Date(0),
        customMetadata: this.objects.get(key)!.customMetadata,
      })),
      truncated: end < keys.length,
      cursor: String(end),
    };
  }
}

const ADMIN = "test-admin-token";
let kv: MemoryKV;
let r2: MemoryR2;
let env: Env;

beforeEach(() => {
  kv = new MemoryKV();
  r2 = new MemoryR2();
  env = {
    RELAY: kv as unknown as KVNamespace,
    CAPTURES: r2 as unknown as R2Bucket,
    CAPTURES_ADMIN_TOKEN: ADMIN,
    PUBLIC_BASE_URL: "https://bbqlaw.app",
  };
});

function call(path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`https://bbqlaw.app${path}`, init), env);
}
function upload(body: BodyInit, ip = "203.0.113.7") {
  return call("/api/captures", { method: "POST", body, headers: { "CF-Connecting-IP": ip }, duplex: "half" } as RequestInit);
}
const admin = (path: string, token = ADMIN) => call(path, { headers: { Authorization: `Bearer ${token}` } });
const capture = JSON.stringify({ bbqlawCapture: 2, events: [] });
const SHAPE_LIMIT = 512 * 1024;
const sized = (bytes: number) => {
  const empty = JSON.stringify({ bbqlawCapture: 2, pad: "" });
  return JSON.stringify({ bbqlawCapture: 2, pad: "x".repeat(bytes - empty.length) });
};

describe("capture upload", () => {
  it("stores the exact bytes under a three-word code and stores no IP", async () => {
    const response = await upload(capture);
    expect(response.status).toBe(200);
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    const { code } = (await response.json()) as { code: string };
    const parts = code.split("-");
    expect(parts).toHaveLength(4);
    expect(parts[3]).toHaveLength(3);
    expect(Number.isInteger(Number(parts[3]))).toBe(true);
    const stored = r2.objects.get(`captures/${code}.json`)!;
    expect(new TextDecoder().decode(stored.bytes)).toBe(capture);
    expect(Object.keys(stored.customMetadata!)).toEqual(["receivedAt"]);
    const everything = JSON.stringify([...kv.entries, ...r2.objects.keys(), stored.customMetadata]);
    expect(everything).not.toContain("203.0.113.7");
  });

  it("accepts exactly 512 KB and rejects one byte more", async () => {
    expect((await upload(sized(SHAPE_LIMIT))).status).toBe(200);
    expect((await upload(sized(SHAPE_LIMIT + 1))).status).toBe(413);
    expect(r2.objects.size).toBe(1);
  });

  it("stops reading a streamed body at the limit", async () => {
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect((await upload(endless)).status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(16);
  });

  it.each(["not json", "null", "[]", '{"bbqlawCapture":1}', '{"bbqlawCapture":"2"}', ""])(
    "rejects %j",
    async (body) => {
      expect((await upload(body)).status).toBe(400);
      expect(r2.objects.size).toBe(0);
    },
  );

  it("allows 10 uploads per hour for each IP", async () => {
    for (let i = 0; i < 10; i++) expect((await upload(capture)).status).toBe(200);
    expect((await upload(capture)).status).toBe(429);
    expect((await upload(capture, "198.51.100.1")).status).toBe(200);
    expect([...kv.entries.values()].every((entry) => entry.ttl === 3600)).toBe(true);
  });

  it("gives no CORS preflight to captures, and keeps it for the bridge", async () => {
    const preflight = await call("/api/captures", { method: "OPTIONS" });
    expect(preflight.headers.has("Access-Control-Allow-Origin")).toBe(false);
    const bridge = await call("/api/latest", { method: "OPTIONS" });
    expect(bridge.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("capture admin routes", () => {
  it("rejects a missing, wrong or unconfigured token", async () => {
    for (const path of ["/api/captures", "/api/captures/smoky-oak-ribs-001"]) {
      expect((await call(path)).status).toBe(401);
      expect((await admin(path, "wrong")).status).toBe(401);
    }
    env.CAPTURES_ADMIN_TOKEN = undefined;
    expect((await admin("/api/captures")).status).toBe(401);
  });

  it("lists the newest 100 across R2 pages", async () => {
    r2.pageSize = 40;
    for (let i = 0; i < 105; i++) {
      // Key order is the reverse of time order.
      await r2.put(`captures/code-${String(200 - i)}.json`, new Uint8Array(2), {
        customMetadata: { receivedAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() },
      });
    }
    const response = await admin("/api/captures");
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    const { captures } = (await response.json()) as { captures: { code: string; size: number }[] };
    expect(captures).toHaveLength(100);
    expect(captures[0]).toMatchObject({ code: "code-96", size: 2 });
    expect(captures[99].code).toBe("code-195");
  });

  it("returns one capture and rejects invalid codes", async () => {
    const { code } = (await (await upload(capture)).json()) as { code: string };
    const response = await admin(`/api/captures/${code}`);
    expect(await response.text()).toBe(capture);
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    for (const bad of ["missing-code", "UPPER", "a.b", "a%2Fb", "a/b", "a".repeat(65), ""]) {
      expect((await admin(`/api/captures/${bad}`)).status).toBe(404);
    }
  });
});

describe("pair rate limit (shared limiter)", () => {
  it("still allows 10 pairs per minute and stores no IP", async () => {
    const pair = () => call("/api/pair", { method: "POST", body: "{}", headers: { "CF-Connecting-IP": "203.0.113.9" } });
    for (let i = 0; i < 10; i++) expect((await pair()).status).toBe(200);
    expect((await pair()).status).toBe(429);
    expect(JSON.stringify([...kv.entries])).not.toContain("203.0.113.9");
  });
});
