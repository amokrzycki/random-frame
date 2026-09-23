---
name: Random Frame
description: A quiet archive table for inspecting one public image at a time.
colors:
  mineral-paper: "#ebe8e1"
  mineral-paper-deep: "#dfdbd1"
  graphite-ink: "#191a18"
  muted-olive-gray: "#5c5d56"
  viewing-stage: "#151614"
  viewing-stage-soft: "#22231f"
  archival-white: "#f9f8f4"
  action-cobalt: "#2759dc"
  action-cobalt-dark: "#1944b8"
  hairline-stone: "#c9c5bc"
  field-stone: "#85827a"
  warning-terracotta: "#c86b55"
  window-close-red: "#c42b1c"
  dark-mineral-paper: "#171815"
  dark-mineral-paper-deep: "#22231f"
  dark-graphite-ink: "#f0eee8"
  dark-muted-olive-gray: "#aaa99f"
  dark-viewing-stage: "#0d0e0c"
  dark-viewing-stage-soft: "#1b1c19"
  dark-action-cobalt: "#496adc"
  dark-action-cobalt-dark: "#3f63d7"
  dark-hairline-stone: "#3b3c36"
  dark-field-stone: "#6f7068"
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

The system is quiet, lightly premium, and intentionally sparse. Three bands stack top to bottom: a fixed custom titlebar, the flexible viewing stage, and one info line that carries position, frame identity, actions, and the single way forward. Typography and framing establish hierarchy, while local-history cues and public-source warnings remain visible but secondary.

**Key Characteristics:**

- One oversized image stage is the visual anchor.
- A fixed desktop frame keeps tools, source actions, and session position continuously available without page scrolling.
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
- **Field Stone:** Text-input borders only, at 3:1 or better against the paper in both themes.
- **Warning Terracotta:** Error icon only.
- **Window Close Red:** Hover fill of the titlebar close control only, matching the native window-close convention in both themes.

**The One Cobalt Rule.** Cobalt communicates action, focus, selection, or live status; it is not decorative fill. Draw next is the only cobalt button on the main screen.

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

**The Serif Sparingly Rule.** Reserve Archive Serif for the viewer title, dialog and reading-page headings, state headlines, and metric numerals; actions and operational copy stay sans-serif.

## Layout

The Tauri window is a full-height desktop workbench. The body fills `100dvh` and uses two rows: a 42px custom titlebar and a flexible `minmax(0, 1fr)` work area. The work area is inset 14px from the titlebar, 16px from each side, and 4px from the bottom, with overflow clipped so the application chrome never becomes a scrolling web page. The privacy page adds its 34px status bar as an implicit third row.

The viewer fills the work area with two rows: the flexible graphite stage and a 56px info line. The stage absorbs window resizing while the info line stays stable. The shipped window opens at 1440×900 and may resize down to 800×600; both sizes must show the complete workbench without document scrolling.

**The Single Frame Rule.** Never turn the viewing stage into a grid: one image owns it at a time. Thumbnail grids live only inside the history dialog, as a way back to a frame.

The history dialog grid auto-fills 138px-minimum columns with 12px gaps. Transient notices float above the frame: toasts stack bottom-right 20px from the window edges, and the update banner centers 16px below the top edge.

**The Desktop Frame Rule.** Treat 800×600 as the compact floor: preserve the titlebar, stage, and info line, and let the stage flex before hiding persistent controls. The info line is a size container that sheds detail in a fixed order: below 720px the `prnt.sc/` prefix and the Draw next keycap drop; below 600px the ID steppers fold into a menu; below 480px the position tightens from `12 / 48` to `12/48`. Draw next never collapses and nothing wraps. The full line fits at the 800px floor.

## Elevation & Depth

Depth is concentrated on the viewing stage and floating controls. The titlebar, info line, and status strips stay flat; the stage receives a compact ambient shadow suited to an inset desktop canvas, while primary and navigation buttons use smaller shadows to read as tangible controls.

### Shadow Vocabulary

