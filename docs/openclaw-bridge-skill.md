# BBQ probe bridge — agent skill

Drop-in instructions for an OpenClaw / Claude-style agent. No compiled
plugin — just a secret and this paragraph.

## Secret

The user pairs in the BBQlaw iOS app (**Link to your OpenClaw**), then copies the
**reader token** shown in the app. Store it in your agent's secret store (for your
OpenClaw: e.g. GCP Secret Manager alongside `GATEWAY_TOKEN`). Name suggestion:
`BBQLAW_READER_TOKEN`.

Each pairing is its own tenant — there is no shared relay secret.

## Skill paragraph (paste into agent config)

> To check a BBQ probe, GET `https://bbqlaw.app/api/latest` with
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
> If the user needs a new reader token, they tap Unlink then Link again in the app
> (this also supersedes the old phone push token).

## Example poll

```bash
curl -s "https://bbqlaw.app/api/latest" \
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
| **Device token** | iPhone Keychain (in-app pair) | `POST /api/ingest` |
| **Reader token** | Agent secret store (copied from app) | `GET /api/latest` |

The reader token is shown once at pair time — the user must copy it into OpenClaw then.
