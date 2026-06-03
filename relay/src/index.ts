export interface Env {
  RELAY: KVNamespace;
  READER_TOKEN: string;
  PUBLIC_BASE_URL: string;
}

interface StoredReading {
  device: string;
  tempF: number | null;
  targetF: number;
  battery: { base: number | null; probe: number | null };
  connected: boolean;
  ts: number;
  receivedAt: number;
}

interface LinkPayload {
  device: string;
  deviceToken: string;
  expiresAt: number;
}

interface TokenRecord {
  type: "device";
  device: string;
}

const LINK_TTL_SECONDS = 300;
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
        case "POST /api/ingest":
          return await handleIngest(request, env);
        case "GET /api/latest":
          return await handleLatest(request, env, url);
        case "POST /api/link/new":
          return await handleLinkNew(request, env, url);
        case "POST /api/link/redeem":
          return await handleLinkRedeem(request, env, url);
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      return json({ error: message }, 500);
    }
  },
};

async function handleIngest(request: Request, env: Env): Promise<Response> {
  const token = bearer(request);
  if (!token) return json({ error: "missing bearer token" }, 401);

  const record = await lookupDeviceToken(env, token);
  if (!record) return json({ error: "invalid device token" }, 401);

  const body = (await request.json()) as Partial<StoredReading>;
  if (body.device !== record.device) {
    return json({ error: "device mismatch" }, 403);
  }

  const receivedAt = Math.floor(Date.now() / 1000);
  const stored: StoredReading = {
    device: record.device,
    tempF: typeof body.tempF === "number" ? body.tempF : null,
    targetF: typeof body.targetF === "number" ? body.targetF : 0,
    battery: {
      base: body.battery?.base ?? null,
      probe: body.battery?.probe ?? null,
    },
    connected: body.connected !== false,
    ts: typeof body.ts === "number" ? body.ts : receivedAt,
    receivedAt,
  };

  await env.RELAY.put(`reading:${record.device}`, JSON.stringify(stored));
  return json({ ok: true });
}

async function handleLatest(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (!readerAuthorized(request, env)) {
    return json({ error: "invalid reader token" }, 401);
  }

  const device = url.searchParams.get("device");
  if (!device) return json({ error: "device query param required" }, 400);

  const raw = await env.RELAY.get(`reading:${device}`);
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

async function handleLinkNew(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (!readerAuthorized(request, env)) {
    return json({ error: "invalid reader token" }, 401);
  }

  let device = `probe-${randomId(6)}`;
  try {
    const body = (await request.json()) as { device?: string };
    if (body.device && /^[a-z0-9-]{2,32}$/i.test(body.device)) {
      device = body.device.toLowerCase();
    }
  } catch {
    // empty body is fine — use generated device id
  }

  const deviceToken = randomToken();
  await storeDeviceToken(env, deviceToken, device);

  const code = randomId(8).toUpperCase();
  const expiresAt = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
  const payload: LinkPayload = { device, deviceToken, expiresAt };
  await env.RELAY.put(`link:${code}`, JSON.stringify(payload), {
    expirationTtl: LINK_TTL_SECONDS,
  });

  const base = publicBase(url, env);
  return json({
    code,
    device,
    url: `${base}/link#${code}`,
    expiresInSeconds: LINK_TTL_SECONDS,
  });
}

async function handleLinkRedeem(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const body = (await request.json()) as { code?: string };
  const code = body.code?.trim().toUpperCase();
  if (!code) return json({ error: "code required" }, 400);

  const key = `link:${code}`;
  const raw = await env.RELAY.get(key);
  if (!raw) return json({ error: "invalid or expired code" }, 404);

  const payload = JSON.parse(raw) as LinkPayload;
  const now = Math.floor(Date.now() / 1000);
  if (payload.expiresAt < now) {
    await env.RELAY.delete(key);
    return json({ error: "invalid or expired code" }, 404);
  }

  await env.RELAY.delete(key);

  const base = publicBase(url, env);
  return json({
    device: payload.device,
    deviceToken: payload.deviceToken,
    ingestUrl: `${base}/api/ingest`,
  });
}

function publicBase(requestUrl: URL, env: Env): string {
  if (env.PUBLIC_BASE_URL && !requestUrl.hostname.endsWith(".workers.dev")) {
    return env.PUBLIC_BASE_URL.replace(/\/$/, "");
  }
  return requestUrl.origin;
}

function readerAuthorized(request: Request, env: Env): boolean {
  const token = bearer(request);
  return !!token && token === env.READER_TOKEN;
}

async function lookupDeviceToken(
  env: Env,
  token: string,
): Promise<TokenRecord | null> {
  const raw = await env.RELAY.get(`token:${await hashToken(token)}`);
  if (!raw) return null;
  return JSON.parse(raw) as TokenRecord;
}

async function storeDeviceToken(
  env: Env,
  token: string,
  device: string,
): Promise<void> {
  const record: TokenRecord = { type: "device", device };
  await env.RELAY.put(`token:${await hashToken(token)}`, JSON.stringify(record));
}

function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

function randomId(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
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