- **Stage Ambient:** A compact two-layer shadow (`0 12px 32px` and `0 2px 6px`) that separates the graphite stage from the surrounding workbench without making it float like a web card.
- **Cobalt Lift:** A colored soft shadow below the primary action and Draw next, mixed from the current theme's cobalt at 28%.
- **Dark Hairline Ring:** In dark mode the stage, toasts, and update banner add a 1px warm-white ring at 10% so their edges survive on charcoal paper; light mode omits it.
- **Control Lift:** A compact neutral shadow below previous/next controls.
- **Notice Lift:** A soft `0 10px 28px` warm shadow under the dark toasts and update banner, so they read as momentary overlays.

**The Flat Surround Rule.** Keep the titlebar, info line, and dialog footers flat; reserve elevation for the image stage, controls floating over it, and Draw next.

## Shapes

The stage uses an 8px outer radius and an 8px inset hairline, matching the compact titlebar and navigation controls. Secondary actions use 9px corners; the primary action, Draw next, history thumbnails, toasts, the ID menu, and the update banner use 10px; ledger thumbnails use 5px; and dialogs retain their softer 14px outer frames. The session indicator and loading spinner are circular. Thin strokes and open SVG icons preserve the technical, machined feel.

## Components

### Buttons

- **Primary:** Cobalt, semibold, compact, and paired with a forward arrow; it is the single dominant call to action.
- **Secondary:** Transparent, 34px tall, and outlined in graphite; hover inverts to graphite with archival-white text.
- **Text action:** Unboxed archival-white text with a thin underline, used only inside the dark error state.
- **Hover / Focus:** Hover changes color or inverts the surface. Keyboard focus uses a high-contrast cobalt outline offset from the component.
- **Icon controls:** 34px paper-deep squares in the titlebar; hover inverts to graphite and active state compresses slightly.

### Cards / Containers

- **Viewing stage:** Near-black flexible surface with an 8px outer frame, faint 10px inset line, and compact ambient shadow.
- **Internal spacing:** Images use 24px vertical and 62px horizontal padding so one frame remains fully visible without displacing the surrounding rails.

### Dialogs

- **Shell:** Native modal behavior with mineral-paper surfaces, a graphite scrim, 14px corners, and the same ambient depth vocabulary as the stage.
- **Header:** Serif title, close control, and one hairline divider.
- **History grid:** Graphite thumbnail tiles with a 10px frame, a 4:3 contained image over Viewing Stage Soft, and a monospace ID caption. The current frame gets a cobalt double-weight border; frames without a stored thumbnail show a diagonal graphite stripe.
- **History pager:** A flat 62px footer below one hairline: muted frame range on the left, outlined Previous/Next steps around a "Page n of m" label, and a native "Per page" select (10/25/50/100, default 25). Steps and select share a 38px outlined control that fills with graphite on hover. The footer is omitted when history fits the smallest page, and the step buttons are omitted when everything fits on one page.
- **Statistics headline:** "Prnt.sc explored" is the one headline figure, in tabular serif numerals, followed by muted detail lines (share of ID space, viewable and unavailable, viewed today and all time).
- **Draw ledger:** A plain ordered list, one hairline-ruled row per active day, newest first: the date ("Today", "Yesterday", then weekday and date), a muted "N drawn · M unavailable" count (the unavailable part only when nonzero), and a strip of up to six 48×36 thumbnails from that day's frames, grouped by the local day of `viewedAt`, with a "+X" overflow. Clicking a thumbnail closes the dialog and shows that frame; the current frame gets the cobalt selection border. Days with no saved thumbnails show a 1px muted hairline sized to their share of the busiest day. Rows are focusable and render 14 days at a time behind an outlined "Show earlier days" button.
- **Dialog footer:** History and Stats end in the Mineral Paper Deep status strip carrying the local-history and privacy sentence; the Stats strip also holds the version, Privacy, and Prnt.sc links.
- **Lightbox:** Zooming opens the image edge to edge below the titlebar on a near-black 94% scrim with 24px padding and a zoom-out cursor.
- **Motion:** Dialogs scale from 0.97 while fading over 220ms; reduced-motion mode removes the scale.

