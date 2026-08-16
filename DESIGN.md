---
name: Tiny Soho
description: An ivory growth record for one Instagram account, set as an editorial page rather than a dashboard.
colors:
  ground: "#F7F4EE"
  ink: "#14120E"
  raised: "#FDFCF8"
  quiet: "#ECE7DC"
  muted-ink: "#6E6A5E"
  hairline: "#E0DACD"
  field-edge: "#CFC8B8"
  gold-display: "#9C7C38"
  gold-text: "#8A6B2C"
  oxblood: "#7A2E2E"
  funnel-mark: "#2A4A6B"
  funnel-soft: "#6B8AA5"
  funnel-unknown: "#8F8A80"
  country-1: "#2A4A6B"
  country-2: "#9C5B21"
  country-3: "#1F6B54"
  country-4: "#8A6B2C"
  country-5: "#8C3B63"
  country-6: "#3F6B22"
  country-7: "#5A4E9C"
  country-8: "#A33A34"
typography:
  display:
    fontFamily: "Bodoni Moda, Didot, Times New Roman, serif"
    fontSize: "clamp(2rem, 5vw, 2.9rem)"
    fontWeight: 400
    lineHeight: 1.06
    letterSpacing: "-0.012em"
  figure:
    fontFamily: "Bodoni Moda, Didot, serif"
    fontSize: "clamp(3.4rem, 7vw, 4.2rem)"
    fontWeight: 400
    lineHeight: 0.86
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Bodoni Moda, Didot, serif"
    fontSize: "1.5rem"
    fontWeight: 400
    lineHeight: 1.15
  body:
    fontFamily: "Jost, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 300
    lineHeight: 1.625
  label:
    fontFamily: "Jost, ui-sans-serif, sans-serif"
    fontSize: "0.625rem"
    fontWeight: 300
    letterSpacing: "0.26em"
rounded:
  sm: "1px"
  md: "2px"
  lg: "2px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    height: "2.25rem"
  button-brand:
    backgroundColor: "{colors.gold-display}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
  button-brand-hover:
    backgroundColor: "{colors.gold-text}"
    textColor: "{colors.ground}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0.25rem 0.75rem"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    padding: "0.375rem 1.25rem 0.375rem 1.75rem"
  nav-item-active:
    backgroundColor: "transparent"
    textColor: "{colors.gold-text}"
    typography: "{typography.title}"
---

# Design System: Tiny Soho

## Overview

**Creative North Star: "The Maison Record"**

A couture house's record book, not an analytics console. The account's growth is
set the way a maison sets a lookbook: ivory stock, noir ink, one thread of
antique gold, and enough silence around a figure that the figure means something.
The measured numbers are the content — they are given display scale and a serif
usually reserved for a magazine cover, because the whole product exists to make
a small number of honest figures worth looking at.

The system's defining refusal is the container. There are no cards. Grouping is
done with a 1px hairline and space, never with a filled, rounded, shadowed box.
This is the single decision that separates this world from the dashboard it
replaced, and it is the first thing to check when a new screen feels wrong: if
content has been put inside a bordered rectangle, the world has been abandoned.

The second refusal is decoration standing in for hierarchy. Emphasis comes from
size, weight, and space. It never comes from a tonal glow, a gradient, a coloured
chip, or an icon beside a label. The house has no icon system in its navigation
at all — the type carries state, and the active route is set in Bodoni italic
rather than given a highlight.

**Key Characteristics:**

- Ivory paper ground (`#F7F4EE`), never white, never dark
- Bodoni Moda for display and every figure; Jost at weight 300 for everything else
- One accent — antique gold — and it appears perhaps twice per screen
- Hairlines and space instead of cards, fills, and shadows
- Near-square corners (1–2px), so nothing reads as a widget
- Tabular figures everywhere, by default rather than per-component

## Colors

Ivory and noir with a single metal. Every value below was measured against the
ground rather than chosen by eye, and the ratios are recorded because several sit
close to their floor.

### Primary

- **Antique Gold — display** (`#9C7C38`): the house thread. Figures at display
  scale, the italic accent word in a headline, the rule under the wordmark.
  **3.57:1 — large text only.** It is not legal for body copy or links.
- **Antique Gold — text** (`#8A6B2C`): the same metal darkened until small text
  is legal. **4.53:1.** Links, the active navigation item, small labels that
  need the accent. These two are not interchangeable; picking the wrong one is
  the most likely contrast failure in this system.

