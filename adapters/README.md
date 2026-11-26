# BBQlaw adapters

An adapter adds one thermometer to BBQlaw. It is a JSON manifest plus a small
JavaScript file. A merge to `main` of `adapters/catalog.json` sends the adapter
to every installed app. No App Store update is necessary.

The full contract is in [`docs/specs/adapter-engine.md`](../docs/specs/adapter-engine.md).

## Add a thermometer

1. Get a capture. In the app, scan, tap the unsupported device, and record it.
   The capture file shows its services, characteristics and traffic.
2. Make a folder `adapters/<id>/`. Use a lowercase kebab-case id. Never change it later.
3. Write `manifest.json`. Copy `inkbird-int-11i-b/manifest.json` as a start.
4. Write `adapter.js`.
5. Write `vectors.json` with real bytes from your capture.
6. Run `node adapters/tools/build.mjs`. It checks everything and writes
   `catalog.json` and `test-vectors.json`. Do not edit those two files by hand.
7. Commit all files and open a pull request.

To change a released adapter, increase `version`. To withdraw it, increase
`version` and set `"disabled": true`.

## Manifest

| Field | Meaning |
|---|---|
| `id`, `name` | Stable id and display name. |
| `version` | Integer. The highest version wins. |
| `engine` | Minimum engine version. The current engine is `1`. |
| `match` | Rules. A device matches if any rule matches. All fields in one rule must match. |
| `match[].namePrefix` | Case-insensitive prefix of the advertised name. |
| `match[].service` | An advertised service UUID. |
| `match[].manufacturerId` | Bluetooth company id (first two bytes of manufacturer data, little-endian). |
| `gatt.notify` | Characteristics to subscribe to before `onReady`. |
| `gatt.read` | Characteristics to read once after `onReady`. |
| `gatt.write` | The only characteristics the script can write. |
| `channels` | Maximum number of probe channels, 1 to 8. |
| `capabilities` | `food` (required), `ambient`, `battery`, `docked`, `deviceAlarm`. |

A UUID is 4 hex digits, or a hyphenated 128-bit UUID.

Do not match on a common vendor service alone. Other thermometers use it too.

## Script

The script is plain ES2017. It has no modules. Each connected device gets its own
context. It defines a global `adapter`:

```js
var adapter = {
  onReady: function () {},                    // required
  onNotify: function (char, bytes) {},        // required; char = uppercase UUID
  setTarget: function (channel, highF) {},    // deviceAlarm; highF null = clear
  setBuzzer: function (channel, muted) {}     // deviceAlarm
};
```

`host` is the only API:

| Call | Effect |
|---|---|
| `host.write(char, bytes)` | Write without response. |
| `host.writeWithResponse(char, bytes)` | Write with response. |
| `host.reading(channel, {state, foodF, ambientF})` | `state` is `live`, `docked` or `none`. `live` needs `foodF`. |
| `host.battery({base, probe, channel})` | A patch. An omitted key keeps its value. `null` clears it. |
| `host.status(s, reason)` | `authenticating`, `waiting`, `ready` or `failed`. |
| `host.after(ms, fn)` | One-shot timer. |
| `host.nowMs()` | Epoch milliseconds. |
| `host.log(msg)` | Debug log. |

Call `host.status("ready")` when the device streams. If the device needs no
authentication, call it in `onReady`. The app calls `setTarget` and `setBuzzer`
only after `ready`.

The host drops a call with bad input. Bytes must be integers from 0 to 255.

## Vectors

`vectors.json` is a list of cases. Each case uses a new runtime.

```json
{
  "name": "temp: live 84.5",
  "nowMs": 1779980959482,
  "steps": [ { "notify": { "char": "FF01", "hex": "02211f" } } ],
  "expect": { "readings": [ { "channel": 0, "state": "live", "foodF": 84.5 } ] }
}
```

- Steps: `ready`, `notify`, `setTarget`, `setBuzzer`, `advance` (milliseconds).
- `expect` keys: `writes`, `readings`, `battery`, `status`. A key that you omit
  is not checked. A key that you include must match exactly and in order.
- A `writes` entry is `{char, hex, withResponse}`. `withResponse` defaults to `false`.
- A `readings` entry is the object you passed, plus `channel`.
- A `battery` entry holds only the keys you passed.

## Send one person a test adapter

Push a branch. Ask the person to open Settings → Advanced → **Adapter test URL**
and enter the raw GitHub link to `adapters/catalog.json` on that branch. The app
accepts only links to this repository. Clear the field to return to the normal catalog.
