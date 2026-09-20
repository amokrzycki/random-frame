---
name: Random Frame
description: A quiet archive table for inspecting one public image at a time.
colors:
  mineral-paper: "#ebe8e1"
  mineral-paper-deep: "#dfdbd1"
  graphite-ink: "#191a18"
  muted-olive-gray: "#66675f"
  viewing-stage: "#151614"
  viewing-stage-soft: "#22231f"
  archival-white: "#f9f8f4"
  action-cobalt: "#2759dc"
  action-cobalt-dark: "#1944b8"
  hairline-stone: "#c9c5bc"
  warning-terracotta: "#c86b55"
  dark-mineral-paper: "#171815"
  dark-mineral-paper-deep: "#22231f"
  dark-graphite-ink: "#f0eee8"
  dark-muted-olive-gray: "#aaa99f"
  dark-viewing-stage: "#0d0e0c"
  dark-viewing-stage-soft: "#1b1c19"
  dark-action-cobalt: "#496adc"
  dark-action-cobalt-dark: "#3f63d7"
  dark-hairline-stone: "#3b3c36"
  dark-control-fill: "#343530"
  dark-floating-control: "#2b2c28"
  dark-warning-terracotta: "#e58b75"
typography:
  display:
    fontFamily: "Archive Serif, serif"
    fontSize: "clamp(26px, 3vw, 42px)"
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: "-0.035em"
  body:
    fontFamily: "Avenir Next, Avenir, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Avenir Next, Avenir, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 650
    lineHeight: 1.2
  metric:
    fontFamily: "Archive Serif, serif"
    fontSize: "clamp(38px, 8vw, 58px)"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "-0.035em"
rounded:
  compact: "5px"
  inset: "8px"
  control: "8px"
  action: "9px"
  primary: "10px"
  dialog: "14px"
spacing:
  xs: "8px"
  shell-top: "14px"
  sm: "16px"
  md: "24px"
  lg: "48px"
components:
  button-primary:
    backgroundColor: "{colors.action-cobalt}"
    textColor: "{colors.archival-white}"
    rounded: "{rounded.control}"
    padding: "0 18px 0 21px"
    height: "50px"
  button-primary-hover:
    backgroundColor: "{colors.action-cobalt-dark}"
    textColor: "{colors.archival-white}"
    rounded: "{rounded.control}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.action}"
    padding: "0 11px"
    height: "34px"
  button-icon:
    backgroundColor: "{colors.mineral-paper-deep}"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.control}"
    width: "34px"
    height: "34px"
  navigation-button:
    backgroundColor: "rgba(249, 248, 244, 0.94)"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.control}"
    width: "38px"
    height: "52px"
---

# Design System: Random Frame

## Overview

**Creative North Star: "The Archive Inspection Table"**

The interface treats each public image as a single archival print under inspection inside a compact desktop workbench. Warm mineral paper frames a deep graphite viewing stage; restrained cobalt actions and compact machined controls provide precision without competing with the image.

The system is quiet, lightly premium, and intentionally sparse. A fixed application toolbar and status bar hold persistent context while the flexible central work area gives the current frame all remaining space. Typography and framing establish hierarchy, while local-history cues and public-source warnings remain visible but secondary.

**Key Characteristics:**

- One oversized image stage is the visual anchor.
- A fixed desktop frame keeps tools, source actions, and session status continuously available without page scrolling.
- Warm paper, dark graphite, and one cobalt action color define the palette.
- Editorial serif headings sit beside neutral sans-serif controls and metadata.
- Controls are compact, tactile, and visibly keyboard-focusable.
- Native dialogs present focused history, consent, and local viewing statistics without becoming dashboard surfaces.

## Colors

The palette pairs warm archival neutrals with a near-black viewing environment and a single precise cobalt accent.

### Primary

- **Action Cobalt:** Primary actions, focus outlines, selection, and the live session indicator.
- **Action Cobalt Dark:** Hover state for the primary action.

### Neutral

- **Mineral Paper:** Page canvas and the dominant warm surround.
- **Mineral Paper Deep:** Supporting warm neutral available for subtle layering.
- **Graphite Ink:** Primary text, borders on secondary actions, and active control marks.
- **Muted Olive Gray:** Explanatory copy, session labels, disabled source metadata, and footer text.
- **Viewing Stage:** The media field and empty, loading, and error-state backdrop.
- **Viewing Stage Soft:** Supporting dark neutral for stage-adjacent layering.
- **Archival White:** High-contrast copy and light control surfaces.
- **Hairline Stone:** Dividers and keycap borders.
- **Warning Terracotta:** Error icon only.

**The One Cobalt Rule.** Cobalt communicates action, focus, or live status; it is not decorative fill.

### Themes

Light mode uses the original warm mineral paper. Dark mode keeps the archival character with charcoal paper, warm white type, restrained olive-gray metadata, and a brighter cobalt reserved for action and focus. The viewing stage deepens rather than inverts, so displayed media remains the focal point. Theme choice follows the system on first visit and persists after the visitor switches it.

## Typography

**Display Font:** Archive Serif (local Noto Serif Display asset, with serif fallback)  
**Body Font:** Avenir Next (with Avenir, Helvetica Neue, Arial, and sans-serif fallbacks)  
**Label/Mono Font:** System monospace for source identifiers only

**Character:** The serif adds archival gravity to titles and state headlines. The sans-serif keeps navigation, warnings, and controls direct; monospace makes the source identifier feel precise and inspectable.

### Hierarchy

- **Display:** Regular-weight serif with tight tracking for the viewer title and prominent state headings.
- **Body:** Compact sans-serif for descriptions and warnings, with generous leading inside the dark stage.
- **Label:** Semibold sans-serif for controls and terse interface labels.
- **Metadata:** Small muted sans-serif or tabular/monospace figures for counters, shortcuts, and source IDs.
- **Metric:** Large tabular serif numerals for viewing and exploration totals inside their focused dialog.

