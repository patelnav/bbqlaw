# BBQlaw — Design System

> The instrument for cooks who don't want another login. **The temperature is the hero.**

BBQlaw is a free, fully-local iOS app for cheap white-label BLE meat thermometers
(INT-11I-B class probes). The phone talks straight to the probe over Bluetooth —
no account, no cloud, no vendor app — and can optionally forward the live cook to
your own OpenClaw agent.

This document is the canonical design reference. The tokens here are **implemented**
in `BBQlaw/DesignSystem.swift` (iOS) and `web/colors_and_type.css` (web); build
on-brand by using them rather than hardcoding values.

---

## The product, in one breath

A glanceable instrument used **outdoors at the grill or smoker** — looked at from
across the yard, one-handed, greasy hands, bright sun, over cooks that run hours.
The home screen's single job: show **the current probe temperature and whether it
hit the target — instantly, from a distance.** Status is communicated through
**color, size, and one icon — never sentences.**

### The five rules that make something feel like BBQlaw
1. **The temperature is the hero** — huge, tabular, ember-colored; everything else is quiet.
2. **Status = color + size + one icon, never a sentence.** Cool slate = waiting / inactive / docked; ember = cooking **and done** (done is ember, *not* traffic-green); amber/red are rare and icon-paired.
3. **The screen warms as the cook climbs** — the `temp-cold → temp-fire` ramp.
4. **Clean cool-neutral white** (never cream/paper); warm smoke-charcoal in dark.
5. **Terse, confident copy.** Sentence case, second person, numbers do the talking. No emoji in the UI.

### Hardware truth (don't design around features that don't exist)
- **Food-temp only** — no ambient/pit sensor. Never show a grill/pit temperature.
- Temperature arrives as `FF01` notify: 2-byte little-endian, **°F × 100**.
- Two battery levels — **probe** and **base**.
- The probe **sleeps ~10 min** without a keep-awake; a stale reading means "probe asleep / bridge dropped," **not** "cook finished."
- Meaningful target band: **80–212 °F**.

---

## Voice & copy

- **Person:** second person, implied. "Your probe's temperature." Rarely "we." Never corporate marketing-speak.
- **Length:** shortest thing that works. UI labels are 1–3 words (`Target`, `Probe`, `Base`, `Linked`). Full sentences only in helper text / landing page.
- **Casing:** **sentence case** everywhere (not Title Case, not ALL CAPS). Overlines are the one small-caps exception, used sparingly.
- **Confidence over hedging:** `Target reached`, not "It looks like your target may have been reached!"
- **Honesty:** independent/unofficial project; plain, unhyped disclaimer energy.
- **Emoji:** `🔥` as a sparing brand garnish only; `🦞` only when literally referring to OpenClaw. Functional UI state is icon + color, never emoji.
- **Units:** always show degree + unit (`203°F`); `°F`/`°C` toggle lives in Settings. Whole degrees for the hero (no decimals across the yard).

---

## Logo — BB◉law

