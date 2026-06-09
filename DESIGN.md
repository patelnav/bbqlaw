---
version: alpha
name: BBQlaw
description: A glanceable, fully-local BLE meat-thermometer instrument. The temperature is the hero — a clean cool-neutral surface wrapped around a warm ember hearth.
colors:
  # ── Literal palette ──────────────────────────────────────────────
  ember: "#E3611F"          # signature brand orange + hot end of the ramp
  ember-bright: "#FF6B2C"   # dark-mode / glow variant
  ember-deep: "#C2410C"     # pressed / deep fire
  temp-cold: "#4A7DB5"      # cool slate-blue — far from target / inactive
  temp-cool: "#7FA8C9"
  temp-warm: "#E0A93C"      # amber / gold — climbing
  temp-fire: "#C2410C"      # deep fire — at target
  red: "#DC2626"
  white: "#FFFFFF"
  bg: "#F3F4F6"             # page — clean cool-grey white
  bg-sunken: "#E8EAEE"      # wells, slider tracks
  surface: "#FFFFFF"        # cards, sheets
  surface-2: "#F5F6F8"
  ink: "#191B20"            # primary text
  ink-2: "#5C616B"          # secondary
  ink-3: "#8D929B"          # tertiary / muted
  line: "#E2E4E9"           # hairline borders
  line-strong: "#C8CCD3"
  # Per-probe identity colors
  probe-1: "#E3611F"
  probe-2: "#4A7DB5"
  probe-3: "#E0A93C"
  probe-4: "#7A9B57"
  # Dark mode (warm smoke-charcoal)
  bg-dark: "#16110E"
  surface-dark: "#211A16"
  ink-dark: "#F6EFE9"
  # ── Semantic aliases ─────────────────────────────────────────────
  primary: "{colors.ember}"
  secondary: "{colors.temp-cold}"
  tertiary: "{colors.temp-warm}"
  neutral: "{colors.bg}"
  accent: "{colors.ember}"
  done: "{colors.ember}"          # target reached is ember, NOT green
  warning: "{colors.temp-warm}"
  danger: "{colors.red}"
  status-idle: "{colors.temp-cold}"
  on-primary: "{colors.white}"
  on-surface: "{colors.ink}"
typography:
  hero:
    fontFamily: Nunito
    fontSize: 120px
    fontWeight: 800
    lineHeight: 0.9
    letterSpacing: -0.03em
  display:
    fontFamily: Nunito
    fontSize: 64px
    fontWeight: 800
    lineHeight: 1.02
    letterSpacing: -0.02em
  h1:
    fontFamily: Nunito
    fontSize: 34px
    fontWeight: 800
    lineHeight: 1.08
    letterSpacing: -0.02em
  h2:
    fontFamily: Nunito
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.15
  h3:
    fontFamily: Hanken Grotesk
    fontSize: 19px
    fontWeight: 700
    lineHeight: 1.25
  body-md:
    fontFamily: Hanken Grotesk
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.5
  body-strong:
    fontFamily: Hanken Grotesk
    fontSize: 17px
    fontWeight: 600
    lineHeight: 1.5
  label:
    fontFamily: Hanken Grotesk
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1.3
  caption:
    fontFamily: Hanken Grotesk
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.35
  overline:
    fontFamily: Hanken Grotesk
    fontSize: 12px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: 0.12em
  mono:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.4
rounded:
  sm: 9px       # chips, small controls
  md: 13px      # buttons, inputs
  lg: 16px      # cards
  xl: 22px      # hero panels, sheets
  pill: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  page-x: 18px      # horizontal screen padding
  stack-gap: 13px   # vertical gap between stacked cards
  card-pad: 18px    # interior card padding
components:
  button-primary:
    backgroundColor: "{colors.ember}"
    textColor: "{colors.white}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.md}"
    padding: 15px
  button-bordered:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.md}"
    padding: 15px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "{spacing.card-pad}"
  status-pill:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-2}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: 8px
  status-pill-live:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.done}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: 8px
  status-pill-idle:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.status-idle}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: 8px
  hero-temp:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ember}"
    typography: "{typography.hero}"
  probe-chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.probe-1}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: 9px
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.md}"
    padding: 15px
  alert-warning:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.warning}"
    typography: "{typography.caption}"
    padding: 14px
---

## Overview

**Concept: an instrument with a hearth.** Apple-like restraint (the chrome gets out
of the way) wrapped around a warm Americana-BBQ soul (fire, smoke, ember). A
glanceable instrument used outdoors at the grill — looked at from across the yard,
one-handed, greasy hands, bright sun, over cooks that run hours. The home screen's
single job: show **the current probe temperature and whether it hit the target —
instantly, from a distance.** Status is communicated through color, size, and one
icon — never sentences.

**Voice:** terse, confident, a little dry — numbers do the talking. Second person,
sentence case everywhere (overlines are the one small-caps exception). No emoji in
functional UI (`🔥` is a sparing brand garnish; `🦞` only when referring to
OpenClaw). Always show degree + unit (`203°F`); whole degrees for the hero.

