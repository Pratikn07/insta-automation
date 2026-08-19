---
name: Tiny Soho
description: A decision surface for one Instagram account — it opens with what to do next and why, and every figure carries the qualification that makes it safe to act on.
colors:
  ground: "#F7F5EF"
  ink: "#171812"
  raised: "#FFFEF9"
  quiet: "#EBE8DF"
  muted-ink: "#66665F"
  line: "#CAC7BD"
  signal: "#2C4A3B"
  signal-soft: "#DCE9E2"
  urgent: "#A8412B"
  destructive: "#8C3A2B"
  funnel-mark: "#2A4A6B"
  funnel-soft: "#6B8AA5"
  funnel-unknown: "#8F8A80"
  country-1: "#2C4A3B"
  country-2: "#8C5A1F"
  country-3: "#2A4A6B"
  country-4: "#8C3A2B"
  country-5: "#5A4E7C"
  country-6: "#3F6B22"
  country-7: "#1E5F66"
  country-8: "#8C3B63"
typography:
  display:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Archivo, ui-sans-serif, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 500
    lineHeight: 1.375
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Archivo, ui-sans-serif, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 500
  figure:
    fontFamily: "Archivo, ui-sans-serif, sans-serif"
    fontSize: "3.25rem" # figure-lead at sm and up; 2.6rem below
    fontWeight: 500
    lineHeight: 1.05
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Archivo, ui-sans-serif, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.625
  label:
    fontFamily: "Archivo, ui-sans-serif, sans-serif"
    fontSize: "0.625rem"
    fontWeight: 400
    letterSpacing: "0.14em"
rounded:
  sm: "2px"
  md: "2px"
  lg: "3px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
    rounded: "{rounded.md}"
    padding: "0 1rem"
    height: "2.25rem"
  button-brand:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.ground}"
    rounded: "{rounded.md}"
    height: "2.25rem"
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
  rail-item:
    backgroundColor: "transparent"
    textColor: "{colors.muted-ink}"
    padding: "0.375rem 1.25rem"
  rail-item-active:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
  read-panel:
    backgroundColor: "{colors.quiet}"
    textColor: "{colors.ink}"
    padding: "1.5rem"
  chip-healthy:
    backgroundColor: "{colors.signal-soft}"
    textColor: "{colors.signal}"
    rounded: "{rounded.sm}"
    padding: "0.125rem 0.5rem"
  chip-unknown:
    backgroundColor: "{colors.quiet}"
    textColor: "{colors.muted-ink}"
    rounded: "{rounded.sm}"
---

# Design System: Tiny Soho

## Overview

**Creative North Star: "The Standing Brief"**

A daily brief, not a dashboard. The page opens with the finding — *what is true
today and what to do about it* — and puts the numbers underneath as support. The
console it replaced reported figures and left the interpretation to the reader,
which is why the person it was built for stopped opening it.

Two refusals define the system. The first is the container drawn to create
hierarchy: grouping is done with one-pixel rules, bordered bands, and rows, not
with a field of boxes. A bounded surface is reserved for content that is
genuinely an object — a message, a sequence step, a draft. The second is the dark
chrome panel: a filled dark sidebar beside a light page is the single most
reliable way a console announces that it could belong to any product. The rail
here is the same paper as the page, divided by a rule, with the active route
marked by a moss edge.

The third rule is not visual at all, and it outranks both. **Every sentence on
this surface is derived from a measurement, and no measurement is stated more
confidently than its sample allows.** The read refuses a percentage without a
usable baseline. The funnel withholds a rate below its minimum sample. Unknown is
its own state everywhere — never rendered as zero, never as "healthy", never as
an em-dash beside a green chip.

**Key Characteristics:**

- Warm paper ground (`#F7F5EF`), never white, never dark
- Archivo throughout, one family, weight carrying hierarchy
- One accent, moss, for focus and affirmative state — never a data colour,
  and never tinting a finding
- One attention tone, and it marks a task rather than a failure
- Rules and rows for hierarchy; bounded surfaces only for real objects
- Near-square corners (2–3px), so nothing reads as a widget
- Tabular figures by default, set at the base layer

## Colors

Warm paper, near-black ink, one accent and one attention tone. Every value is
measured against the ground rather than chosen, and the ratios are recorded
because several sit close to their floor.

### Primary