The wordmark is **BB◉law**, read *"BB-claw"* — a pun on **BBQ** + **claw** (OpenClaw).
The rotated **kettle-damper mark is the Q** (a disc with four punched holes + a slide
tab whose tail becomes the Q's descender), and the **"◉law" runs in one ember color**.

- iOS: `BBQlaw/Logo.swift` — `Logo(size:)` (wordmark) + `DamperMarkView(size:)` (the mark, recreated as a SwiftUI `Shape` with even-odd fill + ember gradient).
- App icon: ember damper on a warm smoke-charcoal tile (`Assets.xcassets/AppIcon`).
- The mark is custom vector — not from any icon set.

---

## Color

Defined in `BBQ` (`DesignSystem.swift`); both light + dark ship, default light.

### Brand / ember (the signature)
| Token | Light | Dark |
|---|---|---|
| `ember` | `#E3611F` | `#FF6B2C` |
| `emberDeep` (pressed) | `#C2410C` | — |

Ember is *the* brand color and the hot end of the data ramp.

### Temperature ramp (the cook's narrative, cold → hot)
`tempCold #4A7DB5` (cool slate) → `tempCool #7FA8C9` → `tempWarm #E0A93C` (amber) →
`tempHot #E3611F` (ember) → `tempFire #C2410C` (deep fire, at target). The screen
literally warms as the cook climbs (hero tick-gauge + ambient glow).

### Semantic status
- `statusIdle #4A7DB5` — connecting / authenticating / waiting / docked / cold.
- `done` = ember (`#E3611F` / `#FF6B2C`) — **reached is ember, not green**.
- `warning #E0A93C`, `danger #DC2626` — rare, always icon-paired.

### Neutrals — clean & cool (not paper)
| Token | Light | Dark (warm smoke-charcoal) |
|---|---|---|
| `bg` (page) | `#F3F4F6` | `#16110E` |
| `surface` (cards) | `#FFFFFF` | `#211A16` |
| `fg1 / fg2 / fg3` | `#191B20 / #5C616B / #8D929B` | `#F6EFE9 / #B39C8D / #7D6B5E` |
| `line / lineStrong` | `#E2E4E9 / #C8CCD3` | white @ 9% / 16% |

Surfaces read as white at a glance; the ember stays the only warm note. Tinted
fills: `emberTint`, `slateTint`. Per-probe identity colors: `probeColors`
(`#E3611F`, `#4A7DB5`, `#E0A93C`, `#7A9B57`).

---

## Type

| Role | iOS (shipping) | Web / design system |
|---|---|---|
| Display + hero numerals | **SF Pro Rounded**, heavy, tabular | Nunito 800 |
| UI / body | **SF Pro Text** (system) | Hanken Grotesk |
| Mono (codes, hex, readouts) | **SF Mono** | JetBrains Mono |

In code: `BBQ.display(_:weight:)` (rounded), `BBQ.ui(_:weight:)`, `BBQ.mono(_:weight:)`.
The hero number is huge, ember (or `fg1` with no target), and tabular so digits don't
jump. Tight tracking on big display; overlines are the only uppercase.

---

## Surfaces, layout & motion

**FLAT — no drop shadows.** Cards are solid `surface` on a cooler `bg`, separated by a
crisp hairline `line` border. The borders do the work; the UI reads flat, structural,
instrument-like. The **only** floating element is the bottom sheet. No glassmorphism.

- **Radii:** chips 9, buttons/inputs 13, cards 16, hero panels/sheets 22, pills round (`BBQ.R`).
- **Helpers:** `.bbqCard()` (flat surface + hairline), `.bbqGlow(reached:)` (ambient ember glow from the top, intensifies at target).
- **Spacing:** 8pt scale; generous breathing room. Touch targets 44px min, 56px+ preferred (greasy hands).
- **Layout:** single column, centered, one hierarchy. Hero owns the top third; status pill at top; cards stack with gap.
- **Motion:** `ease-out` settle (140/240/420ms); numbers cross-fade (`contentTransition(.numericText())`). The one expressive moment is **target-reached** (a single warm pulse + flood, then rest — no infinite loops on an hours-long screen). Connecting/waiting get a slow pulse on the status dot. Respect `prefers-reduced-motion`.
- **Press:** scale to ~0.97 + deeper fill. **Disabled:** 40% opacity.

---

## Iconography

- **iOS uses Apple SF Symbols** — `thermometer.medium`, `battery.100`/`.bolt`, `gearshape`, `checkmark.seal.fill`, `bell`, `link`, `magnifyingglass`, `chevron.right`, `pencil`, `speaker.slash.fill`/`speaker.wave.2.fill`, etc.
- **Web** uses a curated inline-SVG set (Lucide-style, 24-grid, ~1.75 stroke, `currentColor`) since SF Symbols aren't redistributable.
- No emoji in functional UI. Status is always a real icon + color.

---

## Screen structure (iOS — `ContentView.swift` + `AppComponents.swift`)

Progressive disclosure, per Apple HIG:
- **Onboarding-first:** with no probe, the whole screen is "Add your thermometer" (no top-bar chrome). A connecting probe shows the pairing state.
- **Monitoring (≥1 probe):** top bar = `Logo` + (gear → Settings); status pill (with count) + a live freshness line that only warns when the feed goes quiet; then the active probe's hero.
- **Hero:** probe-name overline, huge number, then — no-target → "No target set"; reached → seal-check + "Target reached"; climbing → a 30-tick thermometer gauge (cold→ember) + mono `TARGET 203°F · N° TO GO`. A **live sparkline** of recent temps shows activity.
- **Target card:** editable probe **name** (decoupled from the cook), a "Cooking" row → meat picker, a gradient target slider (80–212), and an alert line (no toggle — reaching the target *is* the alert).
- **Probe rail:** appears only with 2+ probes; switches the active probe + "Add".
- **Settings sheet (gear):** inset-grouped — **Units** (°F/°C), **Devices** (list + per-device mute + remove + "Add device"), **Automations** (the OpenClaw link, buried here per HIG with its explanation as the footer).
- Sheets are native; only the sheet floats.

### States the UI must make obvious without reading
Live temperature · target set vs reached · no-reading vs docked/charging ·
Bluetooth connected / authenticating / waiting / off · linked to OpenClaw (yes/no).

---

## Where it lives in code
- `BBQlaw/DesignSystem.swift` — color/type/radii tokens, `bbqCard`, `bbqGlow`, temp ramp.
- `BBQlaw/Logo.swift` — the BB◉law wordmark + damper mark.
- `BBQlaw/AppComponents.swift` — primitives + app pieces (status pill, hero, tick gauge, sparkline, target card, probe rail, meat picker, settings, scanner).
- `BBQlaw/ContentView.swift` — the single-screen orchestrator + flow.
- `web/colors_and_type.css` — the shared web token source (same palette/ramp).