### Neutral

- **Ivory Stock** (`#F7F4EE`): the page ground. Everything sits directly on it.
- **Noir Ink** (`#14120E`): body and display text. 17.04:1.
- **Raised Ivory** (`#FDFCF8`): the only surface permitted above the ground, and
  only for genuinely floating chrome — a drawer, a popover. Never a card.
- **Quiet Ivory** (`#ECE7DC`): hover beds and inert fills.
- **Muted Ink** (`#6E6A5E`): secondary copy. **4.92:1.** The obvious ivory-grey
  (`#8A8477`) measures 3.39:1 and fails; it was in the first comp and was caught
  by measurement, not by eye.
- **Hairline** (`#E0DACD`): every rule in the system. 1px, never 2px.
- **Field Edge** (`#CFC8B8`): input borders, which need to read as an affordance.

### Tertiary — data

Data colour is a separate vocabulary from house colour, and the two must never be
confused: gold means *the house*, never *a series*.

- **Funnel Mark** (`#2A4A6B`) and **Funnel Soft** (`#6B8AA5`): one hue, two
  steps. 8.35:1 and 3.30:1, luminance gap 0.175.
- **Funnel Unknown** (`#8F8A80`): absence of evidence. Deliberately not a hue.
- **Country marks** (`#2A4A6B`, `#9C5B21`, `#1F6B54`, `#8A6B2C`, `#8C3B63`,
  `#3F6B22`, `#5A4E9C`, `#A33A34`): categorical, separated by hue rather than
  lightness, each clearing 3:1 on the ground.
- **Oxblood** (`#7A2E2E`): loss and destruction. 8.47:1.

### Named Rules

**The Two Golds Rule.** `#9C7C38` for large figures, `#8A6B2C` for anything a
reader has to read at text size. One is 3.57:1 and one is 4.53:1, and the
difference is whether the screen passes.

**The One Thread Rule.** Gold appears at most twice per screen. Its rarity is the
entire effect; a third use makes it a theme colour and the maison becomes a brand
guideline.

**The Ground Truth Rule.** Every data colour in this system was validated against
`#F7F4EE`. The previous set was validated against `#0a0a0a`. If the ground ever
changes again, every chart colour is void until re-measured — a palette does not
travel between grounds.

## Typography

**Display Font:** Bodoni Moda (with Didot, Times New Roman)
**Body Font:** Jost (with system sans fallbacks)

**Character:** A high-contrast didone against a geometric sans in the Futura
lineage — the pairing a fashion house uses for a cover and its captions. Bodoni
supplies the drama and does it only where there is room; Jost at weight 300
carries every functional word without competing.

### Hierarchy

- **Display** (Bodoni 400, `clamp(2rem, 5vw, 2.9rem)`, 1.06, `-0.012em`): page
  headlines, held to an 18ch measure so they break as an editor would break them.
- **Figure** (Bodoni 400, `3.4–4.2rem`, 0.86, `-0.03em`): the one metric that is
  the score. Gold. One per screen.
- **Figure, supporting** (Bodoni 400, `2.1rem`): every other measured number.
- **Title** (Bodoni 400, `1.5rem`): the wordmark, drawer and panel headings.
- **Body** (Jost 300, `0.875rem`, 1.625): all running copy, at a 46–64ch measure.
- **Label** (Jost 300, `0.625rem`, `0.26em`, uppercase): every field name in the
  system, defined once as `label-caps` so the tracking cannot drift between
  screens.

### Named Rules

**The Didone Ceiling Rule.** Bodoni is for display and figures only. Below about
1.25rem it stops being elegant and starts costing legibility, and a didone at
13px is decoration charged to the reader.

**The Tabular Default Rule.** Figures are tabular by default at the `base` layer,
not per component. Numbers in this product are compared down columns, and a new
component must not be able to ship proportional figures by omission.

## Layout

A fixed 224px index column against a fluid record. The index carries a right
hairline and no fill; the record is centred at a 1152px maximum with 40px side
padding on desktop and 20px on mobile, so the measure stays editorial rather than
stretching to the monitor.

Vertical rhythm is a 40px page rhythm (`space-y-10`) with 28px inside a section.
More space sits above a heading than below it. Sections are separated by a
hairline and a 28px lead, never by a card boundary.