- **Moss** (`#2C4A3B`): the single accent. **8.96:1.** It carries **focus and
  affirmative state** — the active rail edge, healthy status, affirmative
  actions — and nothing else. It is never a data series colour.

  An earlier draft claimed moss meant one thing, "the system is working", while
  also tinting the panel that holds today's read. That put a finding like
  *"growth is 40% slower"* on a success colour. The accent may mark where you
  are and what is well; it may not colour a conclusion.
- **Moss Soft** (`#DCE9E2`): the healthy chip only. Moss reads **7.81:1** on it.

### Secondary

- **Attention** (`#A8412B`): **5.57:1.** Marks the thing to do next. Deliberately
  not a siren red — the brand voice forbids shaming a parent, and the operations
  surface inherits that: this colour says *do this*, not *you failed*. The
  obvious choice (`#E74A25`) measures **3.56:1** and was refused; it would have
  carried the highest-priority label on the page below the legibility floor.
- **Destructive** (`#8C3A2B`): **6.99:1.** Deletion and irreversible actions only.

### Neutral

- **Paper** (`#F7F5EF`): the page. Everything sits directly on it.
- **Ink** (`#171812`): body and headings. **16.38:1.**
- **Muted Ink** (`#66665F`): secondary copy and labels. **5.31:1.**
- **Raised** (`#FFFEF9`): controls and floating chrome only, never a card wrapper.
- **Quiet** (`#EBE8DF`): hover beds, inert fills, and the default border.
- **Line** (`#CAC7BD`): structural rules and field edges, where a border must be
  seen rather than felt.

### Tertiary — data

Data colour is a separate vocabulary from interface colour and the two never mix.

- **Funnel Mark** (`#2A4A6B`) **8.41:1** and **Funnel Soft** (`#6B8AA5`)
  **3.30:1**: one hue, two steps, for every stage of a funnel.
- **Funnel Unknown** (`#8F8A80`): absence of evidence. Deliberately not a hue.
- **Country marks** (`#2C4A3B`, `#8C5A1F`, `#2A4A6B`, `#8C3A2B`, `#5A4E7C`,
  `#3F6B22`, `#1E5F66`, `#8C3B63`): categorical, separated by hue. All eight
  measure between **5.35:1 and 8.96:1** — above the 4.5 text floor, not merely
  the 3:1 a mark needs, so any of them can also carry its own label.

### Named Rules

**The Neutral Finding Rule.** A finding sits on neutral ground. Today's read is
delivered on `#EBE8DF` because the sentence may be bad news, and a surface that
celebrates it before the reader has read it is editorialising. Colour may mark
*where you are* and *what is well*; it may not colour a conclusion.

**The Accent Scope Rule.** Moss is focus and affirmative state — active route,
healthy status, affirmative action. It is never a data series, a chart line, or
a decorative fill, and it never tints a surface that carries a finding.

This rule cost the follower chart its most obvious colour. A dark green is the
natural mark for the US series, and moss is the dark green already in the palette —
but an accent that also means "United States" stops meaning "the system is
working". So the US series is `#1F5D3F`: the same family, a different value, and
7.15:1 on the canvas. Neither rule bends.

**The Chart Legibility Rule.** Every semantic mark clears **3:1** against both
paper surfaces (`#F7F5EF` canvas, `#FFFEF9` card) — the WCAG floor for a
graphical object — and renders **fully opaque**. State is carried by shape, not by
transparency: a dash for a provisional window, an outline for selection. Fading a
series to say "this one is incomplete" makes it fail the contrast its colour was
chosen to pass, which is how the chart previously became least legible in exactly
the states that needed reading. The mean line is near-ink (`#171812`) because a
rolling average is a statement of fact.

| Mark | Value | On canvas |
| --- | --- | --- |
| US | `#1F5D3F` | 7.15:1 |
| South Asian | `#8C5A1F` | 5.13:1 |
| Anglosphere | `#2A4A6B` | 8.20:1 |
| Other / provisional | `#66665F` | 4.42:1 |
| Rolling mean | `#171812` | 17.9:1 |

Values live in `web/src/lib/chartPalette.ts`, mirrored as `--color-chart-*` in
`index.css`, and the floor is asserted by test rather than trusted. What these
replaced were Tailwind `*-400` tints and two semi-transparent **white** strokes —
correct for a dark ground, and on paper the white measured about 1.05:1, meaning
the mean line was not dim but absent.

