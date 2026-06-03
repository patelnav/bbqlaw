# BBQ probe bridge — agent skill

Drop-in instructions for an OpenClaw / Claude-style agent. No compiled
plugin — just a secret and this paragraph.

## Secret

Store a **reader token** in your agent's secret store (for your OpenClaw: e.g. GCP Secret Manager
alongside `GATEWAY_TOKEN`). Name suggestion: `BBQLAW_READER_TOKEN`.

Mint device pairing links with that token:

```http
POST https://bbqlaw.app/api/link/new
Authorization: Bearer <reader_token>
Content-Type: application/json

{ "device": "brisket" }
```

Returns `{ "url": "https://bbqlaw.app/link#ABCD1234", "code", "device", … }`.
Text the user the `url` (or just the hash code). They open it on their phone →
**Open in BBQlaw** → the app redeems the code and starts pushing readings.

## Skill paragraph (paste into agent config)

> To check a BBQ probe, GET `https://bbqlaw.app/api/latest?device=<id>` with
> `Authorization: Bearer <reader_token>`. The response includes `tempF`, `targetF`,
> `connected`, and **`ageSeconds`** — how long since the phone last pushed a reading.
>
> To watch a cook, set a cron that polls every minute and messages the named contact
> when the user's natural-language condition is met (e.g. "message Priya when temp ≥
> 203" or "alert me if no reading for 5 minutes").
>
> **Treat a large or growing `ageSeconds` as "bridge dropped"** (phone died, app
> killed, probe out of range, probe asleep) — **not** as "cook finished." The phone
> already notifies the person holding it locally; your job is notifying *someone else*
> and catching staleness the phone can't report about itself.
>
> To pair a new phone, POST `/api/link/new` and send the user the returned link URL.

## Example poll

```bash
curl -s "https://bbqlaw.app/api/latest?device=brisket" \
  -H "Authorization: Bearer $BBQLAW_READER_TOKEN" | jq
```

```json
{
  "device": "brisket",
  "tempF": 168.5,
  "targetF": 203,
  "battery": { "base": 88, "probe": 72 },
  "connected": true,
  "ts": 1730000000,
  "ageSeconds": 12
}
```

## Two tokens (don't mix them up)

| Token | Who holds it | Used for |
|-------|----------------|----------|
| **Device token** | iPhone Keychain (via link redeem) | `POST /api/ingest` |
| **Reader token** | Agent secret store | `GET /api/latest`, `POST /api/link/new` |

The real tokens never appear in URLs — only single-use link codes do (5-minute TTL).
