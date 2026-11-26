export interface Env {
  RELAY: KVNamespace;
  CAPTURES: R2Bucket;
  CAPTURES_ADMIN_TOKEN?: string; // secret: `wrangler secret put CAPTURES_ADMIN_TOKEN`
  PUBLIC_BASE_URL: string;
}

// One probe in a stored snapshot.
interface StoredProbe {
  id: string;
  name: string;
  color: string | null;
  tempF: number | null;
  targetF: number | null;
  meat: string | null;
  doneness: string | null;
  mode: string; // "live" | "docked" | "noReading"
  probeBattery: number | null;
  baseBattery: number | null;
  connected: boolean;
}

interface StoredSnapshot {
  device: string;
  ts: number | null; // device-reported unix seconds
  probes: StoredProbe[];
  receivedAt: number; // server unix seconds
}

// A human-readable event the OpenClaw feed diffs against on each check-in.
interface HistoryEvent {
  ts: number;
  probeId: string;
  probeName: string;
  kind: "reached" | "connected" | "disconnected" | "target-set" | "note";
  text: string;
}

interface TokenRecord {
  type: "device" | "reader";
  device: string;
}

const PAIR_RATE_LIMIT = 10;
const PAIR_RATE_WINDOW_SECONDS = 60;
// Brute-force throttle for the short feed slug: max invalid reader-token attempts
// per IP per window (legit readers send a valid token and never count).
const READER_FAIL_LIMIT = 30;
const READER_FAIL_WINDOW_SECONDS = 60;
const HISTORY_CAP = 60;
const CAPTURE_MAX_BYTES = 512 * 1024;
const CAPTURE_RATE_LIMIT = 10;
const CAPTURE_RATE_WINDOW_SECONDS = 60 * 60;
const CAPTURE_LIST_LIMIT = 100;
const CAPTURE_PREFIX = "captures/";
const CAPTURES_PATH = "/api/captures";
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Captures are for the native app and the operator. No browser origin gets
    // CORS access to them, so these routes stay ahead of the wildcard preflight.
    if (url.pathname === CAPTURES_PATH || url.pathname.startsWith(`${CAPTURES_PATH}/`)) {
      try {
        return await handleCaptures(request, env, url);
      } catch {
        return privateJson({ error: "internal error" }, 500);
      }
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

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
        case "GET /api/history":
          return await handleHistory(request, env);
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
  if (!(await checkRateLimit(env, "pairlimit", ip, PAIR_RATE_LIMIT, PAIR_RATE_WINDOW_SECONDS))) {
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
  const readerToken = await uniqueSlug(env);
  await storePairTokens(env, device, deviceToken, readerToken);

  const base = publicBase(url, env);
  return json({
    device,
    deviceToken,
    readerToken,
    ingestUrl: `${base}/api/ingest`,
    latestUrl: `${base}/api/latest`,
    historyUrl: `${base}/api/history`,
    // The shareable surface handed to OpenClaw: a unique non-guessable URL per
    // pairing, with the reader token as the path segment.
    feedUrl: `${base}/openclaw/${readerToken}`,
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
  const snapshot: StoredSnapshot = {
    device: record.device,
    ts: parsed.ts,
    probes: parsed.probes,
    receivedAt,
  };

  // Diff against the previous snapshot to generate human-readable events.
  const prevRaw = await env.RELAY.get(`reading:${record.device}`);
  const prev = prevRaw ? (JSON.parse(prevRaw) as StoredSnapshot) : null;
  const events = diffEvents(prev, snapshot, receivedAt);

  await env.RELAY.put(`reading:${record.device}`, JSON.stringify(snapshot));
  if (events.length) {
    await appendHistory(env, record.device, events);
  }

  return json({ ok: true, events: events.length });
}

async function handleLatest(request: Request, env: Env): Promise<Response> {
  const record = await requireReader(request, env);
  if ("error" in record) return json({ error: record.error }, record.status);

  const raw = await env.RELAY.get(`reading:${record.device}`);
  if (!raw) return json({ error: "no readings yet" }, 404);

  const snapshot = JSON.parse(raw) as StoredSnapshot;
  const now = Math.floor(Date.now() / 1000);

  return json({
    device: snapshot.device,
    ts: snapshot.ts ?? snapshot.receivedAt,
    receivedAt: snapshot.receivedAt,
    ageSeconds: now - snapshot.receivedAt,
    probes: snapshot.probes,
  });
}

async function handleHistory(request: Request, env: Env): Promise<Response> {
  const record = await requireReader(request, env);
  if ("error" in record) return json({ error: record.error }, record.status);

  const raw = await env.RELAY.get(`history:${record.device}`);
  const events = raw ? (JSON.parse(raw) as HistoryEvent[]) : [];
  // Most-recent first for the feed.
  return json({ events: [...events].reverse() });
}

// MARK: - Captures (opt-in uploads from the app)

async function handleCaptures(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === CAPTURES_PATH) {
    if (request.method === "POST") return handleCaptureUpload(request, env);
    if (request.method === "GET") {
      if (!(await isAdmin(request, env))) return privateJson({ error: "unauthorized" }, 401);
      return handleCaptureList(env);
    }
  } else if (request.method === "GET") {
    if (!(await isAdmin(request, env))) return privateJson({ error: "unauthorized" }, 401);
    return handleCaptureGet(env, url.pathname.slice(CAPTURES_PATH.length + 1));
  }
  return privateJson({ error: "not found" }, 404);
}

async function handleCaptureUpload(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await checkRateLimit(env, "capturelimit", ip, CAPTURE_RATE_LIMIT, CAPTURE_RATE_WINDOW_SECONDS))) {
    return privateJson({ error: "rate limit exceeded" }, 429);
  }

  const bytes = await readCapped(request, CAPTURE_MAX_BYTES);
  if (bytes === null) return privateJson({ error: "capture too large" }, 413);

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return privateJson({ error: "invalid json body" }, 400);
  }
  if (typeof body !== "object" || body === null || (body as { bbqlawCapture?: unknown }).bbqlawCapture !== 2) {
    return privateJson({ error: "not a BBQlaw capture" }, 400);
  }

  const code = await uniqueCaptureCode(env);
  await env.CAPTURES.put(`${CAPTURE_PREFIX}${code}.json`, bytes, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { receivedAt: new Date().toISOString() },
  });
  return privateJson({ code });
}

