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
  stage-link-hover: "#aabcf4"
  stage-muted: "#b8b8b1"
  stage-hint: "#85827a"
  stage-line: "#595a55"
  hairline-stone: "#c9c5bc"
  field-stone: "#85827a"
  control-line: "#85827a"
  disabled-ink: "#7c7c74"
  warning-terracotta: "#b85a43"
  window-close-red: "#c42b1c"
  dark-mineral-paper: "#1c1d19"
  dark-mineral-paper-deep: "#252621"
  dark-graphite-ink: "#f0eee8"
  dark-muted-olive-gray: "#aaa99f"
  dark-viewing-stage: "#0d0e0c"
  dark-viewing-stage-soft: "#151613"
  dark-action-cobalt: "#496adc"
  dark-action-cobalt-dark: "#3f63d7"
  dark-hairline-stone: "#40413a"
  dark-field-stone: "#6f7068"
  dark-control-line: "#6a6b63"
  dark-disabled-ink: "#77776f"
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
    fontFamily: "Archive Sans, Avenir Next, Avenir, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Archive Sans, Avenir Next, Avenir, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 650
    lineHeight: 1.2
  dialog-title:
    fontFamily: "Archive Serif, serif"
    fontSize: "clamp(26px, 3vw, 32px)"
    fontWeight: 400
  entry-title:
    fontFamily: "Archive Serif, serif"
    fontSize: "clamp(28px, 4vw, 34px)"
    fontWeight: 400
  metric:
    fontFamily: "Archive Serif, serif"
    fontSize: "clamp(38px, 8vw, 58px)"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "-0.035em"
  mono:
    fontFamily: "ui-monospace, SF Mono, SFMono-Regular, Menlo, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.2
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
  status-bar:
    backgroundColor: "{colors.mineral-paper-deep}"
    textColor: "{colors.muted-olive-gray}"
    height: "50px"
  tools-menu:
    backgroundColor: "{colors.mineral-paper}"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.primary}"
  tools-menu-item:
    rounded: "{rounded.compact}"
    height: "34px"
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
- **Stage Link Hover:** Pale blue for hovered text actions and toast actions on dark surfaces.

### Neutral

- **Mineral Paper:** Page canvas and the dominant warm surround.
- **Mineral Paper Deep:** Supporting warm neutral available for subtle layering.
- **Graphite Ink:** Primary text, borders on secondary actions, and active control marks.
- **Muted Olive Gray:** Explanatory copy, session labels, disabled source metadata, and footer text.
- **Viewing Stage:** The media field and empty, loading, and error-state backdrop.
- **Viewing Stage Soft:** Supporting dark neutral for stage-adjacent layering.
- **Stage Muted:** Secondary copy inside the viewing stage, and the info toast's dot, where paper-surface metadata colors do not apply.
- **Stage Hint:** The quietest copy on the stage, the empty state's keyboard hint.
- **Stage Line:** Strokes on the stage: the loader track and the loading hint's keycap.
- **Archival White:** High-contrast copy and light control surfaces.
- **Hairline Stone:** Dividers and keycap borders.
- **Field Stone:** Text-input borders only, at 3:1 or better against the paper in both themes.
- **Control Line (`--control-line`):** Outlines of outlined buttons, the ID pill, and the consent checkbox, at 3:1 or better against the paper in both themes. Hairline Stone stays for dividers only.
- **Disabled Ink:** Marks of disabled info-line icons and frame menu items, solid rather than faded, at 3:1 or better against the paper in both themes.
- **Warning Terracotta:** Error dots (stage error headline, Sync error, error toast) and the 1px outline of destructive controls (Leave Sync, armed clear-history buttons, and the hover ring on history remove controls); never text. Holds 3:1 or better on the paper in light mode and on the stage.
- **Window Close Red:** Hover fill of the titlebar close control only, matching the native window-close convention in both themes.

**The One Cobalt Rule.** Cobalt communicates action, focus, selection, or live status; it is not decorative fill. Draw is the only cobalt button on the main screen.

### Themes

