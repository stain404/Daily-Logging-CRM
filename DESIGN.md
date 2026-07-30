---
name: Al Quba
description: Daily Logging — a dark trading-terminal register for internal task reporting
colors:
  amber: "#e8a53d"
  amber-dim: "#c9862a"
  amber-bright: "#ffc670"
  green: "#34d399"
  red: "#f2495c"
  warn: "#f5a623"
  cyan: "#22d3ee"
  violet: "#a78bfa"
  bg-app: "#06080b"
  bg-sidebar: "#0a0d12"
  bg-panel: "#10141a"
  bg-panel-2: "#161b22"
  bg-raised: "#1d232b"
  border: "#232a33"
  border-strong: "#333c47"
  text-primary: "#eef1f3"
  text-secondary: "#b7c0c9"
  text-muted: "#7c8994"
  text-faint: "#4d5861"
typography:
  display:
    fontFamily: "IBM Plex Mono, JetBrains Mono, Fira Code, monospace"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "IBM Plex Mono, JetBrains Mono, monospace"
    fontSize: "22px"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.03em"
  title:
    fontFamily: "IBM Plex Sans, Inter, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "IBM Plex Sans, Inter, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "IBM Plex Sans, Inter, Segoe UI, sans-serif"
    fontSize: "10.5px"
    fontWeight: 700
    letterSpacing: "0.05em"
rounded:
  sm: "3px"
  md: "4px"
  lg: "6px"
  xl: "8px"
  pill: "99px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "18px"
  xxl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.amber}"
    textColor: "#1a1200"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.amber-bright}"
  button-secondary:
    backgroundColor: "{colors.bg-panel-2}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  card:
    backgroundColor: "{colors.bg-panel}"
    rounded: "{rounded.lg}"
    padding: "18px"
  badge:
    rounded: "{rounded.sm}"
    padding: "3px 9px"
    typography: "{typography.label}"
---

# Design System: Al Quba

<!-- FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md. -->

## Overview

**Creative North Star: "The Ledger Terminal"**

Al Quba runs like a financial trading terminal, not a SaaS dashboard: a near-black ground, one disciplined amber signal color, and numbers set in tabular monospace so figures always align. This is a deliberate departure from the previous light "Ops Console" identity — same product truth (daily task logging, role-scoped review, reporting), a completely different register, grounded in the real professional world of the business this serves: a trading/logistics/investment company (Procurement, Shipping, Sales, Finance, IT, HR) where Bloomberg/Reuters-style terminal software is a lived daily reality, not a mood board reference.

Color is spent with the same discipline as before — one accent, functional status colors, nothing decorative — but the register has shifted from "friendly blue productivity app" to "serious instrument for reading numbers fast." Borders replace shadows almost entirely (shadows barely register on a dark ground); geometry has tightened from soft 12–16px rounding to a rectilinear 3–8px scale; and motion is now a real, purposeful part of the system — stat values count up on load, live indicators pulse, pages fade in — rather than absent.

**Key Characteristics:**
- Near-black grounds (`bg-app` → `bg-raised`) do the structural work; a single warm amber (`#e8a53d`) is the only accent, replacing the previous "Confident Blue."
- Numbers are always tabular monospace (IBM Plex Mono) — stat values, table figures, badges, dates — reinforcing the terminal register at every density.
- Status semantics carry over from the previous system unchanged in meaning, recolored for a dark ground: green = done, red = danger/delayed, amber-adjacent warn = pending/caution, violet = analytics/rating, cyan = secondary accent.
- Borders-over-shadows, now absolute: shadows are nearly invisible on a dark surface, so separation is done with a visible border scale (`border` → `border-strong`) first, shadow only for true overlays (modal, toast, login card).
- Motion is now authored, not absent: count-up numbers, a live-pulse notification dot, page-level fade-and-rise transitions, amber glow on button hover/focus.

## Colors

A near-black neutral scale carries structure; one warm amber is the only non-semantic accent; five status colors exist purely to encode task/data meaning.

### Primary
- **Amber** (`#e8a53d`, hover `#ffc670`, dimmed `#c9862a`): the one accent. Primary buttons, active sidebar item, focus rings, links, the brand mark, live indicators. Reads as "the color that means action or attention" everywhere it appears — same rationing discipline as the previous Confident Blue, just a different hue chosen for its trading-terminal heritage (amber-on-black is the literal, historical color of financial terminal displays).

### Secondary (status semantics — meaning only, never decoration)
- **Green** (`#34d399`): completed, approved, success, online status.
- **Red** (`#f2495c`): delayed, rejected, destructive actions, offline status.
- **Warn** (`#f5a623`): on-hold, pending, caution — deliberately a distinct hue from primary Amber so "in progress" (amber) and "on hold" (warn) never collide.
- **Violet** (`#a78bfa`): analytics, completion rate, ratings.
- **Cyan** (`#22d3ee`): secondary/tertiary accent, used least often.

Each has a `-wash` tint (a low-opacity rgba of the same hue) used as badge/stat-icon backgrounds, so the saturated value can sit on top as text/icon color.

### Neutral
- **bg-app** (`#06080b`): the page shell — the darkest surface in the system.
- **bg-sidebar** (`#0a0d12`) / **bg-panel** (`#10141a`): sidebar and every card/modal/table surface — one step lighter than the app shell so panels read as "raised" without needing a shadow.
- **bg-panel-2** (`#161b22`) / **bg-raised** (`#1d232b`): subtle tints for table headers, hover states, and highlighted/read-only inputs.
- **border** (`#232a33`) / **border-strong** (`#333c47`): the primary separation device between surfaces.
- **text-primary** (`#eef1f3`) → **text-faint** (`#4d5861`): a four-step text hierarchy from headings down to placeholder text.

