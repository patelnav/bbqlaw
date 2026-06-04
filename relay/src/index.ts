export interface Env {
  RELAY: KVNamespace;
  PUBLIC_BASE_URL: string;
}

interface StoredReading {
  device: string;
  tempF: number | null;
  targetF: number;
  battery: { base: number | null; probe: number | null };
  connected: boolean;
  ts: number | null;
  receivedAt: number;
}

interface TokenRecord {
  type: "device" | "reader";
  device: string;
}

const PAIR_RATE_LIMIT = 10;
const PAIR_RATE_WINDOW_SECONDS = 60;
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return json({ error: "not found" }, 404);
    }

    try {
      switch (`${request.method} ${url.pathname}`) {
        case "POST /api/pair":
          return await handlePair(request, env, url);
        case "POST /api/ingest":
          return await handleIngest(request, env);
        case "GET /api/latest":
          return await handleLatest(request, env);
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      return json({ error: message }, 500);
    }
  },
};

async function handlePair(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await checkPairRateLimit(env, ip))) {
    return json({ error: "rate limit exceeded" }, 429);
  }

  let device = `probe-${randomId(6)}`;
  try {
    const body = (await request.json()) as { device?: string };
    if (body.device !== undefined) {
      if (!/^[a-z0-9-]{2,32}$/i.test(body.device)) {
        return json({ error: "invalid device id" }, 400);
      }
      device = body.device.toLowerCase();
    }
  } catch {
    // empty body is fine — use generated device id
  }

  const deviceToken = randomToken();
  const readerToken = randomToken();
  await storePairTokens(env, device, deviceToken, readerToken);

  const base = publicBase(url, env);
  return json({
    device,
    deviceToken,
    readerToken,
    ingestUrl: `${base}/api/ingest`,
    latestUrl: `${base}/api/latest`,
  });
}

async function handleIngest(request: Request, env: Env): Promise<Response> {
  const token = bearer(request);
  if (!token) return json({ error: "missing bearer token" }, 401);

  const record = await lookupToken(env, token);
  if (!record || record.type !== "device") {
    return json({ error: "invalid device token" }, 401);
  }

  const tokenHash = await hashToken(token);
  const currentHash = await env.RELAY.get(`device:${record.device}:curtoken`);
  if (currentHash !== tokenHash) {
    return json({ error: "token superseded" }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json body" }, 400);
  }

  const parsed = parseIngestBody(body);
  if ("error" in parsed) return json({ error: parsed.error }, 400);

  if (parsed.device !== record.device) {
    return json({ error: "device mismatch" }, 403);
  }

  const receivedAt = Math.floor(Date.now() / 1000);
  const stored: StoredReading = {
    device: record.device,
    tempF: parsed.tempF,
    targetF: parsed.targetF,
    battery: parsed.battery,
    connected: parsed.connected,
    ts: parsed.ts,
    receivedAt,
  };

  await env.RELAY.put(`reading:${record.device}`, JSON.stringify(stored));
  return json({ ok: true });
}

async function handleLatest(request: Request, env: Env): Promise<Response> {
  const token = bearer(request);
  if (!token) return json({ error: "missing bearer token" }, 401);

  const record = await lookupToken(env, token);
  if (!record || record.type !== "reader") {
    return json({ error: "invalid reader token" }, 401);
  }

  const raw = await env.RELAY.get(`reading:${record.device}`);
  if (!raw) return json({ error: "no readings yet" }, 404);

  const reading = JSON.parse(raw) as StoredReading;
  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = now - reading.receivedAt;

  return json({
    device: reading.device,
    tempF: reading.tempF,
    targetF: reading.targetF,
    battery: reading.battery,
    connected: reading.connected,
    ts: reading.ts,
    ageSeconds,
  });
}

function parseIngestBody(
  body: unknown,
):
  | {
      device: string;
      tempF: number | null;
      targetF: number;
      battery: { base: number | null; probe: number | null };
      connected: boolean;
      ts: number | null;
    }
  | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "malformed body" };
  }

  const o = body as Record<string, unknown>;

  if (typeof o.device !== "string" || !/^[a-z0-9-]{2,32}$/i.test(o.device)) {
    return { error: "invalid device" };
  }

  if (o.tempF !== null && typeof o.tempF !== "number") {
    return { error: "invalid tempF" };
  }

  if (typeof o.targetF !== "number") {
    return { error: "invalid targetF" };
  }

  let battery: { base: number | null; probe: number | null } = {
    base: null,
    probe: null,
  };
  if (o.battery !== undefined) {
    if (typeof o.battery !== "object" || o.battery === null || Array.isArray(o.battery)) {
      return { error: "invalid battery" };
    }
    const b = o.battery as Record<string, unknown>;
    if (
      (b.base !== null && b.base !== undefined && typeof b.base !== "number") ||
      (b.probe !== null && b.probe !== undefined && typeof b.probe !== "number")
    ) {
      return { error: "invalid battery" };
    }
    battery = {
      base: typeof b.base === "number" ? b.base : null,
      probe: typeof b.probe === "number" ? b.probe : null,
    };
  }

  let connected = true;
  if (o.connected !== undefined) {
    if (typeof o.connected !== "boolean") {
      return { error: "invalid connected" };
    }
    connected = o.connected;
  }

  if (o.ts !== null && typeof o.ts !== "number") {
    return { error: "invalid ts" };
  }

  return {
    device: o.device.toLowerCase(),
    tempF: o.tempF === null ? null : (o.tempF as number),
    targetF: o.targetF,
    battery,
    connected,
    ts: o.ts === null || o.ts === undefined ? null : (o.ts as number),
  };
}

async function storePairTokens(
  env: Env,
  device: string,
  deviceToken: string,
  readerToken: string,
): Promise<void> {
  const deviceHash = await hashToken(deviceToken);
  const readerHash = await hashToken(readerToken);

  await env.RELAY.put(
    `token:${deviceHash}`,
    JSON.stringify({ type: "device", device } satisfies TokenRecord),
  );
  await env.RELAY.put(
    `token:${readerHash}`,
    JSON.stringify({ type: "reader", device } satisfies TokenRecord),
  );
  await env.RELAY.put(`device:${device}:curtoken`, deviceHash);
}

async function checkPairRateLimit(env: Env, ip: string): Promise<boolean> {
  const key = `pairlimit:${ip}`;
  const raw = await env.RELAY.get(key);
  const count = raw ? Number.parseInt(raw, 10) : 0;
  if (count >= PAIR_RATE_LIMIT) return false;
  await env.RELAY.put(key, String(count + 1), {
    expirationTtl: PAIR_RATE_WINDOW_SECONDS,
  });
  return true;
}

function publicBase(requestUrl: URL, env: Env): string {
  if (env.PUBLIC_BASE_URL && !requestUrl.hostname.endsWith(".workers.dev")) {
    return env.PUBLIC_BASE_URL.replace(/\/$/, "");
  }
  return requestUrl.origin;
}

async function lookupToken(
  env: Env,
  token: string,
): Promise<TokenRecord | null> {
  const raw = await env.RELAY.get(`token:${await hashToken(token)}`);
  if (!raw) return null;
  return JSON.parse(raw) as TokenRecord;
}

function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

function randomId(length: number): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