**The Attention-Not-Alarm Rule.** `#A8412B` marks a task, not a failure. Nothing
on this surface should make a person feel caught out; the product's voice
forbids it for followers and the same restraint applies to its operator.

**The Legible Caution Rule.** A caution that cannot be read is not a caution.
The `Caveat` component — which carries "this is not X% retention" and "the grey
block is an absence of evidence" — was rendering in an amber that measures
**1.14:1** on paper. Caution prose is `#7A5A0C` (**5.85:1**). When a ground
changes, check the warning colours first: they are the ones nobody looks at
until the moment they matter.

**The Ground Truth Rule.** Every colour here was measured against `#F7F5EF`. A
previous palette was measured against `#0a0a0a`, and a third against `#F7F4EE`;
none survived the move. If the ground changes again, every value is void until
re-measured. A palette does not travel between grounds.

**The No-Quieter-Tier Rule.** `--color-muted-foreground` (**5.31:1**) is the
quiet tier, and it is quiet by design — it has 0.81 of headroom above the 4.5
floor and nothing to spare. An opacity modifier on it is always illegal:
`/70` measures **2.90:1**, `/80` **3.50:1**, `/90` **4.30:1**. All three were
in the codebase and all three failed. Removed.

This is specific to that token. `text-foreground/75` measures **7.56:1** and
`/85` **10.66:1**, both fine — dark ink can be dimmed, the quiet tier cannot.
When a third level of hierarchy is wanted below muted, it comes from size or
weight, not from fading text that is already as faint as it may legally be.

Tailwind will not warn you: it applies opacity to any colour utility silently,
and the result looks intentional. Measure the blend, not the token.

## Typography

**One family: Archivo** (with system sans fallbacks), loaded from Google Fonts.

**Character:** a workhorse grotesk, chosen because an Operate surface is read for
minutes at a time by someone deciding something. Hierarchy comes from weight and
size, never from a second face. Two weights carry the whole system — 400 for
running text, 500 for anything structural.

**Loading is part of the design.** Two predecessor mocks declared a typeface with
no `@font-face` and no stylesheet link, so both silently rendered in fallback
type. A font that is not loaded is not a choice.

### Hierarchy

- **Display** (500, 1.5rem, `-0.02em`): the page name. One per screen.
- **Headline** (500, 1.25rem, 1.375): today's read. The most important sentence
  on the surface and the only place a full sentence is set large.
- **Figure** (500, 3.25rem, 1.05, `-0.025em`, tabular): the scored metric, one
  per surface. A figure is a ladder rather than a size — see *The Figure Ladder
  Rule* — and there are currently two of them.
- **Title** (500, 0.9375rem): section headings above a rule.
- **Body** (400, 0.8125rem, 1.625): all running copy, at a 54–74ch measure.
- **Label** (400, 0.625rem, `0.14em`, uppercase): every field name and section
  marker, defined once as `label-caps` so tracking cannot drift.

### Named Rules

**The Tabular Default Rule.** Figures are tabular at the `base` layer, not per
component. Numbers here are compared down columns, and a new component must not
be able to ship proportional figures by omission.

**The Figure Ladder Rule.** A figure is a ladder, not a size, and there is exactly
one ladder. It is defined once in `index.css` as four utilities, in the same way
and for the same reason as `label-caps`: so the scale cannot drift between
screens.

| Utility | Size | Tracking | Leading | Used for |
| --- | --- | --- | --- | --- |
| `figure-lead` | 2.6rem → **3.25rem** at `sm` | `-0.03em` | 1.05 | The one scored figure on a surface |
| `figure-base` | 2.25rem | `-0.025em` | 1.05 | Supporting figures beside a lead |
| `figure-small` | 1.5rem | `-0.02em` | 1.1 | A compact figure, or a value too long to lead |
| `figure-inline` | 1rem | `-0.01em` | 1.4 | A figure inside a sentence or a table row |

All four carry weight 500 and `tabular-nums`, so a call site never repeats them —
and must never add `tracking-*` beside one. **Tracking tightens as the type
grows, and that is optical correction rather than inconsistency:** `-0.03em` at
the lead would be far too tight at 1rem. That part of the ladder is deliberately
not flat. A stray `tracking-tight` would fight the utility by stylesheet order
rather than class order, which is the kind of bug that looks like nothing.

`figure-lead` carries the ladder's only responsive step. 3.25rem is right in a
desktop column and overbearing at 375px, where it crowds the mark beneath it.

