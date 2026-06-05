export interface Env {
  RELAY: KVNamespace;
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
const HISTORY_CAP = 60;
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
  const record = await lookupToken(env, token);
  if (!record || record.type !== "reader") {
    return { error: "invalid reader token", status: 401 };
  }
  // Reader tokens are scoped to the current pairing — re-pairing revokes old ones.
  // (Tokens minted before this check have no curreader key and stay valid.)
  const currentReader = await env.RELAY.get(`device:${record.device}:curreader`);
  if (currentReader && currentReader !== (await hashToken(token))) {
    return { error: "token superseded", status: 401 };
  }
  return { device: record.device };
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

function randomSlug(): string {
  const r = crypto.getRandomValues(new Uint8Array(2));
  return `${SLUG_ADJ[r[0] % SLUG_ADJ.length]}-${SLUG_NOUN[r[1] % SLUG_NOUN.length]}`;
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
