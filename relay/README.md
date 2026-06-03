# BBQlaw relay (OpenClaw bridge)

Cloudflare Worker that stores the latest probe reading and mints one-time link codes.
Dumb pipe only — no threshold evaluation (see [`../docs/openclaw-bridge.md`](../docs/openclaw-bridge.md)).

## Setup

```bash
cd relay
npm install

# Local dev (uses relay/.dev.vars — copy from .dev.vars.example)
cp .dev.vars.example .dev.vars
npm run dev
```

Create the KV namespace once:

```bash
npx wrangler kv namespace create RELAY
npx wrangler kv namespace create RELAY --preview
```

Paste the returned `id` values into `wrangler.toml` under `[[kv_namespaces]]`.

Set the reader token (agent secret — never commit):

```bash
npx wrangler secret put READER_TOKEN
```

## Deploy

```bash
npm run deploy
```

Preview URL: `https://bbqlaw-relay.<account>.workers.dev/api/...`

When `bbqlaw.app` DNS is live, uncomment the `routes` block in `wrangler.toml` and
redeploy so `/api/*` is served on the production domain. The static link page lives
on Cloudflare Pages at `web/link/`.

## API

| Method | Path | Auth |
|--------|------|------|
| `POST` | `/api/ingest` | `Bearer <device_token>` |
| `GET` | `/api/latest?device=<id>` | `Bearer <reader_token>` |
| `POST` | `/api/link/new` | `Bearer <reader_token>` |
| `POST` | `/api/link/redeem` | `{ "code": "…" }` |

Quick smoke test after deploy:

```bash
READER_TOKEN=… BASE=https://bbqlaw-relay….workers.dev

curl -s -X POST "$BASE/api/link/new" \
  -H "Authorization: Bearer $READER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"device":"brisket"}' | jq

# redeem (simulates the app)
curl -s -X POST "$BASE/api/link/redeem" \
  -H "Content-Type: application/json" \
  -d '{"code":"CODE_FROM_ABOVE"}' | jq
```