**How it got here, because the history is the argument for one definition.** This
document originally recorded a single `figure` of 1.8rem. That was never accurate:
`GuardedNumber` ran 2.6rem → 3rem from the commit that introduced this system and
wrote this document, so the record described one call site and missed the other
from the first day. Home's band and the Funnels hero then grew independently
until the two leads sat at 3.25rem and 3rem, and 1.5rem meant "kpi" in one file
and "too long to be a figure" in the other. Unifying them moved Home's lead down
to 2.6rem on a phone and the Funnels hero up to 3.25rem on a desktop.

**The Placeholder Is Not A Figure Rule.** An em-dash standing in for a missing
number drops to 1.25rem in muted ink — headline scale, not figure scale. At the
lead figure's own size it is a ~55px hole where a value should be, and every tile
shows one before the first snapshot lands. The cell is carried by its mark
instead: see *The Withheld Figure Still Has A Shape Rule*.

**The Withheld Figure Still Has A Shape Rule.** A cell whose figure is withheld
keeps its mark. A week that cannot be *compared* still contains days that were
*measured*, so the score cell draws its trailing series and says how much of the
window was measured, rather than showing a lone em-dash on bare paper. It never
sums those days into a stand-in figure — that would be a wrong number rather than
a withheld one. Descriptive marks may show provisional and catch-up data with
their qualifications; the restriction is on claims, not on visibility.

**The Mark Obeys The Figure Rule.** A meter is a number rendered as length, so it
is withheld wherever the figure is. A rate below its minimum sample prints its raw
counts and draws no meter at all, because a half-filled bar beside "2 of 4" states
the percentage the text deliberately refuses to print. A day nobody measured
draws nothing and keeps its slot: a zero-height bar would say nobody followed
that day, which is the one thing the data does not say.

## Layout

A 208px rail against a fluid page. The rail carries a right rule and no fill; the
page is centred at a 1152px maximum with 40px of side padding on desktop and 20px
on mobile. The strip above is 48px and carries only identity and the way out.

Vertical rhythm is 24px between page sections and 12–14px inside one. Section
headings sit above a full-strength ink rule; rows separate on the quiet border.

Two layouts recur. The **band**: a single bordered rectangle divided internally by
rules, used where two panels must read as one statement — the read and its best
next move. The **two-column split** at `1.55fr 1fr`, with the thing you act on
wider than the thing you monitor.

Below 768px the rail becomes a left drawer over a scrim, the strip regains the
page title, and every grid collapses to one column.

### Named Rules

**The Coarse Pointer Rule.** Every interactive element carries a 44px minimum
target under `@media (pointer: coarse)`, and only under it. The rail's rhythm
depends on tight leading, so a mouse keeps the density and a thumb gets the
target.

**The Wayfinding Rule.** Every screen answers four questions: where am I, where
can I go, what is here, and how do I leave. A screen that cannot answer all four
is not finished.

**The Proximity Rule.** A control sits beside the thing it changes.

## Elevation & Depth

**In-flow content has no shadows.** Depth is the paper ground, one barely-raised
surface (`#FFFEF9`) for controls, and rules at two weights — `#EBE8DF` for row
separation, `#CAC7BD` where a border must be seen.

The single exception is a true overlay. The drawer and the confirm dialog sit
above the page on a scrim and carry a shadow, because an element that genuinely
floats should look like it does. Nothing in the document flow qualifies.

### Named Rules

**The Bounded-Object Rule.** Do not use a container to create hierarchy — that is
what rules and space are for, and a page of boxes drawn to group unrelated
figures is this system's first and most likely regression.

Do use a bounded surface when **the object itself has a boundary**: a message
bubble, a step in a sequence, a media thumbnail, a draft awaiting approval, a
tile in an editor. Those are things a person picks up and moves, and stripping
their edges to satisfy a slogan makes them harder to use, not purer.

The test is one question: *does this box exist because the content is an object,
or because I wanted the layout to feel organised?* Only the first survives.

Proven on the sequence editor, the first surface migrated after this rule was
written. A step **kept** its bounded surface: it is dragged, reordered, and
deleted as a unit, so its edges are the thing you grab. The empty state and the
not-found state **lost** theirs — both were containers drawn to make a paragraph
look considered. Same page, same rule, opposite answers, which is what a usable
rule looks like.

