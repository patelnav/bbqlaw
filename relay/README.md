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

## Captures

The app uploads a Bluetooth capture only when the user taps **Send to BBQlaw**.
Create the bucket, the 90-day lifecycle rule and the admin secret once:

```bash
npx wrangler r2 bucket create bbqlaw-captures
npx wrangler r2 bucket lifecycle add bbqlaw-captures expire-90-days captures/ --expire-days 90
npx wrangler r2 bucket lifecycle list bbqlaw-captures
openssl rand -hex 32   # keep this value; it is the admin token
npx wrangler secret put CAPTURES_ADMIN_TOKEN
```

Read captures:

```bash
curl -s https://bbqlaw.app/api/captures -H "Authorization: Bearer $CAPTURES_ADMIN_TOKEN" | jq
curl -s https://bbqlaw.app/api/captures/<code> -H "Authorization: Bearer $CAPTURES_ADMIN_TOKEN" > capture.json
```

## Test

```bash
npm test
npm run typecheck
```

## Deploy

```bash
npm run deploy
```

Preview URL: `https://bbqlaw-relay.<account>.workers.dev/api/...`
Production URL: `https://bbqlaw.app/api/...`

The production route for `bbqlaw.app/api/*` is configured in `wrangler.toml`.

## API

| Method | Path | Auth |
|--------|------|------|
| `POST` | `/api/pair` | none (rate-limited per IP) |
| `POST` | `/api/ingest` | `Bearer <device_token>` |
| `GET` | `/api/latest` | `Bearer <reader_token>` |
| `GET` | `/api/history` | `Bearer <reader_token>` |
| `POST` | `/api/captures` | none (10 per hour per IP, 512 KB) |
| `GET` | `/api/captures` | `Bearer <CAPTURES_ADMIN_TOKEN>` (newest 100) |
| `GET` | `/api/captures/<code>` | `Bearer <CAPTURES_ADMIN_TOKEN>` |

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
