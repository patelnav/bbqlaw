import { parseDictionary } from "structured-headers";
import { isBase64, isSha256Hex, isToken } from "./checks";
import { readJson, type UpdatesBucket } from "./store";

const ALGORITHM = "rsa-v1_5-sha256";
const CHANNELS = ["production", "preview"];

type Part = "manifest" | "directive";
type SignedBody = { body: string; signature: string; keyid: string; part: Part };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function signed(value: unknown, part: Part): SignedBody {
  const body = isObject(value) ? value[part] : undefined;
  if (!isObject(value) || typeof body !== "string" || !isBase64(value.signature) || !isToken(value.keyid)) {
    throw new Error("Invalid signed update envelope");
  }
  return { body, signature: value.signature, keyid: value.keyid, part };
}

/** Native clients send q-weighted Accept lists. A q=0 type is never selected. */
function negotiate(accept: string | null, multipartOnly = false): string | null {
  const offered = (accept ?? "*/*").split(",").map((item) => {
    const [type = "", ...parameters] = item.trim().toLowerCase().split(";");
    const qParameter = parameters.find((parameter) => parameter.trim().startsWith("q="));
    const q = qParameter ? Number(qParameter.trim().slice(2)) : 1;
    return { type: type.trim(), q: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0 };
  });
  return (multipartOnly ? ["multipart/mixed"] : ["multipart/mixed", "application/expo+json", "application/json"])
    .map((type) => {
      const exact = offered.find((item) => item.type === type);
      const wildcard = offered.find((item) => item.type === "*/*" || item.type === `${type.split("/")[0]}/*`);
      return { type, q: (exact ?? wildcard)?.q ?? 0 };
    })
    .filter((item) => item.q > 0)
    .sort((a, b) => b.q - a.q)[0]?.type ?? null;
}

async function manifestResponse(request: Request, bucket: UpdatesBucket): Promise<Response> {
  const headers = new Headers({
    "expo-protocol-version": "1",
    "expo-sfv-version": "0",
    "expo-manifest-filters": "",
    "cache-control": "private, max-age=0, no-store",
    vary: "accept, expo-protocol-version, expo-platform, expo-runtime-version, expo-channel-name, expo-expect-signature",
  });
  const reply = (status: number) => new Response(null, { status, headers });

  const platform = request.headers.get("expo-platform");
  const runtime = request.headers.get("expo-runtime-version");
  const channel = request.headers.get("expo-channel-name");
  if (request.headers.get("expo-protocol-version") !== "1") return reply(406);
  if ((platform !== "ios" && platform !== "android") || !isToken(runtime)) return reply(400);
  if (channel === null || !CHANNELS.includes(channel)) return reply(400);
  const accept = request.headers.get("accept");
  let contentType = negotiate(accept);
  if (!contentType) return reply(406);

  const pointer = await readJson(bucket, `pointers/${channel}/${platform}/${runtime}.json`);
  if (pointer === null) return reply(204);
  if (!isObject(pointer)) throw new Error("Invalid update pointer");

  let envelope: SignedBody;
  if (typeof pointer.directive === "string") {
    envelope = signed(pointer, "directive");
    const directive: unknown = JSON.parse(envelope.body);
    if (!isObject(directive) || directive.type !== "rollBackToEmbedded" ||
        !isObject(directive.parameters) || typeof directive.parameters.commitTime !== "string" ||
        !Number.isFinite(Date.parse(directive.parameters.commitTime))) {
      throw new Error("Invalid rollback directive");
    }
    contentType = negotiate(accept, true);
    if (!contentType) return reply(406);
  } else {
    if (!isToken(pointer.release)) throw new Error("Invalid release pointer");
    envelope = signed(await readJson(bucket, `releases/${pointer.release}/${platform}.json`), "manifest");
    const manifest: unknown = JSON.parse(envelope.body);
    if (!isObject(manifest) || manifest.runtimeVersion !== runtime) throw new Error("Release runtime mismatch");
  }

  const expectation = request.headers.get("expo-expect-signature");
  if (expectation !== null) {
    try {
      const dictionary = parseDictionary(expectation);
      const keyid = dictionary.get("keyid")?.[0];
      const alg = dictionary.get("alg")?.[0];
      if ((keyid !== undefined && keyid !== envelope.keyid) || (alg !== undefined && alg !== ALGORITHM)) {
        return reply(406);
      }
    } catch {
      return reply(400);
    }
  }

  const signature = `sig="${envelope.signature}", keyid="${envelope.keyid}", alg="${ALGORITHM}"`;
  if (contentType !== "multipart/mixed") {
    headers.set("content-type", contentType);
    headers.set("expo-signature", signature);
    return new Response(envelope.body, { headers });
  }
  const boundary = `update-${crypto.randomUUID()}`;
  headers.set("content-type", `multipart/mixed; boundary="${boundary}"`);
  return new Response(
    `--${boundary}\r\nContent-Disposition: form-data; name="${envelope.part}"\r\n` +
    `Content-Type: application/json\r\nexpo-signature: ${signature}\r\n\r\n` +
    `${envelope.body}\r\n--${boundary}--\r\n`,
    { headers },
  );
}

async function assetResponse(hash: string, bucket: UpdatesBucket): Promise<Response> {
  const file = isSha256Hex(hash) ? await bucket.get(`assets/${hash}`) : null;
  if (file === null) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(file.body, {
    headers: {
      "content-type": file.httpMetadata?.contentType ?? "application/octet-stream",
      "content-length": String(file.size),
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

/** Neither URLs nor request headers enter application logs. */
export async function handleRequest(request: Request, bucket: UpdatesBucket): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
  const { pathname } = new URL(request.url);
  try {
    if (pathname === "/health") return Response.json({ ok: true });
    if (pathname === "/manifest") return await manifestResponse(request, bucket);
    if (pathname.startsWith("/assets/")) return await assetResponse(pathname.slice("/assets/".length), bucket);
    return new Response(null, { status: 404 });
  } catch {
    return Response.json(
      { error: "Updates temporarily unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