A dragged step also carries a shadow while in flight. That is the overlay
exception doing its job: an element genuinely lifted off the page may look like
it is.

**The Foreign Surface Rule.** A preview of somebody else's interface is not ours
to restyle. The phone mockup and its chat bubbles simulate an Instagram DM —
`bg-neutral-800` received, `bg-blue-600` sent — and they stay that way on an
ivory page. Recolouring them into this system would make the preview misrepresent
what the follower actually receives, which is the one thing a preview may never
do. Treat it as a screenshot: framed by our chrome, never repainted.

## Shapes

Near-square: 2px on controls, 3px at most on a band. Enough to take the
mechanical edge off a rendered corner, never enough to read as soft. Pills,
12px cards and circular icon beds belong to the console this replaced.

Borders are 1px and full strength. Chips are the only filled shapes, and they
exist to carry a status word, not to decorate.

## Components

### Buttons

- **Shape:** 2px radius, 36px tall, 16px horizontal padding
- **Primary:** ink on paper, 16.38:1 — the default action
- **Brand:** paper on moss, 8.96:1 — affirmative actions only, never destructive
- **Outline / Ghost:** transparent with a rule, bedding to quiet on hover
- **Focus:** a 2px moss ring, offset from the ground
- **Touch:** 44px minimum under a coarse pointer, on every size

### Inputs

Transparent ground, 1px `#CAC7BD` edge, 2px radius, 36px tall, no shadow.
Placeholder in muted ink so it clears 4.5:1 rather than fading to a hint. Focus
takes a 2px moss ring.

### The rail

Light, typographic, no icons. Group headings in `label-caps`; items at 13px in
muted ink. The active item takes ink, medium weight, and a 2px moss left edge —
state carried by an edge rather than a filled pill, so the rail never becomes a
block of colour.

### Today's read

The signature component. A `label-caps` marker, the finding as a headline, the
measured consequence beneath it, then the qualification — what it rests on —
and a control that opens the evidence. It sits on moss-soft inside the band,
paired with the single best next move across a rule.

**It is never authored.** The sentence is composed from measurements by a pure
function, and when no comparable baseline exists it states counts and says so
rather than inventing a direction.

### Attention rows

A numbered list, not cards. Index, title, consequence in counts, an urgency word
and an action. Ordered by what is lost, and derived only from numbers the API
already returns — so an empty list is a real and good state, rendered as a
sentence rather than as a gap.

### Status chips and the pulse

Three states and only three: healthy on moss-soft, attention on the destructive
tint, and **unknown on quiet grey**. Unknown is not a variant of healthy. A row
whose data failed to load says "No reading" and wears the unknown chip.

## Do's and Don'ts

### Do:

- **Do** separate with a 1px rule and more space before reaching for a container.
- **Do** deliver findings on neutral ground; the accent never colours a conclusion.
- **Do** keep moss for "working" and nothing else.
- **Do** carry counts alongside every rate, and render counts *instead of* a rate
  when the sample is thin.
- **Do** give loading, failed and empty three distinct treatments. A failed
  request must never render as an empty account.
- **Do** derive every sentence from a measurement; if it cannot be derived, do
  not print it.
- **Do** give every interactive element a 44px target under a coarse pointer,
  and press feedback on pointer-down.
- **Do** honour `prefers-reduced-motion` on every entrance and transition.
- **Do** load the typeface, and check it in the built output.
- **Do** re-measure every colour if the ground ever changes.

### Don't:

- **Don't** draw a container to create hierarchy. Rules and space do that.
  A bounded surface is for an object that genuinely has edges — a message, a
  sequence step, a media item, a draft.
- **Don't** add a shadow to anything that is not a true overlay.
- **Don't** introduce a dark chrome panel, least of all the rail.
- **Don't** tint a surface that carries a finding, or use moss or a country
  colour as a general-purpose accent.
- **Don't** state a percentage without a usable baseline, or above a withheld
  rate.
- **Don't** show a green status beside a value you do not have.
- **Don't** add a second typeface, or reach past weight 500 for emphasis.
- **Don't** write a decorative kicker above a heading, or number sections when
  the order carries no information. A short label that *identifies* the subject
  is not a kicker and is welcome — "Biggest leak · no reply" above a heading
  tells the reader which leak, and Funnels would be harder to scan without it.
  The test is whether removing the line loses information. If it does not, it
  was decoration.
- **Don't** rely on hover for anything a phone user needs.
