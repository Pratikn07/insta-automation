# Raising the Instagram messaging rate limit (Meta verification playbook)

## Why this matters

Our comment→DM gate uses Instagram's **Private Replies API**. It fails ~92% of the
time with error `code 100 / subcode 2534025` ("comment is invalid for a private
reply"). We proved (via the event logs) this is an **account-level rate/quota
limit**, not a bug and not a per-comment problem:

- At low volume it succeeds 100%; under real volume it drops to a few sends/hour.
- Our traffic (~50–100 comments/hr) is far below Meta's documented 750/hr cap, so
  the *effective* quota on this account is unusually low — the signature of a
  **new / unverified / low-reputation** app + account.

The **retry queue** (already shipped) works around this by re-attempting within the
7-day window. **This document is the other half: raising the actual ceiling** so
more sends succeed on the first try. It is operator/account work — not code.

> Verify the exact current steps in the Meta App Dashboard and
> https://developers.facebook.com/docs/ — Meta changes this flow periodically.
> Treat the steps below as the checklist, not a guarantee of today's UI labels.

## What raises the limit (in priority order)

### 1. Meta Business Verification  ← the gateway, do this first
Almost every higher-access path is gated behind a verified Business.

1. Go to **business.facebook.com** → **Business Settings** → **Security Center**
   (or **Business Verification**).
2. Submit the legal business: legal name, address, phone, and a verification
   document (business registration / utility bill / etc. as Meta lists).
3. Confirm via the phone/email/domain method Meta offers.
4. Wait for approval (typically a few business days).

**Prerequisite:** the Instagram professional account and the app must be attached
to this Business in Business Settings → Accounts → Instagram accounts / Apps.

### 2. App Review → Advanced Access for messaging permissions
Standard Access (the default) carries the low limits. **Advanced Access** is what
production messaging apps run on.

1. Meta App Dashboard → your app → **App Review → Permissions and Features**.
2. Request **Advanced Access** for the messaging permissions the app uses:
   - `instagram_business_manage_messages` (sending DMs / private replies)
   - `instagram_business_basic`
   - (whichever the app actually requests at login)
3. Provide what App Review requires:
   - A clear use-case description (comment-keyword → deliver requested guide via DM).
   - A **screencast** demonstrating the full flow end-to-end.
   - Privacy policy URL + how data is used.
4. Submit and wait for review.

**Note:** the app must currently be in / moving to **Live** mode (not Development)
for Advanced Access to take effect in production.

### 3. Warm up + good sending behaviour (reduces throttling regardless of tier)
Rate limits are partly reputation-based. Lower the spam signal:

- Keep pacing conservative (the retry worker already spaces sends).
- **Vary the gate message wording**; avoid identical, emoji-only, link-heavy text.
- Avoid sudden bursts right after a viral reel (the worker's adaptive backoff helps).
- Make sure the Instagram account itself is in good standing (no recent violations).

## How we'll know it worked

After verification + Advanced Access is granted, watch the same metrics we used to
diagnose this (via the Supabase MCP / Activity page):

- The **first-try `dm_failed` (2534025) rate should drop** — more gates succeed
  immediately, fewer land in the retry queue.
- `gateQueuePending` on the Home dashboard should trend down.
- Re-run the recovery query (failed-gate users vs. never-recovered) — the
  never-recovered count should shrink.

## Honest expectation

Verification is an **application with no guaranteed outcome or timeline**, and Meta
does not publish the exact post-verification limit. The retry queue is what
guarantees recovery *today*; verification is the lever that should raise the
first-try ceiling over time. Pursue both — they compound.