Light mode uses the original warm mineral paper. Dark mode keeps the archival character with charcoal paper, warm white type, restrained olive-gray metadata, and a brighter cobalt reserved for action and focus. The viewing stage deepens rather than inverts, so displayed media remains the focal point. Theme choice follows the system on first visit and persists after the visitor switches it.

## Typography

**Display Font:** Archive Serif (local Noto Serif Display asset, with serif fallback)  
**Body Font:** Archive Sans (local Noto Sans regular and bold assets, with Avenir Next, Avenir, Helvetica Neue, Arial, and sans-serif fallbacks)
**Mono Font:** SF Mono via `ui-monospace` (with SFMono-Regular, Menlo, and monospace fallbacks) for source identifiers only; 13px in the info line, 12px tabular in history captions

**Character:** The serif adds archival gravity to titles and state headlines. The sans-serif keeps navigation, warnings, and controls direct; monospace makes the source identifier feel precise and inspectable.

### Hierarchy

- **Display:** Regular-weight serif with tight tracking for the viewer title and prominent state headings.
- **Dialog titles:** Utility dialogs use a 26–32px serif off-ramp; the entry dialog uses 28–34px.
- **Body:** Compact sans-serif for descriptions and warnings, with generous leading inside the dark stage.
- **Label:** Semibold sans-serif for controls and terse interface labels.
- **Metadata:** Small muted sans-serif or tabular/monospace figures for counters, shortcuts, and source IDs.
- **Metric:** Large tabular serif numerals for viewing and exploration totals inside their focused dialog.

**The Serif Sparingly Rule.** Reserve Archive Serif for the viewer title, dialog and reading-page headings, state headlines, and metric numerals; actions and operational copy stay sans-serif.

## Layout

The Tauri window is a full-height desktop workbench. The body fills `100dvh` and uses two rows: a 42px custom titlebar and a flexible `minmax(0, 1fr)` work area. The work area is inset 14px from the titlebar, 16px from each side, and 4px from the bottom, with overflow clipped so the application chrome never becomes a scrolling web page. The privacy page adds its 50px status bar as an implicit third row.

The viewer fills the work area with two rows: the flexible graphite stage and a 56px info line. The stage absorbs window resizing while the info line stays stable. The shipped window opens at 1440×900 and may resize down to 800×600; both sizes must show the complete workbench without document scrolling.

**The Single Frame Rule.** Never turn the viewing stage into a grid: one image owns it at a time. Thumbnail grids live only inside the history dialog, as a way back to a frame.

The history dialog grid auto-fills 138px-minimum columns with 12px gaps. Transient notices float above the frame: the current toast sits above the info line, clear of Draw, and the update banner centers 16px below the top edge.

**The Desktop Frame Rule.** Treat 800×600 as the compact floor: preserve the titlebar, stage, and info line, and let the stage flex before hiding persistent controls. The info line stays short at every width: the frame ID button opens a frame menu that carries the position and jump field, the ID steppers, the source link, and Copy and Save image, so nothing on the line sheds or wraps. Favorite and Draw sit beside it and never collapse. The full line fits at the 800px floor.

## Elevation & Depth

Depth is concentrated on the viewing stage and floating controls. The titlebar, info line, and status strips stay flat; the stage receives a compact ambient shadow suited to an inset desktop canvas, while primary and navigation buttons use smaller shadows to read as tangible controls.

### Shadow Vocabulary

- **Stage Ambient:** A compact two-layer shadow (`0 12px 32px` and `0 2px 6px`) that separates the graphite stage from the surrounding workbench without making it float like a web card.
- **Cobalt Lift:** A colored soft shadow below the primary action and Draw, mixed from the current theme's cobalt at 28%.
- **Dark Hairline Ring:** In dark mode the stage, toasts, update banner, frame menu, More menu, and the History and Lightbox dialogs add a 1px warm-white ring at 10% so their edges survive on charcoal paper; light mode omits it. The entry dialog has no ring.
- **Control Lift:** A compact neutral shadow below previous/next controls.
- **Notice Lift:** A soft `0 10px 28px` warm shadow at 20% under the dark toasts, the update banner, and the frame menu, so they read as momentary overlays. It pairs with the Dark Hairline Ring instead of a border.