### Navigation

- **Titlebar:** A fixed 42px Mineral Paper Deep drag region with brand mark and title on the left, compact statistics, keyboard shortcuts and theme controls, then 46px-wide square-stroke window controls on the right, divided from the work area by one stone hairline. Close hovers to Window Close Red.
- **Frame navigation:** 38×52px archival-white controls float 16px from the stage edges. Disabled buttons remain visible at reduced opacity.
- **Info line:** Left to right: the position readout, a hairline divider, the monospace frame ID with its adjacent-ID steppers on either side and copy-link and open-source icons, a flexible gap, History, Copy image and Save image as titled 34px icon buttons, then Draw next at the far right. Focus order follows it: stage, position, steppers, actions, Draw next.
- **Position readout:** `12 / 48` in tabular figures (current in ink, total muted). Clicking it swaps in a native number field in place; Enter jumps, Escape or blur restores the readout.
- **Draw next:** The single cobalt control on the main screen, 40px tall with a muted N keycap. It always draws a new frame, even mid-history; the frame joins the end of history and the view jumps to it. While drawing, an inline spinner replaces the label at the same width with `aria-busy`. During a rate-limit cooldown it reads "Wait 12s", desaturates, and uses `aria-disabled` so it keeps focus. Pressing → on the newest frame pulses it once and announces its key.
- **Keyboard:** ←/→ only move through history. N draws from anywhere outside the jump field; Space and Enter draw when no control has focus. S saves, C copies the image, H opens History. ? toggles the Keyboard shortcuts sheet, a 560px dialog with one hairline-ruled row per action and paper-deep keycaps on the right; the titlebar keyboard icon opens it too. Icon-action tooltips name their key, e.g. "Save image (S)".
- **Provider-specific browsing:** When a source exposes sequential identifiers, chevron steppers flank its ID, visually separated from the large history navigation. Omit this control group for providers without meaningful adjacency.
- **Status bar:** Only the privacy page keeps the fixed 34px status strip. Its muted text holds 4.5:1 or better on Mineral Paper Deep in both themes.

### Status States

- **Empty:** Serif invitation and concise public-content warning; no in-stage button. Draw next in the info line takes initial focus.
- **Loading:** A fine circular spinner and plain status line.
- **Error:** Terracotta warning icon, serif headline, recovery explanation, and underlined retry action.

### Notices

- **Toast:** Near-black 97% pill-cornered (10px) note with a cobalt status dot and 13px semibold archival-white text; enters over 220ms.
- **Update banner:** The same dark surface centered at the top, with a cobalt install action and a dimmed dismiss.

### Reading Pages

- **Privacy page:** A scrolling 760px column inside the work area, with serif headings, 14px body at 1.75 leading, and a hairline under the header. It is the only surface allowed to scroll.

## Do's and Don'ts

### Do:

- **Do** keep the current image as the largest and highest-contrast content on the page.
- **Do** use cobalt only for action, focus, selection, or live status.
- **Do** preserve visible keyboard focus and the reduced-motion override.
- **Do** retain the warm paper surround and graphite stage contrast.
- **Do** keep provider identity and attribution legible without giving any provider visual ownership of the interface.
- **Do** preserve the 42px titlebar / flexible stage / 56px info line frame at every supported desktop size.

### Don't:

- **Don't** introduce dashboard panels or card grids outside the history dialog; persistent history remains a focused navigation aid, and the stats dialog stays a ledger, not a dashboard.
- **Don't** add a second cobalt button to the main screen or text labels to the info line's icon actions.
- **Don't** add decorative color, gradients, or shadows outside the established restrained roles.
- **Don't** use the serif for controls, metadata, or long operational copy.
- **Don't** hide unavailable navigation; show it disabled so session position remains legible.
- **Don't** encode provider-specific controls into the global visual system; reveal them only when the active source supports them.
- **Don't** reintroduce centered page containers, large top gaps, or document scrolling into the desktop workbench; the privacy page scrolls within the work area, never the window.