/** Reads the body as a stream and stops at the limit. Returns null when it is too large. */
async function readCapped(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function uniqueCaptureCode(env: Env): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const [random] = crypto.getRandomValues(new Uint32Array(1));
    const code = `${randomSlug()}-${String(random % 1000).padStart(3, "0")}`;
    if (!(await env.CAPTURES.head(`${CAPTURE_PREFIX}${code}.json`))) return code;
  }
  throw new Error("no free capture code");
}

async function handleCaptureList(env: Env): Promise<Response> {
  // R2 lists by key, not by time, so read every page before the sort. The
  // 90-day lifecycle rule bounds the number of objects.
  const captures: { code: string; receivedAt: string; size: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.CAPTURES.list({ prefix: CAPTURE_PREFIX, include: ["customMetadata"], cursor });
    for (const object of page.objects) {
      captures.push({
        code: object.key.slice(CAPTURE_PREFIX.length, -".json".length),
        receivedAt: object.customMetadata?.receivedAt ?? object.uploaded.toISOString(),
        size: object.size,
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  captures.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  return privateJson({ captures: captures.slice(0, CAPTURE_LIST_LIMIT) });
}

function isCaptureCode(code: string): boolean {
  return (
    code.length >= 1 &&
    code.length <= 64 &&
    [...code].every((c) => "abcdefghijklmnopqrstuvwxyz0123456789-".includes(c))
  );
}

async function handleCaptureGet(env: Env, code: string): Promise<Response> {
  const object = isCaptureCode(code) ? await env.CAPTURES.get(`${CAPTURE_PREFIX}${code}.json`) : null;
  if (!object) return privateJson({ error: "not found" }, 404);
  return new Response(object.body, {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** Compares SHA-256 digests, so the comparison takes equal time for any input. */
async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const token = bearer(request);
  if (!token || !env.CAPTURES_ADMIN_TOKEN) return false;
  const digest = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return crypto.subtle.timingSafeEqual(await digest(token), await digest(env.CAPTURES_ADMIN_TOKEN));
}

/** A response with no CORS headers. */
function privateJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// MARK: - Event diffing

function isReached(p: StoredProbe): boolean {
  return (
    p.mode === "live" &&
    p.tempF !== null &&
    p.targetF !== null &&
    p.tempF >= p.targetF
  );
}

function diffEvents(
  prev: StoredSnapshot | null,
  next: StoredSnapshot,
  at: number,
): HistoryEvent[] {
  const events: HistoryEvent[] = [];
  const prevById = new Map<string, StoredProbe>(
    (prev?.probes ?? []).map((p) => [p.id, p]),
  );

  for (const p of next.probes) {
    const before = prevById.get(p.id);

    // New probe appearing connected.
    if (!before && p.connected) {
      events.push(ev(at, p, "connected", `${p.name} connected`));
    }

    if (before) {
      // Connection transitions.
      if (before.connected && !p.connected) {
        events.push(ev(at, p, "disconnected", `${p.name} disconnected`));
      } else if (!before.connected && p.connected) {
        events.push(ev(at, p, "connected", `${p.name} reconnected`));
      }

      // Target set / changed.
      if (before.targetF !== p.targetF && p.targetF !== null) {
        events.push(
          ev(at, p, "target-set", `${p.name}: target set to ${Math.round(p.targetF)}°F`),
        );
      }
    }

    // Target reached (rising edge).
    if (isReached(p) && !(before && isReached(before))) {
      events.push(
        ev(
          at,
          p,
          "reached",
          `${p.name} hit ${Math.round(p.tempF as number)}°F — target reached`,
        ),
      );
    }
  }

  // Probes that vanished entirely.
  for (const before of prev?.probes ?? []) {
    if (!next.probes.some((p) => p.id === before.id) && before.connected) {
      events.push(ev(at, before, "disconnected", `${before.name} removed`));
    }
  }

  return events;
}

function ev(
  ts: number,
  p: StoredProbe,
  kind: HistoryEvent["kind"],
  text: string,
): HistoryEvent {
  return { ts, probeId: p.id, probeName: p.name, kind, text };
}

async function appendHistory(
  env: Env,
  device: string,
  events: HistoryEvent[],
): Promise<void> {
  const raw = await env.RELAY.get(`history:${device}`);
  const existing = raw ? (JSON.parse(raw) as HistoryEvent[]) : [];
  const merged = [...existing, ...events].slice(-HISTORY_CAP);
  await env.RELAY.put(`history:${device}`, JSON.stringify(merged));
}

// MARK: - Parsing

type ParsedIngest =
  | { device: string; ts: number | null; probes: StoredProbe[] }
  | { error: string };

function parseIngestBody(body: unknown): ParsedIngest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "malformed body" };
  }
  const o = body as Record<string, unknown>;

  if (typeof o.device !== "string" || !/^[a-z0-9-]{2,32}$/i.test(o.device)) {
    return { error: "invalid device" };
  }

  const ts =
    o.ts === null || o.ts === undefined ? null : num(o.ts);
  if (o.ts !== null && o.ts !== undefined && ts === null) {
    return { error: "invalid ts" };
  }

  // New multi-probe schema.
  if (Array.isArray(o.probes)) {
    if (o.probes.length > 16) return { error: "too many probes" };
    const probes: StoredProbe[] = [];
    for (const raw of o.probes) {
      const p = parseProbe(raw);
      if (p) probes.push(p);
    }
    return { device: o.device.toLowerCase(), ts, probes };
  }

  // Legacy single-probe fallback (old app builds).
  if (typeof o.targetF === "number" || o.tempF === null || typeof o.tempF === "number") {
    const battery = (o.battery ?? {}) as Record<string, unknown>;
    const probe: StoredProbe = {
      id: o.device.toLowerCase(),
      name: "Probe",
      color: null,
      tempF: o.tempF === null || o.tempF === undefined ? null : num(o.tempF),
      targetF: typeof o.targetF === "number" ? o.targetF : null,
      meat: null,
      doneness: null,
      mode: o.connected === false ? "noReading" : "live",
      probeBattery: num(battery.probe),
      baseBattery: num(battery.base),
      connected: o.connected !== false,
    };
    return { device: o.device.toLowerCase(), ts, probes: [probe] };
  }

  return { error: "missing probes" };
}

function parseProbe(raw: unknown): StoredProbe | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.length === 0 || o.id.length > 64) return null;
  const mode = typeof o.mode === "string" ? o.mode : "noReading";
  return {
    id: o.id.slice(0, 64),
    name: typeof o.name === "string" ? o.name.slice(0, 48) : "Probe",
    color: typeof o.color === "string" ? o.color.slice(0, 9) : null,
    tempF: num(o.tempF),
    targetF: num(o.targetF),
    meat: typeof o.meat === "string" ? o.meat.slice(0, 48) : null,
    doneness: typeof o.doneness === "string" ? o.doneness.slice(0, 24) : null,
    mode: ["live", "docked", "noReading"].includes(mode) ? mode : "noReading",
    probeBattery: num(o.probeBattery),
    baseBattery: num(o.baseBattery),
    connected: o.connected !== false,
  };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// MARK: - Tokens / infra

async function requireReader(
  request: Request,
  env: Env,
): Promise<{ device: string } | { error: string; status: number }> {
  const token = bearer(request);
  if (!token) return { error: "missing bearer token", status: 401 };

  // Validate first so a VALID token is never throttled (legit polling is always
  // allowed, even from a shared/NAT'd IP). Reader tokens are scoped to the
  // current pairing — re-pairing revokes old ones (tokens minted before this
  // check have no curreader key and stay valid).
  const record = await lookupToken(env, token);
  if (record && record.type === "reader") {
    const currentReader = await env.RELAY.get(`device:${record.device}:curreader`);
    if (!currentReader || currentReader === (await hashToken(token))) {
      return { device: record.device };
    }
  }

  // Invalid / superseded: the feed slug is short, so throttle brute-force
  // enumeration by counting failures per IP.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const fails = Number((await env.RELAY.get(`readerfail:${ip}`)) ?? "0");
  await noteReaderFailure(env, ip);
  if (fails >= READER_FAIL_LIMIT) {
    return { error: "rate limit exceeded", status: 429 };
  }
  return { error: "invalid reader token", status: 401 };
}

async function noteReaderFailure(env: Env, ip: string): Promise<void> {
  const key = `readerfail:${ip}`;
  const n = Number((await env.RELAY.get(key)) ?? "0");
  await env.RELAY.put(key, String(n + 1), {
    expirationTtl: READER_FAIL_WINDOW_SECONDS,
  });
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
  await env.RELAY.put(`device:${device}:curreader`, readerHash);
}

/** Counts requests per client. The key holds a hash, so no IP address is stored. */
async function checkRateLimit(
  env: Env,
  prefix: string,
  ip: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const key = `${prefix}:${await hashToken(ip)}`;
  const raw = await env.RELAY.get(key);
  const count = raw ? Number.parseInt(raw, 10) : 0;
  if (count >= limit) return false;
  await env.RELAY.put(key, String(count + 1), {
    expirationTtl: windowSeconds,
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

// Friendly two-word reader-token slugs (e.g. "smoky-brisket"). Short + memorable;
// low entropy by design, so the feed is obscured, not secret. Collisions are
// avoided at mint time (and a numeric suffix is appended as a last resort).
const SLUG_ADJ = [
  "smoky", "charred", "ember", "ashen", "glowing", "searing", "sizzling", "toasty",
  "spicy", "savory", "tender", "juicy", "crispy", "hearty", "rustic", "peppery",
  "tangy", "sweet", "smoldering", "blazing", "roasted", "grilled", "cured", "brined",
  "golden", "amber", "crimson", "dusky", "warm", "slow", "prime", "bold",
  "rich", "zesty", "fiery", "oaken", "mellow", "smoked", "glazed", "crackling",
  "hickory", "mesquite", "molten", "crusty", "sticky", "burnt", "lush", "bronzed",
  "humble", "happy", "lazy", "merry", "snappy", "cozy", "brisk", "dapper",
  "jolly", "nimble", "plucky", "spry", "wily", "zippy", "chunky", "frosty",
];
const SLUG_NOUN = [
  "brisket", "ribs", "ember", "coal", "smoke", "flame", "grill", "kettle",
  "probe", "char", "rub", "bark", "flank", "chuck", "rump", "shank",
  "wing", "drum", "loin", "chop", "skewer", "oak", "pecan", "spark",
  "cinder", "pit", "flare", "blaze", "sizzle", "sear", "tongs", "apron",
  "platter", "rack", "spit", "wood", "lump", "briquette", "marrow", "crust",
  "burger", "steak", "roast", "wings", "pork", "turkey", "salmon", "sausage",
  "patty", "fillet", "thigh", "breast", "tip", "round", "blade", "plate",
  "ash", "heat", "glow", "fire", "stoke", "char", "lick", "smolder",
];

async function uniqueSlug(env: Env): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const slug = randomSlug();
    const existing = await env.RELAY.get(`token:${await hashToken(slug)}`);
    if (!existing) return slug;
  }
  // Extremely unlikely fallback: disambiguate with two digits.
  const digits = crypto.getRandomValues(new Uint8Array(2));
  return `${randomSlug()}-${digits[0] % 10}${digits[1] % 10}`;
}

// Middle word (woods / fire elements) — gives the three-word slug more entropy.
const SLUG_MID = [
  "oak", "hickory", "mesquite", "pecan", "maple", "cherry", "apple", "birch",
  "cedar", "ash", "ember", "coal", "smoke", "flame", "spark", "cinder",
  "char", "fire", "heat", "glow", "pit", "stoke", "lump", "kindle",
  "blaze", "flare", "soot", "wood", "flint", "torch", "hearth", "kiln",
  "forge", "campfire", "bonfire", "brimstone", "magma", "lava", "scorch", "singe",
];

function randomSlug(): string {
  const r = crypto.getRandomValues(new Uint8Array(3));
  return [
    SLUG_ADJ[r[0] % SLUG_ADJ.length],
    SLUG_MID[r[1] % SLUG_MID.length],
    SLUG_NOUN[r[2] % SLUG_NOUN.length],
  ].join("-");
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