**The Flat Surround Rule.** Keep the titlebar, info line, and dialog footers flat; reserve elevation for the image stage, controls floating over it, and Draw.

## Shapes

The stage uses an 8px outer radius and an 8px inset hairline, matching the compact titlebar and navigation controls. Secondary actions use 9px corners; the primary action, Draw, history thumbnails, toasts, the frame menu, and the update banner use 10px; ledger thumbnails, frame menu items, and the update banner's buttons use 5px; and dialogs retain their softer 14px outer frames. The session indicator and loading spinner are circular. Thin strokes and open SVG icons preserve the technical, machined feel.

## Components

### Buttons

- **Primary:** Cobalt, semibold, compact, and paired with a forward arrow; it is the single dominant call to action.
- **Secondary:** Transparent, 34px tall, and outlined in graphite; hover inverts to graphite with archival-white text.
- **Destructive:** Outlined like a secondary button with a 1px Warning Terracotta border and ink text (never terracotta text). Used for Leave Sync and for the armed "Confirm · N frames and streak" state, whose inset 1px shadow reinforces the outline. Confirmation dialogs focus Cancel first.
- **Text action:** Unboxed archival-white text with a thin underline, used only inside the dark error state.
- **Hover / Focus:** Hover changes color or inverts the surface. Keyboard focus uses a high-contrast cobalt outline offset from the component.
- **Icon controls:** Flat 42px-wide, full-height titlebar controls in the window controls' language: transparent, no outline, a faint key-surface wash on hover, and an inset focus ring. Stats, More, and the privacy page's theme toggle share it with minimize, maximize, and close; tooltips come from the same `data-tip` layer on both pages.

### Cards / Containers

- **Viewing stage:** Near-black flexible surface with an 8px outer frame, faint 10px inset line, and compact ambient shadow.
- **Internal spacing:** Images use 24px vertical and 62px horizontal padding so one frame remains fully visible without displacing the surrounding rails.

### Dialogs

