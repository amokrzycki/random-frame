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
  control: "10px"
  stage: "14px"
spacing:
  xs: "8px"
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
    rounded: "9px"
    padding: "0 14px"
    height: "40px"
  button-icon:
    backgroundColor: "{colors.mineral-paper-deep}"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.control}"
    width: "40px"
    height: "40px"
  navigation-button:
    backgroundColor: "rgba(249, 248, 244, 0.94)"
    textColor: "{colors.graphite-ink}"
    rounded: "11px"
    width: "48px"
    height: "64px"
---

# Design System: Random Frame

## Overview

**Creative North Star: "The Archive Inspection Table"**

The interface treats each public image as a single archival print under inspection. Warm mineral paper surrounds a deep graphite viewing stage; restrained cobalt actions and compact machined controls provide precision without competing with the image.

The system is quiet, lightly premium, and intentionally sparse. Typography and framing establish hierarchy, while temporary-session cues and public-source warnings remain visible but secondary.

**Key Characteristics:**

- One oversized image stage is the visual anchor.
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
- **Metric:** Large tabular serif numerals for the two viewing-stat totals inside their focused dialog.

**The Serif Sparingly Rule.** Reserve Archive Serif for the viewer title and state headlines; actions and operational copy stay sans-serif.

## Layout

The page uses a centered fluid shell capped at 1480px, with the viewer capped at 1240px. A slim 84px masthead leads into a 48px top gap and one stage whose height is `clamp(420px, calc(100dvh - 432px), 720px)`. The viewer header and lower rail align title, count, source, shortcuts, and save action around that stage, keeping the frame responsive to the available viewport rather than relying on a fixed percentage height.

At 720px and below, outer gutters tighten, the stage becomes 58vh tall, secondary header copy and keyboard hints disappear, and previous/next controls move to a two-column bottom dock. At 430px and below, labels compact further, dialogs tighten their internal padding, and the footer stacks.

**The Single Frame Rule.** Never turn the experience into a grid: one image owns the viewing stage at a time.

## Elevation & Depth

Depth is concentrated on the viewing stage and floating controls. The paper shell stays flat; the stage receives a broad warm ambient shadow, while primary and navigation buttons use smaller shadows to read as tangible controls.

### Shadow Vocabulary

- **Stage Ambient:** A broad two-layer shadow that lifts the dark stage from the mineral paper.
- **Cobalt Lift:** A colored soft shadow below the primary action.
- **Control Lift:** A compact neutral shadow below previous/next controls.

**The Flat Surround Rule.** Keep masthead, rails, and footer flat; reserve elevation for the image stage and controls floating over it.

## Shapes

The stage and dialogs use gently rounded outer frames, with the stage carrying a smaller inset hairline. Controls use compact rounded rectangles; the session indicator and loading spinner are circular. Thin strokes and open SVG icons preserve the technical, machined feel.

## Components

### Buttons

- **Primary:** Cobalt, semibold, compact, and paired with a forward arrow; it is the single dominant call to action.
- **Secondary:** Transparent with a graphite outline; hover inverts to graphite with archival-white text.
- **Text action:** Unboxed archival-white text with a thin underline, used only inside the dark error state.
- **Hover / Focus:** Hover changes color or inverts the surface. Keyboard focus uses a high-contrast cobalt outline offset from the component.
- **Icon controls:** Forty-pixel paper-deep squares in the masthead; hover inverts to graphite and active state compresses slightly.

### Cards / Containers

- **Viewing stage:** Near-black surface, gently rounded outer frame, faint inset line, and deep ambient shadow.
- **Internal spacing:** Images retain generous breathing room; mobile reserves extra bottom space for the docked navigation controls.

### Dialogs

- **Shell:** Native modal behavior with mineral-paper surfaces, a graphite scrim, 14px corners, and the same ambient depth vocabulary as the stage.
- **Header:** Serif title, close control, and one hairline divider.
- **Statistics:** Two ruled definition rows pair muted labels with large tabular serif values; the supporting privacy note remains visually secondary.
- **Motion:** Dialogs scale from 0.97 while fading over 220ms; reduced-motion mode removes the scale.

### Navigation

- **Masthead:** Brand mark and title on the left, compact statistics and theme controls plus temporary-session status on the right, divided from content by one stone hairline.
- **Frame navigation:** Archival-white floating edge controls on desktop; equal-width docked controls on mobile. Disabled buttons remain visible at reduced opacity.
- **Lower rail:** Monospace source link on the left; shortcut hint and save action on the right.
- **Provider-specific browsing:** When a source exposes sequential identifiers, compact −1/+1 controls sit beside its source link, visually separated from the large history navigation. Omit this control group for providers without meaningful adjacency.
- **History jump:** A compact native number field in the viewer header shows the current position and accepts direct jumps within the temporary history.

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

### Don't:

- **Don't** introduce dashboard panels, card grids, or persistent browsing history.
- **Don't** add decorative color, gradients, or shadows outside the established restrained roles.
- **Don't** use the serif for controls, metadata, or long operational copy.
- **Don't** hide unavailable navigation; show it disabled so session position remains legible.
- **Don't** encode provider-specific controls into the global visual system; reveal them only when the active source supports them.
