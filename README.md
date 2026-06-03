# BBQlaw 🔥🐾

A free, fully-local iOS app for **INT-11I-B** class wireless meat thermometers.
No account, no cloud, no vendor app — your iPhone talks straight to the probe
over Bluetooth.

> Status: **v0.1 — builds clean, core BLE pipeline implemented.** Not yet tested
> against live hardware (waiting to confirm the protocol on a real probe).

## Why

The INT-11I-B is a solid, cheap BLE thermometer, but the stock app requires an
account and is more than most cooks need. BBQlaw is a single-screen, local-only
reader: connect, see the temp, get a notification when your target is hit. The
INT-series BLE protocol was reverse-engineered by the Home Assistant community;
BBQlaw is a native iOS implementation of it.

## What works in v0.1

- Scan + connect to the thermometer over CoreBluetooth (with a device picker
  that flags likely thermometers)
- Live food-temperature readout (°F/°C toggle)
- Probe + base battery levels
- Target temperature with a local **push notification** when reached
  (works backgrounded via the `bluetooth-central` background mode)
- Raw `FF01` hex shown on-screen to confirm decoding on first real connect

## Protocol (INT-11I-B)

Recovered from the HA community ESPHome integration:

| What | UUID | Format |
|------|------|--------|
| Service | `FF00` | — |
| Temperature | `FF01` (notify) | 2-byte little-endian, **°F × 100** (e.g. `0x0BB8` = 3000 = 30.00 °F) |
| Battery | `2A19` (read) | byte 0 = base %, byte 1 = probe % |

**Known gotcha:** the probe sleeps ~10 min after the last "recipe" was set in the
official app. Set a target once in the manufacturer's companion app to wake it, *then*
use BBQlaw. Open question (see Roadmap): can we send our own keep-awake write?

**Hardware limit:** the INT-11I-B has **no ambient/pit sensor** — food temp only.
BBQlaw cannot show grill temp; that's a hardware constraint, not a software one.

## Build

Requires Xcode + [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).

```bash
cd ~/Developer/BBQlaw
xcodegen generate          # regenerates BBQlaw.xcodeproj from project.yml
open BBQlaw.xcodeproj       # then run on your iPhone (BLE needs a real device)
```

Notes:
- **BLE does not work in the iOS Simulator** — run on a physical iPhone.
- If `actool`/simulator builds fail with "No simulator runtime version …
  available", download the matching iOS simulator runtime in
  Xcode ▸ Settings ▸ Components. (Doesn't affect device builds.)
- `project.yml` is the source of truth; `BBQlaw.xcodeproj` is generated and
  gitignored.

## Roadmap

- [ ] **Confirm protocol on live hardware** — connect, verify `FF01` decodes to
      real °F, ice-bath/boil check (see `../scratchpad/therm/RECON.md`).
- [ ] **Crack the keep-awake handshake** — sniff the official app with Apple's
      PacketLogger; replicate the recipe/enable write so BBQlaw alone keeps the
      probe awake.
- [ ] Cook history graph + share/export
- [ ] Multiple presets (USDA doneness targets)
- [ ] **OpenClaw bridge** — optional forward of live readings to a relay so an
      agent can watch the cook (the phone becomes the bridge). Implemented on
      `feature/openclaw-bridge`; design: [`docs/openclaw-bridge.md`](docs/openclaw-bridge.md),
      agent skill: [`docs/openclaw-bridge-skill.md`](docs/openclaw-bridge-skill.md).
- [ ] App icon + polish, TestFlight, App Store (free)

## Naming / domain ideas

bbqlaw.app · bbqlaw.com · getbbqlaw.com — check availability before committing.

## Project layout

```
project.yml                 XcodeGen spec (source of truth)
BBQlaw/
  BBQlawApp.swift           @main, notification permission
  ContentView.swift         SwiftUI UI + device scanner sheet
  ThermometerManager.swift  CoreBluetooth central + alarm logic
  BridgeClient.swift        Relay push (~20s + on target)
  BridgeLinkManager.swift   Link code redeem + state
  BridgeKeychain.swift    Device token storage
  Models.swift              GATT UUIDs, decoders, types
  Info.plist                BLE usage string + background mode
  Assets.xcassets           AppIcon / AccentColor stubs
```