- **Shell:** Modal behavior from `show()` plus inert, not `showModal()`, which would also inert the drag region, window controls, and the live region. `dialogs.ts` inerts the main content, titlebar tools, and update banner while any dialog is open, and traps Tab inside it. Native with mineral-paper surfaces, a graphite scrim, 14px corners, and the same ambient depth vocabulary as the stage.
- **Header:** Serif title, close control, and one hairline divider.
- **History grid:** Graphite thumbnail tiles with a 10px frame, a 4:3 contained image over Viewing Stage Soft, and a monospace ID caption. The current frame gets a cobalt double-weight border; tiles still awaiting a thumbnail show a soft shimmering skeleton (thumbnails load lazily, three at a time, only for tiles in view), and frames whose thumbnail failed show a diagonal graphite stripe. Favorited tiles carry a small archival-white star on a graphite chip in the top-right corner, never cobalt, so it can't be mistaken for the selection border; ledger thumbnails carry the same mark at a smaller size. The grid runs newest first, so page 1 is always full and the short page falls at the oldest end; captions and the range label count down ("Frames 35–11 of 60"), while Favorites lists the most recently starred first and uses ascending favorite positions in captions, accessible names, and the range. In All, hovering or focusing a tile reveals a 24px graphite chip in its top-left corner that removes the frame from history (its hover adds a 1px Warning Terracotta ring, never terracotta text); the chip stays out of the tab order, and Delete on a focused tile does the same. Removal writes at once and raises an Undo toast that restores the frame to its old place. Favorites, Seen IDs, and Stats are untouched, as with Clear, and Favorites tiles carry no remove control.
- **History filter:** An All / Favorites pair in the dialog header, joined as one 38px outlined control in the pager's language; the chosen side holds the graphite fill. It resets to All on every open. Favorites is the same grid, pager, and empty state over the starred frames in the order they were starred, with its own two-step clear control (click to arm, click again to confirm) shown only while favorites exist. Both clear controls live in the footer below the grid. Clearing history keeps favorites. The clear control's explanatory hint takes no height until armed, then eases open below its footer control (instant under reduced motion).
- **History pager:** A flat 62px footer below one hairline: muted frame range on the left, outlined Previous/Next steps around a "Page n of m" native number field (Enter jumps), and a native "Per page" select (10/25/50/100, default 25). Steps and select share a 38px outlined control that fills with graphite on hover. Pagination is hidden for histories of 10 frames or fewer; the clear-action footer stays available. The History dialog alone holds a fixed viewport-bounded height so All, Favorites, and empty share one size; Stats, Shortcuts, and Sync size to their content.
- **Statistics headline:** Frames drawn, Today, and Activity streak sit as a three-up tabular serif tally, each a figure above its label and divided by a hairline. The Prnt.sc IDs checked count and opened/unavailable breakdown follow as a muted detail line. Unreadable local data replaces every figure with an em dash and swaps the detail line for a plain explanation and a "Try again" action; the Draw ledger below is hidden until stats read successfully.
- **Draw ledger:** A plain ordered list, one hairline-ruled row per active day, newest first: the date ("Today", "Yesterday", then weekday and date), a muted "N drawn · M unavailable" count (the unavailable part only when nonzero), and a strip of up to six 48×36 thumbnails from that day's frames, grouped by the local day of `viewedAt`, with a "+X" overflow. Strips keep one row and scroll horizontally when needed; below 600px they sit beneath the date and counts. Clicking a thumbnail closes the dialog and shows that frame; the current frame gets the cobalt selection border. Rows without thumbnails rely on their labeled counts. Rows are focusable and render 14 days at a time behind an outlined "Show earlier days" button.
- **Sync recovery key:** While the key shows, the status line steps aside. A custom checkbox (the entry dialog's box, without its frame) gates Done. Done stays at full strength with `aria-disabled` and, when pressed early, moves focus to the checkbox; copying the key raises a toast.
- **Dialog footer:** The Stats dialog ends in the Mineral Paper Deep strip with one short line: Stats reset with History; IDs checked stay on this device and do not Sync. Version and Privacy live in the More menu; there is no "How stats work" disclosure.
- **Lightbox:** A near-black inspection view sits below the titlebar. Its top rail holds the frame ID, session position, 1:1/Fit toggle, and close button. Side arrows and ←/→ move through saved history; at 1:1 the image can be dragged or scrolled.
- **Motion:** Dialogs scale from 0.97 while fading over 220ms; reduced-motion mode removes the scale.

### Navigation

- **Titlebar:** A fixed 42px Mineral Paper Deep drag region with brand mark and title on the left, History (clock-arrow, tooltip "History (H)") and a More (three-dot) icon control, then 46px-wide square-stroke window controls (the privacy page swaps the tools for a Back to gallery link and a sun/moon theme toggle in the same control), all in one flat control style on the right, divided from the work area by one stone hairline. The native More popover holds Sync, Stats, Keyboard shortcuts, and the theme switch in 34px rows; it is at least 200px wide. Close hovers to Window Close Red.
- **Frame navigation:** 38×52px archival-white controls float 16px from the stage edges. Previous stays visible at reduced opacity on the first frame; Next is removed on the newest frame, where the info line's frame count already says the position and ← or → points at Draw.
- **Info line:** Left to right: the frame ID button (monospace ID with a chevron, opening the frame menu; its accessible name leads with the visible ID, then "frame options"), a muted tabular frame count beside it (`26 / 26`, no edit affordance), a flexible gap, Favorite and Save as titled 34px icon buttons, then Draw at the far right. The frame menu lists Jump to frame (which opens a jump field), Adjacent ID before and Adjacent ID after steppers, the source link with a copy-link aside, Copy image, and, below a rule, Remove this frame (ink text, a Warning Terracotta outline on hover and focus), which removes the shown frame from history, lands on the frame that takes its place, and offers Undo. The position count appears only beside the ID. History opens from the titlebar; Stats opens from More. Favorite is an outline star that fills with graphite ink (`aria-pressed`) while the shown frame is a favorite. Focus order follows it: stage, frame ID, Favorite, Save, Draw. Completing a save files the arrow icon away and draws a check in its place; the check holds while that frame stays shown and clears once another frame is drawn or restored. The "Saved image" toast carries a "Show in folder" action.
- **Position readout:** `12 / 48` in tabular figures (current in ink, total muted). Clicking it swaps in a native number field in place; Enter jumps, Escape or blur restores the readout.
- **Draw:** The single cobalt control on the main screen, 40px tall with a muted N keycap. It always draws a new frame, even mid-history; the frame joins the end of history and the view jumps to it. While drawing, an inline spinner replaces the label at the same width with `aria-busy`; both it and the stage loader wait 200ms, so a fast draw shows neither. During a rate-limit cooldown it reads "Wait 12s", desaturates, and uses `aria-disabled` so it keeps focus. Pressing → on the newest frame pulses it once and announces its key.
- **Keyboard:** ←/→ only move through history. N draws from anywhere outside the jump field; Space and Enter draw when no control has focus. S saves, C copies the image, F adds or removes the shown frame from favorites, H opens History. ? toggles the Keyboard shortcuts sheet, a 560px dialog with one hairline-ruled row per action and paper-deep keycaps on the right; the More menu opens it too. Icon-action tooltips name their key, e.g. "Save image (S)".
- **Provider-specific browsing:** When a source exposes sequential identifiers, chevron steppers flank its ID, visually separated from the large history navigation. Omit this control group for providers without meaningful adjacency.
- **Status bar:** Only the privacy page keeps the fixed 50px status strip (`.status-bar`), one line of copy with no links; the History pager and the Stats footer share its surface. Its muted text holds 4.5:1 or better on Mineral Paper Deep in both themes.

### Status States

- **Empty:** A small outlined frame mark gives the dark stage presence above the serif invitation, public-content warning, and a muted "Press N or use Draw below" hint; no in-stage button, and no text styled as one. Draw in the info line takes initial focus and gives a slow cobalt ring pulse three times, starting after 600ms, so the eye finds the one way forward.
- **Loading:** A fine circular spinner and plain status line. The spinner panel and the dim on the prior frame wait 200ms before easing in, so a draw that lands sooner never flickers.
- **Error:** A small terracotta dot before the sans-serif headline, a recovery explanation, and an underlined retry action that repeats the exact request that failed, captioned over the dimmed prior frame rather than replacing it. “No new frame this time” omits the extra recovery sentence; the action buttons carry recovery. The frame ID caption steps from ink to muted to match (never faded, which would drop it under 4.5:1); the icon tools beside it stay at full strength so disabled marks keep their 3:1.

### Notices

- **Toast:** Near-black 97% pill-cornered (10px) note with a white success dot, muted info dot, or terracotta error dot and 13px semibold archival-white text; enters over 220ms. New notices replace the current toast in a separate row below the viewer, clear of the image and Draw. Four seconds after a drawn frame settles, one info toast appears, "Tip: press F to favorite a frame.", remembered in local storage and skipped for anyone who already has favorites.
- **Update banner:** The same dark surface in the notice row below the viewer, with a cobalt install action and a dimmed dismiss.

### Reading Pages

- **Privacy page:** A scrolling column inside the work area, 62ch wide (about 75 characters a line), with serif headings, 16px body at 1.7 leading, and a hairline under the header. It is the only surface allowed to scroll.

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
- **Don't** hide Previous at the first frame or disable controls silently; show it disabled so session position remains legible. Next is the one exception on the newest frame, because the frame count beside the ID carries the position.
- **Don't** encode provider-specific controls into the global visual system; reveal them only when the active source supports them.
- **Don't** reintroduce centered page containers, large top gaps, or document scrolling into the desktop workbench; the privacy page scrolls within the work area, never the window.