### Named Rules
**The One Signal Rule.** Amber is the only non-semantic color in the system. A new element needing color is amber, a status hue, or nothing — never an invented accent.

## Typography

**Numeric/Display Font:** IBM Plex Mono (with JetBrains Mono, Fira Code fallback)
**UI/Body Font:** IBM Plex Sans (with Inter, Segoe UI fallback)

**Character:** A monospace face for anything that is a number, a grotesk for everything else — the pairing itself is the terminal signal. Actual webfont `<link>` tags are present in `<head>` this time (the previous system declared Inter but never actually loaded it).

### Hierarchy
- **Display** (IBM Plex Mono, 700, 28px, tabular-nums): stat-tile values only. Still the single boldest, biggest element in the system — that discipline carries over from the previous identity unchanged.
- **Headline** (IBM Plex Mono, 800, 22px): the login screen's product name — set in mono specifically to announce the terminal register the moment someone logs in.
- **Title** (IBM Plex Sans, 700, 13–15px): card titles, topbar page title.
- **Body** (IBM Plex Sans, 400, 13px): descriptions, form values, non-numeric table cells.
- **Label** (IBM Plex Sans, 700, 10–11.5px, uppercase, tracked): table headers, form labels, stat labels.

### Named Rules
**The Tabular Rule.** Any UI element displaying a number — stat values, table figures, badges, dates, audit-log IPs — is set in `IBM Plex Mono` with `font-variant-numeric: tabular-nums`. Never render a number in the body sans face.

## Layout

Unchanged from the previous system's spatial grammar: fixed 232px sidebar, sticky 56px topbar, 24px content padding, 14px root font-size, and the same grid primitives (`g2`/`g3`/`g-auto`/`stat-grid`). The mobile sidebar-drawer behavior below 768px is unchanged. Layout topology was preserved deliberately — the redesign is a register change (color, type, geometry, motion), not a structural one, since the underlying task/review/report workflows were untouched.

## Elevation & Depth

Almost entirely flat, more so than the previous system: shadows read as nearly invisible on a near-black ground, so elevation is communicated by a lightness step between surfaces (`bg-app` < `bg-sidebar`/`bg-panel` < `bg-panel-2` < `bg-raised`) plus a visible border, not by shadow. Shadow is reserved for genuine overlays — the modal, the toast, the login card — where a real backdrop-separation cue is needed, and shadow alpha values were raised (up to `.65`) specifically to stay visible against the dark ground.

### Shadow Vocabulary
- **Ambient** (`0 1px 2px rgba(0,0,0,.5)`): barely-there, used sparingly.
- **Hover** (`0 6px 20px rgba(0,0,0,.55)`): stat-card hover only.
- **Overlay** (`0 28px 56px rgba(0,0,0,.65)`): login card, modals — true above-the-page-plane surfaces.

### Named Rules
**The Lightness-Before-Shadow Rule.** On a dark ground, a shadow is nearly invisible — reach for the next `bg-*` step and a border first. Shadow is reserved for true overlays only.

## Shapes

Tightened deliberately from the previous 6/8/12/16px scale to a rectilinear 3/4/6/8px scale, plus a full pill (99px) for anything reading as a status chip. The tighter geometry is a direct expression of the terminal register — less "friendly rounded SaaS card," more "instrument panel." Badges shifted from pure pills to small rectangular tags with a colored left border (a ledger/manifest-tag reading), while chips and avatars keep their pill/circle shapes.

## Components

### Buttons
- **Shape:** 4px radius, tighter than before.
- **Primary:** Amber fill, near-black text (`#1a1200` — dark text on a light-saturated amber reads correctly, unlike the previous white-on-blue), glows with an amber wash on hover/focus rather than darkening.
- **Secondary/Ghost/Outline:** unchanged in structure, recolored to the neutral/amber palette.

### Badges (changed shape)
- **Style:** rectangular tag, 3px radius, 2px colored left border, monospace label text, tinted wash background.
- **Rule:** border-left color always matches the semantic hue; never decorative.

### Stat Tiles (signature component, refined)
- Same 3px top accent bar and tinted icon chip as before, but the value now renders in tabular monospace, and **counts up from 0 on every dashboard load** — a real, purposeful motion tied to the terminal metaphor (a live feed populating), not decoration for its own sake.

### Inputs
- Dark fill (`bg-input`), amber focus ring (replacing the previous blue glow), same shape/padding rhythm as before.

### Navigation
- Sidebar items now carry a 2px amber left-border indicator when active (replacing the previous solid-fill active state), a lighter-weight signal appropriate to the darker overall palette.

## Do's and Don'ts

### Do:
- **Do** set every numeric UI value in `IBM Plex Mono` with tabular-nums — this is the system's core tell.
- **Do** use a `bg-*` lightness step plus a border before reaching for a shadow.
- **Do** keep Amber as the only non-semantic color; reuse status hues for anything status-adjacent.
- **Do** animate stat values with a count-up on load — it's the system's signature motion moment.

### Don't:
- **Don't** use `var(--amber)` for both "in progress" and "on hold" — they are deliberately different hues (`amber` vs `warn`) precisely so active and paused states never read the same.
- **Don't** add a shadow to an at-rest card — it will barely render on the dark ground and reads as a mistake, not a style.
- **Don't** revert badges to full pills — the rectangular left-border tag is this system's specific signature, distinct from the previous identity's pill badges.
- **Don't** ship a declared webfont without its `<link>` tag again — that was the previous system's actual defect; this one loads IBM Plex properly.
