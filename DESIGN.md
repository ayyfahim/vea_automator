---
name: VideoExpress Library Manager
description: Batch deck for image → video — a film cutting bench select rail translated to a fixed panel.
colors:
  cut-orange: "#7C3AED"
  cut-orange-deep: "#6D28D9"
  cut-orange-soft: "#8B5CF6"
  cut-black: "#111827"
  cut-panel: "#F3F4F6"
  cut-window: "#FFFFFF"
  cut-window-warm: "#F9FAFB"
  cut-line: "#E5E7EB"
  cut-line-soft: "#D1D5DB"
  cut-border-warm: "#E5E7EB"
  cut-border-warm-2: "#E5E7EB"
  cut-ink: "#111827"
  cut-muted: "#6B7280"
  cut-muted-light: "#9CA3AF"
  success: "#0EA768"
  warn: "#F59E0B"
  danger-ink: "#111827"
  bench-orange: "#FF3B0A"
  bench-black: "#0A0A0D"
  teal-accent: "#0F766E"
  amber-accent: "#D97706"
typography:
  display:
    fontFamily: "'Barlow Condensed', 'Instrument Sans', system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.04em"
  headline:
    fontFamily: "'Barlow Condensed', sans-serif"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.09em"
  title:
    fontFamily: "'Barlow Condensed', sans-serif"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.08em"
  body:
    fontFamily: "'Instrument Sans', system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
  label:
    fontFamily: "'JetBrains Mono', monospace"
    fontSize: "10px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.06em"
  mono:
    fontFamily: "'JetBrains Mono', monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "0"
rounded:
  sm: "1px"
  md: "2px"
  pill: "999px"
spacing:
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "14px"
components:
  button-primary:
    backgroundColor: "{colors.cut-orange}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "9px 10px"
  button-primary-hover:
    backgroundColor: "#FF4D1A"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "9px 10px"
  button-success:
    backgroundColor: "{colors.success}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "9px 10px"
  button-warn:
    backgroundColor: "{colors.warn}"
    textColor: "{colors.cut-black}"
    rounded: "{rounded.sm}"
    padding: "9px 10px"
  button-danger:
    backgroundColor: "{colors.danger-ink}"
    textColor: "{colors.cut-orange}"
    rounded: "{rounded.sm}"
    padding: "9px 10px"
  button-ghost:
    backgroundColor: "#ffffff"
    textColor: "{colors.cut-black}"
    rounded: "{rounded.sm}"
    padding: "9px 10px"
  input-default:
    backgroundColor: "#ffffff"
    textColor: "{colors.cut-black}"
    rounded: "{rounded.sm}"
    padding: "9px 10px"
  badge-running:
    backgroundColor: "{colors.cut-orange}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "3px 6px"
  badge-completed:
    backgroundColor: "{colors.success}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "3px 6px"
  card-window:
    backgroundColor: "{colors.cut-window}"
    textColor: "{colors.cut-black}"
    rounded: "{rounded.sm}"
    padding: "12px"
---

# Design System: VideoExpress Library Manager

## Overview

**Creative North Star: "The Cutting Bench Select Rail"**

The VideoExpress Library Manager is now a bench, not a card deck. Injected as `#ve-manager-root` at `top:72px right:16px` (`z-index: 2147483647`), the panel is a true-black field (`#0A0A0D`) crossed by a flag-orange perforated rail. The rail is the primary organizing device: a 44px orange bar with an 8px sprocket row, holding six frame-label tabs (`FOLDERS` / `UPLOAD` / `QUEUE` / `DOWNLOADS` / `TIMELINE` / `ACTIVITY`). Below the rail, every section is a punched white window (`#F5F1EB` with 7px black rivets at top corners) and every folder is a frame cell. The bench lamp is orange; the work is white on black; the grain is physical, not decorative.

The world holds orange at one third of the surface — header + rail + progress + stat flags — and forces all running copy and thumbnails into white windows. Rank is expressed by cell count, not type size: one size of condensed grotesk caps (`Barlow Condensed` 600/700, 11–12px) does the labeling, `JetBrains Mono` handles timestamps and counts, `Instrument Sans` carries the 12.5px body. Motion is stepped (90ms `steps(2)`), scrub snaps to perforation pitch, and hung trims swing rather than fade.

**Key Characteristics:**
- Select rail as queue — position is physical, status is a mark (grease cross, punched corner, tape band, folded flag, pin) not a hue.
- Site-matched default — VideoExpress violet `#7C3AED` on light `#F3F4F6`/`#FFFFFF` by default; bench red retained as opt-in, plus teal and amber dark variants via picker.
- One ink, one flag, one window per palette — light or dark field with 33% accent; success `#0EA768` and warn `#F59E0B` only for semantic badges.
- Perforated topology — rail fixed at 44px, sections string along it; deferred items hang on pins below.
- Condensed grotesk caps + mono data — rank by count, ticks hairline, no marketing radius.