**The Serif Sparingly Rule.** Reserve Archive Serif for the viewer title and state headlines; actions and operational copy stay sans-serif.

## Layout

The Tauri window is a full-height desktop workbench. The body fills `100dvh` and uses three rows: a 56px application toolbar, a flexible `minmax(0, 1fr)` work area, and a 34px status bar. The main work area is inset 14px from the toolbar and 16px from each side, with overflow clipped so the application chrome never becomes a scrolling web page.

The viewer fills the available work area and repeats the same fixed-flex-fixed rhythm: a 50px header, the flexible graphite stage, and a 52px docked source/action rail. The stage absorbs window resizing while the toolbar, title, history jump, source tools, shortcuts, and file actions remain stable. The shipped window opens at 1440×900 and may resize down to 800×600; both sizes must show the complete workbench without document scrolling.

**The Single Frame Rule.** Never turn the experience into a grid: one image owns the viewing stage at a time.

**The Desktop Frame Rule.** Treat 800×600 as the compact floor: preserve all three application rows and let the stage flex before hiding persistent controls.

## Elevation & Depth

Depth is concentrated on the viewing stage and floating controls. The toolbar, rails, and status bar stay flat; the stage receives a compact ambient shadow suited to an inset desktop canvas, while primary and navigation buttons use smaller shadows to read as tangible controls.

### Shadow Vocabulary

- **Stage Ambient:** A compact two-layer shadow (`0 12px 32px` and `0 2px 6px`) that separates the graphite stage from the surrounding workbench without making it float like a web card.
- **Cobalt Lift:** A colored soft shadow below the primary action.
- **Control Lift:** A compact neutral shadow below previous/next controls.

**The Flat Surround Rule.** Keep the application toolbar, rails, and status bar flat; reserve elevation for the image stage and controls floating over it.

## Shapes

The stage uses an 8px outer radius and an 8px inset hairline, matching the compact toolbar and navigation controls. Secondary actions use 9px corners, the primary action uses 10px, and dialogs retain their softer 14px outer frames. The session indicator and loading spinner are circular. Thin strokes and open SVG icons preserve the technical, machined feel.

## Components

### Buttons

- **Primary:** Cobalt, semibold, compact, and paired with a forward arrow; it is the single dominant call to action.
- **Secondary:** Transparent, 34px tall, and outlined in graphite; hover inverts to graphite with archival-white text.
- **Text action:** Unboxed archival-white text with a thin underline, used only inside the dark error state.
- **Hover / Focus:** Hover changes color or inverts the surface. Keyboard focus uses a high-contrast cobalt outline offset from the component.
- **Icon controls:** 34px paper-deep squares in the application toolbar; hover inverts to graphite and active state compresses slightly.

### Cards / Containers

- **Viewing stage:** Near-black flexible surface with an 8px outer frame, faint 10px inset line, and compact ambient shadow.
- **Internal spacing:** Images use 24px vertical and 62px horizontal padding so one frame remains fully visible without displacing the surrounding rails.

### Dialogs

- **Shell:** Native modal behavior with mineral-paper surfaces, a graphite scrim, 14px corners, and the same ambient depth vocabulary as the stage.
- **Header:** Serif title, close control, and one hairline divider.
- **Statistics:** Two ruled definition rows pair muted labels with large tabular serif values; the supporting privacy note remains visually secondary.
- **Motion:** Dialogs scale from 0.97 while fading over 220ms; reduced-motion mode removes the scale.

### Navigation

- **Application toolbar:** A fixed 56px strip with brand mark and title on the left, compact statistics and theme controls plus local-history status on the right, divided from the work area by one stone hairline.
- **Frame navigation:** 38×52px archival-white controls float 16px from the stage edges. Disabled buttons remain visible at reduced opacity.
- **Lower rail:** A fixed 52px row docks the monospace source link and provider controls on the left, with shortcut hint, history, copy, and save actions on the right.
- **Status bar:** A fixed 34px strip carries the local-history notice, version, privacy, and provider attribution without competing with the frame.
- **Provider-specific browsing:** When a source exposes sequential identifiers, compact −1/+1 controls sit beside its source link, visually separated from the large history navigation. Omit this control group for providers without meaningful adjacency.
- **History jump:** A compact native number field in the viewer header shows the current position and accepts direct jumps within local history.

### Status States

- **Empty:** Serif invitation, concise public-content warning, then the cobalt start action.
- **Loading:** A fine circular spinner and plain status line.
- **Error:** Terracotta warning icon, serif headline, recovery explanation, and underlined retry action.

## Do's and Don'ts

### Do:

- **Do** keep the current image as the largest and highest-contrast content on the page.
- **Do** use cobalt only for action, focus, selection, or live status.
- **Do** preserve visible keyboard focus and the reduced-motion override.
- **Do** retain the warm paper surround and graphite stage contrast.
- **Do** keep provider identity and attribution legible without giving any provider visual ownership of the interface.
- **Do** preserve the 56px / flexible / 34px application frame and the 50px / flexible / 52px viewer frame at every supported desktop size.

### Don't:

- **Don't** introduce dashboard panels or card grids; persistent history remains a focused navigation aid.
- **Don't** add decorative color, gradients, or shadows outside the established restrained roles.
- **Don't** use the serif for controls, metadata, or long operational copy.
- **Don't** hide unavailable navigation; show it disabled so session position remains legible.
- **Don't** encode provider-specific controls into the global visual system; reveal them only when the active source supports them.
- **Don't** reintroduce centered page containers, large top gaps, or document scrolling into the desktop workbench.