**The five rules:**
1. The temperature is the hero — huge, tabular, ember.
2. Status = color + size + one icon, never a sentence.
3. The screen warms as the cook climbs (`temp-cold → temp-fire`).
4. Clean cool-neutral white, never cream/paper; warm smoke-charcoal in dark.
5. Terse, confident copy. Sentence case, second person.

## Colors

The palette is clean cool-neutrals with a single warm signature — **ember**.

- **ember (`#E3611F`):** *the* brand color and the hot end of the temperature ramp.
  Brightens to `ember-bright` (`#FF6B2C`) on dark.
- **Temperature ramp** (`temp-cold → temp-cool → temp-warm → ember → temp-fire`):
  the cook's narrative. The hero tick-gauge and ambient glow warm as the cook climbs.
- **Semantic split that makes it glanceable:** cool slate (`status-idle`) =
  waiting / connecting / docked / cold; ember (`done`) = cooking **and done** —
  done is ember, *not* traffic-green. `warning`/`danger` are rare and icon-paired.
- **Neutrals are clean & cool** — surfaces read as white at a glance (`bg #F3F4F6`,
  `surface #FFFFFF`), never paper/cream. The ember stays the only warm note.
- **Dark mode** is warm smoke-charcoal (`bg-dark #16110E`, `surface-dark #211A16`,
  `ink-dark #F6EFE9`); ember shifts to `ember-bright`.
- **Per-probe identity colors** (`probe-1..4`) color-code multiple probes.

## Typography

- **Display + hero numerals — Nunito** (≈ SF Pro Rounded on iOS): rounded, friendly,
  ferociously legible at huge sizes. The temperature is `hero` — ~800 weight,
  tabular so digits don't jump, tight tracking.
- **UI / body — Hanken Grotesk** (≈ SF Pro Text): neutral Swiss; gets out of the way.
- **Mono — JetBrains Mono** (≈ SF Mono): link codes, hex (`FF01`), device IDs,
  technical readouts like `TARGET 203°F · 27° TO GO`.
- Overlines are the only uppercase (`0.12em` tracking), used sparingly.

> iOS ships the SF system equivalents (SF Pro Rounded / Text / Mono); the Google
> Fonts trio above is the canonical, redistributable web/design-system stand-in.

## Layout

- **8pt spacing rhythm.** `page-x` (18px) for horizontal screen padding, `stack-gap`
  (13px) between stacked cards, `card-pad` (18px) inside cards. Generous breathing
  room — this is a calm app.
- **Big touch targets** — 44px minimum, 56px+ preferred (greasy hands, glanced-at use).
- **Single column, centered, one hierarchy.** The hero temperature owns the top third;
  the status pill is fixed at the top; cards stack with `stack-gap`.

## Elevation & Depth

**Flat by default — no drop shadows.** Cards are solid `surface` on a slightly cooler
`bg`, separated by a crisp hairline `line` border. The borders do the work; the UI
reads flat, structural, instrument-like. The **only** element that floats is the
bottom sheet (the lone real overlay). No glassmorphism. An ambient ember glow blooms
softly from the top and intensifies at target — the signature background motif.

## Shapes

Tight, precise radii (not pillowy): `sm` 9px (chips), `md` 13px (buttons/inputs),
`lg` 16px (cards), `xl` 22px (hero panels / sheets), `pill` fully round.

## Components

- **button-primary:** flat ember fill, white text, `md` radius — no glow. Press
  scales to ~0.97 with a deeper fill.
- **button-bordered:** `surface` fill, `ink` text, hairline `line-strong` border.
- **card:** `surface` + hairline `line` border, `lg` radius, no shadow.
- **status-pill:** floating capsule at the top; ember tint + ember text when live,
  slate tint + slate text when idle/connecting (with a slow pulsing dot).
- Hero tick-gauge, live sparkline, gradient target slider (cold→ember), probe rail,
  and the meat picker compose the tokens above. See `BBQlaw/AppComponents.swift`.

## Do's and Don'ts

- **Do** make the temperature the loudest thing on screen; communicate state with
  color + size + one icon.
- **Do** keep surfaces flat — separate with hairlines, not shadows.
- **Don't** use traffic-light green for "done" — done speaks ember.
- **Don't** show a pit/ambient temperature — the hardware has only a food probe.
- **Don't** use emoji to carry UI meaning, or bluish-purple gradients, or
  cream/paper neutrals.

<!--
  Source of truth for design tokens (Google Stitch DESIGN.md format).
  Validate:  npx @google/design.md lint DESIGN.md
  Export:    npx @google/design.md export --format css-tailwind DESIGN.md   (or dtcg / json-tailwind)
  Implemented in: BBQlaw/DesignSystem.swift (iOS) · web/colors_and_type.css (web).
  Not a Tailwind project — consume via the Swift BBQ.* tokens / CSS vars.
-->