## Colors

One ink, one flag, one window — the bench's material honesty. Orange is never scattered; it holds broad regions.

### Primary
- **VideoExpress Violet** (#7C3AED): Default flag — header, rail, primary button, running badge, progress fill, folder active top rule. Holds 1/3 of light panel `#F3F4F6`/`#FFFFFF`. Deep #6D28D9 for pressed, soft #8B5CF6 for hover. **Bench Red #FF3B0A retained as `bench` palette** (see Palettes).
- **Violet Deep** (#6D28D9): Pressed state for rail-adjacent controls (bench deep #D12E04).

### Secondary
- **Success Green** (#0EA768): `completed` badge and success button only. White text, black border.
- **Warn Amber** (#FFC83D): `parallel_limit` / caution. Black text, never a page tint.

### Tertiary
- **Danger Ink** (#1A1A1E): `failed` button — ink field with orange text, punched-corner metaphor.

### Neutral
- **True Black** (#0A0A0D): Panel chassis, log, thumb fallback, badge failed. The bench top.
- **Panel** (#0F1012): Subtle lift from black for panel inner gradient (body).
- **Window** (#F5F1EB): Punched white window for sections and folder cards. Warm second #F7F3EC for table heads.
- **Line** (#1A1D20): 1.5px hairline for inputs, cards, windows. Soft #2A2E33 for scrollbar and secondary strokes.
- **Border Warm** (#D8D0C2): Table rules and section internal dividers; #E0D8CC for section title rule.
- **Ink** (#1A1A18): Section title text on window.
- **Muted** (#5A5752): Secondary text on windows, idle badge text, table meta. Light #6B6760 for muted helpers and placeholder (now 4.5:1 on white).
- **Placeholder** (#6B6760): Input placeholder — same as muted-light, passes contrast on #fff.

### Named Rules
**The One Third Rule.** Flag accent holds 33% — header + rail + progress + 3px stat flags. If heavier, remove accent.
**The Mark Not Hue Rule.** Status is a physical mark, not a new color: grease cross `completed`, punched corner `failed`, tape band `submitted`, folded flag `running`, hung pin `deferred`.

### Palettes (choosable via `#ve-theme-select`, persisted as `theme` in `videoexpress.manager.ui-state.v1`)
Default is site-matched **VideoExpress** (`data-theme` absent) — `#7C3AED` header/rail on `#F3F4F6` panel / `#FFFFFF` windows. Retained **Bench Red** (`bench`) keeps original eye-soring `#FF3B0A` on `#0A0A0D` / `#F5F1EB` for users who prefer the cutting-bench contrast. Two additional dark variants:
- **VideoExpress** (default): `--cut-orange #7C3AED`, `--cut-panel #F3F4F6`, `--cut-window #FFFFFF` / warm `#F9FAFB`, `--cut-line #E5E7EB`, `--cut-ink #111827` — light, violet, matches `app.videoexpress.ai` Save violet `#8B5CF6` / Export orange `#FF6B2B` and body `#D6DBE1`.
- **Bench Red** (`bench`): `--cut-orange #FF3B0A` on `#0A0A0D` / `#F5F1EB` — original bench, dark grain, orange 1/3.
- **Teal Dark** (`teal`): `--cut-orange #0F766E` on `#0B1A1F` / `#F0FDFA` — cool alt, same structure, teal flag on deep slate.
- **Amber Warm** (`amber`): `--cut-orange #D97706` on `#292524` / `#FFFBEB` — warm alt, amber flag on warm charcoal.

Picker is `Barlow Condensed 11px 700` in header (138px `ve-select`), `change` → `applyTheme()` → `root.setAttribute("data-theme",…)` or `removeAttribute` for default, persisted. All accent usages are `var(--cut-orange)` so theme swaps without re-render.

## Typography

**Display Font:** Barlow Condensed 600/700 with Instrument Sans fallback
**Body Font:** Instrument Sans 400 (12.5px/1.5)
**Label/Mono Font:** JetBrains Mono 400/600

**Character:** Industrial, condensed, all caps for chrome. Barlow's narrow apertures keep 11px labels legible at 620px density; JetBrains carries timestamps, counts, and the `00:00:00` ruler. One size does the work — hierarchy is cell count and position on the rail, not size ramping.

### Hierarchy
- **Display** (700, 17px, 1, 0.04em caps): `#ve-manager-title` `VIDEOEXPRESS MANAGER` only. Single per deck, on orange.
- **Headline** (700, 12px, 0.09em caps): `.ve-section-title` — `MEDIA FOLDERS` etc., with 1px warm divider below and orange icon.
- **Title** (700, 11px, 0.08em caps): `.ve-tab` and `.ve-table th` (`th` adds mono 9.5px on warm). Tabs are 42px hairline frames on orange.
- **Body** (400, 12.5px, 1.5): Inputs, `.ve-title-line` (600 12px), log lines. Measure is panel-constrained (~58ch at 620px).
- **Label** (700, 10px, mono 0.06em caps): `.ve-badge`, `.ve-retry-btn`, stat spans (9.5px). Badges are `1px` hairline squares with a 7px mark box.
- **Mono** (400, 11px, 1.45): `.ve-log` and `ve-textarea` — `JetBrains Mono` on black field.

### Named Rules
**The One Size Rule.** One size of condensed grotesk does the labeling; rank is expressed by cell count and rail position, not by larger type.

## Layout

The panel is a **sheet crossed by a rail**. Root fixed `top:72px right:16px`, panel `min(620px, calc(100vw - 24px))` × `calc(100vh - 88px)`, `flex column` with `hidden` overflow and `1.5px solid #000` + `0 22px 70px rgba(0,0,0,0.72)`. Header is `12px 14px 10px` on orange with a sprocket dash `repeating-linear-gradient(90deg, #000 0 10px, transparent 10px 18px)` at its base, `cursor:move`. Body is `18px 14px 14px` on black with `max-height calc(100vh - 150px)` scroll.

**Rail:** `.ve-tabs` sticky at `top:-18px`, `grid repeat(6, minmax(0,1fr))` with `1px` gaps, `padding 9px 8px 10px` on orange, `1.5px solid #000`. Five-pixel sprocket row sits at `top:4px` via `repeating-linear-gradient(90deg, #000 0 6px, transparent 6px 16px)`. At ≤700px, rail wraps to `repeat(3,1fr)` — two rows of frames, not a collapsed menu.

**Windows:** Sections are punched white windows with 7px black rivets at `6px` from top corners, `12px` padding, `1px solid #1A1D20`, `1px` radius, `0 1px 0 #000` shadow. Folder grid `repeat(3, minmax(0,1fr))` → `repeat(2,1fr)` at 640px, each `78px` window with a 2px orange top rule that appears on hover/active; active adds `◆` at `6px 7px` in orange.

**Ruler & tracks:** Timeline ruler `00:00:06` steps remain hairline; progress is `10px` black track with `repeating` slate ticks and orange fill with white right edge, `steps(2)` 0.2s.

**Spacing:** `14px` body inset, `12px` window pad, `8px` row gaps, `6–7px` grid gaps, `1px` hairlines. More space above a headline than below it (title has `8px` border gap, `12px` below). The black field is always the negative space; white never floats without a window and rivets.

## Elevation & Depth

The bench is flat matter, not lifted cards. Depth is a pinned sheet, not a stack of shadows. Black grain field at `z=0`, white windows at `z=1` with `0 1px 0 #000` hard edge, orange rail at `z=5` sticky. No soft drop shadows except the single panel cast `0 22px 70px rgba(0,0,0,0.72)` — the bench's throw onto the host page. Windows have `inset 0 1px 0 rgba(255,255,255,0.7)` to read as acetate, never a blur.

### Shadow Vocabulary
- **Panel Throw** (`0 22px 70px rgba(0,0,0,0.72)`): One cast for `#ve-manager-panel` only; no window ever gets it.
- **Hard Edge** (`0 1px 0 #000`, `0 2px 0 #000` on active): Window and folder active state — a pin, not a glow.
- **Rail Seam** (`0 1px 0 #000` + `inset 0 -3px 0 #FF3B0A` on active tab): Rail's hard bottom edge.

### Named Rules
**The No Glow Rule.** No soft blur beyond the single panel throw. Elevation is hairline and hard edge; glow is decoration on a bench.

## Shapes

The language is **sharp and punched**. Primary radius is `1px` for inputs, buttons, badges, windows, folder cards; `2px` for panel and toggle only; `999px` never appears except as a suppressed legacy (progress is now 1px). Sprocket holes are `7px` circles (rivets), tape flags are `◆` diamonds, and progress ticks are `1px` hairline dashes. Borders are always `1.5px solid #000` on orange/black and `1px solid #1A1D20` on white — never dashed except for `skipped` badge (dashed window) and the hung-trim bin's orange dashed top. The deck reads as a perforated strip and a tray of windows, not a stack of pills.

## Components

### Buttons
- **Shape:** `1px` radius, `1.5px solid #000`, `Barlow Condensed` 12px 700 0.07em caps, `9px 10px` pad, `steps(2)` 0.06s lift.
- **Primary:** Orange `#FF3B0A` on white text — the grease cross action (Run, Download). Hover `#FF4D1A` + `0 3px 0 #000`.
- **Hover / Focus:** Lift `-1px` + hard `0 3px 0 #000`; focus is `0 0 0 2px rgba(255,59,10,0.28)` on inputs, not buttons.
- **Success / Warn / Danger / Ghost:** Success `#0EA768` white, Warn `#FFC83D` black, Danger ink `#1A1A1E` orange text, Ghost white black — all same shape, fill-swapped.

### Chips
No filter chips. Selection uses windows and badges. If introduced, model on badges: `1px` square, mono, hairline, mark-box prefix.

### Cards / Containers
- **Corner:** `1px` for windows and folder cells; `2px` panel.
- **Background:** White `#fff` inside `#F5F1EB` windows; stat `white` with `3px` orange flag top.
- **Shadow:** Hard `0 1px 0 #000` only; active folder `inset 0 0 0 1px #000 + 0 2px 0 #000`.
- **Border:** `1px solid #1A1D20` (inputs) / `#D8D0C2` (stats) / `#000` (orange).
- **Internal:** Sections `12px`, folder `10px 9px 8px`, stats `10px 8px 9px`.

### Inputs / Fields
- **Style:** White `#fff` on `#0A0A0D` field, `1.5px solid #1A1D20`, `1px` radius, `12.5px Instrument Sans`, placeholder `#6B6760`. Textarea mono `11.5px`.
- **Focus:** `border #FF3B0A` + `0 0 0 2px rgba(255,59,10,0.28)`.
- **Error:** No red stroke — error is `failed` badge (black/orange punched corner) and log line, not field color.

### Navigation
- **Tabs:** Orange rail `42px` frames, white `rgba(255,255,255,0.12)` idle, `#F5F1EB` active with `inset 0 -3px 0 #FF3B0A`. Labels caps 11px 700 0.08em with `6px` icon gap. Active text `#0A0A0D`.
- **Header:** Orange bar with white caps `VIDEOEXPRESS MANAGER` 17px, subtitle mono 10px. Close `30px` white square with `1.5px #000`.

### Badges & Indicators
- **Shape:** `inline-flex 5px gap`, `3px 6px` pad, `1px` hairline, mono 10px 700 caps. Mark box `7px` before text: empty square (idle), white fill (running), `X` (completed, grease cross), rotated square (failed), hatched (parallel_limit), dashed (skipped).
- **Palette:** idle `#EDE8DF/#5A5752`, running `#FF3B0A/white`, completed `#0EA768/white`, failed `#0A0A0D/#FF3B0A`, parallel `#FFC83D/#0A0A0D`.

### Tables & Media
- **Table:** `100% border-collapse 11.5px`. `th` mono 9.5px caps on `#F7F3EC` with `1px #D8D0C2` rule; `td` `9px 6px` on white windows with `#E8E2D6` hairline. Hover `#FFF8EE`.
- **Media:** `44×32` thumb `1px #000` on black ground.
- **Progress:** `10px` black track with slate tick overlay, orange fill with white right edge, `steps(2)`.

### Launcher
- **Toggle:** `54×54` orange `#FF3B0A` square, `2px` radius, `1.5px #000`, `18px Barlow` white, `0 8px 22px rgba(0,0,0,0.45)`.

## Do's and Don'ts

### Do:
- **Do** keep orange at 1/3 — header + rail + progress + flag. If you need emphasis, use a mark or a window count, not more orange.
- **Do** use punched windows with rivets for every section — content never sits on black or orange without a white window.
- **Do** keep caps and hairlines — `Barlow Condensed` caps, `1.5px #000` on orange, `1px #1A1D20` on white.
- **Do** express state as a mark in the 7px box — empty, filled, X, rotated, hatched, dashed.
- **Do** keep radius `1px` (panel `2px`) and grid 3→2 cols — the bench is sharp, not soft.
- **Do** preserve the perforated rail's sprocket row at `top:4px` (`6px/16px` repeat) — it's the system's signature.
- **Do** use mono for data — timestamps, IDs, counts, log.

### Don't:
- **Don't** revive the light Control Deck — `#f7f9fc`/`#22a7f0` blues, `6px` soft radius, and `0 16px 55px` soft blur are the anti-reference.
- **Don't** add gradients, glass, or `999px` pills — the bench is physical, not frosted.
- **Don't** add a new saturated hue alongside flag orange — green and amber are semantic only.
- **Don't** use `Inter`, `Space Grotesk`, `IBM Plex`, or `DM Sans` as display — use Barlow Condensed; mono only for data.
- **Don't** soften the hard `0 1px 0 #000` edge with a blur — elevation is a pin, not a glow.
- **Don't** place body copy below `11px` or above `13px` inside windows — caps already carry the hierarchy.

