# BBQlaw relay (OpenClaw bridge)

Cloudflare Worker that stores the latest probe reading and mints per-device tokens on pair.
Dumb pipe only — no threshold evaluation (see [`../docs/openclaw-bridge.md`](../docs/openclaw-bridge.md)).

## Setup

```bash
cd relay
npm install

# Local dev (optional relay/.dev.vars — copy from .dev.vars.example)
cp .dev.vars.example .dev.vars
npm run dev
```

Create the KV namespace once:

```bash
npx wrangler kv namespace create RELAY
npx wrangler kv namespace create RELAY --preview
```

Paste the returned `id` values into `wrangler.toml` under `[[kv_namespaces]]`.

## Deploy

```bash
npm run deploy
```

Preview URL: `https://bbqlaw-relay.<account>.workers.dev/api/...`

When `bbqlaw.app` DNS is live, uncomment the `routes` block in `wrangler.toml` and
redeploy so `/api/*` is served on the production domain.

## API

| Method | Path | Auth |
|--------|------|------|
| `POST` | `/api/pair` | none (rate-limited per IP) |
| `POST` | `/api/ingest` | `Bearer <device_token>` |
| `GET` | `/api/latest` | `Bearer <reader_token>` |

Quick smoke test after deploy:

```bash
BASE=https://bbqlaw-relay.<account>.workers.dev

PAIR=$(curl -s -X POST "$BASE/api/pair" -H "Content-Type: application/json" -d '{}')
echo "$PAIR" | jq

DEVICE_TOKEN=$(echo "$PAIR" | jq -r .deviceToken)
READER_TOKEN=$(echo "$PAIR" | jq -r .readerToken)
DEVICE=$(echo "$PAIR" | jq -r .device)

curl -s -X POST "$BASE/api/ingest" \
  -H "Authorization: Bearer $DEVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"device\":\"$DEVICE\",\"tempF\":168.5,\"targetF\":203,\"battery\":{\"base\":88,\"probe\":72},\"connected\":true,\"ts\":null}" | jq

curl -s "$BASE/api/latest" \
  -H "Authorization: Bearer $READER_TOKEN" | jq
```
