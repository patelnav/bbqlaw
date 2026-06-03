# OpenClaw Bridge — design

Forward live probe readings off the phone so an AI agent can watch a cook and
message someone when it's done. The phone becomes the bridge.

> Status: **implemented** on branch `feature/openclaw-bridge` (relay Worker, `/link`
> page, iOS bridge). Deploy + DNS for `bbqlaw.app` still required for production;
> BLE pipeline not yet confirmed on live hardware (see README roadmap).

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
                                   • KV: latest reading (+ short history)
                                   • KV: one-time link codes
                                      ▲
        agent ──GET /api/latest──────┘   (cron poll → WhatsApp / etc.)
```

## Components

### 1. Relay — Cloudflare Worker on `bbqlaw.app`

A small Worker living alongside the existing Pages site. **It is a dumb pipe:**
it stores the latest reading, keeps a little history, and hands out tokens. It
does **not** evaluate thresholds or send alerts (see "Why the relay is dumb").

Storage: Workers KV (latest reading per device + link codes). A ring buffer of
recent readings is optional polish, not required for v1.

#### Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/ingest` | device token | Phone pushes a reading |
| `GET`  | `/api/latest?device=<id>` | reader token | Agent reads latest |
| `POST` | `/api/link/new` | reader token | Mint a one-time pairing code |
| `POST` | `/api/link/redeem` | (the code itself) | App trades code → device token |

**`POST /api/ingest`** — `Authorization: Bearer <device_token>`
```json
{ "device": "brisket", "tempF": 168.5, "targetF": 203,
  "battery": { "base": 88, "probe": 72 }, "connected": true, "ts": 1730000000 }
```
Stores under the device key with the server's receive time (so staleness is
measured server-side, not trusting the phone's clock).

**`GET /api/latest?device=brisket`** — `Authorization: Bearer <reader_token>`
```json
{ "device": "brisket", "tempF": 168.5, "targetF": 203,
  "battery": { "base": 88, "probe": 72 }, "connected": true,
  "ts": 1730000000, "ageSeconds": 12 }
```
`ageSeconds` is the key field for the agent — a large/growing age means the
bridge dropped, not that the cook finished.

### 2. Link page — `bbqlaw.app/link`

The fun, BBQ-themed pairing page (your OpenClaw can dress this up). It exists so the
app can learn its device token **without the token ever appearing in a URL**.

Flow:
1. Someone calls `POST /api/link/new` → relay mints a short code, 5-min TTL in
   KV → returns `https://bbqlaw.app/link#<code>`.
2. The page, opened **on the phone**, shows an **"Open in BBQlaw"** button that
   deep-links `bbqlaw://link?code=<code>`. Opened on **desktop**, it shows a QR
   of the same link instead.
3. The app calls `POST /api/link/redeem { code }` → relay returns
   `{ device, deviceToken, ingestUrl }` and **deletes the code**. App stores the
   token in the Keychain and starts pushing.

**Bidirectional, one page.** You can browse to `bbqlaw.app/link` yourself, or
the agent can text you `bbqlaw.app/link#<code>` over WhatsApp. Same page, same
flow either way.

### 3. iOS app (BBQlaw)

- **`BridgeClient.swift`** — when connected *and* linked, POST a reading every
  ~20s, and immediately on target-reached. Device token read from Keychain.
  No-ops when unlinked, so unlinked installs behave exactly like today.
- **Deep link** — `onOpenURL` handler for `bbqlaw://link?code=…` → redeem →
  store. Register the `bbqlaw` URL scheme in `Info.plist` (`CFBundleURLTypes`).
- **UI** — a small "Link to your OpenClaw 🔥" row in `ContentView` showing linked /
  unlinked state, with a button that opens `bbqlaw.app/link` (the
  user-initiated direction).
- **Keychain helper** for the device token.

The phone's existing local alarm stays exactly as-is — it's the redundant
"ding" for the person holding the phone.

### 4. Agent integration — a prompt, not a tool

This is the important part. **There is no compiled plugin or adapter to build**
on the agent side. For an OpenClaw/Claude-style agent the integration is just:

- **A reader token** (stored as a secret — for your OpenClaw, e.g. in GCP Secret Manager
  alongside `GATEWAY_TOKEN`).
- **A short skill/prompt:** *"To check a BBQ probe, GET
  `bbqlaw.app/api/latest?device=…` with the reader token. To watch a cook, set a
  cron that polls every minute and messages the named contact when the user's
  condition is met. Treat a large/growing `ageSeconds` as 'bridge dropped,' not
  'done.'"*

The "watch" is the agent's native cron + messaging. No standing infrastructure:
when you ask, it sets a cron; when the condition fires, it messages and clears
the cron. That's the whole tool.

This makes it portable. **Any** agent that can do authenticated HTTP +
scheduling integrates the same way — drop in a token and the skill paragraph.

## The two links

There are two independent pairings, easy to conflate:

- **app → relay (write):** the phone gets a *device token*. This is the
  QR / deep-link flow above.
- **agent → relay (read):** the agent gets a *reader token*. For the OpenClaw agent this is a
  one-time manual step (token into Secret Manager). For a product, the link page
  would hand out both — device token to the app, reader token + a copy-paste
  prompt to the agent.

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
relay stays a pipe: ingest, latest, link. Revisit only if we ever ship to
agentless users who specifically want third-party notification without their
phone present.

## Security notes

- Tokens are `Bearer` secrets. The **real token never appears in a URL** — only
  the throwaway, single-use, 5-min link code does.
- Link codes are one-time: redeeming deletes them.
- Device token → iOS Keychain. Reader token → the agent's secret store (e.g. GCP
  Secret Manager for your OpenClaw), never in a repo or `.env` that's committed.
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

1. **Relay Worker** (ingest / latest / link) → deploy to a `workers.dev`
   preview to click through.
2. **`/link` page** on `bbqlaw.app` — the themed pairing page.
3. **iOS** — `BridgeClient` + deep-link + Keychain + the link row.
4. **OpenClaw agent** — reader token into Secret Manager + the skill paragraph. ~no code.
