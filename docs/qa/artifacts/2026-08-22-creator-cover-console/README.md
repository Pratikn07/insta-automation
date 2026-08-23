# Creator guide-cover console browser QA

These artifacts come from the real `SequenceEditor` and `GuideCoverPanel` mounted in the
local Playwright harness. The harness replaces `window.fetch` with deterministic synthetic
responses in `web/e2e/main.tsx`; no backend, deployed environment, production flag, Meta API,
Instagram account, parent, or delivery route is used.

Capture command:

```sh
cd web
E2E_PORT=5280 npx playwright test e2e/guide-cover-authoring.spec.ts
```

The journey runs at Desktop Chrome and 390×844. It selects Recipes, requests a Bedtime
suggestion, edits the closing line, explicitly saves, approves, and publishes. Its test-only
mutation receipt proves the order is suggestion → draft create → approve → publish and that
no `/messages` mutation occurs.

## Visual comparison

The isolated `bedtime-browser-preview.png` images use the same approved Bedtime copy,
edition `01`, colors, geometry, artwork keys, line breaks, and pinned `Inter` / `Source Serif 4`
families as `../2026-08-22-guide-covers/bedtime-warm-editorial.png`. Browser assertions verify
that Chrome has loaded Source Serif 4 and computes that family on the headline.

The browser evidence is captured at its responsive CSS size (593×454 desktop, 316×242 mobile),
while the approved server artifact is rendered directly at 1200×916. Chrome's native SVG text
rasterization, antialiasing, and screenshot downsampling therefore differ slightly from the
server renderer's full-resolution PNG pixels. The reviewed composition and typography match;
these responsive screenshots are visual evidence, not byte-for-byte golden replacements for
the approved server PNG.

| Artifact | SHA-256 |
| --- | --- |
| `desktop/bedtime-browser-preview.png` | `0324000dd28eefd567d9313f742212c548109b75efcfd72182c316f93792ba14` |
| `desktop/creator-console-published.png` | `06048c4d6e0eb5ad14731301cd40b6d1e0c03d1fb278bcd39346ca35d9d76750` |
| `mobile/bedtime-browser-preview.png` | `2de1ae1598a89ccf043fbecbdff5ade2d54ae17f120c4ce8a1731035688da660` |
| `mobile/creator-console-published.png` | `6321f6dd21f1ec915bf9cfb15db5e052a453d933a29c459f7b644a8f7170cc08` |
