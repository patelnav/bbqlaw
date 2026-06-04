# OpenClaw Bridge — design

Forward live probe readings off the phone so an AI agent can watch a cook and
message someone when it's done. The phone becomes the bridge.

> Status: **implemented** (relay Worker + iOS in-app pairing). Deploy + DNS for
> `bbqlaw.app` still required for production; BLE pipeline not yet confirmed on
> live hardware (see README roadmap).

## The use case

Tell your agent, in plain language:

> "Watch the brisket. Message Priya on WhatsApp when it hits 203, and tell me if
> the probe drops out for more than 5 minutes."

The phone keeps reading the probe over BLE and pushing readings to a relay. The
agent polls the relay, applies whatever natural-language condition you gave it,
and sends the message.

## The one hard constraint

BLE is local. Only a device with a Bluetooth radio sitting near the grill can
read the probe. The OpenClaw agent (e.g. your OpenClaw on a server in another country) **cannot
see the probe**. So something local has to bridge it — and we already built that
something: the iPhone running BBQlaw, which already authenticates the probe,
keeps it awake, and survives backgrounding via `bluetooth-central` + state
restoration.

So the architecture is fixed in shape: **phone reads BLE → pushes to a relay →
agent reads the relay.**

```
Probe ──BLE──> iPhone (BBQlaw) ──POST /api/ingest──┐
                                                      ▼
                                  Cloudflare Worker on bbqlaw.app
                                   • KV: latest reading per device
                                   • KV: scoped device + reader tokens
                                      ▲
        agent ──GET /api/latest──────┘   (cron poll → WhatsApp / etc.)
```

## Components

### 1. Relay — Cloudflare Worker on `bbqlaw.app`

A small Worker living alongside the existing Pages site. **It is a dumb pipe:**
it stores the latest reading and hands out scoped tokens per pairing. It
does **not** evaluate thresholds or send alerts (see "Why the relay is dumb").

Storage: Workers KV (latest reading per device + hashed token records).

#### Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/pair` | none (IP rate limit) | Phone mints device + reader tokens |
| `POST` | `/api/ingest` | device token | Phone pushes a reading |
| `GET`  | `/api/latest` | reader token | Agent reads latest (device from token) |

**`POST /api/pair`** — optional `{ "device": "brisket" }` or auto `probe-xxxxxx`
```json
{
  "device": "brisket",
  "deviceToken": "…",
  "readerToken": "…",
  "ingestUrl": "https://bbqlaw.app/api/ingest",
  "latestUrl": "https://bbqlaw.app/api/latest"
}
```
The app stores the device token; the user copies the reader token to OpenClaw.
Re-pairing updates `device:<id>:curtoken` so old device tokens return 401
`token superseded`.

**`POST /api/ingest`** — `Authorization: Bearer <device_token>`
```json
{ "device": "brisket", "tempF": 168.5, "targetF": 203,
  "battery": { "base": 88, "probe": 72 }, "connected": true, "ts": 1730000000 }
```
Stores under the device key with the server's receive time (so staleness is
measured server-side, not trusting the phone's clock).

**`GET /api/latest`** — `Authorization: Bearer <reader_token>` (no `device` query param)
```json
{ "device": "brisket", "tempF": 168.5, "targetF": 203,
  "battery": { "base": 88, "probe": 72 }, "connected": true,
  "ts": 1730000000, "ageSeconds": 12 }
```
`ageSeconds` is the key field for the agent — a large/growing age means the
bridge dropped, not that the cook finished.

### 2. iOS app (BBQlaw)

- **`BridgeClient.swift`** — when connected *and* linked, POST a reading every
  ~20s, and immediately on target-reached. Device token read from Keychain.
  No-ops when unlinked, so unlinked installs behave exactly like today.
- **In-app pair** — "Link" in `ContentView` calls `POST /api/pair`, saves device
  credentials to Keychain, shows the reader token to copy for OpenClaw.
- **UI** — "Link to your OpenClaw 🔥" row: Link / Unlink, device id, reader token
  (copy), poll URL, instructions.

The phone's existing local alarm stays exactly as-is — it's the redundant
"ding" for the person holding the phone.

### 3. Agent integration — a prompt, not a tool

This is the important part. **There is no compiled plugin or adapter to build**
on the agent side. For an OpenClaw/Claude-style agent the integration is just:

- **A reader token** from the user (copied out of the BBQlaw app at pair time —
  store in the agent's secret store, e.g. GCP Secret Manager).
- **A short skill/prompt:** *"To check a BBQ probe, GET
  `bbqlaw.app/api/latest` with the reader token. To watch a cook, set a
  cron that polls every minute and messages the named contact when the user's
  condition is met. Treat a large/growing `ageSeconds` as 'bridge dropped,' not
  'done.'"*

The "watch" is the agent's native cron + messaging. No standing infrastructure:
when you ask, it sets a cron; when the condition fires, it messages and clears
the cron. That's the whole tool.

This makes it portable. **Any** agent that can do authenticated HTTP +
scheduling integrates the same way — drop in a token and the skill paragraph.

## The two tokens

Each pairing mints two scoped secrets for one logical "cook channel":

- **Device token (write):** stays on the phone in Keychain; used for `POST /api/ingest`.
- **Reader token (read):** copied once into OpenClaw; used for `GET /api/latest`.

There is no shared relay secret and no user accounts — multi-tenant isolation
is per pairing.

## Why the relay is dumb (no relay-side alerts)

We considered letting the relay evaluate `temp ≥ X` and fire alerts itself. We
decided against it — it earns its keep in zero of the real cases:

- **The phone already dings.** BBQlaw's local notification covers the
  phone-holder without the relay involved. Relay-side thresholds just duplicate
  it.
- **The relay can't outlive the phone.** Its only data source is the phone, so
  in the one scenario a backstop would help — phone dies / app killed / probe
  out of range — the relay goes blind too. It has nothing to alert from.
- **"Notify someone else" is the agent's job.** Pinging Priya on WhatsApp with a
  natural-language condition is exactly the agent tier; routing it through the
  relay reinvents the agent with worse flexibility.

The one thing the phone genuinely can't do — alert about its **own** death
(staleness) — is covered by the agent's cron poll watching `ageSeconds`. So the
relay stays a pipe: pair, ingest, latest.

## Security notes

- Tokens are `Bearer` secrets, stored in KV only as SHA-256 hashes.
- Each pair mints fresh device + reader tokens; re-pairing supersedes old device tokens.
- Device token → iOS Keychain. Reader token → agent secret store, never in a repo.
- `POST /api/pair` is rate-limited per IP (~10/min).
- Server-side receive timestamps drive staleness, so a wrong phone clock can't
  mask a dead bridge.

## Caveats to handle when building

- **Hardware not yet validated.** The BLE decode (README roadmap) isn't
  confirmed on a live probe, so true end-to-end can't be tested until that
  works. We can build + mock the relay→agent path so it's ready.
- **Probe sleeps ~10 min** without a keep-awake. The agent's watch must read
  staleness as "lost," not "done."
- **iOS background limits.** `bluetooth-central` + state restoration keep BBQlaw
  alive across reconnects, but iOS can still kill it. The agent's staleness
  check is the safety net.

## Build order

DNS for `bbqlaw.app` first. Then:

1. **Relay Worker** (pair / ingest / latest) → deploy to a `workers.dev`
   preview to click through.
2. **iOS** — `BridgeClient` + in-app pair + Keychain + link row.
3. **OpenClaw agent** — reader token into Secret Manager + the skill paragraph. ~no code.