The KPI row is deliberately unequal: `1.35fr 1fr 1fr` on desktop, collapsing to
two columns then one. An equal three-up row would claim the three numbers matter
the same, and the product record says they do not — the US figure is the score
and the other two are supporting facts.

Below 768px the index becomes a left drawer over a 25% ink scrim, and the running
head regains the page title, because nothing else names where you are once the
index is closed.

## Elevation & Depth

**This system has no shadows.** Not "few" — none. Depth is carried by three
things: the ivory ground, a barely-raised surface (`#FDFCF8`) for genuinely
floating chrome, and 1px hairlines. A drop shadow anywhere in this world is a
regression to the dashboard it replaced.

### Named Rules

**The Hairline-Only Rule.** If two regions need separating, the answer is a 1px
`#E0DACD` rule and more space. It is never a border-radius, never a fill, never a
shadow, and never a 2px accent border on one side.

## Shapes

Near-square throughout: 2px on controls and surfaces, 1px on the smallest. The
radius exists only to take the mechanical edge off a rendered corner, not to
make anything look soft. Rounded pills, 12px cards, and circular icon beds all
belong to the previous world.

Rules are 1px and full-strength; there are no dotted, dashed, or double borders.
The only curve in the system is the drawn line of a chart.

## Components

### Buttons

- **Shape:** near-square (2px), 36px tall, 16px horizontal padding
- **Primary:** noir ink ground with ivory text (17:1) — the default action
- **Brand:** antique gold ground with *ink* text, measured at 4.77:1. White on
  gold is 1.9:1; the dark-era pairing would have failed here unchanged
- **Outline / Ghost:** transparent with a hairline, bedding to quiet ivory on hover
- **Focus:** a 2px gold-text ring, offset from the ground

### Inputs

- **Style:** transparent ground, 1px `#CFC8B8` edge, 2px radius, 36px tall
- **Focus:** 2px gold-text ring with a 1px offset
- **Placeholder:** muted ink, which clears 4.5:1 rather than fading to a hint

### Navigation

The house index. Typographic, with no icons at all. Group headings are
`label-caps`; items are Jost 13.5px at `0.06em`. Hover slides the item 8px right
over 300ms. The active item is set in **Bodoni italic at 15px in gold-text** —
state is carried by the typeface, so the column needs no highlight, pill, or bar.

### The Figure

The signature component. A `label-caps` field name, a hairline above it, and the
number in Bodoni beneath at display scale. The scored figure takes gold and the
larger size; every other figure takes ink at 2.1rem. Counts and qualifications
sit below the figure in body and muted sizes — never beside it, never inside a
parenthesis.

### Guarded figures

Where a rate cannot be supported by its sample, the counts take the value slot
and the percentage is not rendered at all — not greyed, not parenthesised, not
behind a tooltip. This is product doctrine that outranks any visual preference:
see `GuardedNumber`. The visual system must always leave room for a figure slot
to contain "5 of 32" rather than "15.6%".

## Do's and Don'ts

### Do:

- **Do** group with a 1px `#E0DACD` hairline and space.
- **Do** use `#8A6B2C` for any gold a reader must read at text size, and reserve
  `#9C7C38` for figures and headline accents.
- **Do** set every measured number in Bodoni with tabular figures.
- **Do** give one figure per screen the display scale and the gold; make the rest
  supporting.
- **Do** carry counts alongside every rate, and render counts *instead of* a rate
  when the sample is thin.
- **Do** honour `prefers-reduced-motion` on every entrance and transition.
- **Do** re-measure every data colour if the ground ever changes.

### Don't:

- **Don't** put content in a card. No filled, bordered, rounded container as a
  page structure — this is the system's first rule.
- **Don't** add a drop shadow anywhere.
- **Don't** put an icon beside a navigation label, or introduce an icon set into
  the index.
- **Don't** set Bodoni below 1.25rem.
- **Don't** use gold as a data series colour, or a country colour as an accent.
- **Don't** write an eyebrow or kicker above a heading, or number sections
  (01 / 02) when the order carries no information.
- **Don't** give a coloured border to one side of a block; the hairline is
  uniform and 1px.
- **Don't** animate each section in with the same staggered entrance. Motion is
  one authored moment per screen, not a template announcing itself.
