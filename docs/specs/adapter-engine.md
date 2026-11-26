# Spec: Over-the-air thermometer adapters (engine v1)

Status: approved for build. Owner: Nav. Branch: `feat/adapter-engine`.
Revision 2: includes the Gemini 4 Neon review fixes.

## 1. Goal

BBQlaw supports a new Bluetooth thermometer without an App Store update.
Each thermometer is an **adapter**: a JSON manifest plus a small JavaScript file.
A merge to `main` of `adapters/catalog.json` publishes adapters to every installed app.

This release is the last app update that the adapter model needs. It ships:

1. The adapter engine (JavaScriptCore host) and the catalog loader.
2. The INKBIRD INT-11I-B moved from hard-coded Swift into the first adapter.
3. **Capture mode**: a user with an unsupported thermometer records its Bluetooth
   layout and traffic and shares the file with us. This is how we get the data to
   write new adapters (first target: a friend's ThermoMaven).
4. Multi-channel devices (several probes on one base) and ambient temperature.

Non-goals: cloud accounts, Wi-Fi thermometers, adapter signing (§12), an
in-app adapter editor, iPad, in-app vector runs.

## 2. Hard requirements

- **R1 No regression on INT-11I-B.** Auth, temperature, battery, docked state,
  base target alarm, buzzer mute, watch-only, reconnect and state restoration must
  behave byte-for-byte as today. The golden vectors in §9 prove the bytes.
- **R2 Existing saved cooks survive the upgrade.** Probe id for channel 0 stays
  `peripheral.identifier`. A persisted v1.0 cook record without `adapterId` maps
  to `inkbird-int-11i-b`.
- **R3 Offline first launch works.** The app bundles a copy of `adapters/catalog.json`.
- **R4 A bad remote catalog never breaks or crashes the app.** Each adapter is
  validated before use (§6). A failing adapter is skipped; the bundled or cached
  version stays in use. No remote string reaches `CBUUID(string:)` unvalidated.
- **R5 Capture mode never writes to the device.** It reads and subscribes only.
- **R6 An unsupported device never shows as "Connected" with no reading.** Today
  any device in the scan list can be connected (see the ThermoMaven photo).

## 3. Repository layout

```
adapters/
  README.md                         contributor guide (write + test an adapter)
  catalog.json                      GENERATED. The one file the app downloads. No vectors.
  test-vectors.json                 GENERATED. {adapterId: [cases]}. Test-bundle resource only.
  tools/build.mjs                   node, no deps: validate, run vectors, write both files
  tools/build.mjs --check           exit 1 if a generated file is stale or any vector fails
  inkbird-int-11i-b/
    manifest.json
    adapter.js
    vectors.json
web/functions/adapters/catalog.json.js   Pages Function: proxy to GitHub raw main
docs/specs/adapter-engine.md        this file
```

`history/` is gitignored. Every fact needed from it is copied into this spec.

## 4. UUIDs (applies everywhere)

A UUID string in a manifest, a vector, or a `host.write*` call is valid only if:
- it is 4 hex digits (16-bit), or
- `UUID(uuidString:)` parses it (128-bit, hyphenated).

Check 16-bit form by length 4 and every character in `0-9A-Fa-f`. Do not use
regex. Call `CBUUID(string:)` only on a valid string (it raises an uncatchable
Objective-C exception otherwise).

Canonical form: uppercase. A 128-bit UUID on the Bluetooth base
(`0000xxxx-0000-1000-8000-00805F9B34FB`) canonicalises to its 4-digit form, the
same as `CBUUID.uuidString`. `build.mjs` applies the same rule. The `char` string
passed to `onNotify` is the canonical form.

## 5. Manifest (`manifest.json`)

```json
{
  "id": "inkbird-int-11i-b",
  "version": 1,
  "engine": 1,
  "name": "INKBIRD INT-11I-B",
  "match": [
    { "namePrefix": "INT-11" },
    { "namePrefix": "INKBIRD" }
  ],
  "gatt": {
    "notify": ["FF01", "FF02", "FF03", "FF04", "FF05", "FF06", "2A19"],
    "read":   ["2A19"],
    "write":  ["FF02"]
  },
  "channels": 1,
  "capabilities": ["food", "battery", "docked", "deviceAlarm"]
}
```

Field rules:
- `id`: lowercase kebab-case, stable forever.
- `version`: integer. Higher wins (§6).
- `engine`: minimum engine version. App engine version is `1`. Adapters with a
  higher `engine` are skipped.
- `match`: an array of rules. A device matches the adapter when **any** rule
  matches. Inside one rule, **all** present fields must match (AND). A rule must
  have at least one field. Fields:
  - `namePrefix`: case-insensitive prefix of the advertised local name
    (fallback `peripheral.name`).
  - `service`: a UUID in the advertised service UUIDs.
  - `manufacturerId`: integer Bluetooth company id = first two bytes,
    little-endian, of advertised manufacturer data.
- Ranking when several adapters match one device: the rule with the most fields
  wins; then the longest `namePrefix`; then `id` alphabetical. The INT-11I-B
  manifest deliberately has no service-only rule: `FF00` is common across vendors
  and must not claim other thermometers. Widening a match later is an OTA change.
- `gatt.notify`: characteristics (any service) the engine subscribes to before it
  calls `onReady`.
- `gatt.read`: characteristics the engine reads once, **after** `onReady`. Their
  values go to `onNotify` like notifications.
- `gatt.write`: the only characteristics the adapter may write. A write to any
  other UUID is dropped and logged.
- `channels`: maximum probe channels (1–8).
- `capabilities` (closed set in engine v1; unknown values ignored):
  - `food` — food temperature per channel (required).
  - `ambient` — ambient temperature per channel.
  - `battery` — base and/or probe battery.
  - `docked` — reports "probe in base".
  - `deviceAlarm` — base target alarm and buzzer mute. Requires `setTarget` and
    `setBuzzer` in the script.
- Optional `"disabled": true` — this version withdraws the adapter.
- Optional `"notes"`: free text. Ignored by the app.

## 6. Catalog

### Format (`adapters/catalog.json`)

```json
{ "schema": 1, "adapters": [ { ...manifest fields..., "script": "<adapter.js source>" } ] }
```

`build.mjs` writes it (and `test-vectors.json`) with sorted keys, 2-space indent,
adapters sorted by `id`, no timestamp, so `--check` is deterministic.

### Sources

1. **Bundled**: `adapters/catalog.json` is a resource of the BBQlaw target.
2. **Cached remote**: last valid remote catalog in
   `Application Support/adapters/catalog.json`.
3. **Remote**: `https://bbqlaw.app/adapters/catalog.json`.
4. **Test URL** (Settings → Advanced → "Adapter test URL", UserDefaults
   `bbqlaw.adapters.testURL`). Accepted only when `URLComponents` gives scheme
   `https`, host `raw.githubusercontent.com`, and a path that starts with
   `/patelnav/bbqlaw/`. Any other value is rejected in the field with
   "Only BBQlaw repository links work here." When set, it replaces source 3, and
   its result is cached separately at `Application Support/adapters/test-catalog.json`
   (so background restoration still finds the adapter). Clearing the field deletes
   that file. Purpose: Nav sends one person an unreleased adapter from a branch.

### Selection

For each `id`, use the highest `version` across bundled + cached (+ test cache)
that passes validation and has `engine <= 1`. If that winner has
`"disabled": true`, the adapter is unavailable.

### Load order and threading

- `ThermometerManager.init(defaults:catalog:)` takes an `AdapterCatalog`.
  The default catalog loads bundled + cached files **synchronously, before**
  `CBCentralManager` is created, so `willRestoreState` can resolve adapters.
- Tests pass a catalog built from the bundled file only, with fetching disabled.
  Unit tests never touch the network.

### Fetch

- On launch, and on `startScan()` if `lastFetchAt` (UserDefaults
  `bbqlaw.adapters.lastFetchAt`, a `Double` epoch) is older than 1 hour. Never
  read file timestamps (privacy manifest category FileTimestamp).
- `URLSession`, 10 s timeout, `.reloadIgnoringLocalCacheData`.
- Validate on a background queue with its own `JSVirtualMachine`. On success,
  write the data to the cache file atomically, set `lastFetchAt`, then on main:
  replace the selection and re-run matching over `discovered`.
- A failure keeps the current set. No user-visible error.
- A connected device keeps its running adapter instance. A new version applies
  on the next connect.

### Validation (per adapter, at load)

1. Decodes into the manifest model; required fields present; `channels` 1–8;
   every UUID valid (§4); every match rule non-empty.
2. Script evaluates in a fresh `JSContext` with no exception and defines
   `adapter.onReady` and `adapter.onNotify` as functions, plus `setTarget` and
   `setBuzzer` when `deviceAlarm` is declared.

A failing adapter is skipped and logged. Other adapters in the file still load.
Vectors are **not** run in the app. They run in `build.mjs` and in XCTest.

### Hosting

`web/functions/adapters/catalog.json.js` fetches
`https://raw.githubusercontent.com/patelnav/bbqlaw/main/adapters/catalog.json`.
If `res.ok` is false or the body fails `JSON.parse`, return 502 with
`cache-control: no-store`. Otherwise return the body with
`content-type: application/json` and `cache-control: public, max-age=300`.

## 7. Adapter script API (`adapter.js`)

Plain ES2017 script, no modules. One `JSContext` per connected device, so
top-level `var` state is per device. The script defines a global `adapter`:

```js
var adapter = {
  onReady: function () {},                    // required. All gatt.notify subscriptions settled.
  onNotify: function (char, bytes) {},        // required. char = canonical UUID, bytes = number[]
  setTarget: function (channel, highF) {},    // deviceAlarm. highF = number, or null to clear
  setBuzzer: function (channel, muted) {}     // deviceAlarm. muted = boolean
};
```

Host object `host` (the only API; no network, file or other timer API):

| Call | Effect |
|---|---|
| `host.write(char, bytes)` | Write **without** response. `char` must be in `gatt.write`. |
| `host.writeWithResponse(char, bytes)` | Write with response. Same allowlist. |
| `host.reading(channel, r)` | `r = {state: "live"|"docked"|"none", foodF?, ambientF?}`. |
| `host.battery(b)` | `b = {base?, probe?, channel?}`. Patch: an omitted key keeps the old value; `null` clears it. `channel` defaults to 0. |
| `host.status(s, reason?)` | `s` = `"authenticating"` / `"waiting"` / `"ready"` / `"failed"`. |
| `host.after(ms, fn)` | One-shot timer. Cancelled on disconnect. |
| `host.nowMs()` | Epoch milliseconds. Tests inject a value. |
| `host.log(msg)` | Debug log (`os.Logger`, category `adapter`). |

Input checks (host side; a failed check drops the call and logs it):
- `bytes`: a JS array or typed array. Read elements directly from the `JSValue`
  (`isArray` → `length` + `atIndex`; typed array → `length` + `atIndex`). Each
  element must be `isNumber`, finite, an integer, 0–255. Do not use `toArray()`
  (booleans bridge to `NSNumber`).
- Numbers (`foodF`, `ambientF`, `base`, `probe`, `ms`): `isNumber` and finite.
  `null`/`undefined` mean "absent". Never use `toDouble()` on a non-number.
- `channel`: integer in `0..<channels`.
- `state == "live"` requires a finite `foodF`.
- `base`/`probe`: clamp to 0–100.

Status rules:
- The engine sets status `subscribing` while it subscribes.
- The adapter calls `host.status("ready")` once the device streams. An adapter
  without auth calls it inside `onReady`.
- `ready` clears `lastError`. `failed` with a `reason` sets `lastError = reason`.
- When status becomes `ready`, the manager pushes the current target and buzzer
  state for every existing channel probe (today's post-auth behaviour).
- `setTarget`/`setBuzzer` are dispatched only when status is `ready` and the
  adapter has `deviceAlarm`. **The host runtime enforces this** (both the Swift
  runtime and the node runner), so vectors can test it.
- Status mapping to the existing `AuthState`: `subscribing→.subscribing`,
  `authenticating→.requested`, `waiting→.waiting`, `ready→.authed`,
  `failed→.failed`. Keep the enum and its UI labels.

Runtime rules:
- JS exceptions are caught by `exceptionHandler`, logged, and set `lastError`.
- Everything runs on the main queue, except background validation (§6).
- `AdapterRuntime.invalidate()` runs on disconnect and removal: cancel all
  timers, drop stored `JSValue` callbacks, clear `exceptionHandler`, remove
  `host` from the global object. Host closures capture the runtime weakly. A
  timer that fires after `invalidate()` does nothing.

## 8. Engine behaviour in `ThermometerManager`

### Scan list
- `DiscoveredDevice` gains `advertisedName: String?` (nil when the device has no
  name), `manufacturerData: Data?`, `serviceData: [CBUUID: Data]`, and
  `adapter: AdapterInfo?` (id + display name). On repeat discoveries, merge
  non-nil fields (scan responses arrive separately). Equality compares
  `id`, `name`, `rssi`, and `adapter?.id`.
- Delete `looksLikeThermometer` and `ProbeGATT.nameHints`; the adapter match
  replaces them.
- Sheet sections: **Supported** (matched; subtitle = adapter name; tap =
  connect) and **Other Bluetooth devices** (unmatched with a non-empty
  `advertisedName`). Tapping an unmatched device opens the capture sheet (§10).

### Connect and session (discovery barrier)
- `sessions` is keyed by **device id** (`peripheral.identifier`).
- `ProbeSession` holds the manifest, the `AdapterRuntime`, `pendingServices`,
  `pendingNotify`, `charsByUUID`, `status`, and buffered per-channel battery.
  `controlCharacteristic`, `authAttempts`, `challengeSeen` move into the INKBIRD
  adapter and are deleted from Swift.
- `connect(_:)` persists `adapterId` for the device at once (§8 Persistence).
- Discovery:
  1. `didDiscoverServices`: on error or zero services → mismatch (below).
     Otherwise set `pendingServices` and discover characteristics for each.
  2. `didDiscoverCharacteristicsFor`: record characteristics; remove the service
     from `pendingServices` **even on error** (log the error).
  3. When `pendingServices` is empty: if no discovered characteristic is in
     `notify ∪ read ∪ write` → mismatch. Otherwise subscribe to every
     `gatt.notify` char that supports notify or indicate (skip and log missing
     ones) and add each to `pendingNotify`.
  4. `didUpdateNotificationStateFor`: remove the char from `pendingNotify`
     **even on error** (log it). When empty → `onReady()`, then read each
     `gatt.read` char. If step 3 subscribed nothing, call `onReady()` at once.
- `didUpdateValueFor` → `adapter.onNotify(char, bytes)` for every char.
- On disconnect: `invalidate()` the runtime. A reconnect builds a fresh runtime.

### Mismatch (R6)
A matched device whose GATT does not fit its manifest: cancel the connection
with `userInitiatedDisconnect = true`, remove its session and probe cards, and
set `@Published var unsupportedDevice: DiscoveredDevice?`. `ContentView` shows
an alert "BBQlaw can't read this thermometer yet" with **Record capture** (opens
§10 for that device) and **OK**.

### Channels
- `Probe` gains `deviceId: UUID`, `channel: Int`, `ambientF: Double?`,
  `capabilities: Set<String>`, `adapterId: String`.
- Channel 0 probe id = `peripheral.identifier` (R2). Channel n > 0 id = the
  peripheral UUID with its last byte XOR `n`.
- Channel 0 card is created at connect. A channel n > 0 card is created on the
  first `host.reading` for that channel with `state == "live"`. If the session is
  already `ready`, push that channel's target and buzzer state at once. Apply any
  buffered battery for that channel at creation.
- Readings: `live` → `tempF`, `mode = .live`, append to `recentTemps` (cap 60),
  evaluate alarm, exactly as today. `docked`/`none` keep today's notes
  ("Docked · battery full" / "Charging in base station" / "No probe reading").
  `ambientF` updates whenever present.
- Device-level state (connection, status, base battery) is written to every
  probe with that `deviceId`. `resetReadings` resets all of them and clears
  `ambientF`.
- `removeProbe(id)` removes every probe with the same `deviceId`, disconnects,
  and deletes every persisted record for that device.
- `ContentView`: `canRemove` uses the count of distinct `deviceId`s. Auto-select
  a new card only after a user-initiated `connect()`, not when a channel card
  appears later.
- Watch-only copy that mentions the base buzzer shows only with `deviceAlarm`.

### Device alarm
`setDeviceTarget`, `clearDeviceTarget`, `setDeviceBuzzer` become calls to
`adapter.setTarget(channel, highF|null)` and `adapter.setBuzzer(channel, muted)`
on the probe's device session. The 0.5 s debounce, the post-ready push, and
watch-only logic stay in Swift.

### Persistence and restoration
- `PersistedCook` gains optional `adapterId`. Keep key `bbqlaw.cooks.v2` and
  decoding of old records.
- `connect(_:)` writes a record for channel 0 (with defaults if new) that
  includes `adapterId`.
- `willRestoreState`: for each restored peripheral, look up its channel-0
  record. Record with `adapterId` → that adapter. Record without `adapterId`
  (v1.0 data) → `inkbird-int-11i-b`. No record, or the adapter is missing or
  disabled → cancel the connection and do not create a probe.

### UI gates (capability-driven)
- Battery tiles show only with `battery`.
- The base-buzzer mute control shows only with `deviceAlarm`.
- With `ambient`, the probe card shows `Ambient 98°` (respects °F/°C) under the
  big temperature, using tokens from `DesignSystem.swift`.
- No other UI changes besides §8 Mismatch, the scan sections, §10, and the
  Settings test URL field.

### OpenClaw bridge
No change beyond compiling. Channel probes appear as separate probes.

## 9. Golden vectors

`vectors.json` is a list of cases. Each case runs in a fresh runtime with
`channels`, `gatt.write` and `deviceAlarm` from the manifest.

```json
{
  "name": "auth: challenge -> verify",
  "nowMs": 1779980959482,
  "steps": [
    { "ready": true },
    { "notify": { "char": "FF02", "hex": "07fb2a19e11e78aa" } },
    { "notify": { "char": "FF02", "hex": "02fc00" } },
    { "setTarget": { "channel": 0, "highF": 165 } }
  ],
  "expect": {
    "writes": [
      { "char": "FF02", "hex": "01fb" },
      { "char": "FF02", "hex": "08fce2019f5a186a78" },
      { "char": "FF02", "hex": "09010110744000000a1b06230100000000" }
    ],
    "status": ["authenticating", "ready"]
  }
}
```

Step semantics:
- `ready` → `onReady()`. `notify` → `onNotify(char, bytes)`.
- `setTarget` / `setBuzzer` → dispatched through the host gate (§7): dropped
  unless status is `ready`.
- `advance: ms` → discrete-event loop: while the earliest timer's due time
  ≤ now + ms, set now to that due time and fire it (timers it schedules join the
  queue); then set now to the target. Ties fire in scheduling order.
  `host.nowMs()` returns the case `nowMs` + elapsed virtual time.

Expect semantics: for each key present (`writes`, `readings`, `battery`,
`status`), the recorded list must equal it exactly and in order. Absent keys are
not checked. `writes` entries are `{char, hex, withResponse?}`; `withResponse`
defaults to false and is compared. `hex` is lowercase, no spaces. `status`
records `s` only (not `reason`, not the engine's `subscribing`). Floats compare
with tolerance 0.001. A recorded reading or battery object contains only the keys
the adapter passed; `null` values are recorded as `null`.

Runners: `build.mjs` (node `vm`) and Swift `AdapterVectorRunner` (XCTest only).
Both use the real host-side checks and gate from §7.

### Required INT-11I-B vectors (from the current Swift code)

**Auth (17 cases).** Steps: `ready`, notify FF02 `07fb<challenge>`. Expect
writes `01fb`, then `08fc<response>`; status `["authenticating"]`.

| challenge | response | nowMs |
|---|---|---|
| 2a19e11e78aa | e2019f5a186a78 | 1779980959482 |
| 5d734b60667d | 2100e45a186a9c | 1779981028033 |
| 47377c8de21e | a401135b186aa5 | 1779981075420 |
| 596c67b2e5d3 | 80003a5b186a8f | 1779981114128 |
| cb6ec0dcf745 | 1e02665b186a54 | 1779981158542 |
| b5af2104872d | 41038f5b186a78 | 1779981199833 |
| ffa2421a66a9 | 2b00a75b186a24 | 1779981223043 |
| 8950e5402fc7 | 2f02cf5b186a85 | 1779981263559 |
| 6ba0ca5c6ee9 | 2103ec5b186a10 | 1779981292801 |
| 2daa38762211 | d201075c186a2b | 1779981319466 |
| a00e0f1e07ce | 92009259186afd | 1779980690146 |
| b806c756e057 | 0e03cd57186aa1 | 1779980237782 |
| 4a6db7788717 | 7201f157186a87 | 1779980273370 |
| ec7039b602f2 | 64033158186a4c | 1779980337868 |
| 3e3548d38de7 | 52015058186ae8 | 1779980368338 |
| b0b70b26dcec | 6d01265d186a2a | 1779981606365 |
| d228101ad821 | aa02325f186aa0 | 1779982130682 |

Algorithm (today's `buildAuthResponse`): millis = nowMs; epoch = floor(millis/1000)
as u32; rem = millis % 1000 as u16; time6 = rem LE16 + epoch LE32;
inner = CRC8(time6, poly 0xD5, init 0x00); cdma = CRC8(challenge, poly 0x9B,
init 0xFF); chk = CRC8(time6 + [inner, cdma], poly 0xD5, init 0x00);
packet = `08 fc` + time6 + chk. CRC8 is MSB-first, non-reflected.

**Auth flow.**
- ACK `02fc00` → status `ready`. `02fc01` → status `failed` with reason
  `auth rejected (status 1)`.
- Retry: `ready` with no challenge, then `advance 12500` → writes `01fb` ×5
  (at 0, 2.5, 5, 7.5, 10 s); status `["authenticating" ×5, "waiting"]`.
- A challenge after `ready` writes nothing.
- FF02 frame parsing: `<LEN><TYPE><body>` concatenated; LEN counts TYPE; stop at
  LEN 0 or a frame past the end (today's `parseControlFrames`). Challenge needs
  body ≥ 6 bytes; the first 6 are used.

**Temperature (FF01)**, decoded in any status: `02211f` → live 84.5;
`fe7f00`, `ff7f00`, `008000` → docked; `000000`, `ffff00` → none; `02` → none.
Raw = LE16 of bytes 0–1; °F = raw / 100.

**Battery (2A19):** `5037` → `{base: 80, probe: 55}`; `50` → `{base: 80, probe: null}`;
empty → `{base: null, probe: null}`.

**Device alarm (after ACK `02fc00`):**
- setTarget 165 → `09010110744000000a1b06230100000000` (one write).
- setTarget null → `0a0101000000000000000006230100000000`.
- setBuzzer muted → `030b1101`; unmuted → `030b5a02`.
- setTarget before `ready` → no write.

Target frame derivation: scaled = clamp(Int(f × 100), 0, 65535) as LE16;
frame1 body = `[01, 10, scaledLE16, 00 00, 0a, 1b]`; frame2 body =
`[01, 00, 00, 00, 00]`; frame(type, body) = `[1 + body.count, type] + body`;
payload = frame(0x01, frame1) + frame(0x23, frame2). Clear: frame(0x01,
`[01, 00×8]`) + frame(0x23, `[01, 00×4]`).

## 10. Capture mode

Entry points: an unmatched device in the scan sheet, and the §8 Mismatch alert.
Sheet title "Help add this thermometer".

Implementation: a separate `CaptureSession` class with its **own**
`CBCentralManager` (no restore identifier, so a capture is never restored). It
gets the peripheral with `retrievePeripherals(withIdentifiers:)`.

Flow:
1. Copy: "BBQlaw doesn't support this thermometer yet. Record 60 seconds of its
   Bluetooth data and send it to us. BBQlaw only listens; it sends nothing to the
   thermometer." Button **Start recording**.
2. Connect. Discover all services and characteristics (no descriptors). For each
   readable characteristic, read once and wait for the result (record
   `readValue` or `readError`) before subscribing it. Then subscribe every
   notify or indicate characteristic. Values arriving after a subscription are
   `events`. Never write (R5).
3. Show a 60 s countdown and a live packet count. Copy: "Use the thermometer
   while this runs: take the probe out, warm it in your hand, change the target
   on the base."
4. End at 0 s, on **Stop**, on unexpected disconnect, when the sheet closes, or
   when the app goes to the background. Disconnect and write the file with what
   was recorded (`"endedBy": "timer"|"stop"|"disconnect"|"dismissed"|"background"`).
   Show **Share capture** (`ShareLink`) and **Done**.

File name: `bbqlaw-capture-<name>-<yyyyMMdd-HHmm>.json` in the temporary
directory. `<name>` keeps only ASCII letters, digits, `-` and `_` (filter with
a `CharacterSet`), max 32 chars, `device` if empty.

```json
{
  "bbqlawCapture": 1,
  "app": "1.1.0 (3)",
  "ios": "26.1",
  "endedBy": "timer",
  "advertisement": { "name": "...", "rssi": -60, "services": ["..."], "manufacturerData": "hex", "serviceData": {"UUID": "hex"} },
  "services": [ { "uuid": "FF00", "characteristics": [ { "uuid": "FF01", "properties": ["notify","read"], "readValue": "hex|null", "readError": "string|null" } ] } ],
  "events": [ { "t": 1234, "char": "FF01", "hex": "02211f" } ]
}
```

`t` = ms since recording started. Cap events at 5,000. A capture is never a
`Probe`, never persisted, never reconnected.

## 11. Implementation phases (each ends green)

1. **Adapters folder.** INT-11I-B `manifest.json`, `adapter.js`, `vectors.json`
   (all §9 cases); `build.mjs` (+ `--check`); generated `catalog.json` and
   `test-vectors.json`; `adapters/README.md`.
   Gate: `node adapters/tools/build.mjs --check`.
2. **Swift engine.** `AdapterCatalog.swift` (models, UUID validation, load,
   select, fetch, cache, validation), `AdapterRuntime.swift` (JSContext host,
   checks, gate, timers with injectable clock, `invalidate`).
   Test target: `AdapterVectorRunner.swift` and `AdapterTests.swift`:
   bundled catalog loads; every case in `test-vectors.json` passes; allowlist
   drops a bad write; malformed UUID in a manifest is rejected without a crash;
   selection picks the higher version, ignores `engine: 2`, honours `disabled`;
   an invalid script is skipped while a valid one in the same file loads;
   match ranking; channel id derivation; battery patch semantics.
   `project.yml`: `adapters/catalog.json` → BBQlaw resource;
   `adapters/test-vectors.json` → BBQlawTests resource.
3. **Manager refactor.** Route INT-11I-B through the adapter; discovery barrier;
   channels; ambient; capability gates; persistence/restoration; mismatch alert.
   Delete the Swift auth/decode/frame code the adapter replaces.
   `WatchOnlyTests` stay green (update only construction details).
4. **Capture mode, scan sheet sections, Settings test URL.**
5. **Pages Function**, README "Add a thermometer" section (replace the roadmap
   paragraph), `MARKETING_VERSION 1.1.0`, `CURRENT_PROJECT_VERSION 3`.

## 12. Decisions (and how to reverse them)

- **JavaScript via JavaScriptCore.** Auth handshakes need CRCs and clocks.
  Apple's license (3.3.1(B)) and guideline 2.5.2 allow downloaded interpreted
  code run by JavaScriptCore when it does not change the app's purpose.
  Thermometer drivers are the app's stated purpose. The test URL accepts only our
  own repository, so the app never runs code from an arbitrary source.
- **No catalog signing in v1.** Publishing = a merge to our public repo, the same
  trust as the app source. The sandbox has no network or file access and writes
  only declared characteristics. Reverse: Ed25519 signature + public key (engine v2).
- **No JS execution time limit.** Public JavaScriptCore has no API for it.
  Adapters are reviewed in pull requests.
- **Hosting via bbqlaw.app proxy of GitHub raw.** Stable URL, no deploy per adapter.
- **1 h refresh, 60 s capture, 5,000 event cap, lazy channel cards, no
  descriptors in captures.** Engine choices.

## 13. Build and test traps

- BLE does not work in the Simulator. Unit tests run there; device behaviour
  needs Nav's INT-11I-B on a real iPhone.
- Run `xcodegen generate` after editing `project.yml` or adding files.
- Test: `xcodebuild test -project BBQlaw.xcodeproj -scheme BBQlaw -destination 'platform=iOS Simulator,name=iPhone 18 Pro' 2>&1 | tee <scratch>/test.txt`, then read the file.
- No single test may take more than 5 s.
- `PrivacyInfo.xcprivacy`: no new required-reason APIs. Do not read file
  timestamps; do not add disk-space or boot-time APIs.
- `lastError` is not shown in the UI today. Only the §8 Mismatch alert is new.
